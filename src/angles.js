// Stage 2: joint angles from landmarks, plus adaptive low-latency smoothing.

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

/** Angle at vertex b formed by a-b-c, in degrees (0..180). */
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

/** Average visibility (0..1) of a list of landmark indices. */
export function sideVisibility(landmarks, idxs) {
  return idxs.reduce((s, i) => s + (landmarks[i]?.visibility ?? 0), 0) / idxs.length;
}

/** Pick the side (L or R) whose landmarks are more visible. */
export function pickSide(landmarks, leftIdx, rightIdx) {
  return sideVisibility(landmarks, leftIdx) >= sideVisibility(landmarks, rightIdx) ? "L" : "R";
}

/**
 * Adaptive velocity-aware smoother (inspired by 1-Euro filtering).
 * Smooths out small jitter when stationary, but ramps up alpha when the joint is moving
 * purposefully so on-screen gauges and jumps respond immediately with minimal lag.
 */
export class Smoother {
  constructor(alpha = 0.35) {
    this.alpha = alpha;
    this.value = null;
  }
  push(x) {
    if (this.value === null) {
      this.value = x;
      return x;
    }
    const delta = Math.abs(x - this.value);
    const adaptiveAlpha = Math.min(0.85, Math.max(this.alpha * 0.75, this.alpha + (delta / 9) * 0.5));
    this.value = this.value + adaptiveAlpha * (x - this.value);
    return this.value;
  }
  reset() {
    this.value = null;
  }
}
