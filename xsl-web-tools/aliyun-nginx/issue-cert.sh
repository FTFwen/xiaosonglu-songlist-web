#!/usr/bin/env bash
# 签发正式 Let's Encrypt 证书（HTTP-01）并替换自签证书
set -e
echo "=== [1/4] 安装 acme.sh（若未装）==="
if [ ! -f ~/.acme.sh/acme.sh ]; then
  curl -s https://get.acme.sh | sh -s email=admin@viridis.love
  export PATH="$HOME/.acme.sh:$PATH"
fi
echo "=== [2/4] HTTP-01 验证并签发 ==="
# Nginx 80 端口的 /.well-known/acme-challenge/ 已在 viridis.conf 里配置 root 到 /var/www/certbot
~/.acme.sh/acme.sh --issue -d viridis.love -w /var/www/certbot --keylength ec-256 --server letsencrypt 2>&1 | tail -5
echo "=== [3/4] 安装证书到 Nginx 目录并热加载 ==="
~/.acme.sh/acme.sh --installcert -d viridis.love --ecc \
  --fullchain-file /etc/nginx/certs/viridis.love.fullchain.cer \
  --key-file /etc/nginx/certs/viridis.love.key \
  --reloadcmd "nginx -s reload"
echo "=== [4/4] 验证 ==="
openssl x509 -in /etc/nginx/certs/viridis.love.fullchain.cer -noout -subject -issuer -enddate
curl -s -o /dev/null -w "local-https: %{http_code}\n" https://127.0.0.1/ -H "Host: viridis.love" -k
echo "CERT-DEPLOY-DONE"
