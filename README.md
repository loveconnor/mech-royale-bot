# Mech Royale bot

A `mechfight/1` bot for the Builders Buildathon **Mech Royale** track: 16-mech battle royale on the Ohio State campus.

The `Dockerfile` sits at the repo root. It builds a Bun image that runs `bot/bot.ts`.

## How it plays

- **World model** (`bot/map.ts`): loads `/arena/v2/world.json` and `terrain.i16`, then builds:
  - a 1 m surface-height raster (terrain, roofs, stadium stands);
  - a prism spatial hash for line-of-sight checks;
  - a 2 m multi-level navigation grid. Moves can step up 1.2 m and drop down any height. "Hop" edges let the A* search jet over walls and cliffs up to 40 m when there is energy.
- **Navigation**: A* with lookahead smoothing. The bot jumps and jets when a path climbs, gets unstuck when blocked, and escapes roofs and the stadium bowl.
- **Zone**: reads the live circle from each observation and gets inside the next circle with time to spare. A latch stops it flip-flopping at the edge.
- **Loot**: weapon priority is laser > lightning > mortar (the gun is always kept). It explores until it finds a special weapon, collects cubes (including going back to kill sites), shoots crates and NPC drones for cubes, and moves toward a supply drop before it lands if it can reach and hold the ring before a nearby rival. A capture restores full HP and energy. During a fight it favors nearby cube clusters on walkable paths until the ten-cube HP and damage cap. Beyond the cap it makes a short combat detour only if the next cube unlocks an upgrade.
- **Combat**:
  - estimates pressure separately for each visible mech using recent hits, facing, charging, and closing speed. When several opponents are in view, it uses their estimated pressure and remaining HP to select a target and decide whether to retreat.
  - accounts for the rear damage multiplier when choosing between visible targets and circles toward the exposed side of distracted opponents;
  - between mech engagements, turns its front armor toward the directions responsible for the most recent damage;
  - leads the gun using the target's velocity and fires only when the torso is actually aligned and the line of fire is clear;
  - charges the laser and releases it at full charge when aligned (hitscan, no lead);
  - uses lightning in its cone, and mortar for far or indirect targets;
  - strafes unpredictably, dodges incoming mortar shells, and faces its attacker to avoid the 1.5× rear damage.
- **Retreat**: compares time-to-kill with time-to-live. It falls back to a cover point that breaks line of sight from all threats, keeps shooting while it backs off, and re-engages once it has regenerated. When several opponents have line of sight and can win the exchange, it heads for cover even at high HP. It avoids shooting crates and drones while withdrawing so it can regenerate.
- **Upgrades**: armor, then nanites, plating, and laser/gun upgrades.

## Test locally

```sh
# conformance check (kit from the track page, unpacked into ./kit)
python3 kit/check/check.py -- bun bot/bot.ts
docker build -t mech-bot .
python3 kit/check/check.py --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m \
  --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/kit/arena:/arena:ro" mech-bot
```

`tools/bridge.mjs` runs the bot in a private room on play.joinbuilders.org; empty seats are filled by house bots. `tools/runmany.sh` runs batches of matches and summarizes placement, kills and damage.
