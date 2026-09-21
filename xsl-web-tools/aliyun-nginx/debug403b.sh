#!/usr/bin/env bash
URL='https://xsl-songlist.pages.dev/assets/audio/song_198.m4a?v=592076841dda'
echo "=== A. 裸请求 ==="
curl -sk -o /dev/null -w '%{http_code}\n' "$URL"
echo "=== B. 带 nginx 风格头 ==="
curl -sk -o /dev/null -w '%{http_code}\n' "$URL" \
  -H 'Host: xsl-songlist.pages.dev' \
  -H 'X-Real-IP: 101.86.22.113' \
  -H 'X-Forwarded-For: 101.86.22.113' \
  -H 'X-Forwarded-Proto: https' \
  -H 'X-Original-Host: viridis.love' \
  -H 'Connection: close'
echo "=== C. 经 nginx 再看一次（带 -v 抓错误细节）==="
curl -skv -o /dev/null 'https://127.0.0.1/assets/audio/song_198.m4a?v=592076841dda' -H 'Host: viridis.love' 2>&1 | grep -E '^< HTTP|^< cf-|^< x-cache' | head -6
echo "=== D. origin 不带 query ==="
curl -sk -o /dev/null -w '%{http_code}\n' 'https://xsl-songlist.pages.dev/assets/audio/song_198.m4a'
echo "=== E. HEAD vs GET ==="
curl -sk -I -o /dev/null -w 'HEAD: %{http_code}\n' "$URL"
