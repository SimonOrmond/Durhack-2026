// Stage 2: joint angles from landmarks, plus smoothing.

// MediaPipe Pose landmark indices (33 points).
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

/** Angle at vertex b formed by a-b-c, in degrees (0..180). Uses x/y only. */
export function angle2D(a, b, c, aspect = 1) {
  // aspect corrects for non-square normalized coords (x in 0..1 of width, y in 0..1 of height).
  const abx = (a.x - b.x) * aspect, aby = a.y - b.y;
  const cbx = (c.x - b.x) * aspect, cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (mag === 0) return 0;
  return (Math.acos(Math.min(1, Math.max(-1, dot / mag))) * 180) / Math.PI;
}

/** Angle at vertex b using 3D world landmarks (metres). More robust when the camera isn't side-on. */
export function angle3D(a, b, c) {
  const ab = [a.x - b.x, a.y - b.y, a.z - b.z];
  const cb = [c.x - b.x, c.y - b.y, c.z - b.z];
  const dot = ab[0] * cb[0] + ab[1] * cb[1] + ab[2] * cb[2];
  const mag = Math.hypot(...ab) * Math.hypot(...cb);
  if (mag === 0) return 0;
  return (Math.acos(Math.min(1, Math.max(-1, dot / mag))) * 180) / Math.PI;
}

/** Angle of the segment a->b from vertical, in degrees (0 = perfectly vertical). */
export function tiltFromVertical(a, b, aspect = 1) {
  const dx = (b.x - a.x) * aspect, dy = b.y - a.y;
  return Math.abs((Math.atan2(dx, dy) * 180) / Math.PI);
}

/** Pick the side (L or R) whose landmarks are more visible. */
export function pickSide(landmarks, leftIdx, rightIdx) {
  const vis = (idxs) => idxs.reduce((s, i) => s + (landmarks[i]?.visibility ?? 0), 0) / idxs.length;
  return vis(leftIdx) >= vis(rightIdx) ? "L" : "R";
}

/** Exponential moving average smoother. alpha closer to 1 = less smoothing. */
export class Smoother {
  constructor(alpha = 0.35) { this.alpha = alpha; this.value = null; }
  push(x) {
    this.value = this.value === null ? x : this.value + this.alpha * (x - this.value);
    return this.value;
  }
  reset() { this.value = null; }
}
