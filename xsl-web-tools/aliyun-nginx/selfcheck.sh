#!/usr/bin/env bash
# ECS 上自检：回源质量 + 缓存命中
echo "=== ECS -> CF 回源质量（3 次）==="
for i in 1 2 3; do
  curl -s -o /dev/null -w "cf-origin: HTTP %{http_code} dns=%{time_namelookup}s tls=%{time_appconnect}s total=%{time_total}s\n" https://viridis.love/
done
echo "=== 本地缓存命中（X-Cache-Status）==="
curl -sk -o /dev/null -w "home(2nd): %{http_code} " https://127.0.0.1/ -H "Host: viridis.love"
curl -skI https://127.0.0.1/ -H "Host: viridis.love" 2>/dev/null | grep -i x-cache-status
curl -sk -o /dev/null -w "audio(2nd): %{http_code} " https://127.0.0.1/assets/audio/song_198.m4a?v=592076841dda -H "Host: viridis.love"
curl -skI "https://127.0.0.1/assets/audio/song_198.m4a?v=592076841dda" -H "Host: viridis.love" 2>/dev/null | grep -i x-cache-status
echo "=== API 转发测试 ==="
curl -sk -o /dev/null -w "api/data: %{http_code} (%{time_total}s)\n" https://127.0.0.1/api/data -H "Host: viridis.love"
curl -sk -o /dev/null -w "api/live-status: %{http_code} (%{time_total}s)\n" https://127.0.0.1/api/live-status -H "Host: viridis.love"
