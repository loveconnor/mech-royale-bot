# Mech Royale bot (mechfight/1). Build: docker build -t mech-bot .
# Runs with no network, read-only root (writable /tmp), 1 CPU, 512 MB, map mounted at /arena.
FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY bot/ /bot/
ENV MF_HUNT=1 MF_NPCHUNT=1 MF_LOOT=160 MF_CRATEW=0.6 MF_RETREAT=0.2 MF_EVADET=120
ENTRYPOINT ["bun", "/bot/bot.ts"]
