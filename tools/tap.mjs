// record a websocket stream to file for N seconds
import fs from "node:fs";
const [url, out, secs] = process.argv.slice(2);
const f = fs.createWriteStream(out);
const ws = new WebSocket(url);
let n = 0;
ws.onmessage = (e) => { f.write(String(e.data) + "\n"); n++; };
ws.onclose = (e) => { console.error("closed", e.code); };
setTimeout(() => { console.error("msgs", n); f.end(() => process.exit(0)); }, Number(secs) * 1000);
