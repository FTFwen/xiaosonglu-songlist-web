# 2026-08-23「行道树投稿回（2）」弹幕歌单收录流水线运行留档

运行时间：2026-08-24 17:00-18:30（UTC+8）· 场次：2026-08-23 21:03-00:08（北京时间）
liveId：`907b2835-53cf-4885-9691-2d6cbd3d41ea`（ukamnads.icu /api/v2/channel 最新场次，isMerged=true，23024 弹幕）
官方回放（录播号 恩仙仙 mid=7159516，与 8/20 回放同源）：**BV1758h6FEmv**（3:04:27）

## 一、检测方式偏离说明

- 全场 **无【】/［］歌词弹幕**（仅 3 条方括号弹幕，均非歌词），按流水线字面步骤 2 应判"无唱歌片段"。
- 深入扫描发现结尾 **02:14-02:58（相对开播，即北京时间 23:17-00:01）有清唱加演**（弹幕"老师在讲台上唱起来了""清唱好仙""王牌节目之慢启动歌回"）。
- 无 B站歌切/歌回合集（B站搜索 API 全程风控返回 HTML，经关联视频接口 x/web-interface/archive/related 确认无 8/23 歌切）。
- 因此曲目识别改走：**弹幕歌名点名 + 反应弹幕 + 网易云/百度百科/萌百原曲核实**，全部标"自动识别待人工复核"。

## 二、收录曲目（9 首，全部 catalog 新增）

| # | 歌名 | 歌手 | 语言 | 类型 | 置信 | 证据 |
|---|------|------|------|------|------|------|
| 1 | 流霰 | 旅行的蜗牛（Snapmod）/ 星尘 | 中文 | Synthesizer V、中文Vocaloid | 0.8 | 02:16:53"我去，流霰!"；网易云核实星尘版 |
| 2 | 5:20AM | 刀酱 | 中文 | 网络流行、中文流行 | 0.7 | 02:15-02:21"520am"连刷21条 |
| 3 | 栖凰 | 忘川风华录 / 星尘 | 中文 | 忘川风华录、古风 | 0.75 | 02:31"栖凰好听捏"；百科核实 |
| 4 | 多情岸 | 忘川风华录 / 洛天依 | 中文 | 忘川风华录、古风 | 0.75 | 02:40"多情岸，落泪了"；曹植主题曲 |
| 5 | 吹灭小山河 | 国风堂 / 司南 | 中文 | 国风 | 0.7 | 02:46"吹灭小山河有品" |
| 6 | 腐草为萤 | 银临 | 中文 | 古风 | 0.7 | 02:48 点名 |
| 7 | 夏恋慕 | kobasolo / 春茶 | 日文 | J-Pop | 0.75 | 02:49"夏恋慕神！！！"+日文歌词行 |
| 8 | 可惜夜 | 凪 | 日文 | J-Pop | 0.6 | 02:54"你还会可惜夜阿"；歌手待复核 |
| 9 | 夏霞 | あたらよ | 日文 | J-Pop | 0.8 | 02:54-02:58 密集反应15+条，压轴 |

未收录（证据弱/疑似）：拥抱你（单次点名，原曲歧义）、《光》（单次"还有《光》"）、desert（单次"还有desert"，原曲未确认）、流年如歌（"我的流年如歌呢"疑似未唱）、儿歌（未点名具体曲目）及纯点歌未唱曲目（恋苦/追光者/烟草/水星/白鸟过河滩/东京不太热等）。

## 三、数据变更

- replay_song_segments.json：92 → **101**（+9，2026-08-23 新增）
- song_cut_index.json：89 → **98**（+9，clip_kind=replay-danmaku 区分于真歌切，date_source=replay-title-date，song_name_source=danmaku-name-drop）
- song_catalog.json：88 → **96**（+8 曲目数净增，9 首全部 sing_count=1）
- history_index.json：byDate 新增 2026-08-23（9 条）；dateTree/latest 更新
- song_cut_table.csv：98 行（含表头 99）
- 8/21 两场（后日谈？/突击的看纪录片）经扫描无主播独唱曲目（联动群唱、无歌词弹幕），不收录。

