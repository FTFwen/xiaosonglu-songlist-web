# 小松绿歌单收录工具链

这套脚本替代暂时无法迁入的旧 `scripts/`。它只依赖 Node.js 20+ 的内置模块，按“发现直播 → 抓取弹幕 → 聚类候选 → 人工/Agent 复核 → 安全入库 → 派生数据构建 → 校验”的顺序工作。

## 数据边界

- 唯一事实台账：
  - `data/xiaosonglu/replay_song_segments.json`
  - `data/xiaosonglu/song_cut_index.json`
- 可人工维护的元数据：`song_metadata_overrides.json` 与已有 `song_cut_info.json` 选择。
- 派生产物：`song_catalog.json`、`history_index.json`、`song_details.json`、`song_cut_info.json`、`song_cut_table.csv`、`js/data.js`。
- 扫描状态：`ingestion_state.json`。它按 liveId 记录终态与分页进度，避免每天反复抓取。
- `_danmaku_*`、`_candidate_*` 是本地证据缓存，已被 `.gitignore` 排除。`_danmaku_*` 每页原子落盘，意外中断后从 `checkpoint.nextOffset` 继续；完整 artifact 会直接复用，不再请求弹幕接口。
- 线上基线：`remote_baseline_manifest.json`。只用 `tools/sync_viridis_baseline.py` 通过 ETag/Last-Modified 条件请求校验，304 不下载正文，规范化 JSON 哈希相同不重写。
- 不需要视频即可完成弹幕证据收录。若人工复核临时下载视频，必须放在已忽略的 `assets/video/`、`assets/videos/` 或 `data/xiaosonglu/videos/`，不得加入 Git。

## 每日扫描

```powershell
# 只发现，不写文件
node scripts/scan_unrecorded_lives.mjs

# 抓取所有未处理的完整合并场次，生成候选并更新状态
node scripts/scan_unrecorded_lives.mjs --write
```

扫描时频道列表每轮只请求一次；基线当天仍会纳入候选，再按 liveId 判断是否已经完成，避免漏掉同日多场。写入模式持有本地锁，同一时刻只有一个扫描器；分页状态先写 evidence artifact、再写 ingestion state。扫描规则固定为：只取 `payloadKind === 1` 的 `payload.rawText`；只将 `【】` 或 `［］` 包围、去标点后长度至少 6 的弹幕作为歌词证据；相邻歌词弹幕间隔超过 150 秒时开启新候选段。ASCII `[表情]` 不会被误判为歌词。

零候选场次会自动记为 `no-songs`。有候选的场次记为 `review-needed`，必须结合上下文、可信歌切标题和必要的歌词检索复核；不要仅凭单条歌词臆测歌名。

复核后记录决定：

```powershell
node scripts/record_live_review.mjs `
  --candidate data/xiaosonglu/_candidate_YYYY-MM-DD_xxxxxxxx.json `
  --decision no-songs `
  --notes "说明证据" `
  --write
```

若该直播的事实台账已由其他可靠来源完成收录，可将状态记为 `imported`；多首歌用 `|` 分隔（而不是逗号，真实歌名可能含逗号）：

```powershell
node scripts/record_live_review.mjs `
  --candidate data/xiaosonglu/_candidate_YYYY-MM-DD_xxxxxxxx.json `
  --decision imported `
  --songs "歌曲甲|Fly, My Wings|歌曲乙" `
  --notes "与现有回放 BVID、日期及候选时间窗核对一致" `
  --write
```

程序化调用也可用 `--songs-base64` 传入 UTF-8 JSON 数组的 base64url 编码。

## 录入确认歌曲

先在被忽略的 `_curated_*.json` 中准备复核结果：

```json
{
  "schemaVersion": 1,
  "live": {
    "liveId": "直播 UUID",
    "date": "2026-09-08",
    "title": "直播标题",
    "replayId": "BV...（没有回放 BVID 时可省略）",
    "replayTitle": "回放标题",
    "replayUrl": "https://www.bilibili.com/video/BV.../",
    "replayDateSource": "replay-title"
  },
  "songs": [
    {
      "candidateIndex": 1,
      "segmentIndex": 1,
      "startTime": "00:12:34",
      "endTime": "00:16:20",
      "lyricExcerpt": "【】歌词弹幕命中窗口 00:12:34~00:16:20",
      "songName": "真实曲名",
      "artist": "原唱/作者",
      "artistSearch": "用于搜索的作者文本",
      "language": "中文",
      "typeTags": ["流行"],
      "statusLabels": ["歌回", "自动识别待人工复核"],
      "songResolutionMethod": "danmaku-lyrics + song-cut-title",
      "remark": "证据与不确定性说明",
      "confidence": 0.85,
      "resolutionCandidates": [
        { "title": "证据标题", "url": "https://...", "snippet": "命中内容" }
      ],
      "cut": {
        "url": "https://www.bilibili.com/video/BV.../",
        "bvid": "BV...",
        "title": "歌切标题",
        "uploader": "UP 主",
        "kind": "single",
        "dateSource": "description-date",
        "songNameSource": "title-song-name",
        "notes": "歌切证据"
      }
    }
  ]
}
```

先做无写入检查，再正式写入：

```powershell
node scripts/import_curated_songs.mjs --input data/xiaosonglu/_curated_YYYY-MM-DD.json
node scripts/import_curated_songs.mjs --input data/xiaosonglu/_curated_YYYY-MM-DD.json --write
```

去重键为 `日期 + NFKC/大小写/空白归一化后的歌曲名`。同一天同一首歌不会重复写入；不同日期复唱会保留。正式导入会同时重建派生数据，并且只有在每个导入 key 都能从 `replay_song_segments.json` 验证后，才把 liveId 标记为 `imported`。

## 构建与校验

```powershell
node scripts/build_xiaosonglu_song_data.mjs --write
node scripts/build_xiaosonglu_song_data.mjs --check
node scripts/validate_song_data.mjs
node --test --test-isolation=none scripts/tests/song_pipeline.test.mjs
```

构建器保留已有 `song_id`、目录同次数排序和已人工选定的歌切链接；只为缺少歌切显示信息的新歌补充最佳证据，避免覆盖人工选择。无源数据变化时二次构建应为零文件变化。

站点镜像同步和 Cloudflare Pages 条件化部署见 `xsl-web-tools/README.md`。
