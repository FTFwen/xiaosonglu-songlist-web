#!/usr/bin/env python3
"""Download reviewed Bilibili song-cut parts into a safe temporary audio directory.

The curated manifest is the source of truth for part numbers and URLs.  Cookies are
accepted only by path at runtime and must remain outside the workspace; their contents
are never read into logs or output.  Downloads are sequential so a scheduled run does
not create a burst of Bilibili requests.  The follow-up ingestion step is deliberately
separate and is responsible for updating the tracked audio index.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BILIBILI_HOSTS = {"www.bilibili.com", "bilibili.com", "m.bilibili.com"}
CUT_KINDS = {"single", "collection", "collection-chapter", "compilation"}
MULTIPART_CUT_KINDS = {"collection", "collection-chapter"}
AUDIO_TARGET_RE = re.compile(r"^assets/audio/song_\d+\.m4a$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_song_name(value: object) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or "")).strip()).casefold()


def parse_positive_integer(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a positive integer")
    if isinstance(value, int):
        result = value
    elif isinstance(value, float) and value.is_integer():
        result = int(value)
    elif isinstance(value, str) and re.fullmatch(r"[1-9]\d*", value.strip()):
        result = int(value)
    else:
        raise ValueError(f"{label} must be a positive integer")
    if result <= 0 or result > 9_007_199_254_740_991:
        raise ValueError(f"{label} must be a positive safe integer")
    return result


def cut_url_for_item(item: dict[str, Any]) -> object:
    cut = item.get("cut")
    if isinstance(cut, dict):
        return cut.get("url") or cut.get("clip_url")
    return None


def normalized_review_url(value: object) -> str:
    try:
        parsed = urllib.parse.urlsplit(str(value or "").strip())
        port = parsed.port
    except (TypeError, ValueError):
        return ""
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return ""
    hostname = parsed.hostname.casefold()
    if hostname in BILIBILI_HOSTS:
        hostname = "bilibili.com"
    host = hostname + (f":{port}" if port and port != 443 else "")
    path = parsed.path.rstrip("/").casefold()
    return urllib.parse.urlunsplit(("https", host, path, "", ""))


def trusted_same_name_evidence_url(value: object) -> bool:
    try:
        parsed = urllib.parse.urlsplit(str(value or "").strip())
    except ValueError:
        return False
    try:
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme.casefold() == "https"
        and not parsed.username and not parsed.password
        and port in (None, 443)
        and (parsed.hostname or "").casefold() in BILIBILI_HOSTS
        and re.fullmatch(r"/video/bv[0-9a-z]+/?", parsed.path, flags=re.IGNORECASE) is not None
    )


def confirmed_same_name_review(item: dict[str, Any], source_urls: set[str]) -> bool:
    review = item.get("sameNameReview") or item.get("same_name_review")
    if not isinstance(review, dict) or review.get("decision") != "confirmed-repeat":
        return False
    evidence = review.get("evidenceUrls")
    if not isinstance(evidence, list):
        evidence = [review.get("evidenceUrl")]
    return bool(str(review.get("notes") or "").strip()) and any(
        trusted_same_name_evidence_url(url)
        and (normalized := normalized_review_url(url))
        and normalized not in source_urls
        for url in evidence
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json_atomic(path: Path, value: object) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    if temporary.exists() or temporary.is_symlink():
        raise ValueError(f"unsafe temporary provenance file: {temporary.name}")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary.is_file():
            temporary.unlink()


def path_inside(root: Path, candidate: Path, label: str) -> Path:
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label} must stay inside the workspace root") from error
    return candidate


def is_m4a(path: Path) -> bool:
    if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0:
        return False
    with path.open("rb") as handle:
        header = handle.read(12)
    return len(header) >= 12 and header[4:8] == b"ftyp"


def read_curated(path: Path, existing_segments: list[dict[str, Any]], existing_cuts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    songs = value.get("songs") if isinstance(value, dict) else None
    if not isinstance(songs, list) or not songs:
        raise ValueError("curated manifest must contain a non-empty songs list")
    live = value.get("live") if isinstance(value.get("live"), dict) else {}
    live_date = str(live.get("date") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", live_date):
        raise ValueError("curated live.date must be YYYY-MM-DD")
    live_identity = str(live.get("replayId") or live.get("replay_id") or live.get("liveId") or "").strip()
    if not live_identity:
        raise ValueError("curated live must contain a stable liveId or replayId")
    live_id = str(live.get("replayId") or live.get("replay_id") or f"live:{live.get('liveId')}")
    superseded_segments: dict[tuple[str, int], dict[str, str]] = {}
    for position, item in enumerate(songs, start=1):
        if not isinstance(item, dict):
            continue
        fact_action = str(item.get("factAction") or item.get("fact_action") or "keep-existing").strip().casefold()
        if fact_action not in {"keep-existing", "replace-existing-segment"}:
            raise ValueError(f"curated song has unsupported factAction: {fact_action}")
        if fact_action == "replace-existing-segment":
            raw_target_part = item.get("segmentIndex") if item.get("segmentIndex") is not None else item.get("segment_index")
            target_part = parse_positive_integer(raw_target_part, "replace-existing-segment segmentIndex")
            previous_name = normalize_song_name(item.get("previousSongName") or item.get("previous_song_name"))
            previous_bvid = str(item.get("previousCutBvid") or item.get("previous_cut_bvid") or "").strip()
            reason = str(item.get("factReplacementReason") or item.get("fact_replacement_reason") or "").strip()
            replacement_cut = item.get("cut")
            replacement_cut_url = replacement_cut.get("url") or replacement_cut.get("clip_url") if isinstance(replacement_cut, dict) else ""
            replacement_cut_match = re.search(r"/video/(BV[0-9A-Za-z]+)", str(replacement_cut_url), flags=re.IGNORECASE)
            declared_replacement_bvid = str(replacement_cut.get("bvid") or replacement_cut.get("clip_bvid") or "").strip() if isinstance(replacement_cut, dict) else ""
            if target_part <= 0 or not previous_name or not reason or not re.fullmatch(r"BV[0-9A-Za-z]+", previous_bvid):
                raise ValueError("replace-existing-segment requires reason, previousSongName, previousCutBvid, and positive segmentIndex")
            if not replacement_cut_match or not declared_replacement_bvid or declared_replacement_bvid.casefold() != replacement_cut_match.group(1).casefold():
                raise ValueError("replace-existing-segment requires cut.bvid matching its Bilibili video URL")
            desired_name = normalize_song_name(item.get("songName") or item.get("song_name"))
            superseded_segments[(live_id, target_part)] = {"previous": previous_name, "desired": desired_name, "bvid": previous_bvid.casefold()}
    for coordinate, spec in superseded_segments.items():
        matches = [segment for segment in existing_segments if isinstance(segment, dict) and str(segment.get("replay_id") or "") == coordinate[0] and parse_positive_integer(segment.get("segment_index"), "existing segment_index") == coordinate[1]]
        if len(matches) != 1:
            raise ValueError(f"replace-existing-segment requires exactly one fact at {coordinate[0]} segment {coordinate[1]}")
        current_name = normalize_song_name(matches[0].get("song_name"))
        if current_name == spec["previous"]:
            cut_match = re.search(r"/video/(BV[0-9A-Za-z]+)", str(matches[0].get("cut_link") or ""), flags=re.IGNORECASE)
            matching_cut_rows = [cut for cut in existing_cuts if isinstance(cut, dict) and str(cut.get("clip_date") or "") == live_date and normalize_song_name(cut.get("song_name")) == spec["previous"] and str(cut.get("clip_bvid") or "").casefold() == spec["bvid"]]
            if not cut_match or cut_match.group(1).casefold() != spec["bvid"] or len(matching_cut_rows) != 1:
                raise ValueError("replace-existing-segment previousCutBvid must exactly match the stale segment and cut ledger")
        elif current_name != spec["desired"]:
            raise ValueError("replace-existing-segment target has an unexpected song name")
    existing_by_name: dict[str, list[dict[str, Any]]] = {}
    existing_source_urls: dict[str, set[str]] = {}
    for segment in existing_segments:
        if not isinstance(segment, dict) or str(segment.get("replay_date") or "").strip() != live_date:
            continue
        superseded_spec = superseded_segments.get((str(segment.get("replay_id") or ""), int(segment.get("segment_index") or 0)))
        if superseded_spec and normalize_song_name(segment.get("song_name")) == superseded_spec["previous"]:
            continue
        key = normalize_song_name(segment.get("song_name"))
        if not key:
            continue
        existing_by_name.setdefault(key, []).append(segment)
        source_url = normalized_review_url(segment.get("cut_link"))
        if source_url:
            existing_source_urls.setdefault(key, set()).add(source_url)
    result: list[dict[str, Any]] = []
    parts: set[int] = set()
    names: set[str] = set()
    source_urls_by_name: dict[str, set[str]] = {key: set(urls) for key, urls in existing_source_urls.items()}
    for item in songs:
        if not isinstance(item, dict):
            continue
        name_key = normalize_song_name(item.get("songName") or item.get("song_name"))
        source_url = normalized_review_url(cut_url_for_item(item))
        if name_key and source_url:
            source_urls_by_name.setdefault(name_key, set()).add(source_url)
    for position, item in enumerate(songs, start=1):
        if not isinstance(item, dict):
            raise ValueError("each curated song must be an object")
        raw_part = item.get("segmentIndex") if item.get("segmentIndex") is not None else item.get("segment_index")
        part = parse_positive_integer(position if raw_part is None else raw_part, "each curated song segmentIndex")
        if part <= 0 or part in parts:
            raise ValueError(f"invalid or duplicate curated segmentIndex: {part}")
        cut = item.get("cut")
        if not isinstance(cut, dict):
            raise ValueError(f"curated segment {part} must use a nested cut object")
        url = cut_url_for_item(item)
        if not isinstance(url, str) or not url.strip():
            raise ValueError(f"curated segment {part} has no cut URL")
        parsed = urllib.parse.urlsplit(url.strip())
        if parsed.scheme != "https" or (parsed.hostname or "").lower() not in BILIBILI_HOSTS:
            raise ValueError(f"curated segment {part} does not use an HTTPS Bilibili URL")
        if parsed.username or parsed.password:
            raise ValueError(f"curated segment {part} URL contains user info")
        url_bvid_match = re.fullmatch(r"/video/(BV[0-9A-Za-z]+)/?", parsed.path, flags=re.IGNORECASE)
        if not url_bvid_match:
            raise ValueError(f"curated segment {part} is not a canonical Bilibili video URL")
        song_name = str(item.get("songName") or item.get("song_name") or "").strip()
        if not song_name:
            raise ValueError(f"curated segment {part} has no songName")
        name_key = normalize_song_name(song_name)
        source_urls = set(source_urls_by_name.get(name_key, set()))
        source_urls.add(normalized_review_url(url))
        source_urls.discard("")
        existing = existing_by_name.get(name_key, [])
        idempotent = any(
            str(segment.get("segment_index") or "") == str(part)
            and str(segment.get("replay_id") or "") == live_id
            for segment in existing
        )
        needs_review = name_key in names or (bool(existing) and not idempotent)
        if needs_review and not confirmed_same_name_review(item, source_urls):
            raise ValueError(
                f"curated segment {part} repeats {song_name!r} without a confirmed sameNameReview "
                "backed by an independent Bilibili video URL; recheck the song using another uploader or "
                "a direct Bilibili search before downloading"
            )
        raw_kind = cut.get("kind") if isinstance(cut, dict) else None
        raw_kind = raw_kind or item.get("clipKind") or item.get("clip_kind")
        if not raw_kind:
            raise ValueError(f"curated segment {part} must declare cut kind")
        kind = str(raw_kind).strip().casefold()
        if kind not in CUT_KINDS:
            raise ValueError(f"curated segment {part} has unsupported cut kind: {kind}")
        audio_action = str(item.get("audioAction") or item.get("audio_action") or "keep-existing").strip().casefold()
        if item.get("replaceExistingAudio") is True:
            audio_action = "replace-existing"
        if audio_action not in {"keep-existing", "replace-existing"}:
            raise ValueError(f"curated segment {part} has unsupported audioAction: {audio_action}")
        if audio_action == "replace-existing":
            declared_bvid = str(cut.get("bvid") or cut.get("clip_bvid") or "").strip()
            replacement_reason = str(item.get("audioReplacementReason") or item.get("audio_replacement_reason") or "").strip()
            audio_target = str(item.get("audioTarget") or item.get("audio_target") or "").strip().split("?", 1)[0]
            if not declared_bvid or declared_bvid.casefold() != url_bvid_match.group(1).casefold():
                raise ValueError(f"curated segment {part} replace-existing requires cut.bvid matching its URL")
            if not replacement_reason or not AUDIO_TARGET_RE.fullmatch(audio_target):
                raise ValueError(f"curated segment {part} replace-existing requires audioReplacementReason and safe audioTarget")
        expected_audio_hash = str(item.get("audioSha256") or item.get("audio_sha256") or "").strip().casefold()
        raw_audio_bytes = item.get("audioBytes") if item.get("audioBytes") is not None else item.get("audio_bytes")
        expected_audio_bytes = parse_positive_integer(raw_audio_bytes, f"curated segment {part} audioBytes") if audio_action == "replace-existing" else 0
        if audio_action == "replace-existing" and (
            not re.fullmatch(r"[0-9a-f]{64}", expected_audio_hash) or expected_audio_bytes <= 0
        ):
            raise ValueError(f"curated segment {part} replace-existing requires reviewed audioSha256 and audioBytes")
        names.add(name_key)
        source_urls_by_name[name_key] = source_urls
        parts.add(part)
        result.append({
            "part": part, "song": song_name, "url": url.strip(), "kind": kind,
            "audioAction": audio_action, "audioSha256": expected_audio_hash,
            "audioBytes": expected_audio_bytes,
        })
    return sorted(result, key=lambda item: item["part"])


def part_files(source_dir: Path, part: int) -> list[Path]:
    if not source_dir.exists():
        return []
    prefix = f"{part:02d}_" if part < 100 else f"{part}_"
    return sorted(
        path for path in source_dir.iterdir()
        if path.is_file() and not path.is_symlink() and path.name.lower().endswith(".m4a") and path.name.startswith(prefix)
    )


def download_page_url(url: str, part: int, kind: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    # The curated URL is public metadata; discard incidental query parameters so a
    # pasted tracking/token parameter can never be forwarded. Only collection
    # chapters use segmentIndex as Bilibili's page selector; standalone cuts must
    # stay on their sole video page rather than receiving an invalid ?p=N.
    query = urllib.parse.urlencode({"p": part}) if kind in MULTIPART_CUT_KINDS else ""
    return urllib.parse.urlunsplit(parsed._replace(query=query, fragment=""))


def download_source_identity(url: str, part: int, kind: str) -> str:
    page_url = download_page_url(url, part, kind)
    parsed = urllib.parse.urlsplit(page_url)
    base = normalized_review_url(page_url)
    query = urllib.parse.urlencode(sorted(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)))
    return base + (f"?{query}" if query else "")


def probe_audio(ffprobe: Path, path: Path) -> None:
    command = [
        str(ffprobe), "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_type,duration", "-of", "json", str(path),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(f"ffprobe failed for {path.name}") from error
    if result.returncode != 0:
        raise ValueError(f"ffprobe rejected {path.name}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError(f"ffprobe returned invalid metadata for {path.name}") from error
    streams = payload.get("streams")
    if not isinstance(streams, list) or not streams or streams[0].get("codec_type") != "audio":
        raise ValueError(f"downloaded file has no audio stream: {path.name}")


def validate_download(ffprobe: Path, path: Path) -> dict[str, Any]:
    if not is_m4a(path):
        raise ValueError(f"downloaded file is not a valid M4A: {path.name}")
    probe_audio(ffprobe, path)
    return {"file": path.name, "bytes": path.stat().st_size, "sha256": sha256_file(path)}


def run_download(
    yt_dlp: Path,
    ffmpeg_dir: Path,
    cookies: Path,
    url: str,
    part: int,
    kind: str,
    output_template: Path,
    timeout_seconds: int,
    retries: int,
) -> int:
    command = [
        str(yt_dlp), "--ignore-config", "--no-playlist", "--cookies", str(cookies),
        "--format", "bestaudio/best", "--extract-audio", "--audio-format", "m4a",
        "--audio-quality", "0", "--ffmpeg-location", str(ffmpeg_dir),
        "--output", str(output_template), "--retries", str(retries),
        "--fragment-retries", str(retries), "--newline", download_page_url(url, part, kind),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout_seconds, check=False)
    except subprocess.TimeoutExpired:
        return 124
    except OSError as error:
        raise RuntimeError("could not start yt-dlp") from error
    # Never print yt-dlp output: it can contain signed media URLs or cookie-derived data.
    return int(result.returncode)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--curated", default="data/xiaosonglu/_curated_2026-09-08.json")
    parser.add_argument("--segments", default="data/xiaosonglu/replay_song_segments.json")
    parser.add_argument("--cuts", default="data/xiaosonglu/song_cut_index.json")
    parser.add_argument("--source-dir", default="", help="Source directory (default: assets/audio/source/<live identity>)")
    parser.add_argument("--cookies-file", default=os.environ.get("XSL_BILIBILI_COOKIE_FILE", ""))
    parser.add_argument("--yt-dlp", default="tools/yt-dlp/yt-dlp.exe")
    parser.add_argument("--ffmpeg-dir", default="tools/ffmpeg")
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--yt-dlp-retries", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.attempts <= 8 or not 1 <= args.yt_dlp_retries <= 10 or not 60 <= args.timeout_seconds <= 7200:
        raise ValueError("attempts/retries/timeout are outside the permitted range")

    root = Path(args.root).resolve()
    curated_path = path_inside(root, (root / args.curated).resolve(), "--curated")
    segments_path = path_inside(root, (root / args.segments).resolve(), "--segments")
    cuts_path = path_inside(root, (root / args.cuts).resolve(), "--cuts")
    curated_preview = json.loads(curated_path.read_text(encoding="utf-8"))
    preview_live = curated_preview.get("live") if isinstance(curated_preview.get("live"), dict) else {}
    source_identity = str(preview_live.get("replayId") or preview_live.get("replay_id") or preview_live.get("liveId") or "").strip()
    safe_source_identity = re.sub(r"[^A-Za-z0-9._-]", "_", source_identity).strip("_")
    if not safe_source_identity:
        raise ValueError("curated live must contain an identity suitable for an isolated source directory")
    source_relative = args.source_dir or f"assets/audio/source/{safe_source_identity}"
    source_dir = path_inside(root, (root / source_relative).resolve(), "--source-dir")
    yt_dlp = path_inside(root, (root / args.yt_dlp).resolve(), "--yt-dlp")
    ffmpeg_dir = path_inside(root, (root / args.ffmpeg_dir).resolve(), "--ffmpeg-dir")
    ffprobe = ffmpeg_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    cookies = Path(args.cookies_file).expanduser().resolve() if args.cookies_file else None

    segments_document = json.loads(segments_path.read_text(encoding="utf-8"))
    existing_segments = segments_document.get("segments")
    if not isinstance(existing_segments, list):
        raise ValueError("replay_song_segments.json must contain a segments list")
    cuts_document = json.loads(cuts_path.read_text(encoding="utf-8"))
    existing_cuts = cuts_document.get("items")
    if not isinstance(existing_cuts, list):
        raise ValueError("song_cut_index.json must contain an items list")
    songs = read_curated(curated_path, existing_segments, existing_cuts)
    if source_dir.exists() and source_dir.is_symlink():
        raise ValueError("source directory must not be a symlink")
    if not source_dir.exists() and not args.dry_run:
        source_dir.mkdir(parents=True, exist_ok=True)
    provenance_path = source_dir / "_source_manifest.json"
    if provenance_path.is_symlink():
        raise ValueError("source provenance manifest must not be a symlink")
    if provenance_path.is_file():
        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
        if provenance.get("schemaVersion") != 1 or not isinstance(provenance.get("items"), dict):
            raise ValueError("source provenance manifest is invalid")
    else:
        provenance = {"schemaVersion": 1, "updatedAt": "", "items": {}}
    provenance_items = provenance["items"]
    if not args.dry_run:
        if cookies is None or not cookies.is_file() or cookies.is_dir():
            raise ValueError("an external --cookies-file (or XSL_BILIBILI_COOKIE_FILE) is required")
        try:
            cookies.relative_to(root)
        except ValueError:
            pass
        else:
            raise ValueError("cookie file must stay outside the workspace")
        if not yt_dlp.is_file() or yt_dlp.is_symlink():
            raise ValueError("yt-dlp executable is missing or unsafe")
        if not ffprobe.is_file() or ffprobe.is_symlink():
            raise ValueError("ffprobe executable is missing or unsafe")

    downloaded: list[dict[str, Any]] = []
    existing: list[dict[str, Any]] = []
    plan: list[dict[str, Any]] = []
    for item in songs:
        part = item["part"]
        matches = part_files(source_dir, part)
        if len(matches) > 1:
            raise ValueError(f"multiple M4A files found for source part {part}")
        source_identity = download_source_identity(item["url"], part, item["kind"])
        provenance_entry = provenance_items.get(str(part))
        if matches:
            candidate = matches[0]
            candidate_hash = sha256_file(candidate)
            candidate_bytes = candidate.stat().st_size
            expected_audio_matches = (
                item["audioAction"] != "replace-existing"
                or (candidate_hash == item["audioSha256"] and candidate_bytes == item["audioBytes"])
            )
            provenance_matches = (
                isinstance(provenance_entry, dict)
                and provenance_entry.get("sourceIdentity") == source_identity
                and provenance_entry.get("songKey") == normalize_song_name(item["song"])
                and provenance_entry.get("file") == candidate.name
                and provenance_entry.get("sha256") == candidate_hash
                and expected_audio_matches
                and is_m4a(candidate)
            )
            if args.dry_run:
                action = "existing" if provenance_matches else "refresh-stale-source"
                if provenance_matches:
                    existing.append({"part": part, "song": item["song"], "file": candidate.name})
                plan.append({
                    "part": part,
                    "action": action,
                    "file": candidate.name,
                    "kind": item["kind"],
                    "sourceIdentity": source_identity,
                    "downloadUrl": download_page_url(item["url"], part, item["kind"]),
                })
                continue
            if not provenance_matches:
                stale_path = candidate.with_name(f"{candidate.name}.stale-{int(time.time())}-{os.getpid()}")
                candidate.replace(stale_path)
                provenance_items.pop(str(part), None)
                matches = []
            else:
                try:
                    metadata = validate_download(ffprobe, candidate)
                except ValueError:
                    bad_path = candidate.with_name(f"{candidate.name}.invalid-{int(time.time())}-{os.getpid()}")
                    candidate.replace(bad_path)
                    provenance_items.pop(str(part), None)
                    matches = []
                else:
                    existing.append({"part": part, "song": item["song"], **metadata})
                    plan.append({"part": part, "action": "existing", "file": candidate.name})
                    continue
        prefix = f"{part:02d}" if part < 100 else str(part)
        output_template = source_dir / f"{prefix}_%(title)s.%(ext)s"
        plan.append({
            "part": part,
            "action": "download",
            "kind": item["kind"],
            "url": item["url"],
            "downloadUrl": download_page_url(item["url"], part, item["kind"]),
        })
        if args.dry_run:
            continue
        last_code = 1
        for attempt in range(1, args.attempts + 1):
            last_code = run_download(yt_dlp, ffmpeg_dir, cookies, item["url"], part, item["kind"], output_template, args.timeout_seconds, args.yt_dlp_retries)
            matches = part_files(source_dir, part)
            if len(matches) == 1:
                try:
                    metadata = validate_download(ffprobe, matches[0])
                    if item["audioAction"] == "replace-existing" and (
                        metadata["sha256"] != item["audioSha256"] or metadata["bytes"] != item["audioBytes"]
                    ):
                        raise ValueError(f"downloaded replacement does not match reviewed hash/size for part {part}")
                    downloaded.append({"part": part, "song": item["song"], **metadata})
                    provenance_items[str(part)] = {
                        "part": part,
                        "song": item["song"],
                        "songKey": normalize_song_name(item["song"]),
                        "kind": item["kind"],
                        "sourceIdentity": source_identity,
                        "file": matches[0].name,
                        "bytes": metadata["bytes"],
                        "sha256": metadata["sha256"],
                        "downloadedAt": utc_now(),
                    }
                    provenance["updatedAt"] = utc_now()
                    write_json_atomic(provenance_path, provenance)
                    break
                except ValueError:
                    # Keep a resumable .part file, but reject an invalid completed output.
                    try:
                        matches[0].unlink()
                    except FileNotFoundError:
                        pass
            if attempt < args.attempts:
                time.sleep(min(60, 5 * (2 ** (attempt - 1))))
        else:
            raise RuntimeError(f"song-cut download failed for part {part} (exit code {last_code})")

    print(json.dumps({
        "ok": True,
        "changed": bool(downloaded),
        "curatedCount": len(songs),
        "downloaded": downloaded,
        "existing": existing,
        "plan": plan if args.dry_run else None,
        "finishedAt": utc_now(),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
