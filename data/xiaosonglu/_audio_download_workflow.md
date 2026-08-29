# 音频下载加入播放流程（可复用）

> 2026-08-29 用户确认：**只要歌曲有可信来源的视频（歌切/合集分P），即可下载音频加入网页播放**。
> 本文档记录标准操作流程，供后续每次新增/补充歌曲时复用。

## 适用条件

- 歌曲已入 catalog（segments + cut_index 有记录），且具备**可信视频源**：
  - 单曲歌切直链（BV1XXXX 无 ?p=）
  - 合集分P（BV1XXXX/?p=N，如心灵火Flame/银河的鱼/也许是因为我喜欢 等歌回合集）
- 无视频源的歌（仅弹幕证据，如 08-29 的 梦良衣/难过233秒）**不下载**，维持待复核。

## 标准步骤

1. **确定音频编号**：`web-deploy/assets/audio/` 下当前最大 `song_N.m4a` 的下一个（当前到 song_119）。
2. **追加下载清单** `data/_audio_download_batch.json`：
   ```json
   { "name": "歌名", "out": "song_120.m4a", "url": "https://www.bilibili.com/video/BV1XXXX/", "item": null }
   // 合集分P: { "name": "歌名", "out": "song_121.m4a", "url": "https://www.bilibili.com/video/BV1YYYY/", "item": 6 }
   ```
   （item=分P号；单曲直链 item=null）
3. **下载音频**（沙箱限制 Node spawn EPERM，必须用 PowerShell 直调 yt_dlp）：
   ```
   powershell -ExecutionPolicy Bypass -File E:\tool\plugin\scripts\download_audio_batch.ps1
   ```
   - 已存在的文件自动 SKIP（可断点续跑）
   - B站偶发 **412 风控**：等待 45-60s 后重跑（脚本对未下载项重试）；多轮仍失败则隔更久再试
4. **重建任务清单 + 音频索引**：
   ```
   node E:\tool\plugin\scripts\rebuild_audio_tasks.cjs   （对齐 catalog 顺序，读 batch 清单）
   node E:\tool\plugin\scripts\build_audio_index.cjs     （重建 audio_index.json，双写 web-deploy）
   ```
5. **同步 + 部署**：
   ```
   powershell -ExecutionPolicy Bypass -File E:\tool\plugin\xsl-web-tools\sync_workspace_data.ps1
   powershell -ExecutionPolicy Bypass -File E:\tool\plugin\xsl-web-tools\deploy_web.ps1
   ```
   部署脚本已支持**分块上传**（每批 ≤20MB + 重试），大音频文件不会撑爆单请求；中途失败可安全重跑（断点续传）。
6. **验证**：`GET https://viridis.love/data/xiaosonglu/audio_index.json` count 应等于有音频的歌数；
   抽查 `GET https://viridis.love/assets/audio/song_XXX.m4a` 返回 200。

## 当前状态（2026-08-29）

- catalog 120 首，**118 首有音频可播放**（audio_index count=118）；仅 梦良衣/难过233秒 无视频源未下载。
- 任务清单 `_audio_download_tasks.json`（118 条）与 catalog 顺序对齐；`_audio_source_audit.json` 覆盖 120 首。
- song_cut_info.json 120 首全部有歌切标题（前端歌切链接显示）。
- 部署脚本 deploy_pages.cjs 含分块上传修复（2026-08-29）。

## 历史下载批次

- song_01..99：08-22 前（旧流水线，download_audio.cjs 时代）
- song_100..102：08-29 临川浮梦/泼墨漓江/流光记（心灵火Flame 08-29 合集 P6/P11/P15）
- song_103..119：08-29 批量 17 首（绿色/阿拉斯加海湾/初恋日記/炼金少女日志/好妹妹/女孩你为何踮脚尖/绮凝盏/是风动/四重罪孽/下个夏天的烟火/夏日已所剩无几/台风歌/虚拟/远旅休憩中的邂逅/月出/Talking to the Rain/サリシノハラ）
