/** 点到线段的最短距离与垂足 */
export function distPointToSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { dist: number; footX: number; footY: number } {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-9) return { dist: Math.hypot(px - ax, py - ay), footX: ax, footY: ay }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  const fx = ax + t * dx
  const fy = ay + t * dy
  return { dist: Math.hypot(px - fx, py - fy), footX: fx, footY: fy }
}

/** 两条线段的交点；平行或交点不在两段范围内返回 null */
export function segSegIntersect(
  a1: [number, number],
  a2: [number, number],
  b1: [number, number],
  b2: [number, number]
): [number, number] | null {
  const d1x = a2[0] - a1[0]
  const d1y = a2[1] - a1[1]
  const d2x = b2[0] - b1[0]
  const d2y = b2[1] - b1[1]
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-9) return null
  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / den
  const u = ((b1[0] - a1[0]) * d1y - (b1[1] - a1[1]) * d1x) / den
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return [a1[0] + t * d1x, a1[1] + t * d1y]
}
