# Mech Royale bot (mechfight/1). Build: docker build -t mech-bot .
# Runs with no network, read-only root (writable /tmp), 1 CPU, 512 MB, map mounted at /arena.
FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY bot/ /bot/
ENV MF_HUNT=1 MF_NPCHUNT=1 MF_LOOT=160 MF_CRATEW=0.6 MF_RETREAT=0.2
ENV MF_UPS=armor,plating,nanites,gun_damage,laser_damage,gun_rate,laser_charge,servos,reactor,gyros,lightning_efficiency,gun_mag,gun_velocity,capacitor,jets,sensors,lightning_range,lightning_chain,mortar_reload,mortar_velocity,mortar_splash,laser_pierce
ENTRYPOINT ["bun", "/bot/bot.ts"]
