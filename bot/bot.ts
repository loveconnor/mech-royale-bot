// Mech Royale bot: navigation, looting, target selection, lead aiming, weapon handling, cover and zone play.
import { type Action, draw, type Hello, type Observation, run } from "./mechfight.ts"
import { World } from "./map.ts"

type V3 = [number, number, number]
type Track = { id: number; kind: string; pos: V3; vel: V3; aim: [number, number]; hp: number; maxHp: number; cubes: number; weapons: string[]; charging: boolean; seenT: number; firstT: number; vis: boolean }

const TAU = Math.PI * 2
const wrap = (a: number) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const d2 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])
const d3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

const ENV = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d)
const P = {
  wantSlot: (process.env.MF_WEAPONS || "laser,lightning,mortar").split(","),
  retreatHp: ENV("MF_RETREAT", 0.25),
  reengageHp: ENV("MF_REENGAGE", 0.85),
  lootRange: ENV("MF_LOOT", 90),
  npcFarm: ENV("MF_NPC", 1),
  crateFarm: ENV("MF_CRATE", 1),
  dropGo: ENV("MF_DROP", 1),
  seek: ENV("MF_SEEK", 0),
  dropGun: ENV("MF_DROPGUN", 0),
  ttkRatio: ENV("MF_TTK", 1.0),
  regen: ENV("MF_REGEN", 0),
  lead: ENV("MF_LEAD", 1.0),
  jinkMin: ENV("MF_JINKMIN", 0.3),
  jinkVar: ENV("MF_JINKVAR", 0.5),
  fboost: ENV("MF_FBOOST", 0),
}

const UPGRADE_PREF = ["armor", "nanites", "plating", "laser_damage", "laser_charge", "gun_rate", "gun_damage", "lightning_efficiency", "gyros", "lightning_range", "lightning_chain", "gun_mag", "gun_velocity", "mortar_reload", "sensors", "servos", "capacitor", "reactor", "jets", "mortar_velocity", "mortar_splash", "laser_pierce"]

let W: World | null = null

class Bot {
  name = "osu-mech"
  cfg: any
  t = 0
  tracks = new Map<number, Track>()
  me: any
  myEye = 8
  myMuzzle = 7
  myR = 2.5
  // threat memory
  dmgLog: { t: number; by: number | null; amt: number; bearing: number | null }[] = []
  lastDmgT = -99
  lastDealT = -99
  // navigation
  path: number[] | null = null
  pathGoal: [number, number] | null = null
  pathT = -99
  pathIdx = 0
  stuckN = 0
  lastPos: V3 = [0, 0, 0]
  strafeDir = 1
  strafeT = 0
  jinkT = 0
  mode = "init"
  modeTarget = -1
  scanPhase = 0
  laserHold = 0
  crateMem = new Map<number, { pos: V3; hp: number; t: number }>()
  pickMem = new Map<number, { pos: V3; kind: string; t: number }>()
  cubeMem = new Map<number, { pos: V3; t: number }>()
  badPick = new Map<number, number>()
  killSites: { pos: V3; t: number }[] = []
  retreating = false
  coverGoal: [number, number] | null = null
  coverT = -99
  zoneLatch = false
  rng: () => number

  constructor(hello: Hello) {
    this.cfg = hello.config
    let s = (hello.seed >>> 0) || 1
    this.rng = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
    if (!W) {
      W = new World(hello.map.dir)
      // warm up the JIT on the hot paths while we still have the hello budget
      for (let i = 0; i < 40; i++) {
        const ax = -400 + ((i * 97) % 800), ay = -250 + ((i * 53) % 500)
        W.astar(ax, ay, undefined, -ax * 0.5, -ay * 0.5, null, 20000)
        W.blocked(ax, ay, 5, -ax, -ay, 5, 1.5)
        W.walkLine(ax, ay, ax + 30, ay + 20)
      }
    }
  }

