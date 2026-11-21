// Static world model: terrain, prisms (buildings/bridges), line-of-sight, and a ground navigation grid.
import fs from "node:fs"
import path from "node:path"

type Prism = { kind: string; base: number; top: number; ring: Float64Array; holes: Float64Array[]; minX: number; maxX: number; minY: number; maxY: number }

function pip(px: number, py: number, r: Float64Array): boolean {
  let inside = false
  const n = r.length >> 1
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export class World {
  tMinX: number; tMinY: number; nx: number; ny: number; terr: Float32Array
  prisms: Prism[] = []
  // prism spatial hash
  cs = 8; gx0: number; gy0: number; gnx: number; gny: number; cells: Int32Array[]
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  // nav grid (2 m)
  ns = 2; nnx: number; nny: number; nox: number; noy: number
  walk: Uint8Array // 1 walkable
  clear: Float32Array // clearance (m) on 1 m grid
  roofTop: Float32Array // 1m grid: highest prism top over cell (or -1e9)
  roofBase: Float32Array

  constructor(dir: string) {
    const w = JSON.parse(fs.readFileSync(path.join(dir, "v2/world.json"), "utf8"))
    const t = w.terrain
    this.tMinX = t.minX; this.tMinY = t.minY; this.nx = t.nx; this.ny = t.ny
    const buf = fs.readFileSync(path.join(dir, "v2/terrain.i16"))
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, (buf.byteLength >> 1))
    this.terr = new Float32Array(this.nx * this.ny)
    for (let i = 0; i < this.terr.length; i++) this.terr[i] = i16[i] * 0.01
    this.bounds = w.bounds
    for (const p of w.prisms) {
      const ring = Float64Array.from(p.ring)
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9
      for (let i = 0; i < ring.length; i += 2) { minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]); minY = Math.min(minY, ring[i + 1]); maxY = Math.max(maxY, ring[i + 1]) }
      this.prisms.push({ kind: p.kind, base: p.base, top: p.top, ring, holes: (p.holes || []).map((h: number[]) => Float64Array.from(h)), minX, maxX, minY, maxY })
    }
    this.gx0 = this.bounds.minX - 10; this.gy0 = this.bounds.minY - 10
    this.gnx = Math.ceil((this.bounds.maxX - this.gx0 + 10) / this.cs); this.gny = Math.ceil((this.bounds.maxY - this.gy0 + 10) / this.cs)
    const lists: number[][] = Array.from({ length: this.gnx * this.gny }, () => [])
    this.prisms.forEach((p, idx) => {
      const i0 = Math.max(0, Math.floor((p.minX - this.gx0) / this.cs)), i1 = Math.min(this.gnx - 1, Math.floor((p.maxX - this.gx0) / this.cs))
      const j0 = Math.max(0, Math.floor((p.minY - this.gy0) / this.cs)), j1 = Math.min(this.gny - 1, Math.floor((p.maxY - this.gy0) / this.cs))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) lists[j * this.gnx + i].push(idx)
    })
    this.cells = lists.map((l) => Int32Array.from(l))
    this.buildRoof()
    this.buildNav()
  }

  ground(x: number, y: number): number {
    let fx = (x - this.tMinX), fy = (y - this.tMinY)
    if (fx < 0) fx = 0; if (fy < 0) fy = 0
    if (fx > this.nx - 1.001) fx = this.nx - 1.001; if (fy > this.ny - 1.001) fy = this.ny - 1.001
    const i = fx | 0, j = fy | 0, ax = fx - i, ay = fy - j
    const k = j * this.nx + i, T = this.terr
    return (T[k] * (1 - ax) + T[k + 1] * ax) * (1 - ay) + (T[k + this.nx] * (1 - ax) + T[k + this.nx + 1] * ax) * ay
  }

  inPrism(p: Prism, x: number, y: number): boolean {
    if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) return false
    if (!pip(x, y, p.ring)) return false
    for (const h of p.holes) if (pip(x, y, h)) return false
    return true
  }

  cellList(x: number, y: number): Int32Array | null {
    const i = Math.floor((x - this.gx0) / this.cs), j = Math.floor((y - this.gy0) / this.cs)
    if (i < 0 || j < 0 || i >= this.gnx || j >= this.gny) return null
    return this.cells[j * this.gnx + i]
  }

  solidAt(x: number, y: number, z: number): boolean {
    const l = this.cellList(x, y)
    if (l) for (let k = 0; k < l.length; k++) {
      const p = this.prisms[l[k]]
      if (z >= p.base && z <= p.top && this.inPrism(p, x, y)) return true
    }
    return z < this.ground(x, y) - 0.05
  }

  // true if the straight segment a->b passes through a prism or terrain. step in meters
  blocked(ax: number, ay: number, az: number, bx: number, by: number, bz: number, step = 1.0, skipEnd = 0): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.hypot(dx, dy, dz)
    const n = Math.max(1, Math.ceil(L / step))
    const nEnd = n - Math.ceil(skipEnd / (L / n))
    for (let s = 1; s < nEnd; s++) {
      const f = s / n
      if (this.solidAt(ax + dx * f, ay + dy * f, az + dz * f)) return true
    }
    return false
  }

  // ---- 1 m surface raster: highest solid top standing on the ground (roofs, stands), else terrain ----
  surf: Float32Array
  steep: Uint8Array
  hN: Float32Array // nav cell surface height
  roofSpots: number[] = []
  buildRoof() {
    const N = this.nx * this.ny
    this.roofTop = new Float32Array(N).fill(-1e9)
    this.roofBase = new Float32Array(N).fill(1e9)
    this.surf = new Float32Array(N)
    for (let k = 0; k < N; k++) this.surf[k] = this.terr[k]
    for (const p of this.prisms) {
      const i0 = Math.max(0, Math.floor(p.minX - this.tMinX)), i1 = Math.min(this.nx - 1, Math.ceil(p.maxX - this.tMinX))
      const j0 = Math.max(0, Math.floor(p.minY - this.tMinY)), j1 = Math.min(this.ny - 1, Math.ceil(p.maxY - this.tMinY))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = this.tMinX + i, y = this.tMinY + j
        if (!this.inPrism(p, x, y)) continue
        const k = j * this.nx + i
        const g = this.terr[k]
        if (p.base < g + 9.2 && p.top > g + 0.05) {
          if (p.top > this.roofTop[k]) this.roofTop[k] = p.top
          if (p.base < this.roofBase[k]) this.roofBase[k] = p.base
          if (p.top > this.surf[k]) this.surf[k] = p.top
        }
      }
    }
  }

  buildNav() {
    const nx = this.nx, ny = this.ny
    const S = this.surf
    const tanMax = Math.tan((50 * Math.PI) / 180) * 0.92
    // steep terrain marker (only meaningful where surface is terrain)
    this.steep = new Uint8Array(nx * ny)
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i
      if (this.roofTop[k] > -1e8) continue
      const g = this.terr[k]
      if (Math.abs(this.terr[k + 1] - g) > tanMax || Math.abs(this.terr[k + nx] - g) > tanMax) this.steep[k] = 1
    }
    this.nox = this.tMinX; this.noy = this.tMinY
    this.nnx = Math.floor(nx / 2); this.nny = Math.floor(ny / 2)
    const NN = this.nnx * this.nny
    this.walk = new Uint8Array(NN)
    this.hN = new Float32Array(NN)
    const b = this.bounds, margin = 4
    for (let j = 0; j < this.nny; j++) for (let i = 0; i < this.nnx; i++) {
      const ci = 2 * i + 1, cj = 2 * j + 1
      const kc = cj * nx + ci
      const h = S[kc]
      this.hN[j * this.nnx + i] = h
      const x = this.tMinX + ci, y = this.tMinY + cj
      if (x < b.minX + margin || x > b.maxX - margin || y < b.minY + margin || y > b.maxY - margin) continue
      let ok = true
      for (let dj = -3; dj <= 3 && ok; dj++) for (let di = -3; di <= 3; di++) {
        if (di * di + dj * dj > 9) continue
        const ii = ci + di, jj = cj + dj
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) { ok = false; break }
        const kk = jj * nx + ii
        if (S[kk] > h + 1.2) { ok = false; break }
        if (this.steep[kk] && Math.abs(S[kk] - h) < 3 && di * di + dj * dj <= 2) { ok = false; break }
      }
      // standing on a thin ledge: require some support under the body
      if (ok && this.roofTop[kc] > -1e8) {
        let sup = 0
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (Math.abs(S[(cj + dj) * nx + ci + di] - h) < 0.6) sup++
        if (sup < 6) ok = false
      }
      this.walk[j * this.nnx + i] = ok ? 1 : 0
    }
    // roof camping spots: nav cells well above the ground whose 6 m neighbourhood is flat roof
    this.roofSpots = []
    for (let j = 3; j < this.nny - 3; j++) for (let i = 3; i < this.nnx - 3; i++) {
      const c = j * this.nnx + i
      if (!this.walk[c]) continue
      const h = this.hN[c]
      const g = this.terr[(2 * j + 1) * nx + 2 * i + 1]
      if (h < g + 10 || h > g + 42) continue
      let ok = true
      for (let dj = -3; dj <= 3 && ok; dj++) for (let di = -3; di <= 3; di++) {
        const n = (j + dj) * this.nnx + i + di
        if (!this.walk[n] || Math.abs(this.hN[n] - h) > 1.0) { ok = false; break }
      }
      if (ok) this.roofSpots.push(c)
    }
    // clearance grid not used anymore: keep a cheap version for compatibility
    this.clear = new Float32Array(0)
  }

  clearanceAt(_x: number, _y: number): number { return 10 }
  roofAt(x: number, y: number): number {
    const i = Math.round(x - this.tMinX), j = Math.round(y - this.tMinY)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1e9
    return this.roofTop[j * this.nx + i]
  }
  surfAt(x: number, y: number): number {
    const i = Math.round(x - this.tMinX), j = Math.round(y - this.tMinY)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return 0
    return this.surf[j * this.nx + i]
  }

  // nav cell helpers
  toCell(x: number, y: number): number {
    const i = Math.floor((x - this.nox) / 2), j = Math.floor((y - this.noy) / 2)
    if (i < 0 || j < 0 || i >= this.nnx || j >= this.nny) return -1
    return j * this.nnx + i
  }
  cellX(c: number) { return this.nox + (c % this.nnx) * 2 + 1 }
  cellY(c: number) { return this.noy + Math.floor(c / this.nnx) * 2 + 1 }

  // nearest walkable cell whose surface is not above z+1.2 (z = current feet height, or undefined)
  nearestWalk(x: number, y: number, maxR = 40, z?: number): number {
    const okZ = (c: number) => z === undefined || this.hN[c] <= z + 1.5
    const c0 = this.toCell(x, y)
    if (c0 >= 0 && this.walk[c0] && okZ(c0)) return c0
    const i0 = Math.floor((x - this.nox) / 2), j0 = Math.floor((y - this.noy) / 2)
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bd = 1e9
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
        const i = i0 + di, j = j0 + dj
        if (i < 0 || j < 0 || i >= this.nnx || j >= this.nny) continue
        const c = j * this.nnx + i
        if (!this.walk[c] || !okZ(c)) continue
        const d = di * di + dj * dj + (z === undefined ? 0 : Math.abs(this.hN[c] - z) * 0.5)
        if (d < bd) { bd = d; best = c }
      }
      if (best >= 0) return best
    }
    return -1
  }

  maxSurfAlong(ax: number, ay: number, bx: number, by: number): number {
    const L = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(L / 0.7))
    let m = -1e9
    for (let s = 0; s <= n; s++) { const v = this.surfAt(ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n); if (v > m) m = v }
    return m
  }

  // can walk straight from a to b without climbing more than a step (drops allowed)
  walkLine(ax: number, ay: number, bx: number, by: number): boolean {
    const L = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(L / 1.0))
    let prevH = -1e9
    for (let s = 0; s <= n; s++) {
      const f = s / n
      const c = this.toCell(ax + (bx - ax) * f, ay + (by - ay) * f)
      if (c < 0 || !this.walk[c]) return false
      const h = this.hN[c]
      if (s > 0 && h > prevH + 1.15) return false
      prevH = h
    }
    return true
  }

  // A* on nav grid. cost(c) extra per-cell cost. returns list of cells or null
  private gS: Float32Array | null = null
  private came: Int32Array | null = null
  private stamp: Uint32Array | null = null
  private closedStamp: Uint32Array | null = null
  private curStamp = 0
  maxJet = 40
  astar(sx: number, sy: number, sz: number | undefined, tx: number, ty: number, extra: ((x: number, y: number) => number) | null, maxExp = 60000): number[] | null {
    const s = this.nearestWalk(sx, sy, 15, sz), t = this.nearestWalk(tx, ty, 40)
    if (s < 0 || t < 0) return null
    const N = this.nnx * this.nny
    if (!this.gS) { this.gS = new Float32Array(N); this.came = new Int32Array(N); this.stamp = new Uint32Array(N); this.closedStamp = new Uint32Array(N) }
    const g = this.gS!, came = this.came!, st = this.stamp!, cl = this.closedStamp!
    const stp = ++this.curStamp
    const nnx = this.nnx, nny = this.nny
    const txc = t % nnx, tyc = Math.floor(t / nnx)
    const h = (c: number) => { const dx = Math.abs((c % nnx) - txc), dy = Math.abs(Math.floor(c / nnx) - tyc); return 2 * (Math.max(dx, dy) + 0.4142 * Math.min(dx, dy)) * 1.2 }
    // binary heap
    const heapC: number[] = [], heapF: number[] = []
    const push = (c: number, f: number) => {
      let i = heapC.length; heapC.push(c); heapF.push(f)
      while (i > 0) { const p = (i - 1) >> 1; if (heapF[p] <= f) break; heapC[i] = heapC[p]; heapF[i] = heapF[p]; i = p }
      heapC[i] = c; heapF[i] = f
    }
    const pop = () => {
      const top = heapC[0]
      const lc = heapC.pop()!, lf = heapF.pop()!
      if (heapC.length) {
        let i = 0; const n = heapC.length
        while (true) { let l = 2 * i + 1; if (l >= n) break; const r = l + 1; if (r < n && heapF[r] < heapF[l]) l = r; if (heapF[l] >= lf) break; heapC[i] = heapC[l]; heapF[i] = heapF[l]; i = l }
        heapC[i] = lc; heapF[i] = lf
      }
      return top
    }
    st[s] = stp; g[s] = 0; came[s] = -1; push(s, h(s))
    let exp = 0, best = s, bestH = h(s)
    const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1]
    while (heapC.length) {
      const c = pop()
      if (cl[c] === stp) continue
      cl[c] = stp
      if (c === t) { best = c; break }
      const hc = h(c)
      if (hc < bestH) { bestH = hc; best = c }
      if (++exp > maxExp) break
      const ci = c % nnx, cj = Math.floor(c / nnx)
      for (let d = 0; d < 8; d++) {
        const i = ci + DI[d], j = cj + DJ[d]
        if (i < 0 || j < 0 || i >= nnx || j >= nny) continue
        const n = j * nnx + i
        if (!this.walk[n] || cl[n] === stp) continue
        if (d >= 4 && (!this.walk[cj * nnx + i] || !this.walk[j * nnx + ci])) continue
        const rise = this.hN[n] - this.hN[c]
        let cost = d < 4 ? 2 : 2.828
        if (rise > 1.15) {
          if (rise > this.maxJet) continue
          cost += 12 + rise * 2.5
        }
        if (extra) cost += extra(this.cellX(n), this.cellY(n)) * (d < 4 ? 1 : 1.414)
        const ng = g[c] + cost
        if (st[n] !== stp || ng < g[n]) { st[n] = stp; g[n] = ng; came[n] = c; push(n, ng + h(n)) }
      }
      // hop edges: jet over walls / up cliffs in the 8 directions where the neighbor is blocked
      const hc0 = this.hN[c]
      for (let d = 0; d < 8; d++) {
        const i1 = ci + DI[d], j1 = cj + DJ[d]
        if (i1 < 0 || j1 < 0 || i1 >= nnx || j1 >= nny) continue
        const n1 = j1 * nnx + i1
        if (this.walk[n1] && this.hN[n1] - hc0 <= 1.15) continue
        let maxH = -1e9
        for (let k = 1; k <= 10; k++) {
          const i = ci + DI[d] * k, j = cj + DJ[d] * k
          if (i < 0 || j < 0 || i >= nnx || j >= nny) break
          const n = j * nnx + i
          // max surface along this 2 m step (sample the 1 m raster)
          const sx = 2 * i + 1, sy = 2 * j + 1
          for (let q = -1; q <= 1; q++) {
            const kk = (sy + (DI[d] !== 0 && DJ[d] === 0 ? q : 0)) * this.nx + sx + (DJ[d] !== 0 && DI[d] === 0 ? q : 0)
            if (this.surf[kk] > maxH) maxH = this.surf[kk]
          }
          if (maxH - hc0 > this.maxJet) break
          if (k >= 2 && this.walk[n] && cl[n] !== stp && this.hN[n] >= maxH - 1.2) {
            const rise = Math.max(0, maxH - hc0)
            const ng = g[c] + k * (d < 4 ? 2 : 2.828) + 14 + rise * 2.5
            if (st[n] !== stp || ng < g[n]) { st[n] = stp; g[n] = ng; came[n] = c; push(n, ng + h(n)) }
            break
          }
          if (k >= 2 && this.walk[n] && this.hN[n] < maxH - 1.2) {
            // landing lower than the obstacle top (dropping off the far side of a wall)
            const rise = Math.max(0, maxH - hc0)
            const ng = g[c] + k * (d < 4 ? 2 : 2.828) + 14 + rise * 2.5
            if (cl[n] !== stp && (st[n] !== stp || ng < g[n])) { st[n] = stp; g[n] = ng; came[n] = c; push(n, ng + h(n)) }
            break
          }
        }
      }
    }
    const out: number[] = []
    let c = best
    while (c >= 0) { out.push(c); if (c === s) break; c = came[c] }
    out.reverse()
    return out
  }
}
