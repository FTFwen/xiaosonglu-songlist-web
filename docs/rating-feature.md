# 歌曲评分（按 IP 区分访客）

> 主站歌曲卡片右下角的两行星级评分。最后更新：2026-09-13。

## 一、功能

- 每张歌曲卡片右下角两行 × 5 颗星，**每颗星 2 分，半颗星 1 分**（所以 1 到 10 的整数分都能打）。
- 星星是自己画的一套三张配套图（`js/rating.js` 里的 `STAR_FULL_PATH` / `STAR_LEFT_PATH` / `STAR_RIGHT_PATH`，24×24 视口，外接半径 10.2、内径 4.9 的圆润五角星），配色跟着小松绿的橄榄绿走：
  - **空星**：只描边，颜色用 `--line-strong`（#c3cd9a，和卡片分隔线同一族）；
  - **满星**：橄榄绿实心 + 同色描边（`--primary` #8a9a4e），边缘更饱满；
  - **半星**：真正的「半边星」——左半边闭合路径实心橄榄绿、右半边闭合路径只描边，两半在中线（x=12）精确相接，既不重叠也没有缝。
- 这条路走对了两次：最早用 `clip-path` 裁 SVG（浏览器上没生效，半星看着和满星一样），后来改成宽度裁切 + 灰金双色（能看出半颗，但灰块压在小星星上很丑）。现在三张图都是独立闭合路径，不依赖 `clip-path`、蒙版或叠加裁切，13px 下也干净。
  描边宽度按档位换算：卡片 13px 用 1.9（≈1px），弹窗 27px 用 0.89（≈1px）。
- **第一行**：服务器上的全站平均分，附评分人数（`8.0 分 · 2 人`）；没有人打分时显示「还没有人打分」。
- **第二行**：自己的评分。没打过显示「我来打分」，打过显示「我的 X 分」——**它同时是一个按钮**。
- **打分走弹窗**：点第二行弹出小面板，面板里 5 颗大星星（27px，比卡片上的大一圈，好点），点第 N 颗星的左半边得 `2N-1` 分、右半边得 `2N` 分，点完立即提交并刷新卡片；随时可以再点开改成别的分，或按「清除评分」撤销。点面板外面、点 `×`、按 `Esc` 都能关掉。
- 平均分只显示到 0.5 分粒度（整星/半星），真实平均值取一位小数显示在星星右边，鼠标悬停能看到两位小数。
- 评分只在卡片进入视口附近时才加载，同一分片的歌曲合并成一次请求。
- **底部播放栏也有一份**：在歌曲名右侧、进度条左侧，同样是两行——第一行「均分」+ 平均分、第二行「我的」+ 自己的评分，点第二行弹出同一个打分面板；打完分卡片和播放栏会同步刷新，切歌时自动跟随当前播放的歌。
  播放栏空间小，所以**不写「还没有人打分 / 我来打分」这类提示**：没分数就只显示标签和空心星，打过才出现数字。星星用 11px、字号 10px；窄屏（≤768px）下播放栏改成两行网格，评分单独占一格。

> 版本沿革：最初直接在卡片上点星星（星星小又要悬停预览，不好用）→ 改成点「我来打分」弹窗打分 → 半星用 `clip-path` 裁 SVG（浏览器上没生效）→ 改成宽度裁切双色（能看但难看）→ 现在换成自绘的三张配套图标。

## 二、访客身份

- 身份来自 Cloudflare 注入的 `CF-Connecting-IP`，经 `RATING_IP_SALT` 哈希后落盘，**R2 里不存在明文 IP**。
- 拿不到该头部时（异常链路），接口返回 `identified: false`，前端把评分行置为只读，不会静默把评分记到匿名桶里。
- 已知边界（见文末「局限」）：同一出口 IP 的人会被当成同一位访客。

## 三、接口

### `GET /api/rating/song?key=<歌名>&key=<歌名>...`

- 最多 64 个 `key`，重复的自动去重；无 `key` 返回 400。
- 返回：

```json
{
  "ok": true,
  "identified": true,
  "items": {
    "孤勇者": {
      "bucket": 13,
      "average": { "total": 16, "count": 2, "average": 8, "distribution": { "6": 1, "10": 1 } },
      "own": 6
    }
  }
}
```

- 只回**请求者自己**的评分；`distribution` 是各档位人数，不含任何访客标识。

### `PUT /api/rating/song?key=<歌名>`

```json
{ "key": "孤勇者", "score": 8, "confirmRemove": false }
```

- `score` 只接受 `1`–`10` 的整数（半颗星 = 1 分，奇数分同样合法）；`0` = 撤销评分且必须带 `confirmRemove: true`。
- `key` 可以放查询串或请求体；两处都给且不一致 → 400。
- 响应带更新后的 `average` 与 `own`，前端直接用它刷新卡片。
- 同一访客两次提交间隔小于 800ms → 429（同一 worker 实例内的轻量节流，不构成正确性依赖）。

## 四、存储与并发

R2 bucket `xsl_buttons`（与按钮墙、中意存档共用一个 bucket，前缀隔离）：

| Key | 内容 |
| --- | --- |
| `rating/v1/agg-<bucket>.json` | `{ songs: { <歌名>: { total, count, distribution, updatedAt } } }`（全站聚合，所有人可读） |
| `rating/v1/user-<bucket>.json` | `{ details: { <访客哈希>: { <歌名>: { score, at } } } }`（只回给本人） |