  t0 = 0
  busy(ms = 18) { return performance.now() - this.t0 > ms }
  act(obs: Observation): Omit<Action, "tick"> {
    this.t0 = performance.now()
    const me = obs.self
    this.me = me
    this.t = obs.t
    const st: any = me.stats || {}
    this.myEye = st.eye_height ?? 8
    this.myMuzzle = st.muzzle_height ?? 7
    this.myR = st.radius ?? 2.5
    const act: any = {}
    this.updateTracks(obs)
    this.handleEvents(obs)

    // upgrades
    if (obs.offer) act.pick = this.pickUpgrade(obs.offer)

    const pos = me.pos as V3
    const hpFrac = me.hp / me.max_hp

    // --- targets ---
    const enemies = [...this.tracks.values()].filter((t) => t.kind === "mech" && this.t - t.seenT < 4)
    const npcs = [...this.tracks.values()].filter((t) => t.kind === "npc" && this.t - t.seenT < 1)
    const target = this.chooseTarget(enemies)
    const recentlyHurt = this.t - this.lastDmgT < 3
    const dangerEnemies = enemies.filter((e) => d2(e.pos, pos) < 160 && this.t - e.seenT < 2)

    // --- zone ---
    const zone = this.zoneInfo(obs)

    // --- weapon pickup logic ---
    this.lootActions(obs, act)

    // --- choose movement goal ---
    let goal: [number, number] | null = null
    let face: number | null = null // desired aim yaw when no target
    let boost = false
    let mode = "roam"
    const losThreats = dangerEnemies.filter((e) => this.t - e.seenT < 1.0 && this.losClear(pos, e))
    // time-to-kill comparison
    let theirDps = 0
    for (const e of losThreats) theirDps += this.dpsOf(e.weapons, e.cubes, d2(e.pos, pos))
    const armor = (me.stats as any)?.armor ?? 0
    const myTTL = (me.hp / Math.max(0.2, 1 - armor)) / Math.max(1, theirDps)
    const tgtHp = target ? target.hp : 1e9
    const myTTK = target ? tgtHp / Math.max(1, this.myDps(d2(target.pos, pos))) : 1e9
    const losing = losThreats.length > 0 && myTTL < myTTK * P.ttkRatio
    this.dbg = `ttl${myTTL.toFixed(1)} ttk${myTTK.toFixed(1)}`
    if (!this.retreating && (hpFrac < P.retreatHp || (losing && hpFrac < 0.7)) && (dangerEnemies.length > 0 || recentlyHurt) && !(target && myTTK < 2.5 && !losing)) { this.retreating = true; this.coverGoal = null }
    if (this.retreating && hpFrac > P.reengageHp) this.retreating = false
    // the target is nearly dead and we can finish it: keep fighting
    if (this.retreating && target && losThreats.length === 1 && myTTK < myTTL * 0.7 && this.t - target.seenT < 0.5) this.retreating = false
    // an enemy right on top of us: fight instead of turning our back
    const closeFight = target && this.t - target.seenT < 0.6 && d2(target.pos, pos) < 22 && this.losClear(pos, target)

    let wg: { pos: [number, number]; what: string } | null = null
    const zoneUrgent = zone.urgent
    if (zoneUrgent || !me.in_zone) {
      mode = "zone"
      goal = zone.safePoint
      boost = !me.in_zone || zone.veryUrgent
    } else if (this.retreating && !closeFight) {
      mode = "retreat"
      const threats = dangerEnemies.length ? dangerEnemies : enemies.filter((e) => this.t - e.seenT < 6)
      if (threats.length) {
        if (!this.coverGoal || (this.t - this.coverT > 1.5 && !this.busy(12))) { this.coverGoal = this.coverPoint(pos, threats, zone); this.coverT = this.t }
        goal = this.coverGoal
        boost = d2(pos, goal) > 4 && recentlyHurt
      } else {
        mode = "regen"
        goal = [pos[0], pos[1]]
      }
    } else if ((wg = !this.hasSpecial() ? this.lootGoal(obs, zone, enemies, true) : null) && wg.what === "wpn" && !(target && d2(target.pos, pos) < 60 && this.dmgFrom(target.id, 4) > 0)) {
      mode = "getweapon"
      goal = wg.pos
    } else if (target && this.wantEngage(target, hpFrac, enemies)) {
      mode = "fight"
      goal = this.fightPosition(target, zone, enemies)
    } else if (P.regen && hpFrac < 0.8 && this.t - this.lastDmgT > 1 && !dangerEnemies.length) {
      mode = "regen"
      goal = [pos[0], pos[1]]
    } else {
      const lg = this.lootGoal(obs, zone, enemies, false)
      if (lg) { mode = "loot:" + lg.what; goal = lg.pos }
      else {
        const dg = P.dropGo ? this.dropGoal(obs, zone, enemies) : null
        if (dg) { mode = "drop"; goal = dg }
        else if (!this.hasSpecial()) { mode = "explore"; goal = this.explore(zone) }
        else { mode = "roam"; goal = this.roamGoal(zone) }
      }
    }
    this.mode = mode

    // --- movement ---
    let mv = goal ? this.steer(pos, goal) : [0, 0]
    if (mode === "fight" && target) {
      mv = this.fightMove(target, mv)
      if (P.fboost && me.energy > P.fboost && this.t - target.seenT < 0.5 && this.losClear(pos, target)) boost = true
    }
    const evade = this.shellEvade(obs)
    if (evade) { mv = evade; boost = true }
    if (me.weapons.some((w: any) => w && w.kind === "laser" && w.charge > 0)) boost = false
    // stuck handling
    const sp = Math.hypot(me.vel[0], me.vel[1])
    const wantMove = Math.hypot(mv[0], mv[1]) > 0.3
    if (wantMove && sp < 1.5 && me.grounded) this.stuckN++
    else if (sp > 3) this.stuckN = 0
    let jump = false
    if (this.stuckN > 5) {
      this.path = null
      if (this.stuckN < 12) { const a = Math.atan2(mv[1], mv[0]) + (this.stuckN % 2 ? 1.2 : -1.2); mv = [Math.cos(a), Math.sin(a)] }
      else { jump = true; if (this.stuckN > 20) this.stuckN = 0 }
    }
    if (boost && me.energy < 25 && me.in_zone && !evade) boost = false
    if (this.climbH !== null) {
      const rise = this.climbH - pos[2]
      const need = rise * 1.7 + 10
      if (me.grounded) {
        if (me.energy >= Math.min(need, 95)) { jump = true; boost = true }
        else if (rise > 3) mv = [mv[0] * 0.2, mv[1] * 0.2] // wait for energy near the wall
      } else boost = pos[2] < this.climbH + 1.5 && me.energy > 2
      this.stuckN = 0
    } else if (!me.grounded && me.vel[2] > 0 && this.stuckN === 0) boost = boost && me.energy > 30
    act.move = mv
    act.boost = boost
    act.jump = jump

    // --- aim & fire ---
    this.aimAndFire(obs, act, target, npcs, face, mv)

    // debug
    draw.label(`${mode} hp${Math.round(me.hp)} t${target ? target.id : "-"} c${me.cubes} ${this.dbg}`)
    if (goal) draw.point([goal[0], goal[1], pos[2] + 1], "#40c0ff", 5)
    this.lastPos = pos
    return act
  }

