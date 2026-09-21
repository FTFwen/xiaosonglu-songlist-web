#!/usr/bin/env bash
# =============================================================================
# setup-aliyun-accel.sh — viridis.love 国内加速节点一键部署（阿里云 ECS）
# 在 ECS（Ubuntu/Debian/Alibaba Cloud Linux）上以 root 执行：
#   bash setup-aliyun-accel.sh
# 前置条件：
#   1. 安全组已放行 80/443
#   2. 域名 viridis.love 已完成 ICP 备案
#   3. DNS 已按 README 配好（境内线路 → ECS 公网 IP）
# 脚本做：装 Nginx → 装 acme.sh 并签证书 → 放置配置 → 自检 → 重载
# =============================================================================
set -euo pipefail

DOMAIN="viridis.love"
CONF_SRC="$(cd "$(dirname "$0")" && pwd)/viridis.conf"
CONF_DST="/etc/nginx/conf.d/viridis.conf"
CERT_DIR="/etc/nginx/certs"
CACHE_DIR="/var/cache/nginx/viridis"
WEBROOT_CERTBOT="/var/www/certbot"

echo "==> [1/6] 安装 Nginx"
if ! command -v nginx >/dev/null 2>&1; then
    if command -v apt >/dev/null 2>&1; then
        apt-get update -qq && apt-get install -y -qq nginx
    elif command -v yum >/dev/null 2>&1; then
        yum install -y nginx && systemctl enable nginx
    else
        echo "不支持的包管理器，请手动安装 Nginx" && exit 1
    fi
fi

echo "==> [2/6] 准备目录"
mkdir -p "$CERT_DIR" "$CACHE_DIR" "$WEBROOT_CERTBOT/.well-known/acme-challenge"
# 缓存目录属主设为 nginx worker 用户（Debian 系 www-data / RHEL 系 nginx）
CACHE_USER=$(ps -o user= -p "$(cat /run/nginx.pid 2>/dev/null || pgrep -o nginx)" 2>/dev/null || echo nginx)
chown -R "${CACHE_USER}:root" "$CACHE_DIR" 2>/dev/null || chown -R nginx:root "$CACHE_DIR"

echo "==> [3/6] 安装 acme.sh 并签发证书（HTTP-01）"
if [ ! -f ~/.acme.sh/acme.sh ]; then
    curl -s https://get.acme.sh | sh -s email=admin@viridis.love
fi
if [ ! -f "$CERT_DIR/$DOMAIN.fullchain.cer" ]; then
    ~/.acme.sh/acme.sh --issue -d "$DOMAIN" -d www.viridis.love \
        -w "$WEBROOT_CERTBOT" --keylength ec-256 --server letsencrypt
    ~/.acme.sh/acme.sh --installcert -d "$DOMAIN" --ecc \
        --fullchain-file "$CERT_DIR/$DOMAIN.fullchain.cer" \
        --key-file "$CERT_DIR/$DOMAIN.key" \
        --reloadcmd "nginx -s reload"
fi

echo "==> [4/6] 放置站点配置"
# acme.sh HTTP-01 验证目录与配置里的 root 对齐
[ -f "$CONF_DST" ] && cp "$CONF_DST" "$CONF_DST.bak.$(date +%s)"
cp "$CONF_SRC" "$CONF_DST"
# 临时开放 80 端口的验证路径（配置文件里已含），先做语法检查
nginx -t

echo "==> [5/6] 生成 HTML 验证页（供 DNS 切换前自测）"
cat > /var/www/html/accel-check.html <<'EOF'
<!doctype html><meta charset="utf-8"><title>accel node ok</title>
<h1>ECS 加速节点工作正常</h1><p>如果你看到这个页面，说明 Nginx 已就绪。</p>
EOF

echo "==> [6/6] 启动并自检"
systemctl enable nginx
nginx -s reload 2>/dev/null || systemctl start nginx
sleep 1
curl -s -o /dev/null -w "local http:  %{http_code} (%{time_total}s)\n" http://127.0.0.1/accel-check.html
echo "==> 完成。下一步：阿里云 DNS 添加分线路解析（见 README），然后浏览器访问 https://viridis.love/ 验证"
