# viridis.love 国内加速部署手册（阿里云 ECS + Nginx 反代 Cloudflare Pages）

## 架构

```
国内用户 ──(阿里云DNS 境内线路)──▶ ECS (Nginx 443, 备案域名)
                                    ├─ 静态资源/音频 → 本地磁盘缓存 30 天（命中即毫秒级）
                                    ├─ /data/*.json → 60s 微缓存 + stale 兜底
                                    ├─ /api/*       → 透明转发 CF（零缓存）
                                    └─ 页面         → 1m 微缓存 + stale 兜底（CF 抽风不白屏）
境外用户 ──(默认线路)──────────▶ Cloudflare Pages（现状不变）
```

**收益**：
- 音频（站内最大流量，207 个 m4a 共 ~830MB）首次回源后走 ECS 本地缓存，国内播放不再卡
- 页面 60s~1m 微缓存 + `proxy_cache_use_stale`：CF 不稳定时国内用户照样能打开
- 动态 API（评分/收藏/登录/音频管理）保持 CF 单数据源，无同步/一致性问题
- 境外用户体验不变（仍直连 CF）

**不做**（明确排除，避免过度工程）：
- 不把 API 迁到 ECS——9 个 Pages Functions 依赖 R2/KV/Secrets，迁移=重写+双写一致性噩梦
- 不做双活——数据源仍只有 CF 一份，ECS 只读缓存

## 一、前置检查（阿里云控制台）

1. **ECS 公网 IP**：记下来（下称 `<ECS_IP>`）
2. **安全组**：入方向放行 TCP 80、443（源 0.0.0.0/0）
3. **ICP 备案**：确认备案号挂在 viridis.love 域名上（备案主体与域名注册商一致；域名在 CF NS 托管不影响备案，但**解析必须指向国内 IP 才合规**）
4. **系统**：Ubuntu 22.04/24.04 或 Alibaba Cloud Linux 3（脚本支持 apt/yum）

## 二、部署（ECS 上执行）

```bash
# 1. 拉取本目录（或 scp 上去）
scp -r xsl-web-tools/aliyun-nginx root@<ECS_IP>:/opt/

# 2. 一键部署
ssh root@<ECS_IP>
cd /opt/aliyun-nginx && bash setup-aliyun-accel.sh
```

脚本幂等，重复执行安全。证书 90 天自动续期（acme.sh 装了 cron）。

## 三、DNS 分线路解析（关键步骤）

**阿里云云解析 DNS**（https://dns.console.aliyun.com）：

> 注意：域名 NS 目前在 Cloudflare（garret/suzanne.ns.cloudflare.com）。
> 要用阿里云分线路解析，需先把 **NS 切回阿里云**（DNS 控制台添加域名 → 修改注册商处 NS 为阿里云分配的两条）。
> NS 切换不影响 CF 上的站点，只是解析服务商换了。

| 主机记录 | 记录类型 | 线路 | 记录值 | TTL |
|---------|---------|------|--------|-----|
| `@` | A | **境外** | 104.21.45.31 | 600 |
| `@` | A | **境外** | 172.67.208.56 | 600 |
| `@` | A | **默认** | `<ECS_IP>` | 600 |
| `www` | CNAME | **默认** | `@` | 600 |
| `www` | A | **境外** | 104.21.45.31 | 600 |

**效果**：境内用户（运营商递归 DNS 走阿里权威）解析到 ECS；境外用户解析到 CF 边缘。
（阿里云免费版 DNS 就支持「境外/默认」两条线路，够用；若用付费版可细化到省份。）

**验证**：
```bash
# 国内视角（ECS 上）
curl -s https://viridis.love/ -o /dev/null -w "%{http_code} %{time_total}s\n"
dig viridis.love @223.5.5.5 +short    # 应返回 ECS IP
dig viridis.love @1.1.1.1 +short     # 境外视角，应返回 CF IP
```

## 四、验证清单（切 DNS 后逐项过）

- [ ] `https://viridis.love/` 国内打开 < 500ms（ECS 缓存命中时 < 50ms）
- [ ] 歌曲播放、拖进度条正常（Range 透传）
- [ ] 按钮墙 `/buttons/` 正常
- [ ] 评分/收藏/登录正常（API 走 CF）
- [ ] `curl -sI https://viridis.love/assets/audio/song_198.m4a | grep X-Cache-Status` → 二次请求应为 `HIT`
- [ ] 境外访问不受影响（CF IP 直连）
- [ ] 手机端正常（中秋皮肤按设计屏蔽不受影响）

## 五、运维备忘

- **缓存清理**：部署新版后想立即刷新页面缓存：`rm -rf /var/cache/nginx/viridis/* && nginx -s reload`
  （音频带 `?v=` 哈希，新版自动换 URL，无需清缓存）
- **看命中率**：`awk '{print $NF}' /var/log/nginx/viridis.access.log | sort | uniq -c`（需在 log_format 加 $upstream_cache_status）
- **CF 回源质量监控**：`tail -f /var/log/nginx/viridis.error.log` 看 upstream timeout
- **回滚**：DNS 默认线路改回 CF IP 即可，ECS 可整台下线，零风险
- **证书**：acme.sh 自动续期，`~/.acme.sh/acme.sh --list` 查看

## 六、已知限制（如实告知）

1. **API 动态请求仍走 CF**——国内用户评分/收藏的延迟取决于 ECS→CF 回源质量（阿里云国际出口通常 150-250ms，比家宽直连稳一个量级）。若某 API 实测仍慢，后续可单独为 `/api/rating` 之类加 5s 微缓存。
2. **首页仍是 DYNAMIC**——CF 那边 `cache-control: must-revalidate`，但 ECS 1 分钟微缓存已把它挡在国内。
3. **合规**：解析指国内 IP + 备案 = 合规；境外线路指 CF 是常见做法，无问题。
4. NS 从 CF 切回阿里云后，**CF 内的 DNS 记录要导一份**（目前只有 viridis.love 本身 + pages.dev 别名，很简单）。
