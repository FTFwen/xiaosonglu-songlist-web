from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INGEST = REPO_ROOT / "tools" / "ingest_song_cut_audio.py"
SYNC = REPO_ROOT / "tools" / "sync_song_audio_assets.py"


def m4a(payload: bytes) -> bytes:
    return b"\x00\x00\x00\x18ftypM4A " + payload


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class SongAudioPipelineTests(unittest.TestCase):
    def make_replacement_root(self) -> tuple[tempfile.TemporaryDirectory[str], Path, bytes, bytes]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        old_bytes = m4a(b"old-audio")
        new_bytes = m4a(b"reviewed-new-audio")
        target = root / "assets" / "audio" / "song_1.m4a"
        target.parent.mkdir(parents=True)
        target.write_bytes(old_bytes)
        source = root / "assets" / "audio" / "source" / "live-test" / "01_cut.m4a"
        source.parent.mkdir(parents=True)
        source.write_bytes(new_bytes)
        cut_url = "https://www.bilibili.com/video/BV1replacement/"
        source_identity = "https://bilibili.com/video/bv1replacement"
        write_json(source.parent / "_source_manifest.json", {
            "schemaVersion": 1,
            "items": {
                "1": {
                    "sourceIdentity": source_identity,
                    "songKey": "测试歌",
                    "file": source.name,
                    "bytes": len(new_bytes),
                    "sha256": digest(new_bytes),
                }
            },
        })
        write_json(root / "data" / "xiaosonglu" / "audio_index.json", {
            "count": 1,
            "audios": {"测试歌": f"assets/audio/song_1.m4a?v={digest(old_bytes)[:12]}"},
            "verificationTargets": [],
        })
        write_json(root / "data" / "xiaosonglu" / "audio_asset_baseline.json", {
            "schemaVersion": 1,
            "count": 1,
            "files": {"assets/audio/song_1.m4a": {"bytes": len(old_bytes), "sha256": digest(old_bytes)}},
        })
        write_json(root / "data" / "xiaosonglu" / "song_cut_index.json", {"items": [{
            "clip_date": "2026-09-09", "song_name": "测试歌", "clip_bvid": "BV1replacement",
            "clip_url": cut_url, "clip_kind": "single", "duplicate_key": "2026-09-09::测试歌", "duplicate_status": "primary",
        }]})
        write_json(root / "data" / "xiaosonglu" / "replay_song_segments.json", {
            "segments": [{
                "replay_id": "live:live-test", "replay_date": "2026-09-09", "segment_index": 1,
                "song_name": "测试歌", "cut_link": cut_url,
            }],
        })
        write_json(root / "data" / "xiaosonglu" / "curated.json", {
            "live": {"liveId": "live-test", "date": "2026-09-09"},
            "songs": [{
                "segmentIndex": 1,
                "songName": "测试歌",
                "cut": {"url": cut_url, "bvid": "BV1replacement", "kind": "single"},
                "audioAction": "replace-existing",
                "audioReplacementReason": "reviewed test replacement",
                "audioSha256": digest(new_bytes),
                "audioBytes": len(new_bytes),
                "audioTarget": "assets/audio/song_1.m4a",
            }],
        })
        return temporary, root, old_bytes, new_bytes

    def run_ingest(self, root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(INGEST), "--root", str(root), "--curated", "data/xiaosonglu/curated.json"],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_reviewed_replacement_is_idempotent_and_recreates_missing_target(self) -> None:
        temporary, root, _, new_bytes = self.make_replacement_root()
        self.addCleanup(temporary.cleanup)
        first = self.run_ingest(root)
        self.assertEqual(first.returncode, 0, first.stderr)
        first_result = json.loads(first.stdout)
        self.assertTrue(first_result["changed"])
        self.assertEqual(first_result["replaced"][0]["status"], "replaced")
        index = json.loads((root / "data/xiaosonglu/audio_index.json").read_text(encoding="utf-8"))
        self.assertEqual(index["audios"]["测试歌"], f"assets/audio/song_1.m4a?v={digest(new_bytes)[:12]}")
        self.assertEqual(index["verificationTargets"], ["测试歌"])

        second = self.run_ingest(root)
        self.assertEqual(second.returncode, 0, second.stderr)
        second_result = json.loads(second.stdout)
        self.assertFalse(second_result["changed"])
        self.assertEqual(second_result["replaced"][0]["status"], "already-current")

        (root / "assets/audio/song_1.m4a").unlink()
        third = self.run_ingest(root)
        self.assertEqual(third.returncode, 0, third.stderr)
        self.assertEqual((root / "assets/audio/song_1.m4a").read_bytes(), new_bytes)
        self.assertEqual(json.loads(third.stdout)["replaced"][0]["status"], "created-target")

    def test_replacement_requires_reason_before_mutating_audio(self) -> None:
        temporary, root, old_bytes, _ = self.make_replacement_root()
        self.addCleanup(temporary.cleanup)
        curated_path = root / "data/xiaosonglu/curated.json"
        curated = json.loads(curated_path.read_text(encoding="utf-8"))
        del curated["songs"][0]["audioReplacementReason"]
        write_json(curated_path, curated)
        result = self.run_ingest(root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("audioReplacementReason", result.stderr)
        self.assertEqual((root / "assets/audio/song_1.m4a").read_bytes(), old_bytes)

    def test_selective_baseline_adoption_uses_exact_reviewed_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = m4a(b"new-first")
            second = m4a(b"stable-second")
            first_path = root / "assets/audio/song_1.m4a"
            second_path = root / "assets/audio/song_2.m4a"
            first_path.parent.mkdir(parents=True)
            first_path.write_bytes(first)
            second_path.write_bytes(second)
            write_json(root / "data/xiaosonglu/audio_index.json", {
                "count": 2,
                "audios": {
                    "一": f"assets/audio/song_1.m4a?v={digest(first)[:12]}",
                    "二": f"assets/audio/song_2.m4a?v={digest(second)[:12]}",
                },
                "verificationTargets": ["一"],
            })
            old_first = m4a(b"old-first")
            write_json(root / "data/xiaosonglu/audio_asset_baseline.json", {
                "schemaVersion": 1,
                "count": 2,
                "files": {
                    "assets/audio/song_1.m4a": {"bytes": len(old_first), "sha256": digest(old_first)},
                    "assets/audio/song_2.m4a": {"bytes": len(second), "sha256": digest(second)},
                },
            })
            command = [
                sys.executable, str(SYNC), "--root", str(root), "--source-base", "https://example.invalid/",
                "--adopt-baseline", "--adopt-spec", f"assets/audio/song_1.m4a|{len(first)}|{digest(first)}", "--quiet",
            ]
            result = subprocess.run(command, text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            baseline = json.loads((root / "data/xiaosonglu/audio_asset_baseline.json").read_text(encoding="utf-8"))
            self.assertEqual(baseline["files"]["assets/audio/song_1.m4a"]["sha256"], digest(first))
            self.assertEqual(baseline["files"]["assets/audio/song_2.m4a"]["sha256"], digest(second))


if __name__ == "__main__":
    unittest.main()