- 歌名按 djb2 哈希散到 16 个分片（`functions/_rating.js` 的 `BUCKET_COUNT`），一次评分只读写一对小文件。
- 两个文件都是**读-改-写 + ETag 条件写入**，冲突时指数退避重试（60ms 起步、上限 800ms、8 次）。这里有两个坑踩过：
  1. 无条件 `put` 会让并发评分互相覆盖（8 人同时打分只剩 1 人的记录），所以每次写入都必须带 `onlyIf`；
  2. 快照与 ETag **必须来自同一次 `get`**。先 `get` 拿数据、再 `head` 拿 ETag 的话，两次调用之间别人写入会让条件写入用新 ETag 覆盖旧快照，同样丢数据。
- 顺序固定为「先明细、后聚合」：明细已落盘而聚合没跟上时返回 409，前端会退避重试两次；重试时 delta 归零，聚合被自然补偿，不会重复计数。
- 歌名（`display_song_name || song_name`）是稳定键：跨房间、跨数据管线重建都不变，`song_id` 会随收录顺序浮动。

## 五、涉及文件

| 路径 | 说明 |
| --- | --- |
| `functions/_rating.js` | 共享逻辑：分片、归一化、IP 哈希、条件写入重试、聚合计算 |
| `functions/api/rating/song.js` | `GET`（单曲/批量读）/ `PUT`（写评分） |
| `js/rating.js` | 前端模块：卡片/播放栏挂载、懒加载、打分弹窗、提交与补偿重试 |
| `js/app.js` | 卡片 HTML 里加 `data-rating-key` / `data-rating-name` 与 `data-rating-host` 锚点（`getSongCardHtml`）；播放栏由 rating.js 自己盯 `#playerSongName` 同步 |
| `index.html` | `.song-rating*`（卡片与播放栏显示）、`.player-rating-host`（播放栏位置与窄屏网格）、`.rating-pop*` 弹窗样式，以及 `js/rating.js?v=N` 引用 |
| `scripts/tests/rating_api.test.mjs` | 内存 R2 跑后端逻辑：改分、撤销、批量读、8 人并发、冲突失败留痕 |
| `scripts/tests/_verify_rating_api.mjs` | 按 HTTP 契约直接调用 handler 的参数校验与读写用例 |
| `scripts/tests/_rating_preview_server.mjs` | 本地验证服务器：真实 handler + 内存 R2 + 静态文件 |

## 六、验证

```powershell
# 后端逻辑与并发
node --test scripts/tests/rating_api.test.mjs

# HTTP 契约（14 项）
node scripts/tests/_verify_rating_api.mjs

# 真实页面联调：起本地服务器后打开 http://127.0.0.1:8099/
node scripts/tests/_rating_preview_server.mjs
```

本地服务器给每个请求注入固定的 `CF-Connecting-IP`；加 `?ip=198.51.100.9` 可以模拟第二位访客，用来看平均分与「我的评分」是否正确分开。它还能在 `scripts/tests/` 下按 `_diag_xxx.js` 命名放一个页内诊断脚本，用 `DIAG_SCRIPT=__diag_xxx.js` 启动就会自动注入到 index.html 末尾（把断言结果 POST 到 `/__diag-log`，随后打印在终端），用来在真实页面上跑交互自检。

手工检查清单：桌面与窄屏各看一次卡片右下角两行是否美观；点「我来打分」弹出面板且面板完整落在视口内；面板里点左半星 = 1 分、右半星 = 2 分；打完后卡片第二行变成「我的 X 分」；再点开能改成别的分（人数不变、平均分跟着变）；「清除评分」后平均分回落；点面板外面会关闭；整个过程中点星星都不会触发卡片选中或播放。

播放栏：播放一首歌后，歌曲名右侧出现同样的两行评分；在播放栏上打分，列表里那张卡片要同步变化；切下一首歌时播放栏的评分要跟着换成新歌的（不能把上一首的评分留过去）；手机窄屏下播放栏是两行网格，评分占第二行中间那一格，不能把进度条挤没。

## 七、部署

1. 新文件必须进 `xsl-web-tools/deploy_web.ps1` 的 overlay 清单，否则 staging 只用 git HEAD 的版本：
   `js\rating.js`、`functions\_rating.js`、`functions\api\rating\song.js`（已在清单里；`js/rating.js` 同时在静态哈希校验清单里）。
2. 改了 `js/rating.js` 或 `index.html` 要按项目惯例升版本号（`js/rating.js?v=N`）。
3. 建议在 Cloudflare Pages 里配置 Secret `RATING_IP_SALT`（任意长随机串）。缺失时用代码内默认盐，哈希仍不可逆，但换盐会让已记录的评分与访客对不上——**上线后不要再改**。

```powershell
# 预检（不联网部署）
.\xsl-web-tools\deploy_web.ps1
# 条件化部署
.\xsl-web-tools\deploy_web.ps1 -Deploy -AllowOAuth
```

## 八、局限（按 IP 区分的已知边界）

- 同一 WiFi / 同一学校或公司出口的多人算**同一位访客**，会互相覆盖评分。
- 手机在移动网络下切换基站、IPv6 前缀轮换、开不开代理，都可能被认成新访客，于是「我的评分」丢失（旧评分仍计入平均分）。
- 这些是 IP 粒度本身的性质。若以后要求「一人一票、换网络也不丢」，需要换成登录账号或浏览器本地生成的持久访客 ID（可在此结构上叠加：把 `clientIdOf` 换成优先读签名 cookie，IP 哈希作为回退）。
