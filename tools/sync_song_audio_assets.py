#!/usr/bin/env python3
"""Materialize ignored song audio assets without downloading an existing file twice.

The audio catalog is tracked, while assets/audio/ intentionally is not. This helper
copies only missing files from a known-good deployed site, resumes .part downloads,
and records local sizes/hashes in an ignored manifest for later runs.
"""
from __future__ import annotations

import argparse
import atexit
import concurrent.futures
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

USER_AGENT = "xiaosonglu-audio-baseline/1.0"
AUDIO_PATH_RE = re.compile(r"^assets/audio/[A-Za-z0-9][A-Za-z0-9._-]*\.m4a$")
MAX_AUDIO_BYTES = 25 * 1024 * 1024


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_limited(response: Any, handle: Any, byte_limit: int) -> None:
    copied = 0
    while True:
        chunk = response.read(min(1024 * 1024, byte_limit - copied + 1))
        if not chunk:
            return
        copied += len(chunk)
        if copied > byte_limit:
            raise RuntimeError("Audio response exceeds the permitted size")
        handle.write(chunk)


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name("{}.{}.tmp".format(path.name, os.getpid()))
    if temporary.is_symlink():
        raise ValueError("Refusing symlink manifest temporary file: {}".format(temporary))
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(str(temporary), str(path))
    finally:
        if temporary.is_file():
            temporary.unlink()


