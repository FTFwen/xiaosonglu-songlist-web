# xsl-listen-room

独立部署的 Cloudflare Worker + Durable Object 房间协调器。Pages 只负责页面与歌曲静态音频；本 Worker 只传输播放控制状态，不转发音频字节。

## 接口

- `POST /rooms`：创建临时房间，返回 `{ roomCode, hostToken }`。`hostToken` 只在创建响应返回，前端需保存。
- `GET /rooms/<8位房间号>?role=host&token=<hostToken>`：房主 WebSocket。
- `GET /rooms/<8位房间号>?role=member`：成员 WebSocket。
- `GET /health`：健康检查。

客户端发 `state` 或低频 `heartbeat`：

```json
{"type":"state","state":{"track":{"songId":1,"rowKey":"...","name":"...","artist":"","assetVersion":"sha256前缀"},"playing":true,"positionSeconds":12.3,"playMode":"list"}}
```

服务端广播带单调 `revision`、`changedAtServerMs` 与 `serverNowMs` 的 `snapshot`。房主断开后保留 30 秒重连窗口，房间空闲 1 小时或最长 24 小时关闭；单房间最多 20 个连接。仅房主可以改变播放状态，成员音量由本地控制。

## 部署

Pages 文档要求 Durable Object 由独立 Worker 创建/部署，不能在 Pages 项目内创建。首次部署：

```powershell
npx wrangler@4.130.0 deploy --config workers/listen-room/wrangler.toml
```

生产建议将 `sync.viridis.love` 路由到此 Worker；完成自定义域后，把主站前端端点设置为 `wss://sync.viridis.love`，并重新部署 Pages。不要把 host token、管理员 secret 或歌曲外部 URL 放进日志/广播。

本地开发需要在 Worker 目录运行 `npx wrangler dev --config wrangler.toml`；Pages 本地页用同源或配置的 WebSocket 端点连接。生产部署前应先在 Cloudflare 控制台确认 Durable Object namespace、迁移和自定义域均已生效。
