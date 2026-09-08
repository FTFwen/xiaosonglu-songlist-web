#!/usr/bin/env python3
"""Synchronize viridis.love song JSON as a conditional, content-addressed baseline.

The first run records the deployed files and their HTTP validators. Later runs send
If-None-Match / If-Modified-Since, so unchanged payloads return 304 and are not
re-downloaded or rewritten. Local edits are never overwritten after they diverge
from the recorded baseline unless --adopt-remote is explicitly supplied.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_URL = "https://viridis.love/data/xiaosonglu/"
FILES = (
    "song_catalog.json",
    "history_index.json",
    "song_details.json",
    "replay_song_segments.json",
    "song_cut_index.json",
    "song_cut_info.json",
    "song_metadata_overrides.json",
    "audio_index.json",
)
MANIFEST_NAME = "remote_baseline_manifest.json"
USER_AGENT = "xiaosonglu-songlist-baseline-sync/1.0"


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def content_sha256(payload: Any) -> str:
    """Hash JSON meaning, not formatting or checkout line endings."""
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256_bytes(canonical)


def file_content_sha256(path: Path) -> str:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    return content_sha256(payload)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def load_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def record_count(payload: Any) -> int | None:
    if not isinstance(payload, dict):
        return len(payload) if isinstance(payload, list) else None
    for key in ("songs", "segments", "items", "audios", "cuts", "details"):
        value = payload.get(key)
        if isinstance(value, (list, dict)):
            return len(value)
    by_date = payload.get("byDate")
    if isinstance(by_date, dict):
        return sum(len(value) for value in by_date.values() if isinstance(value, list))
    return None


def fetch(url: str, previous: dict[str, Any], timeout: float, conditional: bool) -> tuple[int, bytes | None, dict[str, str]]:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if conditional:
        if previous.get("etag"):
            headers["If-None-Match"] = str(previous["etag"])
        if previous.get("lastModified"):
            headers["If-Modified-Since"] = str(previous["lastModified"])
    request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            response_headers = {
                "etag": response.headers.get("ETag", ""),
                "lastModified": response.headers.get("Last-Modified", ""),
            }
            return response.status, response.read(), response_headers
    except HTTPError as error:
        if error.code == 304:
            return 304, None, {
                "etag": error.headers.get("ETag", previous.get("etag", "")),
                "lastModified": error.headers.get("Last-Modified", previous.get("lastModified", "")),
            }
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Conditionally synchronize the deployed Viridis song-data baseline.")
    parser.add_argument("--base-url", default=BASE_URL, help="Remote data directory URL")
    parser.add_argument("--data-dir", default="data/xiaosonglu", help="Local song data directory")
    parser.add_argument("--manifest", default="", help="Manifest path (defaults inside data directory)")
    parser.add_argument("--timeout", type=float, default=30.0, help="Per-request timeout in seconds")
    parser.add_argument("--adopt-remote", action="store_true", help="Explicitly replace locally diverged files with deployed content")
    parser.add_argument("--force-download", action="store_true", help="Ignore cached validators and request every payload")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    data_dir = (root / args.data_dir).resolve()
    manifest_path = (root / args.manifest).resolve() if args.manifest else data_dir / MANIFEST_NAME
    old_manifest = load_manifest(manifest_path)
    old_files = old_manifest.get("files") if isinstance(old_manifest.get("files"), dict) else {}
    next_files: dict[str, Any] = dict(old_files)
    changed_entries = False
    updated_local = 0
    skipped_remote = 0
    conflicts: list[str] = []

    for name in FILES:
        local_path = data_dir / name
        previous = old_files.get(name) if isinstance(old_files.get(name), dict) else {}
        try:
            local_hash = file_content_sha256(local_path) if local_path.exists() else ""
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            print(f"ERROR {name}: local file is not valid UTF-8 JSON ({error})", file=sys.stderr)
            return 1
        conditional = not (args.force_download or args.adopt_remote) and bool(previous) and local_path.exists()
        url = args.base_url.rstrip("/") + "/" + name

        try:
            status, content, response_headers = fetch(url, previous, args.timeout, conditional)
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            print(f"ERROR {name}: {error}", file=sys.stderr)
            return 1

        if status == 304:
            skipped_remote += 1
            previous_hash = str(previous.get("contentSha256") or previous.get("sha256") or "")
            diverged = bool(previous_hash) and local_hash != previous_hash
            if diverged:
                conflicts.append(name)
            state = "local-diverged" if diverged else "unchanged"
            print(f"SKIP  {name}: HTTP 304 ({state})")
            continue

        assert content is not None
        try:
            payload = json.loads(content.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            print(f"ERROR {name}: remote response is not valid UTF-8 JSON ({error})", file=sys.stderr)
            return 1

        remote_hash = content_sha256(payload)
        remote_byte_hash = sha256_bytes(content)
        previous_hash = str(previous.get("contentSha256") or previous.get("sha256") or "")
        local_matches_previous = bool(previous_hash) and local_hash == previous_hash
        local_matches_remote = local_hash == remote_hash
        safe_to_replace = not local_path.exists() or local_matches_previous or args.adopt_remote

        if local_matches_remote:
            action = "verified"
        elif safe_to_replace:
            atomic_write(local_path, content)
            updated_local += 1
            action = "updated"
        else:
            conflicts.append(name)
            action = "conflict-preserved-local"

        entry = {
            "url": url,
            "etag": response_headers.get("etag", ""),
            "lastModified": response_headers.get("lastModified", ""),
            "contentSha256": remote_hash,
            "remoteByteSha256": remote_byte_hash,
            "bytes": len(content),
        }
        if isinstance(payload, dict):
            version_time = payload.get("generatedAt") or payload.get("updatedAt")
            if version_time:
                entry["versionTimestamp"] = version_time
        count = record_count(payload)
        if count is not None:
            entry["recordCount"] = count
        if previous != entry:
            changed_entries = True
        next_files[name] = entry
        print(f"{action.upper():24} {name}: {len(content)} bytes contentSha256={remote_hash[:12]}")

    manifest = {
        "schemaVersion": 1,
        "source": args.base_url.rstrip("/") + "/",
        "capturedAt": old_manifest.get("capturedAt") or utc_now(),
        "dedupePolicy": {
            "transport": "Use ETag/Last-Modified conditional GET; HTTP 304 skips payload download.",
            "content": "Compare canonical JSON SHA-256 before writing; formatting and line-ending changes do not trigger rewrites.",
            "records": "Replay segments use replay_date + song_name; song cuts use clip_date + song_name; retain repeat performances on different dates.",
            "conflicts": "Preserve locally changed files unless --adopt-remote is explicitly supplied.",
        },
        "files": next_files,
    }
    if changed_entries or not manifest_path.exists():
        if old_manifest.get("files") != next_files:
            manifest["capturedAt"] = utc_now()
        encoded = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        atomic_write(manifest_path, encoded)
        print(f"MANIFEST updated: {manifest_path.relative_to(root)}")
    else:
        print("MANIFEST unchanged")

    print(f"SUMMARY downloaded={len(FILES) - skipped_remote} http304={skipped_remote} localUpdated={updated_local} conflicts={len(conflicts)}")
    if conflicts:
        print("CONFLICTS preserved: " + ", ".join(conflicts), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
