// Stage 3: exercise definitions + rep-detection state machine.
//
// Each exercise exposes:
//   joints(side)          -> [a, b, c] landmark indices; angle is measured at b
//   restAngle/targetAngle -> angle at the rest position and the fully-performed position
//   formChecks            -> [{ test(ctx) -> cue string | null }]
//
// Everything is normalised into a 0..1 "progress" value so the state machine
// and the game don't need to know whether the angle gets bigger or smaller.

import { LM, tiltFromVertical } from "./angles.js";

const side = (s, l, r) => (s === "L" ? l : r);

export const EXERCISES = {
  squat: {
    name: "Squat / sit-to-stand",
    instructions: "Stand side-on to the camera, whole body in frame. Bend knees to ~90 degrees and stand back up.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_KNEE, LM.R_KNEE), side(s, LM.L_ANKLE, LM.R_ANKLE)],
    restAngle: 170,
    targetAngle: 95,
    formChecks: [
      {
        test: ({ lm, s, aspect }) => {
          const sh = lm[side(s, LM.L_SHOULDER, LM.R_SHOULDER)];
          const hip = lm[side(s, LM.L_HIP, LM.R_HIP)];
          return tiltFromVertical(hip, sh, aspect) > 45 ? "Keep your chest up" : null;
        },
      },
    ],
  },

  curl: {
    name: "Elbow flexion (bicep curl)",
    instructions: "Face the camera, arm by your side. Bend the elbow fully, then straighten.",
    joints: (s) => [side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_ELBOW, LM.R_ELBOW), side(s, LM.L_WRIST, LM.R_WRIST)],
    restAngle: 160,
    targetAngle: 50,
    formChecks: [
      {
        test: ({ lm, s, aspect }) => {
          const sh = lm[side(s, LM.L_SHOULDER, LM.R_SHOULDER)];
          const el = lm[side(s, LM.L_ELBOW, LM.R_ELBOW)];
          return tiltFromVertical(sh, el, aspect) > 35 ? "Keep your elbow tucked in" : null;
        },
      },
    ],
  },

  shoulderRaise: {
    name: "Shoulder abduction (arm raise)",
    instructions: "Face the camera. Raise one arm out to the side and up above shoulder height, then lower.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_ELBOW, LM.R_ELBOW)],
    restAngle: 20,
    targetAngle: 140,
    formChecks: [
      {
        test: ({ lm, aspect }) => {
          const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
          const hips = mid(lm[LM.L_HIP], lm[LM.R_HIP]);
          const shoulders = mid(lm[LM.L_SHOULDER], lm[LM.R_SHOULDER]);
          return tiltFromVertical(hips, shoulders, aspect) > 15 ? "Keep your torso upright" : null;
        },
      },
    ],
  },

  kneeExtension: {
    name: "Seated knee extension",
    instructions: "Sit side-on to the camera. Straighten the knee fully, hold briefly, then lower.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_KNEE, LM.R_KNEE), side(s, LM.L_ANKLE, LM.R_ANKLE)],
    restAngle: 95,
    targetAngle: 165,
    formChecks: [],
  },
};

/** Map a raw angle to 0 (rest) .. 1 (target). Can slightly exceed 1 for extra ROM. */
export function progressFromAngle(ex, angle) {
  return (angle - ex.restAngle) / (ex.targetAngle - ex.restAngle);
}

/**
 * Rep state machine driven by progress (0..1).
 *   rest   --(progress > enterTarget)-->  active
 *   active --(progress < exitTarget)-->   rest   => REP COMPLETE
 * Hysteresis (0.8 in / 0.25 out) stops jitter from double-counting.
 */
export class RepCounter extends EventTarget {
  constructor({ enterTarget = 0.8, exitTarget = 0.25, minRepMs = 400 } = {}) {
    super();
    this.enterTarget = enterTarget;
    this.exitTarget = exitTarget;
    this.minRepMs = minRepMs;
    this.reset();
  }

  reset() {
    this.phase = "rest"; // "rest" | "active"
    this.count = 0;
    this.maxProgress = 0;
    this.repStart = 0;
    this.holdStart = 0;
    this.holdMs = 0;
    this.lastRom = null;
  }

  update(progress, tMs) {
    const p = Math.max(-0.2, Math.min(1.3, progress));

    if (this.phase === "rest") {
      if (p >= this.enterTarget) {
        this.phase = "active";
        this.repStart = this.holdStart = tMs;
        this.maxProgress = p;
        this.dispatchEvent(new CustomEvent("phase", { detail: { phase: this.phase } }));
      }
    } else {
      this.maxProgress = Math.max(this.maxProgress, p);
      this.holdMs = tMs - this.holdStart;
      this.dispatchEvent(new CustomEvent("hold", { detail: { holdMs: this.holdMs } }));

      if (p <= this.exitTarget) {
        const durationMs = tMs - this.repStart;
        this.phase = "rest";
        this.dispatchEvent(new CustomEvent("phase", { detail: { phase: this.phase } }));
        if (durationMs >= this.minRepMs) {
          this.count += 1;
          this.lastRom = Math.min(1.3, this.maxProgress);
          this.dispatchEvent(
            new CustomEvent("rep", {
              detail: { count: this.count, rom: this.lastRom, durationMs, holdMs: this.holdMs },
            })
          );
        }
        this.holdMs = 0;
      }
    }

    this.dispatchEvent(new CustomEvent("progress", { detail: { progress: p, phase: this.phase } }));
  }
}

/** Run every form check for an exercise; returns the first cue or null. */
export function checkForm(ex, ctx) {
  for (const check of ex.formChecks) {
    const cue = check.test(ctx);
    if (cue) return cue;
  }
  return null;
}
