#!/usr/bin/env bash
rm -rf /var/cache/nginx/viridis/*
echo "=== 403 body ==="
curl -sk 'https://127.0.0.1/assets/audio/song_198.m4a?v=592076841dda' -H 'Host: viridis.love' | head -c 400
echo ""
echo "=== origin direct GET ==="
curl -sk -o /dev/null -w 'GET full: %{http_code}\n' 'https://xsl-songlist.pages.dev/assets/audio/song_198.m4a?v=592076841dda'
echo "=== origin with empty Range ==="
curl -sk -o /dev/null -H 'Range;' -H 'If-Range;' -w 'empty-range: %{http_code}\n' 'https://xsl-songlist.pages.dev/assets/audio/song_198.m4a?v=592076841dda'