  // ---------------- perception ----------------
  updateTracks(obs: Observation) {
    const seen = new Set<number>()
    for (const m of obs.mechs as any[]) {
      seen.add(m.id)
      const old = this.tracks.get(m.id)
      this.tracks.set(m.id, {
        id: m.id, kind: m.kind, pos: m.pos, vel: m.vel, aim: m.aim, hp: m.hp ?? old?.hp ?? 1400, maxHp: m.max_hp ?? old?.maxHp ?? 1400,
        cubes: m.cubes ?? 0, weapons: m.weapons ?? [], charging: !!m.charging, seenT: this.t, firstT: old && this.t - old.seenT < 6 ? old.firstT : this.t, vis: true,
      })
    }
    for (const [id, tr] of this.tracks) {
      if (!seen.has(id)) {
        tr.vis = false
        const dt = 0.1
        tr.pos = [tr.pos[0] + tr.vel[0] * dt, tr.pos[1] + tr.vel[1] * dt, tr.pos[2]]
        if (this.t - tr.seenT > 8) this.tracks.delete(id)
      }
    }
    for (const c of obs.crates as any[]) this.crateMem.set(c.id, { pos: c.pos, hp: c.hp, t: this.t })
    for (const p of obs.pickups as any[]) this.pickMem.set(p.id, { pos: p.pos, kind: p.kind, t: this.t })
    for (const c of obs.cubes as any[]) this.cubeMem.set(c.id, { pos: c.pos, t: this.t })
    // forget items that should be visible but are not (near range)
    const me = obs.self.pos
    const visC = new Set((obs.crates as any[]).map((c) => c.id)), visP = new Set((obs.pickups as any[]).map((c) => c.id)), visQ = new Set((obs.cubes as any[]).map((c) => c.id))
    for (const [id, c] of this.crateMem) if (!visC.has(id) && (d2(c.pos, me) < 30 || this.t - c.t > 60)) this.crateMem.delete(id)
    for (const [id, c] of this.pickMem) if (!visP.has(id) && (d2(c.pos, me) < 30 || this.t - c.t > 90)) this.pickMem.delete(id)
    for (const [id, c] of this.cubeMem) if (!visQ.has(id) && (d2(c.pos, me) < 30 || this.t - c.t > 60)) this.cubeMem.delete(id)
  }

  handleEvents(obs: Observation) {
    for (const e of obs.events as any[]) {
      if (e.type === "damaged") {
        this.dmgLog.push({ t: this.t, by: e.by, amt: e.amount, bearing: e.bearing })
        if (e.weapon !== "zone") this.lastDmgT = this.t
      } else if (e.type === "kill") {
        const tr = this.tracks.get(e.target)
        if (tr) this.killSites.push({ pos: [tr.pos[0], tr.pos[1], tr.pos[2]], t: this.t })
      } else if (e.type === "hit") {
        this.lastDealT = this.t
        const tr = this.tracks.get(e.target)
        if (tr && tr.kind === "npc" && tr.hp - e.amount <= 0) this.killSites.push({ pos: [tr.pos[0], tr.pos[1], tr.pos[2]], t: this.t })
      } else if (e.type === "take_failed") {
        this.badPick.set(e.id, this.t)
      }
    }
    while (this.dmgLog.length && this.t - this.dmgLog[0].t > 8) this.dmgLog.shift()
  }

  dmgFrom(id: number, win = 4) {
    let s = 0
    for (const d of this.dmgLog) if (d.by === id && this.t - d.t < win) s += d.amt
    return s
  }

  // ---------------- zone ----------------
  zoneInfo(obs: Observation) {
    const z: any = obs.zone
    const t = this.t
    const f = z.shrink_end > z.shrink_start ? clamp((t - z.shrink_start) / (z.shrink_end - z.shrink_start), 0, 1) : 0
    const cx = z.center[0] + (z.next_center[0] - z.center[0]) * f
    const cy = z.center[1] + (z.next_center[1] - z.center[1]) * f
    const r = z.radius + (z.next_radius - z.radius) * f
    const pos = obs.self.pos
    const nr = z.next_radius
    const margin = Math.min(25, nr * 0.25)
    const dNext = d2(pos, z.next_center)
    const outNext = dNext - (nr - margin)
    const speed = 11.7
    const travel = Math.max(0, outNext) / speed * 1.5
    const timeLeft = z.shrink_end - t
    // also the live circle: distance to edge
    const dLive = d2(pos, [cx, cy]) - r
    if (outNext < -5) this.zoneLatch = false
    let urgent = outNext > 0 && (travel + 15 > timeLeft || dLive > -20 || this.zoneLatch)
    if (urgent) this.zoneLatch = true
    const veryUrgent = !obs.self.in_zone || (outNext > 0 && travel + 2 > timeLeft)
    // safe point: toward next center, just inside the margin
    let sp: [number, number]
    if (dNext < 1) sp = [z.next_center[0], z.next_center[1]]
    else {
      const k = Math.max(0, nr - margin * 1.5) / dNext
      sp = outNext > 0 ? [z.next_center[0] + (pos[0] - z.next_center[0]) * Math.min(1, k), z.next_center[1] + (pos[1] - z.next_center[1]) * Math.min(1, k)] : [pos[0], pos[1]]
    }
    if (nr < 5) sp = [z.next_center[0], z.next_center[1]]
    return { cx, cy, r, nc: z.next_center as number[], nr, urgent, veryUrgent, safePoint: sp, outNext, margin, timeLeft }
  }

  insideNext(p: number[], zone: any, extra = 0) { return d2(p, zone.nc) < zone.nr - zone.margin - extra }

