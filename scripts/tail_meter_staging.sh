#!/usr/bin/env bash
# Live-watch the worker's per-charge [meter] log on STAGING while you chat.
# The [meter] line now includes cachedTok, so you can see the implicit-cache hit directly:
#   [meter] {"action":"chat","model":"gemini-3.1-pro-preview","inTok":219000,"outTok":1200,"cachedTok":0,"credits":194,...}      <- COLD (first msg)
#   [meter] {"action":"chat",...,"inTok":219100,"outTok":900,"cachedTok":218900,"credits":25,...}                                <- WARM (cache hit)
#
# Run it, then send chat messages in the app. Ctrl-C to stop.
cd "$(dirname "$0")/.." || exit 1
npx wrangler tail --env staging --format pretty 2>&1 | grep --line-buffered -E '\[meter\]|chat'
