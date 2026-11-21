import { World } from "../bot/map.ts"
import fs from "node:fs"
const w = new World(new URL("../kit/arena", import.meta.url).pathname)
fs.writeFileSync("logs/walk.bin", w.walk)
fs.writeFileSync("logs/hN.bin", Buffer.from(w.hN.buffer))
fs.writeFileSync("logs/walk.json", JSON.stringify({ nnx: w.nnx, nny: w.nny, nox: w.nox, noy: w.noy }))