def acquire_lock(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(2):
        try:
            descriptor = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(descriptor, json.dumps({"pid": os.getpid(), "startedAt": utc_now()}).encode("utf-8"))
            return descriptor
        except FileExistsError:
            if path.is_symlink():
                raise ValueError("Refusing symlink audio sync lock: {}".format(path))
            stale = path.is_file() and time.time() - path.stat().st_mtime > 6 * 60 * 60
            if attempt == 0 and stale:
                path.unlink()
                continue
            raise RuntimeError("Another audio baseline sync is already running: {}".format(path))
    raise RuntimeError("Could not acquire audio sync lock: {}".format(path))


def release_lock(path: Path, descriptor: int) -> None:
    try:
        os.close(descriptor)
    finally:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def safe_target(root: Path, relative: str) -> Path:
    if "\\" in relative or not AUDIO_PATH_RE.fullmatch(relative):
        raise ValueError("Unsafe audio path in audio_index.json: {}".format(relative))
    raw_audio_root = root / "assets" / "audio"
    if raw_audio_root.is_symlink():
        raise ValueError("assets/audio must not be a symlink")
    audio_root = raw_audio_root.resolve()
    target = root / relative
    if target.is_symlink():
        raise ValueError("Audio target must not be a symlink: {}".format(relative))
    resolved = target.resolve()
    if audio_root != resolved.parent and audio_root not in resolved.parents:
        raise ValueError("Audio path escapes assets/audio: {}".format(relative))
    return resolved


def load_manifest(path: Path) -> Dict[str, Any]:
    try:
        value = read_json(path)
        if isinstance(value, dict) and isinstance(value.get("files"), dict):
            return value
    except FileNotFoundError:
        pass
    return {"schemaVersion": 1, "files": {}}


def has_m4a_signature(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            header = handle.read(12)
        return len(header) >= 12 and header[4:8] == b"ftyp"
    except OSError:
        return False


def download_one(root: Path, source_base: str, relative: str, old_entry: Dict[str, Any]) -> Dict[str, Any]:
    target = safe_target(root, relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    expected_size = int(old_entry.get("bytes") or 0)
    expected_hash = str(old_entry.get("sha256") or "")
    if target.is_file() and target.stat().st_size > 0:
        info = target.stat()
        actual_hash = ""
        if expected_size and expected_hash:
            actual_hash = sha256_file(target)
            valid = expected_size == info.st_size and actual_hash == expected_hash and has_m4a_signature(target)
        else:
            actual_hash = sha256_file(target)
            valid = has_m4a_signature(target)
        if valid:
            return {
                "path": relative,
                "status": "existing",
                "bytes": info.st_size,
                "mtimeNs": info.st_mtime_ns,
                "sha256": actual_hash,
                "etag": old_entry.get("etag"),
                "lastModified": old_entry.get("lastModified"),
                "fetchedAt": old_entry.get("fetchedAt"),
            }
        target.unlink()

    part = target.with_name(target.name + ".part")
    if part.is_symlink():
        raise ValueError("Audio partial file must not be a symlink: {}".format(relative))
    resume_at = part.stat().st_size if part.is_file() else 0
    if resume_at and not expected_hash:
        part.unlink()
        resume_at = 0
    if expected_size and resume_at >= expected_size:
        complete_part = resume_at == expected_size and expected_hash and sha256_file(part) == expected_hash and has_m4a_signature(part)
        if complete_part:
            os.replace(str(part), str(target))
            info = target.stat()
            return {
                "path": relative,
                "status": "resumed",
                "bytes": info.st_size,
                "mtimeNs": info.st_mtime_ns,
                "sha256": expected_hash,
                "etag": old_entry.get("etag"),
                "lastModified": old_entry.get("lastModified"),
                "fetchedAt": utc_now(),
            }
        part.unlink()
        resume_at = 0
    url = urllib.parse.urljoin(source_base.rstrip("/") + "/", urllib.parse.quote(relative, safe="/"))
    headers = {"User-Agent": USER_AGENT, "Accept": "audio/*"}
    if resume_at:
        headers["Range"] = "bytes={}-".format(resume_at)
        if old_entry.get("etag"):
            headers["If-Range"] = str(old_entry["etag"])
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        response = urllib.request.urlopen(request, timeout=120)
    except urllib.error.HTTPError as error:
        if error.code == 416 and part.is_file() and expected_size == part.stat().st_size and expected_hash:
            part_hash = sha256_file(part)
            if part_hash == expected_hash and has_m4a_signature(part):
                os.replace(str(part), str(target))
                info = target.stat()
                return {
                    "path": relative,
                    "status": "resumed",
                    "bytes": info.st_size,
                    "mtimeNs": info.st_mtime_ns,
                    "sha256": part_hash,
                    "etag": old_entry.get("etag"),
                    "lastModified": old_entry.get("lastModified"),
                    "fetchedAt": utc_now(),
                }
        if error.code == 416 and part.is_file():
            part.unlink()
            return download_one(root, source_base, relative, old_entry)
        raise
    with response:
        status = getattr(response, "status", response.getcode())
        if status not in (200, 206):
            if part.is_file():
                part.unlink()
            raise RuntimeError("Unexpected HTTP {} for {}".format(status, relative))
        if status == 206 and resume_at == 0:
            if part.is_file():
                part.unlink()
            raise RuntimeError("Unsolicited partial response for {}".format(relative))
        append = resume_at > 0 and status == 206
        range_total = 0
        content_length = int(response.headers.get("Content-Length") or 0)
        if append:
            content_range = response.headers.get("Content-Range") or ""
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
            if not match:
                part.unlink()
                raise RuntimeError("Invalid Content-Range while resuming {}".format(relative))
            range_start, range_end, range_total = (int(value) for value in match.groups())
            range_length = range_end - range_start + 1
            if range_start != resume_at or range_end < range_start or range_end != range_total - 1:
                part.unlink()
                raise RuntimeError("Incomplete Content-Range while resuming {}".format(relative))
            if content_length and content_length != range_length:
                part.unlink()
                raise RuntimeError("Content-Length disagrees with Content-Range for {}".format(relative))
            if expected_size and range_total != expected_size:
                part.unlink()
                raise RuntimeError("Remote total size changed while resuming {}".format(relative))
        mode = "ab" if append else "wb"
        if not append:
            resume_at = 0
        expected_transfer_size = range_total if append else (content_length if content_length else 0)
        maximum_transfer = (expected_size - resume_at) if expected_size else (MAX_AUDIO_BYTES - resume_at)
        if maximum_transfer <= 0 or (content_length and content_length > maximum_transfer):
            if part.is_file():
                part.unlink()
            raise RuntimeError("Audio response size exceeds its trusted limit: {}".format(relative))
        try:
            with part.open(mode) as handle:
                copy_limited(response, handle, maximum_transfer)
        except Exception:
            if part.is_file():
                part.unlink()
            raise
        etag = response.headers.get("ETag")
        last_modified = response.headers.get("Last-Modified")
    if not part.is_file() or part.stat().st_size <= 0:
        if part.is_file():
            part.unlink()
        raise RuntimeError("Downloaded an empty audio file: {}".format(relative))
    if expected_transfer_size and part.stat().st_size != expected_transfer_size:
        actual_size = part.stat().st_size
        part.unlink()
        raise RuntimeError("Incomplete audio download for {}: expected {}, got {}".format(relative, expected_transfer_size, actual_size))
    if not has_m4a_signature(part):
        part.unlink()
        raise RuntimeError("Downloaded file is not an M4A container: {}".format(relative))
    downloaded_hash = sha256_file(part)
    if expected_size and part.stat().st_size != expected_size:
        actual_size = part.stat().st_size
        part.unlink()
        raise RuntimeError("Audio size changed for {}: expected {}, got {}".format(relative, expected_size, actual_size))
    if expected_hash and downloaded_hash != expected_hash:
        part.unlink()
        raise RuntimeError("Audio hash changed for {}".format(relative))
    os.replace(str(part), str(target))
    info = target.stat()
    return {
        "path": relative,
        "status": "resumed" if resume_at else "downloaded",
        "bytes": info.st_size,
        "mtimeNs": info.st_mtime_ns,
        "sha256": downloaded_hash,
        "etag": etag,
        "lastModified": last_modified,
        "fetchedAt": utc_now(),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="Repository root")
    parser.add_argument("--source-base", required=True, help="Known-good deployment base URL")
    parser.add_argument("--audio-index", default="data/xiaosonglu/audio_index.json")
    parser.add_argument("--baseline", default="data/xiaosonglu/audio_asset_baseline.json")
    parser.add_argument("--manifest", default="data/xiaosonglu/_audio_asset_manifest.json")
    parser.add_argument("--lock", default="data/xiaosonglu/_audio_sync.lock")
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--quiet", action="store_true", help="Hide per-file existing messages")
    parser.add_argument("--adopt-baseline", action="store_true", help="Explicitly replace the durable expected size/hash set")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.source_base.startswith("https://"):
        raise ValueError("--source-base must use https://")
    root = Path(args.root).resolve()
    index_path = (root / args.audio_index).resolve()
    baseline_path = (root / args.baseline).resolve()
    manifest_path = (root / args.manifest).resolve()
    lock_path = (root / args.lock).resolve()
    lock_descriptor = acquire_lock(lock_path)
    atexit.register(release_lock, lock_path, lock_descriptor)

    index = read_json(index_path)
    values = index.get("audios", {})
    if not isinstance(values, dict) or not values:
        raise ValueError("audio_index.json must contain a non-empty audios object")
    declared_count = int(index.get("count") or len(values))
    if declared_count != len(values):
        raise ValueError("audio_index.json count does not match its audios entries")
    raw_paths = [str(value).split("?", 1)[0] for value in values.values()]
    canonical_targets: Dict[str, str] = {}
    for relative in raw_paths:
        target = safe_target(root, relative)
        identity = os.path.normcase(str(target)).casefold()
        if identity in canonical_targets:
            raise ValueError("audio_index.json contains colliding targets: {} and {}".format(canonical_targets[identity], relative))
        canonical_targets[identity] = relative
    paths = sorted(raw_paths)

    baseline = load_manifest(baseline_path)
    baseline_files = baseline.get("files", {}) if baseline_path.is_file() else {}
    if not args.adopt_baseline:
        if baseline.get("schemaVersion") != 1 or not baseline_files:
            raise ValueError("The durable audio baseline is missing; use --adopt-baseline only after explicit review")
        if int(baseline.get("count") or 0) != len(baseline_files):
            raise ValueError("Durable audio baseline count does not match its files")
        if set(baseline_files) != set(paths):
            raise ValueError("audio_index.json differs from the durable audio baseline; review and explicitly adopt the new set")
        for relative in paths:
            if not baseline_files[relative].get("bytes") or not baseline_files[relative].get("sha256"):
                raise ValueError("Durable audio baseline lacks size/hash for {}".format(relative))

    manifest = load_manifest(manifest_path)
    old_files = manifest.get("files", {})
    sync_entries: Dict[str, Dict[str, Any]] = {}
    for relative in paths:
        if args.adopt_baseline:
            # Adoption explicitly trusts the reviewed local/remote bytes and replaces old expectations.
            sync_entries[relative] = {}
            continue
        entry = dict(baseline_files[relative])
        local_entry = old_files.get(relative, {})
        for key in ("mtimeNs", "etag", "lastModified", "fetchedAt"):
            if local_entry.get(key) is not None:
                entry[key] = local_entry[key]
        sync_entries[relative] = entry
    results: List[Dict[str, Any]] = []
    failures: List[Dict[str, str]] = []

    workers = max(1, min(int(args.workers), 12))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(download_one, root, args.source_base, relative, sync_entries[relative]): relative
            for relative in paths
        }
        for future in concurrent.futures.as_completed(futures):
            relative = futures[future]
            try:
                result = future.result()
                results.append(result)
                if not args.quiet or result["status"] != "existing":
                    print("{:<10} {} ({:,} bytes)".format(result["status"].upper(), relative, result["bytes"]))
            except Exception as error:  # keep other independent downloads running
                failures.append({"path": relative, "error": str(error)})
                print("FAILED     {}: {}".format(relative, error), file=sys.stderr)

    if args.adopt_baseline and not failures and len(results) == len(paths):
        durable_baseline = {
            "schemaVersion": 1,
            "count": len(paths),
            "sourceBase": args.source_base.rstrip("/") + "/",
            "capturedAt": utc_now(),
            "files": {
                result["path"]: {"bytes": result["bytes"], "sha256": result["sha256"]}
                for result in sorted(results, key=lambda item: item["path"])
            },
        }
        write_json_atomic(baseline_path, durable_baseline)
        print("BASELINE adopted")

    files = dict(old_files)
    for result in results:
        files[result["path"]] = {
            "bytes": result["bytes"],
            "mtimeNs": result["mtimeNs"],
            "sha256": result["sha256"],
            "etag": result.get("etag"),
            "lastModified": result.get("lastModified"),
            "fetchedAt": result.get("fetchedAt"),
        }
    downloaded_count = sum(result["status"] in ("downloaded", "resumed") for result in results)
    old_manifest_complete = (
        manifest.get("schemaVersion") == 1
        and set(old_files) == set(paths)
        and all(old_files[path].get("bytes") and old_files[path].get("mtimeNs") and old_files[path].get("sha256") for path in paths)
    )
    if downloaded_count == 0 and not failures and old_manifest_complete:
        print("MANIFEST unchanged")
    else:
        next_manifest = {
            "schemaVersion": 1,
            "sourceBase": args.source_base.rstrip("/") + "/",
            "audioIndex": args.audio_index.replace("\\", "/"),
            "updatedAt": utc_now(),
            "files": {key: files[key] for key in sorted(files) if key in paths},
        }
        write_json_atomic(manifest_path, next_manifest)
        print("MANIFEST updated")
    counts = {
        "expected": len(paths),
        "downloaded": downloaded_count,
        "existing": sum(result["status"] == "existing" for result in results),
        "failed": len(failures),
        "bytes": sum(int(result["bytes"]) for result in results),
    }
    print("SUMMARY " + json.dumps(counts, ensure_ascii=False, separators=(",", ":")))
    if failures:
        print(json.dumps({"failures": failures}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("ERROR: {}".format(exc), file=sys.stderr)
        sys.exit(1)
