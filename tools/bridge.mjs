// Bridge: run a mechfight/1 bot process in a private room on play.joinbuilders.org (empty seats = house bots).
// Plays NMATCH consecutive matches in the same room.
// usage: NMATCH=3 node tools/bridge.mjs <logprefix> -- <bot command...>    -> <logprefix>_<k>.jsonl
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

const HOST = "play.joinbuilders.org";
const args = process.argv.slice(2);
const sep = args.indexOf("--");
const prefix = args[0];
const cmd = args.slice(sep + 1);
const NMATCH = Number(process.env.NMATCH || 1);
const sid = "s" + Math.random().toString(36).slice(2, 12);
const name = process.env.BOTNAME || "probe";
const MAPDIR = process.env.MAPDIR || new URL("../kit/arena", import.meta.url).pathname;

async function newCode() {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`https://${HOST}/mm/code/new?sid=${sid}`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    if (r.code) return r;
    console.error("code/new:", JSON.stringify(r));
    await new Promise((s) => setTimeout(s, (r.retry_s || 5) * 1000 + Math.random() * 5000));
  }
  throw new Error("no room");
}

const { code, room } = process.env.ROOM ? { code: process.env.CODE, room: Number(process.env.ROOM) } : await newCode();
console.error(`room ${room} code ${code}`);
const url = `wss://${HOST}/r/${room}/play?token=&sid=${sid}&name=${encodeURIComponent(name)}&code=${code}`;
const ws = new WebSocket(url);
let k = 0; // match index
let bot = null, log = null, inMatch = false, startSentAt = 0, readySent = false;
let lastObsAt = 0;
let stats = { obs: 0, late: 0 };

function startBot() {
  const b = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
  const myLog = log;
  const rl = readline.createInterface({ input: b.stdout });
  rl.on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === "ready") return;
    const dt = Date.now() - lastObsAt;
    if (dt > 50) stats.late++;
    if (ws.readyState === 1 && b === bot) ws.send(line);
    try { myLog.write(JSON.stringify({ act: m, dt }) + "\n"); } catch {}
  });
  b.on("exit", () => {});
  return b;
}

function endMatch() {
  console.error(`match ${k} done`, JSON.stringify(stats));
  try { bot?.kill(); } catch {}
  bot = null;
  const l = log; log = null; l?.end();
  inMatch = false;
  k++;
  stats = { obs: 0, late: 0 };
  if (k >= NMATCH) setTimeout(() => { try { ws.close(); } catch {} ; process.exit(0); }, 1500);
}

ws.onopen = () => console.error("ws open");
ws.onclose = (e) => { console.error("ws close", e.code, e.reason); if (log) endMatch(); process.exit(0); };
ws.onerror = (e) => console.error("ws error", e.message);
ws.onmessage = (ev) => {
  let m;
  try { m = JSON.parse(String(ev.data)); } catch { return; }
  if (m.type === "lobby") {
    if (!readySent || (m.you && !m.you.ready)) { readySent = true; ws.send(JSON.stringify({ type: "ready", name })); }
    if (!inMatch && k < NMATCH && m.you?.host && m.phase !== "running" && Date.now() - startSentAt > 4000) {
      startSentAt = Date.now();
      setTimeout(() => ws.send(JSON.stringify({ type: "start", ...(process.env.STARTX ? JSON.parse(process.env.STARTX) : {}) })), 800);
    }
    return;
  }
  if (m.type === "hello") {
    m.map.dir = MAPDIR;
    inMatch = true;
    log = fs.createWriteStream(`${prefix}_${k}.jsonl`);
    log.write(JSON.stringify(m) + "\n");
    bot = startBot();
    bot.stdin.write(JSON.stringify(m) + "\n");
    return;
  }
  if (m.type === "obs") {
    stats.obs++;
    lastObsAt = Date.now();
    log?.write(JSON.stringify(m) + "\n");
    try { bot?.stdin.write(JSON.stringify(m) + "\n"); } catch {}
    return;
  }
  if (m.type === "end") {
    log?.write(JSON.stringify(m) + "\n");
    try { bot?.stdin.write(JSON.stringify(m) + "\n"); bot?.stdin.end(); } catch {}
    return;
  }
  if (m.type === "results") {
    log?.write(JSON.stringify(m) + "\n");
    if (log) endMatch();
    return;
  }
};
setTimeout(() => { console.error("timeout"); process.exit(0); }, 60 * 60 * 1000);