  // ---------------- decisions ----------------
  threatScore(e: Track) {
    const pos = this.me.pos
    const d = d3(e.pos, pos)
    let s = 0
    s += this.dmgFrom(e.id, 5) * 2
    s += 200 * (1 - e.hp / e.maxHp)
    s -= d * 1.5
    if (e.vis) s += 80
    if (!this.losClear(pos, e)) s -= 150
    return s
  }

  chooseTarget(enemies: Track[]): Track | null {
    let best: Track | null = null, bs = -1e9
    for (const e of enemies) {
      const d = d2(e.pos, this.me.pos)
      if (d > 260) continue
      const s = this.threatScore(e)
      // stickiness
      const sc = s + (e.id === this.modeTarget ? 60 : 0)
      if (sc > bs) { bs = sc; best = e }
    }
    if (best) this.modeTarget = best.id
    return best
  }

  wantEngage(t: Track, hpFrac: number, enemies: Track[]) {
    const d = d2(t.pos, this.me.pos)
    if (this.dmgFrom(t.id, 6) > 0) return true
    if (d < 70) return true
    if (P.seek && hpFrac > 0.6) return true
    return d < 140 && hpFrac > 0.5
  }

  hasWeapon(kind: string) { return this.me.weapons.some((w: any) => w && w.kind === kind) }

  prefRange(t: Track) {
    if (this.hasWeapon("lightning") && this.me.energy > 20) return 28
    if (this.hasWeapon("laser")) return 90
    return 70
  }

  fightPosition(t: Track, zone: any, enemies: Track[]): [number, number] {
    const pos = this.me.pos
    const d = d2(t.pos, pos)
    const pr = this.prefRange(t)
    // if no LOS, path to the target directly
    if (!this.losClear(pos, t)) return [t.pos[0], t.pos[1]]
    if (Math.abs(d - pr) < 12) return [pos[0], pos[1]]
    const k = (d - pr) / Math.max(d, 1)
    let gx = pos[0] + (t.pos[0] - pos[0]) * k, gy = pos[1] + (t.pos[1] - pos[1]) * k
    if (!this.insideNext([gx, gy], zone) && this.insideNext(pos, zone)) return [pos[0], pos[1]]
    return [gx, gy]
  }

  fightMove(t: Track, mv: number[]): number[] {
    const pos = this.me.pos
    // strafe perpendicular to the line to the target, switching direction irregularly
    if (this.t > this.strafeT) { this.strafeDir = this.rng() < 0.5 ? -1 : 1; this.strafeT = this.t + P.jinkMin + this.rng() * P.jinkVar }
    const bx = t.pos[0] - pos[0], by = t.pos[1] - pos[1]
    const L = Math.hypot(bx, by) || 1
    const px = (-by / L) * this.strafeDir, py = (bx / L) * this.strafeDir
    // check strafe direction is walkable
    let sx = px, sy = py
    if (!W!.walkLine(pos[0], pos[1], pos[0] + px * 6, pos[1] + py * 6)) { this.strafeDir *= -1; sx = -px; sy = -py }
    const ox = mv[0] * 0.8 + sx * 0.7, oy = mv[1] * 0.8 + sy * 0.7
    const n = Math.hypot(ox, oy) || 1
    return [ox / n, oy / n]
  }

