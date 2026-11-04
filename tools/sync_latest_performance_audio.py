#!/usr/bin/env python3
"""Replace a song's representative audio with the newest performance's cut.

The song data keeps one audio track per song. This tool enforces the
"newest performance wins" convention: when a song is sung again, the cut
audio of the newest performance replaces the file the index already points
at (same path, old bytes discarded -- no archive copy is kept).

Inputs
  data/xiaosonglu/replay_song_segments.json    verified performance facts
  data/xiaosonglu/audio_index.json             one track per song
  data/xiaosonglu/_audio_performance_state.json
        which performance each indexed track currently comes from

Trust model
  A cut only qualifies when the *fact ledger* already recorded it for that
  exact performance (date + segment index), i.e. a reviewer accepted it.
  Songs without a cut, or without an indexed track, are skipped and reported.

Duration guardrail
  When the performance carries start/end times (collection chapters), the
  downloaded cut must match that window within --duration-tolerance. Standalone
  song cuts have no window in the ledger; they are accepted on ledger
  provenance and their measured length is recorded for transparency.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ingest_song_cut_audio as ingest  # noqa: E402

STATE_REL = "data/xiaosonglu/_audio_performance_state.json"
SEGMENTS_REL = "data/xiaosonglu/replay_song_segments.json"
INDEX_REL = "data/xiaosonglu/audio_index.json"
SOURCE_REL = "assets/audio/source/_latest"
BVID_RE = re.compile(r"/video/(BV[0-9A-Za-z]+)/?", re.IGNORECASE)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, payload):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def cut_bvid(url):
    match = BVID_RE.search(str(url or ""))
    return match.group(1) if match else ""


def safe_stem(name):
    return "".join(ch if ch.isalnum() or ch in " .-_" else "_" for ch in name).strip() or "track"


def parse_clock(value):
    text = str(value or "").strip()
    parts = text.split(":")
    if len(parts) != 3 or not all(part.strip().isdigit() for part in parts):
        return None
    hours, minutes, seconds = (int(part) for part in parts)
    return hours * 3600 + minutes * 60 + seconds


def expected_seconds(segment):
    start = parse_clock(segment.get("start_time"))
    end = parse_clock(segment.get("end_time"))
    if start is None or end is None or end <= start:
        return None
    return float(end - start)


def latest_performance_by_song(segments):
    latest = {}
    for segment in segments:
        name = str(segment.get("song_name") or "").strip()
        date = str(segment.get("replay_date") or "").strip()
        if not name or not date:
            continue
        key = ingest.normalize(name)
        current = latest.get(key)
        if current is None or (date, segment.get("segment_index") or 0) > (
            str(current.get("replay_date")),
            current.get("segment_index") or 0,
        ):
            latest[key] = segment
    return latest


def indexed_target(index, name):
    audios = index.get("audios") or {}
    owners = {ingest.normalize(key): key for key in audios}
    key = ingest.normalize(name)
    if key not in owners:
        return None, None
    owner = owners[key]
    return owner, str(audios[owner]).split("?", 1)[0]


def build_state(latest, index):
    songs = {}
    for key, segment in latest.items():
        name = str(segment.get("song_name") or "").strip()
        owner, target = indexed_target(index, name)
        if not target:
            continue
        songs[key] = {
            "song": owner or name,
            "date": str(segment.get("replay_date")),
            "segmentIndex": segment.get("segment_index"),
            "cutBvid": cut_bvid(segment.get("cut_link")),
            "audioTarget": target,
            "status": "bootstrap",
        }
    return songs


def probe_duration(ffmpeg_dir, path):
    tool = Path(ffmpeg_dir) / "ffprobe.exe"
    if not tool.is_file():
        return None
    try:
        result = subprocess.run(
            [str(tool), "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=120, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    try:
        return float(result.stdout.strip().splitlines()[0])
    except (IndexError, ValueError):
        return None


def fetch_cut(args, cut_url, destination):
    command = [
        str(Path(args.root) / args.yt_dlp),
        "--ignore-config", "--no-playlist", "--no-progress",
        "-f", "bestaudio/best", "--extract-audio", "--audio-format", "m4a",
        "--audio-quality", "0",
        "--ffmpeg-location", str(Path(args.root) / args.ffmpeg_dir),
        "--retries", "3", "-o", str(destination),
        # Keep the full cut URL (including any ?p=N page): a bare BV URL always
        # resolves to part 1 of a multi-part collection, which would silently
        # give every song in the batch the same wrong audio.
        str(cut_url),
    ]
    if args.cookies_file:
        command[1:1] = ["--cookies", args.cookies_file]
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                timeout=args.timeout_seconds, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0 and destination.is_file() and destination.stat().st_size > 0


def plan_replacements(state, latest, index, max_songs):
    groups = {}
    skipped = []
    for key, segment in latest.items():
        name = str(segment.get("song_name") or "").strip()
        date = str(segment.get("replay_date") or "")
        owner, target = indexed_target(index, name)
        if not target:
            skipped.append({"song": name, "reason": "no indexed audio"})
            continue
        record = state.get(key)
        if not record:
            skipped.append({"song": name, "reason": "not bootstrapped yet"})
            continue
        if date <= str(record.get("date") or ""):
            continue
        bvid = cut_bvid(segment.get("cut_link"))
        if not bvid:
            skipped.append({"song": name, "reason": f"no cut recorded for {date}"})
            continue
        group = groups.setdefault(date, {
            "date": date,
            "liveId": str(segment.get("replay_id") or ""),
            "title": str(segment.get("replay_title") or ""),
            "songs": [],
        })
        group["songs"].append({
            "key": key,
            "song": owner or name,
            "segmentIndex": segment.get("segment_index"),
            "cutUrl": str(segment.get("cut_link")),
            "cutBvid": bvid,
            "audioTarget": target,
            "expectedSeconds": expected_seconds(segment),
            "previousDate": str(record.get("date") or ""),
        })
    ordered = [groups[date] for date in sorted(groups)]
    budget = max_songs
    for group in ordered:
        group["songs"] = group["songs"][:max(0, budget)]
        budget -= len(group["songs"])
    return [group for group in ordered if group["songs"]], skipped


def replace_group(args, group):
    live_dir = Path(args.root) / SOURCE_REL / re.sub(r"[^0-9A-Za-z._-]+", "_", group["liveId"])
    if live_dir.exists():
        shutil.rmtree(live_dir)
    live_dir.mkdir(parents=True, exist_ok=True)
    prepared, skipped = [], []
    for song in group["songs"]:
        # Reuse the recorded segment index as the batch part: ingestion treats a
        # batch entry as idempotent only when its part equals the ledger's
        # segment index for that replay, which is what keeps an audio-only
        # replacement from being mistaken for a duplicate performance.
        part = int(song["segmentIndex"] or 0)
        if part <= 0:
            skipped.append({"song": song["song"], "reason": "ledger segment has no index"})
            continue
        scratch = live_dir / f".scratch_{safe_stem(song['song'])}.m4a"
        if not fetch_cut(args, song["cutUrl"], scratch):
            skipped.append({"song": song["song"], "reason": "download failed"})
            continue
        measured = probe_duration(Path(args.root) / args.ffmpeg_dir, scratch)
        expected = song.get("expectedSeconds")
        if expected and measured and abs(measured - expected) / expected > args.duration_tolerance:
            skipped.append({
                "song": song["song"],
                "reason": f"cut {measured:.0f}s vs performance window {expected:.0f}s",
            })
            scratch.unlink(missing_ok=True)
            continue
        final = live_dir / f"{part:02d}_{safe_stem(song['song'])}.m4a"
        scratch.replace(final)
        song.update({
            "part": part,
            "path": final,
            "bytes": final.stat().st_size,
            "sha256": ingest.sha256(final),
            "measuredSeconds": measured,
        })
        prepared.append(song)
    if prepared:
        seen, duplicates = set(), []
        for song in prepared:
            if song["sha256"] in seen and song["song"] not in duplicates:
                duplicates.append(song["song"])
            seen.add(song["sha256"])
        if duplicates:
            # Two songs in one batch can never share identical bytes: that means
            # the downloads collapsed onto the same (wrong) source page. Refuse
            # to ingest any of them rather than corrupt indexed tracks.
            skipped.append({
                "song": ", ".join(duplicates),
                "reason": "duplicate download bytes within batch; refusing to ingest",
            })
            for song in prepared:
                song["path"].unlink(missing_ok=True)
            return [], skipped
    return prepared, skipped


def run_ingest(args, group, prepared):
    batch = {
        "schemaVersion": 1,
        "notes": f"auto: replace audio with the newest performance ({group['date']})",
        "live": {
            "liveId": group["liveId"],
            "date": group["date"],
            "title": group["title"],
            "replayId": group["liveId"],
            "replayDateSource": "live-api-date",
        },
        "songs": [],
    }
    specs = []
    for song in prepared:
        batch["songs"].append({
            "segmentIndex": song["part"],
            "songName": song["song"],
            "audioAction": "replace-existing",
            "audioReplacementReason": f"同曲改用最新演唱版本（{group['date']}）",
            "audioSha256": song["sha256"],
            "audioBytes": song["bytes"],
            "audioTarget": song["audioTarget"],
            "audioPreviousSongName": song["song"],
            "cut": {"kind": "single", "url": song["cutUrl"], "bvid": song["cutBvid"]},
        })
        identity = ingest.download_source_identity(song["cutUrl"], song["part"], "single")
        specs.append(f"{song['part']}|{song['bytes']}|{song['sha256']}|{identity}")
    batch_path = Path(args.root) / "data/xiaosonglu" / f"_latest_audio_{group['date']}.json"
    write_json(batch_path, batch)
    command = [
        sys.executable, str(Path(args.root) / "tools/ingest_song_cut_audio.py"),
        "--root", str(args.root), "--curated", str(batch_path),
        "--source-dir", str(prepared[0]["path"].parent),
    ]
    for spec in specs:
        command.extend(["--reviewed-source-spec", spec])
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-3:]
        return None, " | ".join(tail)
    try:
        return json.loads(result.stdout), None
    except ValueError:
        return None, "ingest produced unparsable output"


def adopt_baseline(args, replaced):
    specs = [
        f"{entry['target'].split('?', 1)[0]}|{entry['bytes']}|{entry['sha256']}"
        for entry in replaced
        if entry.get("target") and entry.get("sha256")
    ]
    if not specs:
        return 0
    command = [
        sys.executable, str(Path(args.root) / "tools/sync_song_audio_assets.py"),
        "--root", str(args.root), "--source-base", "https://viridis.love/",
        "--adopt-baseline", "--quiet",
    ]
    for spec in specs:
        command.extend(["--adopt-spec", spec])
    return subprocess.run(command, capture_output=True, text=True, check=False).returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--max-songs", type=int, default=8)
    parser.add_argument("--duration-tolerance", type=float, default=0.05)
    parser.add_argument("--yt-dlp", default="tools/yt-dlp/yt-dlp.exe")
    parser.add_argument("--ffmpeg-dir", default="tools/ffmpeg")
    parser.add_argument("--cookies-file", default=os.environ.get("XSL_BILIBILI_COOKIE_FILE", ""))
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    state_path = Path(args.root) / STATE_REL
    latest = latest_performance_by_song(load_json(Path(args.root) / SEGMENTS_REL)["segments"])
    index = load_json(Path(args.root) / INDEX_REL)

    if not state_path.exists():
        state = {"schemaVersion": 1, "updatedAt": now_iso(), "songs": build_state(latest, index)}
        if not args.dry_run:
            write_json(state_path, state)
        print(json.dumps({"ok": True, "bootstrapped": True, "tracked": len(state["songs"]),
                          "groups": [], "skipped": [], "planned": 0}, ensure_ascii=False))
        return 0

    state = load_json(state_path)
    songs = state.setdefault("songs", {})
    groups, skipped = plan_replacements(songs, latest, index, args.max_songs)
    if args.dry_run or not groups:
        print(json.dumps({"ok": True, "bootstrapped": False, "groups": groups, "skipped": skipped,
                          "planned": sum(len(g["songs"]) for g in groups)}, ensure_ascii=False))
        return 0

    applied, errors = [], []
    for group in groups:
        prepared, group_skipped = replace_group(args, group)
        skipped.extend(group_skipped)
        if not prepared:
            continue
        payload, error = run_ingest(args, group, prepared)
        if error:
            errors.append({"date": group["date"], "error": error})
            continue
        replaced = payload.get("replaced") or []
        adopt_status = adopt_baseline(args, replaced)
        for song in prepared:
            record = songs.setdefault(song["key"], {})
            record.update({
                "song": song["song"],
                "date": group["date"],
                "segmentIndex": song["segmentIndex"],
                "cutBvid": song["cutBvid"],
                "audioTarget": song["audioTarget"],
                "bytes": song["bytes"],
                "sha256": song["sha256"],
                "measuredSeconds": song["measuredSeconds"],
                "status": "replaced",
            })
        applied.append({
            "date": group["date"],
            "songs": [song["song"] for song in prepared],
            "replaced": len(replaced),
            "adoptStatus": adopt_status,
        })
    state["schemaVersion"] = state.get("schemaVersion", 1)
    state["updatedAt"] = now_iso()
    write_json(state_path, state)
    print(json.dumps({"ok": not errors, "bootstrapped": False, "applied": applied,
                      "skipped": skipped, "errors": errors}, ensure_ascii=False))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
