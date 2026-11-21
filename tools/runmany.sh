#!/bin/bash
# usage: tools/runmany.sh <tag> <rooms> <matches_per_room> [env...]
tag=$1; n=$2; nm=$3; shift 3
mkdir -p logs/$tag
rm -rf logs/$tag/bot && cp -r bot logs/$tag/bot
for i in $(seq 1 $n); do
  env "$@" NMATCH=$nm BOTNAME=osu-$tag node tools/bridge.mjs logs/$tag/r$i -- bun logs/$tag/bot/bot.ts > logs/$tag/r$i.err 2>&1 &
  sleep 3
done
wait
python3 tools/summary.py logs/$tag