## 四、同步与部署

- 同步：sync_workspace_data.ps1 成功，web-deploy\data\xiaosonglu\ 已含 96 首，js\data.js 已重新生成（298289 字节，含新歌）。
- 部署：**失败 —— Cloudflare OAuth refresh token 失效（invalid_grant 400）**。凭据 E:\tool\plugin\xsl-web-tools\.wrangler-auth.json 的 refreshToken 已于 2026-08-22 过期且被吊销，无备用 token。
- 线上现状：viridis.love 首页 200；/data/xiaosonglu/song_catalog.json 200（仍为旧版 88 首，generatedAt 2026-08-21）。

## 五、遗留项

1. **部署待人工重新授权**：`node E:\tool\plugin\xsl-web-tools\cloudflare_device_login.cjs` 设备流授权后重跑 `deploy_web.ps1`（web-deploy 已就绪，无需重同步）。
2. 可惜夜 歌手"凪"待复核；拥抱你/光/desert 未收录待人工听录确认。
3. B站搜索 API 自 8/24 起持续风控（HTML 验证页），后续检索需等待解除或换通道。

---

## 六、2026-08-24 晚间复查（本轮追加，19:57-20:05 UTC+8）

### 检查结论

1. **频道场次复核**：`/api/v2/channel?uid=1891335475` 仍为 24 场（08-07~08-23），isLiving=false，
   lastLiveDate=2026-08-24T00:08+08。08-23 之后无新场次 → 无新弹幕可拉、无新曲目可识别。
2. **部署复查**：重跑 `deploy_web.ps1` → **仍失败**，Cloudflare OAuth `invalid_grant`（refresh token 已被吊销，
   工作区缓存 `.wrangler-auth.json` 有效期止于 2026-08-22T03:49Z）。遗留项 #1 仍有效，需人工设备授权。
3. **数据回归修复（本轮发现并处理）**：对比线上（88 首）与本地重建（96 首）catalog 发现「YOU & IDOL」
   （2026-08-10 练歌小电，用户补充条目，BV1P6ud6dEkm，相対性理論，音频 song_89.m4a 已部署）在本次重建中
   意外掉出——其 user-supplied segment 已不在 replay_song_segments.json，但 audio_index / song_cut_info /
   旧 song_details（songplg 08-21 产物）仍保留该曲，且线上一直展示。判定为意外丢失（无任何删除留档），
   已按旧产物恢复 segment（scripts/restore_you_idol_segment.cjs）并重建。
4. **数据现状（本地 + web-deploy 已同步）**：catalog **97 首**（88 线上 - 0 移除 + 9 新 + 1 恢复）、
   segments **102 条**、cut_index 98 条、history byDate 10 天（含 08-23 ×9）、cut_table 98 数据行（无 YOU & IDOL 行，与旧版一致）、
   song_details bySongKey 97。js\data.js 已重新生成（300777 字节）。
5. **线上现状**：viridis.love 仍为 08-21 构建（catalog 88 首 / history 9 天），待授权后部署即更新。

### 遗留项（维持）

1. **部署待人工重新授权**：`node E:\tool\plugin\xsl-web-tools\cloudflare_device_login.cjs`
   （或工作区缓存版 `cloudflare_device_login_cache.cjs`，token 写入 `.wrangler-auth.json`，deploy_pages.cjs 优先读取）
   完成授权后重跑 `deploy_web.ps1`。web-deploy 已就绪（97 首），无需重同步。
2. 可惜夜 歌手"凪"待复核；拥抱你/光/desert 未收录待人工听录确认。
3. B站搜索 API 风控（HTML 验证页）持续，后续检索需等待解除或换通道。
