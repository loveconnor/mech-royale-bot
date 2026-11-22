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
  npcHunt: ENV("MF_NPCHUNT", 0),
  roof: ENV("MF_ROOF", 0),
  hunt: ENV("MF_HUNT", 0),
  huntHp: ENV("MF_HUNTHP", 0.75),
  huntNow: ENV("MF_HUNTNOW", 0),
  roofAfter: ENV("MF_ROOFAFTER", 45),
  npcRange: ENV("MF_NPCRANGE", 250),
  crateW: ENV("MF_CRATEW", 1),
  evade: ENV("MF_EVADE", 0), // after this many kills, stop hunting and keep away from the squad
  evadeT: ENV("MF_EVADET", 0), // ...or after this many seconds
  quit: ENV("MF_QUIT", 0), // probe: stop acting after this many seconds (sitting target)
  ldodge: ENV("MF_LDODGE", 0), // sidestep enemy lasers this long (s) into their charge
  precharge: ENV("MF_PRECHARGE", 0), // charge the laser behind cover before a known enemy shows up
}

const UPGRADE_PREF = process.env.MF_UPS ? process.env.MF_UPS.split(",") : ["armor", "nanites", "plating", "laser_damage", "laser_charge", "gun_rate", "gun_damage", "lightning_efficiency", "gyros", "lightning_range", "lightning_chain", "gun_mag", "gun_velocity", "mortar_reload", "sensors", "servos", "capacitor", "reactor", "jets", "mortar_velocity", "mortar_splash", "laser_pierce"]

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
  chargeStart = new Map<number, number>()
  dodgeDir = 0
  dodgeUntil = -99
  crateMem = new Map<number, { pos: V3; hp: number; t: number }>()
  pickMem = new Map<number, { pos: V3; kind: string; t: number }>()
  cubeMem = new Map<number, { pos: V3; t: number }>()
  badPick = new Map<number, number>()
  killSites: { pos: V3; t: number }[] = []
  sndMem: { x: number; y: number; t: number; kind: string }[] = []
  npcMem = new Map<number, { pos: V3; t: number; hp: number }>()
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
    if (P.quit && obs.t > P.quit) return { move: [0, 0], fire: [false, false], boost: false } as any
    this.me = me
    this.t = obs.t
    const st: any = me.stats || {}
    this.myEye = st.eye_height ?? 8
    this.myMuzzle = st.muzzle_height ?? 7
    this.myR = st.radius ?? 2.5
    const act: any = {}
    this.updateTracks(obs)
    this.handleEvents(obs)
    this.updateSounds(obs)

    // upgrades
    if (obs.offer) act.pick = this.pickUpgrade(obs.offer)

    const pos = me.pos as V3
    const hpFrac = me.hp / me.max_hp

    // --- targets ---
    const enemies = [...this.tracks.values()].filter((t) => t.kind === "mech" && this.t - t.seenT < 4)
    const npcs = [...this.tracks.values()].filter((t) => t.kind === "npc" && this.t - t.seenT < 1)
    let target = this.chooseTarget(enemies)
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
    // A visible house mech can be waiting while a different hunter engages.
    // Estimate immediate pressure independently for each mech.
    const pressure = new Map(losThreats.map(e => [e.id,this.attackPressure(e,pos)]))
    const attackers = losThreats.filter(e => pressure.get(e.id)! >= 0.65)
    if (losThreats.length > 1) {
      let bestValue = -Infinity
      for (const foe of losThreats) {
        const distance = d2(pos,foe.pos)
        const viewAngle = Math.atan2(pos[1]-foe.pos[1],pos[0]-foe.pos[0])
        const rear = Math.abs(wrap(viewAngle-foe.aim[0])) > this.cfg.mech.front_arc_deg * Math.PI / 360 + 0.12
        const multiplier = rear ? this.cfg.mech.rear_mult : 1
        const seconds = foe.hp / Math.max(1,multiplier*this.myDps(distance))
        // A disabled or distracted mech can yield a place before a longer duel.
        const value = (1 + (pressure.get(foe.id) ?? 0)*0.45) / (seconds+1.5)
        if (value > bestValue) { bestValue = value; target = foe }
      }
    }
    // time-to-kill comparison
    let theirDps = 0
    for (const e of losThreats) theirDps += (pressure.get(e.id) ?? 1) * this.dpsOf(e.weapons, e.cubes, d2(e.pos, pos))
    const armor = (me.stats as any)?.armor ?? 0
    const myTTL = (me.hp / Math.max(0.2, 1 - armor)) / Math.max(1, theirDps)
    const tgtHp = target ? target.hp : 1e9
    const myTTK = target ? tgtHp / Math.max(1, this.myDps(d2(target.pos, pos))) : 1e9
    const losing = losThreats.length > 0 && myTTL < myTTK * P.ttkRatio
    this.dbg = `ttl${myTTL.toFixed(1)} ttk${myTTK.toFixed(1)}`
    const outnumbered = attackers.length >= 2 && losing
    if (!this.retreating && (outnumbered || hpFrac < P.retreatHp || (losing && hpFrac < 0.7)) && (dangerEnemies.length > 0 || recentlyHurt) && !(target && myTTK < 2.5 && !losing)) { this.retreating = true; this.coverGoal = null }
    if (this.retreating && !outnumbered && hpFrac > P.reengageHp) this.retreating = false
    // the target is nearly dead and we can finish it: keep fighting
    if (this.retreating && target && losThreats.length === 1 && myTTK < myTTL * 0.7 && this.t - target.seenT < 0.5) this.retreating = false
    // an enemy right on top of us: fight instead of turning our back
    const closeFight = target && this.t - target.seenT < 0.6 && d2(target.pos, pos) < 22 && this.losClear(pos, target)

    let wg: { pos: [number, number]; what: string } | null = null
    let rg: [number, number] | null = null
    const zoneUrgent = zone.urgent
    if (zoneUrgent || !me.in_zone) {
      mode = "zone"
      goal = zone.safePoint
      boost = !me.in_zone || zone.veryUrgent
    } else if (P.dropGo && (rg = this.dropGoal(obs, zone, enemies, myTTL))) {
      mode = "drop"
      goal = rg
      boost = d2(pos, goal) > 12 && me.energy > 45
    } else if (P.roof && this.roofWanted() && (rg = this.roofGoal(zone)) && !(closeFight && d2(target!.pos, pos) < 15)) {
      mode = d2(pos, rg) < 4 && pos[2] > W!.ground(pos[0], pos[1]) + 8 ? "camp" : "toroof"
      goal = rg
      if (mode === "camp") goal = [pos[0], pos[1]]
    } else if (this.retreating && (!closeFight || outnumbered)) {
      mode = "retreat"
      const threats = attackers.length ? attackers : dangerEnemies.length ? dangerEnemies : enemies.filter((e) => this.t - e.seenT < 6)
      if (threats.length) {
        if (!this.coverGoal || (this.t - this.coverT > 1.5 && !this.busy(8))) { this.coverGoal = this.coverPoint(pos, threats, zone); this.coverT = this.t }
        goal = this.coverGoal
        boost = d2(pos, goal) > 4 && recentlyHurt
      } else {
        mode = "regen"
        goal = [pos[0], pos[1]]
      }
    } else if (this.evading() && !(target && this.t - target.seenT < 0.6 && (d2(target.pos, pos) < 45 || (this.dmgFrom(target.id, 2) > 0 && d2(target.pos, pos) < 90 && myTTK < myTTL)))) {
      mode = "evade"
      if (!this.evadeGoal || this.t - this.evadeGT > 2 || d2(pos, this.evadeGoal) < 5) { if (!this.busy(10)) { this.evadeGoal = this.evadePoint(pos, zone); this.evadeGT = this.t } }
      goal = this.evadeGoal ?? [pos[0], pos[1]]
      boost = recentlyHurt && d2(pos, goal) > 6
    } else if ((wg = !this.hasSpecial() ? this.lootGoal(obs, zone, enemies, true) : null) && wg.what === "wpn" && !(target && d2(target.pos, pos) < 60 && this.dmgFrom(target.id, 4) > 0)) {
      mode = "getweapon"
      goal = wg.pos
    } else if (target && this.wantEngage(target, hpFrac, enemies)) {
      mode = "fight"
      const cube = this.combatCube(obs, target, zone)
      if (cube) {
        mode = "collect"
        goal = cube
      } else {
        goal = this.fightPosition(target, zone, enemies)
      }
    } else if (P.regen && hpFrac < 0.8 && this.t - this.lastDmgT > 1 && !dangerEnemies.length) {
      mode = "regen"
      goal = [pos[0], pos[1]]
    } else {
      const lg = this.lootGoal(obs, zone, enemies, false)
      if (lg) { mode = "loot:" + lg.what; goal = lg.pos }
      else {
        if (!this.hasSpecial() && !(P.huntNow && this.t > P.huntNow)) { mode = "explore"; goal = this.explore(zone) }
        else if (P.hunt && hpFrac > P.huntHp && (rg = this.huntGoal(zone))) { mode = "hunt"; goal = rg }
        else if (P.hunt && hpFrac > P.huntHp) { mode = "search"; goal = this.explore(zone) }
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
    let evade = this.shellEvade(obs)
    if (!evade && mode !== "zone") { evade = this.laserDodge(obs); if (evade) this.strafeT = this.t + 0.3 + this.rng() * 0.3 }
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
    for (const m of obs.mechs as any[]) {
      if (m.charging) { if (!this.chargeStart.has(m.id)) this.chargeStart.set(m.id, this.t - 0.05) }
      else this.chargeStart.delete(m.id)
    }
    for (const id of this.chargeStart.keys()) if (!seen.has(id)) this.chargeStart.delete(id)
    for (const [id, tr] of this.tracks) {
      if (!seen.has(id)) {
        tr.vis = false
        const dt = 0.1
        tr.pos = [tr.pos[0] + tr.vel[0] * dt, tr.pos[1] + tr.vel[1] * dt, tr.pos[2]]
        if (this.t - tr.seenT > 8) this.tracks.delete(id)
      }
    }
    for (const m of obs.mechs as any[]) if (m.kind === "npc") this.npcMem.set(m.id, { pos: m.pos, t: this.t, hp: m.hp ?? 350 })
    for (const [id, n] of this.npcMem) if (!seen.has(id) && (d2(n.pos, obs.self.pos) < 35 || this.t - n.t > 120)) this.npcMem.delete(id)
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

  updateSounds(obs: Observation) {
    const me = obs.self.pos
    const est: any = { near: 35, mid: 110, far: 220 }
    for (const sd of (obs.sounds as any[]) || []) {
      if (!["gun", "laser", "lightning", "mortar", "step", "boost", "jet", "laser_charge", "reload", "crate"].includes(sd.kind)) continue
      const r = est[sd.dist] ?? 100
      this.sndMem.push({ x: me[0] + Math.cos(sd.bearing) * r, y: me[1] + Math.sin(sd.bearing) * r, t: this.t, kind: sd.kind })
    }
    this.sndMem = this.sndMem.filter((m) => this.t - m.t < 12).slice(-40)
  }

  huntGoal(zone: any): [number, number] | null {
    const pos = this.me.pos
    let best: [number, number] | null = null, bs = 1e9
    for (const m of this.sndMem) {
      if (!this.zoneOk([m.x, m.y], zone)) continue
      const d = Math.hypot(m.x - pos[0], m.y - pos[1])
      if (d < 15) continue
      const sc = d + (this.t - m.t) * 15
      if (sc < bs) { bs = sc; best = [m.x, m.y] }
    }
    // remembered (out of sight) mechs are even better leads
    for (const e of this.tracks.values()) {
      if (e.kind !== "mech" || this.t - e.seenT > 8) continue
      const d = d2(e.pos, pos)
      const sc = d * 0.7 + (this.t - e.seenT) * 10
      if (sc < bs && this.zoneOk(e.pos, zone)) { bs = sc; best = [e.pos[0], e.pos[1]] }
    }
    return best
  }

  handleEvents(obs: Observation) {
    for (const e of obs.events as any[]) {
      if (e.type === "damaged") {
        this.dmgLog.push({ t: this.t, by: e.by, amt: e.amount, bearing: e.bearing })
        if (e.weapon !== "zone") this.lastDmgT = this.t
      } else if (e.type === "kill") {
        this.kills++
        const tr = this.tracks.get(e.target)
        this.tracks.delete(e.target)
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
    // Observations already report the live center and radius during a shrink.
    const [cx, cy] = z.center
    const r = z.radius
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
  // Keep the front armor toward recent incoming damage during breaks in combat.
  // A heading between two bearings can cover both within the front arc.
  guardFacing(preferred: number): number | null {
    const hits = this.dmgLog.filter(hit => hit.bearing !== null && this.t - hit.t < 2.5)
    if (!hits.length) return null
    const halfArc = this.cfg.mech.front_arc_deg * Math.PI / 360
    const start = this.me.aim[0]
    const headings = [preferred, start]
    for (const hit of hits) {
      const bearing = hit.bearing!
      headings.push(bearing, bearing - halfArc * 0.85, bearing + halfArc * 0.85)
    }
    let bestYaw = preferred, bestCost = Infinity
    for (const yaw of headings) {
      let cost = 12*Math.abs(wrap(yaw-preferred)) + 6*Math.abs(wrap(yaw-start))
      for (const hit of hits) {
        const age = this.t - hit.t
        if (Math.abs(wrap(yaw-hit.bearing!)) > halfArc*0.95) cost += hit.amt * Math.exp(-age)
      }
      if (cost < bestCost) { bestCost = cost; bestYaw = yaw }
    }
    return bestYaw
  }

  attackPressure(foe: Track, pos: number[]): number {
    if (this.dmgFrom(foe.id, 3) > 0) return 1
    const dx = pos[0]-foe.pos[0], dy = pos[1]-foe.pos[1]
    const distance = Math.max(1,Math.hypot(dx,dy))
    const aimError = Math.abs(wrap(Math.atan2(dy,dx)-foe.aim[0]))
    if (aimError < Math.atan2(this.myR+3,distance) + 0.10 || (foe.charging && aimError < 0.4)) return 1
    const closing = (foe.vel[0]*dx + foe.vel[1]*dy)/distance
    if (closing > 5 && aimError < 0.8) return 0.7
    return distance < 45 ? 0.5 : 0.25
  }

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
    if ((P.seek || P.hunt) && hpFrac > 0.6) return true
    return d < 140 && hpFrac > 0.5
  }

  hasWeapon(kind: string) { return this.me.weapons.some((w: any) => w && w.kind === kind) }

  prefRange(t: Track) {
    if (this.hasWeapon("lightning") && this.me.energy > 20) return 28
    if (this.hasWeapon("laser")) return 90
    return 70
  }

  combatCube(obs: Observation, target: Track, zone: ReturnType<Bot["zoneInfo"]>): [number, number] | null {
    const pos = obs.self.pos
    let best: [number, number] | null = null
    // Cubes improve damage and HP up to the cap; extra size keeps growing.
    // Beyond the cap, only detour for a nearby upgrade threshold.
    const config = this.cfg.cubes
    const room = Math.max(0, config.stat_cap - obs.self.cubes)
    const nextUpgrade = config.upgrade_thresholds.find((n: number) => n > obs.self.cubes)
    if (!room && nextUpgrade !== obs.self.cubes + 1) return null
    const budget = room ? 40 : 12
    let bestCost = budget
    const enemyDistance = d2(pos, target.pos)
    for (const cube of obs.cubes) {
      const point = cube.pos
      const distance = d2(pos, point)
      if (distance > budget + 12 || Math.abs(point[2] - pos[2]) >= 4) continue
      if (d2(point, [zone.cx, zone.cy]) >= zone.r || !W!.walkLine(pos[0], pos[1], point[0], point[1])) continue
      const closingDistance = Math.max(0, enemyDistance - d2(point, target.pos))
      // A cluster from a defeated opponent can be collected in one pass.
      let neighbors = 0
      for (const other of obs.cubes) {
        if (neighbors >= Math.min(2, room - 1)) break
        if (other.id !== cube.id && Math.abs(other.pos[2] - point[2]) < 4 && d2(other.pos, point) < 7) neighbors++
      }
      const cost = distance + closingDistance - 6 * neighbors
      if (cost < bestCost) {
        bestCost = cost
        best = [point[0], point[1]]
      }
    }
    return best
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
    // Near the edge of a distracted mech's front arc, strafe onto its weaker side.
    // Keep the normal jink when it is facing us or when we already have its back.
    const side = wrap(Math.atan2(-by,-bx)-t.aim[0])
    if (t.vis && Math.abs(side)>0.85 && Math.abs(side)<2.25 && this.dmgFrom(t.id,1)<1) {
      this.strafeDir = side>0 ? -1 : 1
    }
    const px = (-by / L) * this.strafeDir, py = (bx / L) * this.strafeDir
    // check strafe direction is walkable
    let sx = px, sy = py
    if (!W!.walkLine(pos[0], pos[1], pos[0] + px * 6, pos[1] + py * 6)) { this.strafeDir *= -1; sx = -px; sy = -py }
    const unit = (x: number, y: number): number[] => {
      const length = Math.hypot(x,y) || 1
      return [x/length,y/length]
    }
    const preferred = unit(mv[0]*0.8 + sx*0.7, mv[1]*0.8 + sy*0.7)
    // The path and the sidestep can each be clear while their diagonal
    // crosses a building corner. Check the command the legs will receive.
    if (!this.me.grounded || this.climbH !== null) return preferred
    const cell = W!.toCell(pos[0],pos[1])
    if (cell < 0 || !W!.walk[cell] || Math.abs(W!.hN[cell]-pos[2]) > 1.5) return preferred
    const clear = (direction: number[], distance: number) =>
      W!.walkLine(pos[0],pos[1],pos[0]+direction[0]*distance,pos[1]+direction[1]*distance)
    if (clear(preferred,6)) return preferred

    const alternatives = [
      unit(mv[0]*0.8 - sx*0.7,mv[1]*0.8 - sy*0.7), mv, [sx,sy], [-sx,-sy]
    ].filter(v => Math.hypot(v[0],v[1]) > 0.5)
    for (const distance of [6,3]) {
      if (distance === 3 && clear(preferred,distance)) return preferred
      for (const direction of alternatives) {
        if (clear(direction,distance)) return direction
      }
    }
    return preferred
  }

  coverPoint(pos: number[], threats: Track[], zone: any): [number, number] {
    let best: [number, number] = [pos[0], pos[1]], bs = -1e9
    const tx = threats.reduce((s, t) => s + t.pos[0], 0) / threats.length, ty = threats.reduce((s, t) => s + t.pos[1], 0) / threats.length
    const away = Math.atan2(pos[1] - ty, pos[0] - tx)
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU
      for (const r of [12, 25, 40]) {
        const x = pos[0] + Math.cos(a) * r, y = pos[1] + Math.sin(a) * r
        const c = W!.toCell(x, y)
        if (c < 0 || !W!.walk[c]) continue
        let hidden = 0
        const gz = W!.hN[c] + this.myEye
        for (const t of threats.slice(0, 3)) if (W!.blocked(t.pos[0], t.pos[1], t.pos[2] + 8, x, y, gz, 3)) hidden++
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
    let bestRank = Infinity
    for (const p of obs.pickups as any[]) {
      if (Math.hypot(p.pos[0] - me.pos[0], p.pos[1] - me.pos[1]) > pr - 0.3 || Math.abs(p.pos[2] - me.pos[2]) > 3.8) continue
      if (this.badPick.has(p.id) && this.t - this.badPick.get(p.id)! < 2) continue
      const sl = this.slotFor(p.kind)
      const rank = this.wRank(p.kind)
      if (sl < 0 || rank >= bestRank) continue
      bestRank = rank
      act.take = p.id
      if (me.weapons[sl]) act.drop = sl
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

  roofSpot = -1
  roofFailT = -99
  roofWanted() { return (this.hasSpecial() || this.t > P.roofAfter) && this.t - this.roofFailT > 20 }
  roofGoal(zone: any): [number, number] | null {
    const pos = this.me.pos
    const ok = (c: number) => d2([W!.cellX(c), W!.cellY(c)], zone.nc) < zone.nr - Math.min(20, zone.nr * 0.3)
    if (this.roofSpot >= 0 && !ok(this.roofSpot)) this.roofSpot = -1
    if (this.roofSpot < 0) {
      if (this.busy(10)) return null
      let best = -1, bs = 1e9
      for (const c of W!.roofSpots) {
        if (!ok(c)) continue
        const x = W!.cellX(c), y = W!.cellY(c)
        const sc = Math.hypot(x - pos[0], y - pos[1]) - (W!.hN[c] - W!.ground(x, y)) * 1.5
        if (sc < bs) { bs = sc; best = c }
      }
      if (best < 0) return null
      this.roofSpot = best
      this.roofSetT = this.t
    }
    // give up if we cannot get there in reasonable time
    if (this.t - this.roofSetT > 60 && d2(pos, [W!.cellX(this.roofSpot), W!.cellY(this.roofSpot)]) > 6) { this.roofFailT = this.t; this.roofSpot = -1; return null }
    return [W!.cellX(this.roofSpot), W!.cellY(this.roofSpot)]
  }
  roofSetT = 0

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
      if (rise > 2 && (this.onRoof(p) || !W!.walkLine(pos[0], pos[1], p[0], p[1]))) {
        if (what !== "wpn" || rise > 30) return
        cost += 20 + rise * 2
      }
      if (cost < bs) { bs = cost; best = { pos: [p[0], p[1]], what } }
    }
    for (const [, p] of this.pickMem) {
      if (!this.pickupWanted(p.kind)) continue
      const d = d2(p.pos, pos)
      if (d > (wantWeapon ? 230 : P.lootRange * 1.5)) continue
      consider(p.pos, d * (wantWeapon ? 0.3 : 0.6), "wpn")
    }
    // The caller is deciding whether to divert for a second weapon before
    // engaging. Other loot competes only during ordinary scavenging.
    if (wantWeapon) return best
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
      consider(c.pos, d * P.crateW + 25, "crate")
    }
    if (!nearEnemy && P.npcHunt && this.me.hp / this.me.max_hp > 0.55) for (const [, n] of this.npcMem) {
      const d = d2(n.pos, pos)
      if (d > P.npcRange || d < 50) continue
      consider(n.pos, d * 0.5, "npc")
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

  dropGoal(obs: Observation, zone: ReturnType<Bot["zoneInfo"]>, enemies: Track[], ttl: number): [number, number] | null {
    const me = obs.self
    let best: [number, number] | null = null
    let bestCost = Infinity
    for (const drop of obs.drops) {
      if (drop.holder !== null && drop.holder !== me.id) continue
      const distance = d2(me.pos, drop.pos)
      const walkTime = Math.max(0, distance - drop.radius + 2) / this.cfg.mech.walk_speed
      const captureTime = drop.capture_s - (drop.holder === me.id ? drop.progress : 0)
      const time = Math.max(walkTime, drop.lands_in) + captureTime
      const missingHp = 1 - me.hp / me.max_hp
      const valuable = me.cubes < 10 || missingHp > 0.2
      if (walkTime > (valuable ? 14 : 5) || drop.lands_in > walkTime + 5) continue
      if (d2(drop.pos, [zone.cx, zone.cy]) > zone.r ||
          (time + 3 > zone.timeLeft && d2(drop.pos, zone.nc) > zone.nr - drop.radius)) continue
      if (time + 1 > ttl) continue
      // Skip a race that a visible opponent can finish before we arrive.
      const enemyDistance = enemies.reduce((nearest, e) => Math.min(nearest, d2(e.pos, drop.pos)), Infinity)
      if (enemyDistance < drop.radius || (enemyDistance + drop.radius < distance && enemyDistance < 40)) continue
      const cost = time + Math.max(0, 60 - enemyDistance) / 12
      if (cost < bestCost) {
        bestCost = cost
        best = [drop.pos[0], drop.pos[1]]
      }
    }
    return best
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
    if (needPlan && (!this.path || !this.busy(10))) {
      this.path = W!.astar(pos[0], pos[1], pos[2], goal[0], goal[1], null, this.busy(6) ? 2500 : 7000)
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

  // an enemy charging a laser at us: commit to a sidestep against our current drift shortly before it can fire
  laserDodge(obs: Observation): number[] | null {
    if (!P.ldodge) return null
    const me = this.me, pos = me.pos
    if (this.t < this.dodgeUntil && this.dodgeDir) {
      return this.dodgeVec
    }
    for (const m of obs.mechs as any[]) {
      if (m.kind !== "mech" || !m.charging) continue
      const st = this.chargeStart.get(m.id)
      if (st === undefined) continue
      const el = this.t - st
      if (el < P.ldodge) continue
      const bx = pos[0] - m.pos[0], by = pos[1] - m.pos[1]
      const d = Math.hypot(bx, by)
      if (d > 280 || d < 8) continue
      const off = Math.abs(wrap(Math.atan2(by, bx) - m.aim[0]))
      if (off > Math.atan2(10, d) + 0.05) continue
      const tr = this.tracks.get(m.id)
      if (tr && !this.losClear(pos, tr)) continue
      // perpendicular, opposite to our current sideways drift
      const px = -by / d, py = bx / d
      const lat = me.vel[0] * px + me.vel[1] * py
      let dir = lat > 0.5 ? -1 : lat < -0.5 ? 1 : this.rng() < 0.5 ? -1 : 1
      if (!W!.walkLine(pos[0], pos[1], pos[0] + px * dir * 6, pos[1] + py * dir * 6)) dir = -dir
      this.dodgeDir = dir
      this.dodgeVec = [px * dir, py * dir]
      this.dodgeUntil = this.t + 0.45
      return this.dodgeVec
    }
    return null
  }
  dodgeVec: number[] = [0, 0]
  kills = 0
  evadeGoal: [number, number] | null = null
  evadeGT = -99
  evading() { return (P.evade > 0 && this.kills >= P.evade) || (P.evadeT > 0 && this.t > P.evadeT) }
  // a spot inside the next circle as far as possible from every mech we know about, preferring cover
  evadePoint(pos: number[], zone: any): [number, number] {
    const threats = [...this.tracks.values()].filter((e) => e.kind === "mech" && this.t - e.seenT < 20)
    const snd = this.sndMem.filter((m) => this.t - m.t < 6)
    let best: [number, number] = [pos[0], pos[1]], bs = -1e9
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU
      for (const r of [0, 30, 60, 100]) {
        if (r === 0 && k) continue
        const x = pos[0] + Math.cos(a) * r, y = pos[1] + Math.sin(a) * r
        const c = W!.toCell(x, y)
        if (c < 0 || !W!.walk[c]) continue
        if (!this.insideNext([x, y], zone, 15)) continue
        let md = 400, hidden = 0
        for (const t of threats) {
          const d = Math.hypot(t.pos[0] - x, t.pos[1] - y)
          md = Math.min(md, d)
          if (d < 200 && W!.blocked(t.pos[0], t.pos[1], t.pos[2] + 8, x, y, W!.ground(x, y) + 6, 4)) hidden++
        }
        for (const m of snd) md = Math.min(md, Math.hypot(m.x - x, m.y - y) + 40)
        let sc = Math.min(md, 250) + hidden * 25 - r * 0.15
        // stay away from the edge of the next circle and from the current zone edge
        sc -= Math.max(0, 40 - (zone.nr - d2([x, y], zone.nc))) * 1.5
        if (sc > bs) { bs = sc; best = [x, y] }
      }
    }
    return best
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
    let tgt: Track | null = target && target.vis && this.losClear(pos, target) ? target : null
    if (!tgt) {
      // any visible enemy with LOS
      let bd = 1e9
      for (const e of this.tracks.values()) {
        if (e.kind !== "mech" || !e.vis) continue
        const d = d2(e.pos, pos)
        if (d < bd && d < 230 && this.losClear(pos, e)) { bd = d; tgt = e }
      }
    }
    let isNpc = false
    const withdrawing = this.mode === "retreat" || this.mode === "regen" || this.mode === "evade" || (this.mode === "zone" && !me.in_zone)
    if (!tgt && P.npcFarm && !withdrawing) {
      let bd = 1e9
      for (const n of npcs) {
        const d = d2(n.pos, pos)
        const hostile = this.dmgLog.some((x) => x.by === n.id && this.t - x.t < 5)
        if ((hostile || (d < 120 && me.hp / me.max_hp > 0.4)) && d < bd && this.losClear(pos, n)) { bd = d; tgt = n }
      }
      if (tgt) isNpc = true
    }
    let crateTgt: any = null
    if (!tgt && P.crateFarm && !withdrawing) {
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
        let finishNow = false
        if (dist < (l.stats.range ?? 280) * 0.97) {
          if (l.charge > 0) {
            // charging: keep holding until full and aligned
            // Release as soon as a centered beam can finish a mech, allowing
            // for three armor stacks and the minimum effective charge.
            const minCharge = l.stats.min_charge
            if (tgt.kind === "mech" && l.charge >= minCharge && yErr < tolL && pErr < tolL) {
              const fraction = clamp((l.charge-minCharge)/Math.max(0.01,fullCharge-minCharge),0,1)
              const power = l.stats.min_frac + (1-l.stats.min_frac)*fraction
              const cubes = 1+this.cfg.cubes.damage_per_cube*Math.min(me.cubes,this.cfg.cubes.stat_cap)
              const bonus = tgt.weapons.includes("mortar") ? 1+l.stats.cookoff : 1
              finishNow = tgt.hp <= l.stats.damage*power*cubes*bonus*0.76
            }
            const ready = l.charge >= fullCharge - 0.02
            if (ready && yErr < tolL && pErr < tolL * 1.5) fire[lzS] = false
            else fire[lzS] = true
            if (finishNow || (ready && yErr < tolL * 1.6)) fire[lzS] = false
          } else if (l.cooldown <= 0.05) {
            fire[lzS] = true // start charge
          }
          // when using the laser, aim without bullet lead (hitscan)
          if (l.charge > 0 || l.cooldown <= 0.1) {
            if (finishNow || !(gunS >= 0 && fire[gunS] && l.charge < fullCharge * 0.5)) aim = instAim
          }
        } else if (l.charge > 0) fire[lzS] = false
      }
      if (moS >= 0) {
        const m = ws[moS]
        // At close range the gun and mortar can both hit the same mech.
        // Aim the tube into the lower torso and keep an aligned gun trigger.
        if (tgt.kind === "mech" && m.cooldown <= 0 && dist <= 60 &&
            dist > Math.max(16, this.myR+this.cfg.weapons.mortar.splash_radius+4)) {
          const arrival = dist/m.stats.speed
          const point = [tgt.pos[0]+tgt.vel[0]*arrival, tgt.pos[1]+tgt.vel[1]*arrival,
            tgt.pos[2]+0.7*(this.centerZ(tgt)-tgt.pos[2])]
          const arc = this.mortarSolve(point,false)
          if (arc && arc[1] > this.cfg.mech.min_pitch && arc[1] < this.cfg.mech.max_pitch) {
            aim = [arc[0],arc[1]]
            const tolerance = Math.atan2(rad*0.75,dist)
            fire[moS] = Math.abs(wrap(arc[0]-curYaw)) < tolerance && Math.abs(arc[1]-curPitch) < tolerance
          }
        } else if (m.cooldown <= 0 && dist > 30 && dist < 220 && !(lzS >= 0 && ws[lzS].charge > 0)) {
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
    if (!tgt || isNpc) {
      const guard = this.guardFacing(aim[0])
      if (guard !== null && Math.abs(wrap(guard-aim[0])) > 0.15) {
        aim = [guard,0]
        fire.fill(false)
      }
    }
    // reload when idle
    if (gunS >= 0) {
      const g = ws[gunS]
      if (g.reload === 0 && g.ammo < g.stats.mag * 0.5 && !tgt) act.reload = true
    }
    // don't release laser into nothing
    if (!withdrawing && lzS >= 0 && !tgt && ws[lzS].charge > 0) fire[lzS] = true
    // pre-charge behind cover for an enemy we expect to see soon
    if (!withdrawing && P.precharge && lzS >= 0 && !tgt && ws[lzS].charge === 0 && ws[lzS].cooldown <= 0.05 && target && target.kind === "mech" && this.t - target.seenT < 3 && d2(target.pos, pos) < 170 && !["zone", "retreat", "getweapon", "explore", "regen"].includes(this.mode)) fire[lzS] = true
    act.aim = [aim[0], clamp(aim[1], this.cfg.mech.min_pitch, this.cfg.mech.max_pitch)]
    act.fire = fire
  }
}

run((hello) => new Bot(hello) as any)
