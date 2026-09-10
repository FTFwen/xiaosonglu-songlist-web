#!/usr/bin/env python3
"""Validate downloaded song-cut audio and add one asset per unique curated song."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
import unicodedata
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

M4A_RE = re.compile(r"^(\d+)_.*\.m4a$", re.IGNORECASE)
ASSET_RE = re.compile(r"^assets/audio/song_(\d+)\.m4a$")
BILIBILI_HOSTS = {"www.bilibili.com", "bilibili.com", "m.bilibili.com"}
CUT_KINDS = {"single", "collection", "collection-chapter", "compilation"}
MULTIPART_CUT_KINDS = {"collection", "collection-chapter"}


def normalize(value: object) -> str:
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


def cut_url_for_item(item: dict[str, object]) -> object:
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


def download_source_identity(url: object, part: int, kind: str) -> str:
    parsed = urllib.parse.urlsplit(str(url or "").strip())
    query = urllib.parse.urlencode({"p": part}) if kind in MULTIPART_CUT_KINDS else ""
    page_url = urllib.parse.urlunsplit(parsed._replace(query=query, fragment=""))
    base = normalized_review_url(page_url)
    return base + (f"?{query}" if query else "")


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


def confirmed_same_name_review(item: dict[str, object], source_urls: set[str]) -> bool:
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


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_m4a(path: Path) -> bool:
    with path.open("rb") as handle:
        header = handle.read(12)
    return len(header) >= 12 and header[4:8] == b"ftyp"


def atomic_json(path: Path, value: object) -> None:
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temp, path)


def path_inside(root: Path, candidate: Path, label: str) -> Path:
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label} must stay inside the workspace root") from error
    return candidate


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--curated", default="data/xiaosonglu/_curated_2026-09-08.json")
    parser.add_argument("--source-dir", default="", help="Source directory (default: assets/audio/source/<live identity>)")
    parser.add_argument("--audio-index", default="data/xiaosonglu/audio_index.json")
    parser.add_argument("--audio-baseline", default="data/xiaosonglu/audio_asset_baseline.json")
    parser.add_argument("--segments", default="data/xiaosonglu/replay_song_segments.json")
    parser.add_argument("--cuts", default="data/xiaosonglu/song_cut_index.json")
    parser.add_argument("--reviewed-source-spec", action="append", default=[], metavar="PART|BYTES|SHA256|SOURCE_IDENTITY", help="Explicit provenance for an externally prepared source file (repeatable)")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    curated_path = path_inside(root, (root / args.curated).resolve(), "--curated")
    curated = json.loads(curated_path.read_text(encoding="utf-8"))
    preview_live = curated.get("live") if isinstance(curated.get("live"), dict) else {}
    source_identity = str(preview_live.get("replayId") or preview_live.get("replay_id") or preview_live.get("liveId") or "").strip()
    safe_source_identity = re.sub(r"[^A-Za-z0-9._-]", "_", source_identity).strip("_")
    if not safe_source_identity:
        raise ValueError("curated live must contain an identity suitable for an isolated source directory")
    source_relative = args.source_dir or f"assets/audio/source/{safe_source_identity}"
    source_dir = path_inside(root, (root / source_relative).resolve(), "--source-dir")
    index_path = path_inside(root, (root / args.audio_index).resolve(), "--audio-index")
    baseline_path = path_inside(root, (root / args.audio_baseline).resolve(), "--audio-baseline")
    segments_path = path_inside(root, (root / args.segments).resolve(), "--segments")
    cuts_path = path_inside(root, (root / args.cuts).resolve(), "--cuts")
    songs = curated.get("songs")
    if not isinstance(songs, list) or not songs:
        raise ValueError("curated batch must contain at least one song")
    live = curated.get("live") if isinstance(curated.get("live"), dict) else {}
    live_date = str(live.get("date") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", live_date):
        raise ValueError("curated live.date must be YYYY-MM-DD")
    live_identity = str(live.get("replayId") or live.get("replay_id") or live.get("liveId") or "").strip()
    if not live_identity:
        raise ValueError("curated live must contain a stable liveId or replayId")
    live_id = str(live.get("replayId") or live.get("replay_id") or f"live:{live.get('liveId')}")
    segments_document = json.loads(segments_path.read_text(encoding="utf-8"))
    existing_segments = segments_document.get("segments")
    if not isinstance(existing_segments, list):
        raise ValueError("replay_song_segments.json must contain a segments list")
    cuts_document = json.loads(cuts_path.read_text(encoding="utf-8"))
    existing_cuts = cuts_document.get("items")
    if not isinstance(existing_cuts, list):
        raise ValueError("song_cut_index.json must contain an items list")
    superseded_segments: dict[tuple[str, int], dict[str, str]] = {}
    for position, song in enumerate(songs, start=1):
        if not isinstance(song, dict):
            continue
        fact_action = str(song.get("factAction") or song.get("fact_action") or "keep-existing").strip().casefold()
        if fact_action not in {"keep-existing", "replace-existing-segment"}:
            raise ValueError(f"curated song has unsupported factAction: {fact_action}")
        if fact_action == "replace-existing-segment":
            raw_target_part = song.get("segmentIndex") if song.get("segmentIndex") is not None else song.get("segment_index")
            target_part = parse_positive_integer(raw_target_part, "replace-existing-segment segmentIndex")
            previous_name = normalize(song.get("previousSongName") or song.get("previous_song_name"))
            desired_name = normalize(song.get("songName") or song.get("song_name"))
            previous_bvid = str(song.get("previousCutBvid") or song.get("previous_cut_bvid") or "").strip()
            reason = str(song.get("factReplacementReason") or song.get("fact_replacement_reason") or "").strip()
            replacement_cut = song.get("cut")
            replacement_cut_url = (replacement_cut.get("url") or replacement_cut.get("clip_url")) if isinstance(replacement_cut, dict) else ""
            replacement_cut_match = re.search(r"/video/(BV[0-9A-Za-z]+)", str(replacement_cut_url), flags=re.IGNORECASE)
            declared_replacement_bvid = str(replacement_cut.get("bvid") or replacement_cut.get("clip_bvid") or "").strip() if isinstance(replacement_cut, dict) else ""
            if not previous_name or not desired_name or not reason or not re.fullmatch(r"BV[0-9A-Za-z]+", previous_bvid):
                raise ValueError("replace-existing-segment requires reason, previousSongName, previousCutBvid, and positive segmentIndex")
            if not replacement_cut_match or not declared_replacement_bvid or declared_replacement_bvid.casefold() != replacement_cut_match.group(1).casefold():
                raise ValueError("replace-existing-segment requires cut.bvid matching its Bilibili video URL")
            superseded_segments[(live_id, target_part)] = {"previous": previous_name, "desired": desired_name, "bvid": previous_bvid.casefold()}
    for coordinate, spec in superseded_segments.items():
        matches = [segment for segment in existing_segments if isinstance(segment, dict) and str(segment.get("replay_id") or "") == coordinate[0] and parse_positive_integer(segment.get("segment_index"), "existing segment_index") == coordinate[1]]
        if len(matches) != 1:
            raise ValueError(f"replace-existing-segment requires exactly one fact at {coordinate[0]} segment {coordinate[1]}")
        current_name = normalize(matches[0].get("song_name"))
        if current_name == spec["previous"]:
            cut_match = re.search(r"/video/(BV[0-9A-Za-z]+)", str(matches[0].get("cut_link") or ""), flags=re.IGNORECASE)
            matching_cut_rows = [cut for cut in existing_cuts if isinstance(cut, dict) and str(cut.get("clip_date") or "") == live_date and normalize(cut.get("song_name")) == spec["previous"] and str(cut.get("clip_bvid") or "").casefold() == spec["bvid"]]
            if not cut_match or cut_match.group(1).casefold() != spec["bvid"] or len(matching_cut_rows) != 1:
                raise ValueError("replace-existing-segment previousCutBvid must exactly match the stale segment and cut ledger")
        elif current_name != spec["desired"]:
            raise ValueError("replace-existing-segment target has an unexpected song name")
    existing_by_name: dict[str, list[dict[str, object]]] = {}
    source_urls_by_name: dict[str, set[str]] = {}
    for segment in existing_segments:
        if not isinstance(segment, dict) or str(segment.get("replay_date") or "").strip() != live_date:
            continue
        spec = superseded_segments.get((str(segment.get("replay_id") or ""), int(segment.get("segment_index") or 0)))
        if spec and normalize(segment.get("song_name")) == spec["previous"]:
            continue
        key = normalize(segment.get("song_name"))
        if not key:
            continue
        existing_by_name.setdefault(key, []).append(segment)
        source_url = normalized_review_url(segment.get("cut_link"))
        if source_url:
            source_urls_by_name.setdefault(key, set()).add(source_url)

    for song in songs:
        if not isinstance(song, dict):
            continue
        name_key = normalize(song.get("songName") or song.get("song_name"))
        source_url = normalized_review_url(cut_url_for_item(song))
        if name_key and source_url:
            source_urls_by_name.setdefault(name_key, set()).add(source_url)

    normalized_songs = []
    expected_parts = set()
    curated_names = set()
    for song in songs:
        if not isinstance(song, dict):
            raise ValueError("each curated song must be an object")
        raw_part = song.get("segmentIndex") if song.get("segmentIndex") is not None else song.get("segment_index")
        part = parse_positive_integer(len(normalized_songs) + 1 if raw_part is None else raw_part, "each curated song segmentIndex")
        name = str(song.get("songName") or song.get("song_name") or "").strip()
        if part <= 0 or not name:
            raise ValueError("each curated song needs a positive segmentIndex and songName")
        if part in expected_parts:
            raise ValueError(f"duplicate curated segmentIndex {part}")
        name_key = normalize(name)
        cut = song.get("cut")
        if not isinstance(cut, dict):
            raise ValueError(f"curated segment {part} must use a nested cut object")
        cut_kind = str(cut.get("kind") or cut.get("clip_kind") or "").strip().casefold()
        if cut_kind not in CUT_KINDS:
            raise ValueError(f"curated segment {part} has unsupported or missing cut kind: {cut_kind}")
        cut_url = cut.get("url") or cut.get("clip_url")
        if not trusted_same_name_evidence_url(cut_url):
            raise ValueError(f"curated segment {part} must use a canonical HTTPS Bilibili video URL")
        parsed_cut_url = urllib.parse.urlsplit(str(cut_url))
        cut_url_bvid = re.fullmatch(r"/video/(BV[0-9A-Za-z]+)/?", parsed_cut_url.path, flags=re.IGNORECASE).group(1)
        current_source = normalized_review_url(cut_url)
        source_urls = set(source_urls_by_name.get(name_key, set()))
        if current_source:
            source_urls.add(current_source)
        existing = existing_by_name.get(name_key, [])
        idempotent = any(
            str(segment.get("segment_index") or "") == str(part)
            and str(segment.get("replay_id") or "") == live_id
            for segment in existing
        )
        needs_review = name_key in curated_names or (bool(existing) and not idempotent)
        if needs_review and not confirmed_same_name_review(song, source_urls):
            raise ValueError(
                f"curated segment {part} repeats {name!r} without a confirmed sameNameReview backed by "
                "an independent Bilibili video URL; recheck the song using another uploader or a direct "
                "Bilibili search before ingestion"
            )
        audio_action = str(song.get("audioAction") or song.get("audio_action") or "keep-existing").strip().casefold()
        if song.get("replaceExistingAudio") is True:
            audio_action = "replace-existing"
        if audio_action not in {"keep-existing", "replace-existing"}:
            raise ValueError(f"curated segment {part} has unsupported audioAction: {audio_action}")
        replacement_reason = str(song.get("audioReplacementReason") or song.get("audio_replacement_reason") or "").strip()
        expected_audio_hash = str(song.get("audioSha256") or song.get("audio_sha256") or "").strip().casefold()
        raw_audio_bytes = song.get("audioBytes") if song.get("audioBytes") is not None else song.get("audio_bytes")
        expected_audio_bytes = parse_positive_integer(raw_audio_bytes, f"curated segment {part} audioBytes") if audio_action == "replace-existing" else 0
        audio_target = str(song.get("audioTarget") or song.get("audio_target") or "").strip().split("?", 1)[0]
        previous_song_name = str(song.get("audioPreviousSongName") or song.get("audio_previous_song_name") or "").strip()
        if audio_action == "replace-existing":
            declared_bvid = str(cut.get("bvid") or cut.get("clip_bvid") or "").strip()
            if not declared_bvid or declared_bvid.casefold() != cut_url_bvid.casefold():
                raise ValueError(f"curated segment {part} replace-existing requires cut.bvid matching its URL")
            if not replacement_reason:
                raise ValueError(f"curated segment {part} requires audioReplacementReason for replace-existing")
            if not re.fullmatch(r"[0-9a-f]{64}", expected_audio_hash) or expected_audio_bytes <= 0:
                raise ValueError(f"curated segment {part} replace-existing requires reviewed audioSha256 and audioBytes")
            if not ASSET_RE.fullmatch(audio_target):
                raise ValueError(f"curated segment {part} replace-existing requires a safe explicit audioTarget")
        curated_names.add(name_key)
        source_urls_by_name[name_key] = source_urls
        expected_parts.add(part)
        normalized_songs.append((part, name, audio_action, replacement_reason, expected_audio_hash, expected_audio_bytes, audio_target, previous_song_name, cut_kind, str(cut_url)))

    if not source_dir.is_dir() or source_dir.is_symlink():
        raise ValueError(f"source directory is missing or unsafe: {source_dir}")
    source_files = {}
    for path in source_dir.iterdir():
        if not path.is_file() or path.is_symlink():
            continue
        match = M4A_RE.fullmatch(path.name)
        if match:
            part = int(match.group(1))
            if part in source_files:
                raise ValueError(f"duplicate source part {part}")
            source_files[part] = path
    if set(source_files) != expected_parts:
        raise ValueError(
            f"source parts do not match curated segments: expected {sorted(expected_parts)}, found {sorted(source_files)}"
        )
    for part, path in source_files.items():
        if path.stat().st_size <= 0 or not is_m4a(path):
            raise ValueError(f"invalid M4A source part {part}: {path.name}")

    provenance_path = source_dir / "_source_manifest.json"
    provenance_items = {}
    if provenance_path.is_symlink():
        raise ValueError("source provenance manifest must not be a symlink")
    if provenance_path.is_file():
        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
        if provenance.get("schemaVersion") != 1 or not isinstance(provenance.get("items"), dict):
            raise ValueError("source provenance manifest is invalid")
        provenance_items = provenance["items"]
    reviewed_source_specs: dict[int, dict[str, object]] = {}
    for raw_spec in args.reviewed_source_spec:
        pieces = str(raw_spec).split("|", 3)
        if len(pieces) != 4:
            raise ValueError("--reviewed-source-spec must be PART|BYTES|SHA256|SOURCE_IDENTITY")
        part = parse_positive_integer(pieces[0], "reviewed source PART")
        size = parse_positive_integer(pieces[1], "reviewed source BYTES")
        digest = pieces[2].strip().casefold()
        if not re.fullmatch(r"[0-9a-f]{64}", digest) or not pieces[3].strip():
            raise ValueError("--reviewed-source-spec requires full SHA256 and SOURCE_IDENTITY")
        reviewed_source_specs[part] = {"bytes": size, "sha256": digest, "sourceIdentity": pieces[3].strip()}
    for part, name, _, _, _, _, _, _, cut_kind, cut_url in normalized_songs:
        source = source_files[part]
        source_hash = sha256(source)
        source_identity = download_source_identity(cut_url, part, cut_kind)
        entry = provenance_items.get(str(part))
        if isinstance(entry, dict):
            valid = (
                entry.get("sourceIdentity") == source_identity
                and entry.get("songKey") == normalize(name)
                and entry.get("file") == source.name
                and entry.get("bytes") == source.stat().st_size
                and entry.get("sha256") == source_hash
            )
        else:
            spec = reviewed_source_specs.get(part)
            valid = bool(spec) and spec.get("sourceIdentity") == source_identity and spec.get("bytes") == source.stat().st_size and spec.get("sha256") == source_hash
        if not valid:
            raise ValueError(f"source part {part} lacks matching URL-bound provenance; redownload it or pass a reviewed source spec")

    index = json.loads(index_path.read_text(encoding="utf-8"))
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    baseline_files = baseline.get("files")
    if not isinstance(baseline_files, dict):
        raise ValueError("audio baseline must contain a files object")
    audios = index.get("audios")
    if not isinstance(audios, dict):
        raise ValueError("audio_index.json audios must be an object")
    raw_verification_targets = index.get("verificationTargets", [])
    if not isinstance(raw_verification_targets, list) or not all(isinstance(item, str) and item.strip() for item in raw_verification_targets):
        raise ValueError("audio_index.json verificationTargets must be a string list")
    verification_targets = list(dict.fromkeys(item.strip() for item in raw_verification_targets))
    if any(name not in audios for name in verification_targets):
        raise ValueError("audio_index.json contains an unmapped verificationTargets entry")
    used_paths = set(str(value).split("?", 1)[0] for value in audios.values())
    used_numbers = [int(match.group(1)) for value in used_paths if (match := ASSET_RE.fullmatch(value))]
    next_number = max(used_numbers or [0]) + 1
    existing_name_by_key = {normalize(name): name for name in audios}
    copied = []
    replaced = []
    recovered = []
    skipped_duplicate = []
    created_targets = []
    replacement_backups = []
    changed = False
    try:
        for part, name, audio_action, replacement_reason, expected_audio_hash, expected_audio_bytes, audio_target, previous_song_name, cut_kind, cut_url in sorted(normalized_songs):
            key = normalize(name)
            source = source_files[part]
            source_hash = sha256(source)
            if audio_action == "replace-existing" and (source_hash != expected_audio_hash or source.stat().st_size != expected_audio_bytes):
                raise ValueError(f"curated replacement source does not match reviewed hash/size for segment {part}")
            if audio_action == "replace-existing":
                target_rel = audio_target
                target = path_inside(root, (root / target_rel).resolve(), "replacement audio target")
                if target.is_symlink():
                    raise ValueError(f"replacement audio target is unsafe: {target_rel}")
                owners = [owner for owner, value in audios.items() if str(value).split("?", 1)[0] == target_rel]
                if len(owners) > 1:
                    raise ValueError(f"replacement audio target has multiple index owners: {target_rel}")
                owner = owners[0] if owners else ""
                existing_name = existing_name_by_key.get(key, "")
                if existing_name and str(audios[existing_name]).split("?", 1)[0] != target_rel:
                    raise ValueError(f"replace-existing target does not match the indexed target for {name!r}")
                if owner and normalize(owner) != key and normalize(previous_song_name) != normalize(owner):
                    raise ValueError(f"replacement target {target_rel} belongs to {owner!r}; audioPreviousSongName must confirm reassignment")
                if target.is_file() and not owner and (
                    target.stat().st_size != expected_audio_bytes or sha256(target) != expected_audio_hash
                ):
                    raise ValueError(f"ownerless replacement target does not match reviewed hash/size: {target_rel}")
                old_hash = ""
                status = "created-target"
                if target.is_file():
                    old_hash = sha256(target)
                    if old_hash == source_hash:
                        status = "already-current"
                    else:
                        backup = target.with_name(f".{target.name}.{os.getpid()}.backup")
                        temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
                        if backup.exists() or backup.is_symlink() or temporary.exists() or temporary.is_symlink():
                            raise ValueError(f"replacement temporary file already exists for {target_rel}")
                        shutil.copy2(target, backup)
                        replacement_backups.append((target, backup))
                        try:
                            shutil.copy2(source, temporary)
                            if temporary.stat().st_size != source.stat().st_size or not is_m4a(temporary) or sha256(temporary) != source_hash:
                                raise ValueError(f"replacement audio failed hash/size validation: {target_rel}")
                            os.replace(temporary, target)
                        finally:
                            if temporary.is_file():
                                temporary.unlink()
                        status = "replaced"
                        changed = True
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
                    if temporary.exists() or temporary.is_symlink():
                        raise ValueError(f"replacement temporary file already exists for {target_rel}")
                    try:
                        shutil.copy2(source, temporary)
                        if temporary.stat().st_size != source.stat().st_size or not is_m4a(temporary):
                            raise ValueError(f"replacement audio failed validation: {target_rel}")
                        os.replace(temporary, target)
                    finally:
                        if temporary.is_file():
                            temporary.unlink()
                    created_targets.append(target)
                    changed = True
                final_target_hash = sha256(target)
                if target.stat().st_size != source.stat().st_size or final_target_hash != source_hash or not is_m4a(target):
                    raise ValueError(f"replacement target changed during verification: {target_rel}")
                if owner and normalize(owner) != key:
                    del audios[owner]
                    existing_name_by_key.pop(normalize(owner), None)
                    verification_targets = [item for item in verification_targets if normalize(item) != normalize(owner)]
                    changed = True
                index_name = existing_name or name
                versioned_target_rel = f"{target_rel}?v={final_target_hash[:12]}"
                if str(audios.get(index_name, "")) != versioned_target_rel:
                    audios[index_name] = versioned_target_rel
                    changed = True
                existing_name_by_key[key] = index_name
                used_paths.add(target_rel)
                if index_name not in verification_targets:
                    verification_targets.append(index_name)
                    changed = True
                replaced.append({
                    "part": part, "song": name, "source": source.name, "target": versioned_target_rel,
                    "status": status, "reason": replacement_reason, "beforeSha256": old_hash,
                    "sha256": final_target_hash, "bytes": target.stat().st_size,
                })
                continue
            if key in existing_name_by_key:
                existing_name = existing_name_by_key[key]
                mapped_value = str(audios[existing_name])
                target_rel = mapped_value.split("?", 1)[0]
                if target_rel not in baseline_files:
                    expected_mapping = f"{target_rel}?v={source_hash[:12]}"
                    target = path_inside(root, (root / target_rel).resolve(), "recovery audio target")
                    if mapped_value != expected_mapping or target.is_symlink() or not target.is_file() or not is_m4a(target):
                        raise ValueError(f"baseline-missing indexed target is not safely recoverable: {target_rel}")
                    if target.stat().st_size != source.stat().st_size or sha256(target) != source_hash:
                        raise ValueError(f"baseline-missing indexed target differs from its reviewed source: {target_rel}")
                    recovered.append({
                        "part": part, "song": name, "source": source.name, "target": mapped_value,
                        "bytes": target.stat().st_size, "sha256": source_hash,
                    })
                else:
                    skipped_duplicate.append({
                        "part": part, "song": name, "source": source.name,
                        "target": mapped_value,
                    })
                continue
            while f"assets/audio/song_{next_number}.m4a" in used_paths:
                next_number += 1
            target_rel = f"assets/audio/song_{next_number}.m4a"
            target = path_inside(root, (root / target_rel).resolve(), "audio target")
            if target.is_symlink():
                raise ValueError(f"target is unsafe: {target_rel}")
            target.parent.mkdir(parents=True, exist_ok=True)
            recovered_orphan = False
            if target.exists():
                if not target.is_file() or not is_m4a(target) or target.stat().st_size != source.stat().st_size or sha256(target) != source_hash:
                    raise ValueError(f"ownerless target does not match the reviewed source: {target_rel}")
                recovered_orphan = True
            else:
                temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
                if temporary.exists() or temporary.is_symlink():
                    raise ValueError(f"temporary target already exists or is unsafe: {temporary.name}")
                try:
                    shutil.copy2(source, temporary)
                    if temporary.stat().st_size != source.stat().st_size or not is_m4a(temporary) or sha256(temporary) != source_hash:
                        raise ValueError(f"copied audio failed hash/size validation: {target_rel}")
                    os.replace(temporary, target)
                finally:
                    if temporary.is_file():
                        temporary.unlink()
                created_targets.append(target)
            final_target_hash = sha256(target)
            if target.stat().st_size != source.stat().st_size or final_target_hash != source_hash or not is_m4a(target):
                raise ValueError(f"audio target changed during verification: {target_rel}")
            versioned_target_rel = f"{target_rel}?v={final_target_hash[:12]}"
            audios[name] = versioned_target_rel
            used_paths.add(target_rel)
            existing_name_by_key[key] = name
            result_item = {"part": part, "song": name, "source": source.name, "target": versioned_target_rel, "bytes": target.stat().st_size, "sha256": final_target_hash}
            (recovered if recovered_orphan else copied).append(result_item)
            changed = True
            next_number += 1
        if changed:
            index["count"] = len(audios)
            index["verificationTargets"] = verification_targets
            index["generatedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            atomic_json(index_path, index)
    except Exception:
        for target in created_targets:
            try:
                target.unlink()
            except FileNotFoundError:
                pass
        for target, backup in reversed(replacement_backups):
            if backup.is_file():
                os.replace(backup, target)
        raise
    else:
        for _, backup in replacement_backups:
            try:
                backup.unlink()
            except FileNotFoundError:
                pass
    print(json.dumps({"ok": True, "changed": changed, "sourceCount": len(source_files), "curatedCount": len(normalized_songs), "copied": copied, "replaced": replaced, "recovered": recovered, "skippedDuplicate": skipped_duplicate, "audioCount": len(audios)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
