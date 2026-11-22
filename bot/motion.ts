import gun from "./gun-motion.json"
import mortar from "./mortar-motion.json"

type Velocity = [number, number, number]
type Sample = { time: number; vx: number; vy: number }
type Model = typeof gun

function correction(model: Model, features: number[]) {
  let result = model.bias
  for (const tree of model.trees) {
    let node = 0
    while (tree.left[node] >= 0) {
      node = features[tree.feature[node]] <= tree.threshold[node] ? tree.left[node] : tree.right[node]
    }
    result += tree.value[node]
  }
  return result
}

export class MotionHistory {
  private samples = new Map<number, Sample[]>()

  observe(id: number, time: number, vel: Velocity) {
    const samples = this.samples.get(id) ?? []
    if (samples.length && time <= samples[samples.length-1].time) return
    samples.push({ time, vx: vel[0], vy: vel[1] })
    while (samples.length > 4) samples.shift()
    this.samples.set(id, samples)
  }

  // Estimate the deviation from constant velocity in the plane of the arena.
  // The fitted residuals use only observations available before the shot.
  adjust(weapon: "gun" | "mortar", target: {id:number; pos:Velocity; vel:Velocity; aim:[number,number]; charging:boolean},
      shooter: Velocity, time: number, flight: number, point: Velocity) {
    const samples = this.samples.get(target.id)
    if (!samples || samples.length < 4 || time-samples[0].time > 0.36 ||
        Math.abs(samples[3].time-time) > 0.01) return
    const dx = target.pos[0]-shooter[0], dy = target.pos[1]-shooter[1]
    const distance = Math.hypot(dx,dy), speed = Math.hypot(target.vel[0],target.vel[1])
    if (speed < 1 || distance < 10 || distance > (weapon === "gun" ? 225 : 190)) return
    const nx = -dy/distance, ny = dx/distance
    const lateral = target.vel[0]*nx + target.vel[1]*ny
    const radial = target.vel[0]*ny - target.vel[1]*nx
    const sign = lateral >= 0 ? 1 : -1
    const change = (s: Sample) => (lateral - s.vx*nx - s.vy*ny)*sign
    const facing = target.aim[0]-Math.atan2(-dy,-dx)
    const features = [flight, Math.abs(lateral), radial, change(samples[2]), change(samples[0]),
      Math.cos(facing), Math.sin(facing)*sign, Math.abs(target.vel[2]), Number(target.charging)]
    const bound = weapon === "gun" ? 7 : 15
    const limit = (value: number) => Math.max(-bound, Math.min(value,bound))
    const side = sign * limit(correction(weapon === "gun" ? gun : mortar[0], features))
    const along = weapon === "gun" ? 0 : limit(correction(mortar[1],features))
    point[0] += side*nx + along*ny
    point[1] += side*ny - along*nx
  }
}