  coverPoint(pos: number[], threats: Track[], zone: any): [number, number] {
    let best: [number, number] = [pos[0], pos[1]], bs = -1e9
    const tx = threats.reduce((s, t) => s + t.pos[0], 0) / threats.length, ty = threats.reduce((s, t) => s + t.pos[1], 0) / threats.length
    const away = Math.atan2(pos[1] - ty, pos[0] - tx)
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * TAU
      for (const r of [12, 25, 40]) {
        const x = pos[0] + Math.cos(a) * r, y = pos[1] + Math.sin(a) * r
        const c = W!.toCell(x, y)
        if (c < 0 || !W!.walk[c]) continue
        let hidden = 0
        const gz = W!.ground(x, y) + 6
        for (const t of threats) if (W!.blocked(t.pos[0], t.pos[1], t.pos[2] + 8, x, y, gz, 1.5)) hidden++
        let s = hidden * 100 - r * 0.8 + 25 * Math.cos(wrap(a - away))
        if (!this.insideNext([x, y], zone) && !(zone.nr > 300)) s -= 60
        if (!W!.walkLine(pos[0], pos[1], x, y)) s -= 30
        if (s > bs) { bs = s; best = [x, y] }
      }
    }
    return best
  }

  wRank(k: string | null): number {
    if (k === null) return 99
    if (k === "gun") return P.dropGun ? 10 : -1
    const i = P.wantSlot.indexOf(k)
    return i < 0 ? 60 : i
  }

  // which slot would a new weapon of this kind go into (-1 = not wanted)
  slotFor(kind: string): number {
    const ws = this.me.weapons
    const have = ws.map((w: any) => (w ? w.kind : null))
    if (have.includes(kind)) return -1
    if (!P.wantSlot.includes(kind)) return -1
    if (have[0] === null) return 0
    if (have[1] === null) return 1
    let worst = -1, wr = -2
    for (let i = 0; i < 2; i++) {
      if (ws[i].kind === "laser" && ws[i].charge > 0) continue
      const r = this.wRank(have[i])
      if (r > wr) { wr = r; worst = i }
    }
    if (worst >= 0 && this.wRank(kind) < wr) return worst
    return -1
  }

  lootActions(obs: Observation, act: any) {
    const me = this.me
    const pr = this.cfg.loot.pickup_radius
    for (const p of obs.pickups as any[]) {
      if (Math.hypot(p.pos[0] - me.pos[0], p.pos[1] - me.pos[1]) > pr - 0.3 || Math.abs(p.pos[2] - me.pos[2]) > 3.8) continue
      if (this.badPick.has(p.id) && this.t - this.badPick.get(p.id)! < 2) continue
      const sl = this.slotFor(p.kind)
      if (sl < 0) continue
      act.take = p.id
      if (me.weapons[sl]) act.drop = sl
      return
    }
  }

  pickupWanted(kind: string) { return this.slotFor(kind) >= 0 }

  onRoof(p: number[]) { return p[2] > W!.ground(p[0], p[1]) + 2.5 }

  dbg = ""
  dpsOf(weapons: string[], cubes: number, dist: number): number {
    let d = 0
    for (const w of weapons || []) {
      if (w === "gun") d += dist < 230 ? 60 : 0
      else if (w === "laser") d += dist < 280 ? 95 : 0
      else if (w === "lightning") d += dist < 45 ? 210 : 0
      else if (w === "mortar") d += dist > 20 && dist < 230 ? 45 : 0
    }
    return d * (1 + 0.04 * Math.min(cubes || 0, 10))
  }
  myDps(dist: number): number {
    const ws = this.me.weapons.filter((w: any) => w).map((w: any) => w.kind)
    return this.dpsOf(ws, this.me.cubes, dist)
  }

  hasSpecial() { return this.me.weapons.some((w: any) => w && w.kind !== "gun") }

  // is a point OK to travel to w.r.t. the zone
  zoneOk(p: number[], zone: any) {
    if (this.insideNext(p, zone)) return true
    // inside the live circle with margin and the shrink is not imminent
    const dl = d2(p, [zone.cx, zone.cy])
    return dl < zone.r - 30 && !zone.urgent && zone.timeLeft > 25
  }

  lootGoal(obs: Observation, zone: any, enemies: Track[], wantWeapon: boolean): { pos: [number, number]; what: string } | null {
    const pos = this.me.pos
    let best: { pos: [number, number]; what: string } | null = null, bs = 1e9
    const nearEnemy = enemies.some((e) => d2(e.pos, pos) < 60)
    const consider = (p: number[], cost: number, what: string) => {
      if (p[2] > W!.surfAt(p[0], p[1]) + 3) return // floating?
      if (!this.zoneOk(p, zone)) return
      // roofs: only worth it for weapons, and only if reachable without a big climb
      const rise = p[2] - pos[2]
      if (rise > 2) { if (what !== "wpn" || rise > 30) return; cost += 20 + rise * 2 }
      if (cost < bs) { bs = cost; best = { pos: [p[0], p[1]], what } }
    }
    for (const [, p] of this.pickMem) {
      if (!this.pickupWanted(p.kind)) continue
      const d = d2(p.pos, pos)
      if (d > (wantWeapon ? 230 : P.lootRange * 1.5)) continue
      consider(p.pos, d * (wantWeapon ? 0.3 : 0.6), "wpn")
    }
    for (const [, c] of this.cubeMem) {
      const d = d2(c.pos, pos)
      if (d > P.lootRange) continue
      consider(c.pos, d * 0.7, "cube")
    }
    this.killSites = this.killSites.filter((k) => this.t - k.t < 25 && d2(k.pos, pos) > 3)
    for (const k of this.killSites) {
      const d = d2(k.pos, pos)
      if (d > 150) continue
      consider(k.pos, d * 0.5, "kill")
    }
    if (!nearEnemy && P.crateFarm) for (const [, c] of this.crateMem) {
      const d = d2(c.pos, pos)
      if (d > P.lootRange) continue
      consider(c.pos, d + 25, "crate")
    }
    return best
  }

  exploreGoal: [number, number] | null = null
  exploreT = -99
  explore(zone: any): [number, number] {
    const pos = this.me.pos
    if (!this.exploreGoal || d2(pos, this.exploreGoal) < 10 || this.t - this.exploreT > 25 || !this.zoneOk(this.exploreGoal, zone)) {
      // random walkable point 60-140 m away, inside the next circle, biased toward its center
      let best: [number, number] | null = null, bs = -1e9
      for (let k = 0; k < 30; k++) {
        const a = this.rng() * TAU, r = 60 + this.rng() * 80
        const x = pos[0] + Math.cos(a) * r, y = pos[1] + Math.sin(a) * r
        const c = W!.toCell(x, y)
        if (c < 0 || !W!.walk[c]) continue
        if (W!.hN[c] > W!.ground(x, y) + 2) continue
        let sc = this.rng() * 30 - d2([x, y], zone.nc) * 0.3
        if (!this.insideNext([x, y], zone)) sc -= 200
        if (sc > bs) { bs = sc; best = [x, y] }
      }
      this.exploreGoal = best ?? zone.safePoint
      this.exploreT = this.t
    }
    return this.exploreGoal!
  }

  dropGoal(obs: Observation, zone: any, enemies: Track[]): [number, number] | null {
    const pos = this.me.pos
    for (const dr of (obs.drops as any[]) || []) {
      const d = d2(dr.pos, pos)
      if (d > 180) continue
      if (dr.lands_in > d / 11.7 + 3) continue
      const contested = enemies.filter((e) => d2(e.pos, dr.pos) < 50).length
      if (contested >= 2) continue
      return [dr.pos[0], dr.pos[1]]
    }
    return null
  }

  roamGoal(zone: any): [number, number] {
    const pos = this.me.pos
    if (this.insideNext(pos, zone, 10)) {
      // hold position near cover inside the next circle; drift toward the next center slowly
      const dc = d2(pos, zone.nc)
      if (dc > zone.nr * 0.5) return [pos[0] + (zone.nc[0] - pos[0]) * 0.3, pos[1] + (zone.nc[1] - pos[1]) * 0.3]
      return [pos[0], pos[1]]
    }
    return zone.safePoint
  }

  pickUpgrade(offer: any): number {
    let bi = 0, br = 1e9
    offer.choices.forEach((c: any, i: number) => {
      let r = UPGRADE_PREF.indexOf(c.id)
      if (r < 0) r = 50
      if (r < br) { br = r; bi = i }
    })
    return bi
  }

  // ---------------- movement ----------------
  // when standing on a roof (or any non-walkable spot above ground), head for the edge that leads toward the goal
  roofEscape(pos: number[], goal: [number, number]): number[] | null {
    const gz = W!.ground(pos[0], pos[1])
    const c = W!.toCell(pos[0], pos[1])
    if (pos[2] < gz + 2.5 && c >= 0 && W!.walk[c]) return null
    if (pos[2] < gz + 2.5) {
      // on ground but in a non-walkable cell: go to nearest walkable cell
      const n = W!.nearestWalk(pos[0], pos[1], 10)
      if (n < 0) return null
      const x = W!.cellX(n), y = W!.cellY(n), L = Math.hypot(x - pos[0], y - pos[1]) || 1
      return [(x - pos[0]) / L, (y - pos[1]) / L]
    }
    let best: number[] | null = null, bs = 1e9
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU, ca = Math.cos(a), sa = Math.sin(a)
      for (let r = 2; r < 80; r += 1.5) {
        const x = pos[0] + ca * r, y = pos[1] + sa * r
        const top = W!.roofAt(x, y)
        if (top > pos[2] + 1.0) break // wall higher than us
        const surf = Math.max(top, W!.ground(x, y))
        if (surf < pos[2] - 2) {
          // edge found: landing spot a bit beyond
          const lx = x + ca * 4, ly = y + sa * 4
          const lc = W!.toCell(lx, ly)
          const ok = lc >= 0 && W!.walk[lc]
          const s = r + d2([lx, ly], goal) * 0.7 + (ok ? 0 : 40)
          if (s < bs) { bs = s; best = [ca, sa] }
          break
        }
      }
    }
    return best
  }

  climbH: number | null = null
  steer(pos: number[], goal: [number, number]): number[] {
    this.climbH = null
    const dg = d2(pos, goal)
    if (dg < 2.0) return [0, 0]
    const c0 = W!.toCell(pos[0], pos[1])
    const here = c0 >= 0 && W!.walk[c0] && Math.abs(W!.hN[c0] - pos[2]) < 2
    // direct if walkable line
    if (here && dg < 60 && W!.walkLine(pos[0], pos[1], goal[0], goal[1])) {
      this.path = null
      const s = dg < 6 ? dg / 6 : 1
      return [((goal[0] - pos[0]) / dg) * s, ((goal[1] - pos[1]) / dg) * s]
    }
    const needPlan = !this.path || !this.pathGoal || d2(this.pathGoal, goal) > 6 || this.t - this.pathT > 2.5
    if (needPlan && (!this.path || !this.busy(15))) {
      this.path = W!.astar(pos[0], pos[1], pos[2], goal[0], goal[1], null, this.busy(8) ? 8000 : 30000)
      this.pathGoal = goal
      this.pathT = this.t
      this.pathIdx = 0
    }
    const path = this.path
    if (!path || path.length < 2) return [((goal[0] - pos[0]) / dg), ((goal[1] - pos[1]) / dg)]
    // advance index to closest cell (prefer ones at our height)
    let bi = this.pathIdx, bd = 1e9
    for (let i = this.pathIdx; i < Math.min(path.length, this.pathIdx + 30); i++) {
      const d = Math.hypot(W!.cellX(path[i]) - pos[0], W!.cellY(path[i]) - pos[1]) + Math.max(0, W!.hN[path[i]] - pos[2] - 1.5) * 3
      if (d < bd) { bd = d; bi = i }
    }
    this.pathIdx = bi
    // look ahead to farthest walkable-visible point
    let tgt = Math.min(path.length - 1, bi + 1)
    if (here) for (let i = Math.min(path.length - 1, bi + 15); i > bi; i--) {
      if (W!.walkLine(pos[0], pos[1], W!.cellX(path[i]), W!.cellY(path[i]))) { tgt = i; break }
    }
    // climb needed? max surface along the way to the next couple of cells
    {
      const j = Math.min(path.length - 1, bi + 2)
      let px = pos[0], py = pos[1], mh = -1e9
      for (let i = bi; i <= j; i++) {
        const cx = W!.cellX(path[i]), cy = W!.cellY(path[i])
        mh = Math.max(mh, W!.maxSurfAlong(px, py, cx, cy))
        px = cx; py = cy
      }
      if (mh > pos[2] + 1.15 && !(here && tgt > j)) { this.climbH = mh; tgt = Math.max(tgt, j) }
    }
    const tx = W!.cellX(path[tgt]), ty = W!.cellY(path[tgt])
    const L = Math.hypot(tx - pos[0], ty - pos[1]) || 1
    draw.line([pos[0], pos[1], pos[2] + 1], [tx, ty, W!.hN[path[tgt]] + 1], "#4f4")
    return [(tx - pos[0]) / L, (ty - pos[1]) / L]
  }

  shellEvade(obs: Observation): number[] | null {
    const pos = this.me.pos
    const g = this.cfg.weapons.mortar.gravity
    for (const p of obs.projectiles as any[]) {
      if (p.kind !== "mortar") continue
      // simulate to ground
      let x = p.pos[0], y = p.pos[1], z = p.pos[2], vx = p.vel[0], vy = p.vel[1], vz = p.vel[2]
      let t = 0
      for (; t < 6; t += 0.05) {
        x += vx * 0.05; y += vy * 0.05; z += vz * 0.05; vz -= g * 0.05
        if (z < W!.ground(x, y) + 0.3 || W!.solidAt(x, y, z)) break
        if (Math.hypot(x - pos[0], y - pos[1]) < 3 && z < pos[2] + 9 && z > pos[2]) break
      }
      const dl = Math.hypot(x - pos[0], y - pos[1])
      if (dl < this.cfg.weapons.mortar.splash_radius + 4 && t < 3) {
        const a = Math.atan2(pos[1] - y, pos[0] - x)
        return [Math.cos(a), Math.sin(a)]
      }
    }
    return null
  }

  // ---------------- combat ----------------
  muzzle(): V3 { const p = this.me.pos; return [p[0], p[1], p[2] + this.myMuzzle] }

  centerZ(t: Track) { return t.pos[2] + (t.kind === "npc" ? 1.75 : 4.5 * (1 + 0.05 * (t.cubes || 0))) }

  losClear(from: number[], t: Track) {
    return !W!.blocked(from[0], from[1], from[2] + this.myMuzzle, t.pos[0], t.pos[1], this.centerZ(t), 1.5, 2)
  }

  leadPoint(t: Track, speed: number): V3 {
    const m = this.muzzle()
    let px = t.pos[0], py = t.pos[1], pz = this.centerZ(t)
    const vz = t.vel[2] || 0
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(px - m[0], py - m[1], pz - m[2])
      const tt = Math.max(0, d - 3) / speed + 0.05
      px = t.pos[0] + t.vel[0] * tt * P.lead
      py = t.pos[1] + t.vel[1] * tt * P.lead
      pz = this.centerZ(t) + (Math.abs(vz) > 0.5 ? vz * tt - 0.5 * 22 * tt * tt * (t.pos[2] > W!.ground(t.pos[0], t.pos[1]) + 1 ? 1 : 0) : 0)
      const gz = W!.ground(px, py)
      if (pz < gz + 1) pz = gz + 1
    }
    return [px, py, pz]
  }

  aimTo(p: number[]): [number, number] {
    const m = this.muzzle()
    const yaw = Math.atan2(p[1] - m[1], p[0] - m[0])
    const pitch = Math.atan2(p[2] - m[2], Math.hypot(p[0] - m[0], p[1] - m[1]))
    return [yaw, pitch]
  }

  mortarSolve(tp: number[], high: boolean): [number, number, number] | null {
    const m = this.me.pos
    const ox = m[0], oy = m[1], oz = m[2] + (this.me.stats?.height ?? 9) + 0.5
    const v = this.me.weapons.find((w: any) => w && w.kind === "mortar")?.stats?.speed ?? 72
    const g = this.cfg.weapons.mortar.gravity
    const d = Math.hypot(tp[0] - ox, tp[1] - oy)
    const h = tp[2] - oz
    const disc = v ** 4 - g * (g * d * d + 2 * h * v * v)
    if (disc < 0) return null
    const sq = Math.sqrt(disc)
    const th = Math.atan((v * v + (high ? sq : -sq)) / (g * d))
    const tof = d / (v * Math.cos(th))
    return [Math.atan2(tp[1] - oy, tp[0] - ox), th, tof]
  }

  aimAndFire(obs: Observation, act: any, target: Track | null, npcs: Track[], face: number | null, mv: number[]) {
    const me = this.me
    const pos = me.pos
    const ws = me.weapons
    const fire = [false, false]
    let aim: [number, number] | null = null
    const curYaw = me.aim[0], curPitch = me.aim[1]
    const slotOf = (k: string) => ws.findIndex((w: any) => w && w.kind === k)
    const gunS = slotOf("gun"), lzS = slotOf("laser"), ltS = slotOf("lightning"), moS = slotOf("mortar")

    // pick shooting target: enemy mech with LOS, else NPC, else crate
    let tgt: Track | null = target && this.losClear(pos, target) ? target : null
    if (!tgt) {
      // any visible enemy with LOS
      let bd = 1e9
      for (const e of this.tracks.values()) {
        if (e.kind !== "mech" || this.t - e.seenT > 1) continue
        const d = d2(e.pos, pos)
        if (d < bd && d < 230 && this.losClear(pos, e)) { bd = d; tgt = e }
      }
    }
    let isNpc = false
    if (!tgt && P.npcFarm) {
      let bd = 1e9
      for (const n of npcs) {
        const d = d2(n.pos, pos)
        const hostile = this.dmgLog.some((x) => x.by === n.id && this.t - x.t < 5)
        if ((hostile || (d < 120 && me.hp / me.max_hp > 0.4)) && d < bd && this.losClear(pos, n)) { bd = d; tgt = n }
      }
      if (tgt) isNpc = true
    }
    let crateTgt: any = null
    if (!tgt && P.crateFarm) {
      let bd = 1e9
      for (const c of obs.crates as any[]) {
        const d = d3(c.pos, pos)
        if (d < 90 && d < bd && !W!.blocked(pos[0], pos[1], pos[2] + this.myMuzzle, c.pos[0], c.pos[1], c.pos[2] + 1.2, 1.5, 1.5)) { bd = d; crateTgt = c }
      }
    }

    if (tgt) {
      const dist = d3(tgt.pos, pos)
      const gunSpeed = gunS >= 0 ? ws[gunS].stats.speed : 252
      const lead = this.leadPoint(tgt, gunSpeed)
      aim = this.aimTo(lead)
      const rad = (tgt.kind === "npc" ? 1.8 : 2.5 * (1 + 0.05 * (tgt.cubes || 0)))
      const tol = Math.atan2(rad * 0.75, dist) + 0.01
      const yawErr = Math.abs(wrap(aim[0] - curYaw)), pitchErr = Math.abs(aim[1] - curPitch)
      const aligned = yawErr < tol && pitchErr < tol * 1.5
      // gun
      if (gunS >= 0) {
        const g = ws[gunS]
        if (aligned && g.ammo > 0 && g.reload === 0 && dist < g.stats.range) fire[gunS] = true
      }
      // lightning
      if (ltS >= 0) {
        const l = ws[ltS]
        const cone = ((l.stats.cone_deg ?? 30) * Math.PI) / 180 / 2
        const yawT = Math.atan2(tgt.pos[1] - pos[1], tgt.pos[0] - pos[0])
        if (dist < (l.stats.range ?? 45) * 0.97 && Math.abs(wrap(yawT - curYaw)) < cone * 0.8 && me.energy >= (l.stats.energy ?? 3) + (isNpc ? 30 : 4)) fire[ltS] = true
      }
      // laser
      if (lzS >= 0) {
        const l = ws[lzS]
        const instAim = this.aimTo([tgt.pos[0] + tgt.vel[0] * 0.1, tgt.pos[1] + tgt.vel[1] * 0.1, this.centerZ(tgt)])
        const fullCharge = l.stats.charge ?? 0.75
        const yErr = Math.abs(wrap(instAim[0] - curYaw)), pErr = Math.abs(instAim[1] - curPitch)
        const tolL = Math.atan2(rad * 0.6, dist)
        if (dist < (l.stats.range ?? 280) * 0.97) {
          if (l.charge > 0) {
            // charging: keep holding until full and aligned
            const ready = l.charge >= fullCharge - 0.02
            if (ready && yErr < tolL && pErr < tolL * 1.5) fire[lzS] = false
            else fire[lzS] = true
            if (ready && yErr < tolL * 1.6) fire[lzS] = false
          } else if (l.cooldown <= 0.05) {
            fire[lzS] = true // start charge
          }
          // when using the laser, aim without bullet lead (hitscan)
          if (l.charge > 0 || l.cooldown <= 0.1) {
            if (!(gunS >= 0 && fire[gunS] && l.charge < fullCharge * 0.5)) aim = instAim
          }
        } else if (l.charge > 0) fire[lzS] = false
      }
      // mortar: only for far or indirect targets
      if (moS >= 0) {
        const m = ws[moS]
        if (m.cooldown <= 0 && dist > 30 && dist < 220 && !(lzS >= 0 && ws[lzS].charge > 0)) {
          const sol0 = this.mortarSolve([tgt.pos[0], tgt.pos[1], tgt.pos[2]], false)
          if (sol0) {
            const lp = [tgt.pos[0] + tgt.vel[0] * sol0[2], tgt.pos[1] + tgt.vel[1] * sol0[2], tgt.pos[2]]
            const sol = this.mortarSolve(lp, false)
            if (sol && dist > 60) {
              const ma: [number, number] = [sol[0], sol[1]]
              aim = ma
              if (Math.abs(wrap(ma[0] - curYaw)) < 0.03 && Math.abs(ma[1] - curPitch) < 0.03) fire[moS] = true
              if (gunS >= 0) fire[gunS] = false
            }
          }
        }
      }
    } else if (crateTgt) {
      aim = this.aimTo([crateTgt.pos[0], crateTgt.pos[1], crateTgt.pos[2] + 1.2])
      const dist = d3(crateTgt.pos, pos)
      const tol = Math.atan2(1.0, dist)
      if (gunS >= 0 && Math.abs(wrap(aim[0] - curYaw)) < tol && Math.abs(aim[1] - curPitch) < tol && ws[gunS].ammo > 0) fire[gunS] = true
      if (ltS >= 0 && dist < 40 && Math.abs(wrap(aim[0] - curYaw)) < 0.2 && me.energy > 50) fire[ltS] = true
    }

    // remembered target without LOS (pre-aim at it)
    if (!aim && target) aim = this.aimTo([target.pos[0], target.pos[1], this.centerZ(target)])
    if (!aim) {
      // scan: damage bearing, sounds, else along motion
      const recent = this.dmgLog.filter((d) => d.bearing !== null && this.t - d.t < 3)
      let yaw: number
      if (recent.length) yaw = recent[recent.length - 1].bearing!
      else {
        const snd = (obs.sounds as any[]).filter((s) => ["gun", "laser", "lightning", "mortar", "laser_charge", "boost", "step", "jet"].includes(s.kind) && s.dist !== "far")
        if (snd.length) yaw = snd[0].bearing
        else if (Math.hypot(mv[0], mv[1]) > 0.3) yaw = Math.atan2(mv[1], mv[0]) + Math.sin(this.t * 1.3) * 0.9
        else yaw = curYaw + 0.6
      }
      aim = [yaw, 0]
    }
    // reload when idle
    if (gunS >= 0) {
      const g = ws[gunS]
      if (g.reload === 0 && g.ammo < g.stats.mag * 0.5 && !tgt) act.reload = true
    }
    // don't release laser into nothing
    if (lzS >= 0 && !tgt && ws[lzS].charge > 0) fire[lzS] = true
    act.aim = [aim[0], clamp(aim[1], this.cfg.mech.min_pitch, this.cfg.mech.max_pitch)]
    act.fire = fire
  }
}

run((hello) => new Bot(hello) as any)
