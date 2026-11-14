// Stage 3: exercise definitions + rep-detection state machine.
//
// Each exercise exposes:
//   joints(side)          -> [a, b, c] landmark indices; angle is measured at b
//   restAngle/targetAngle -> angle at the rest position and the fully-performed position
//   formChecks            -> [{ test(ctx) -> cue string | null }]
//
// Everything is normalised into a 0..1 "progress" value so the state machine
// and the game don't need to know whether the angle gets bigger or smaller.

import { LM, angle2D, tiltFromVertical } from "./angles.js";

const side = (s, l, r) => (s === "L" ? l : r);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Shared form checks ---------------------------------------------------------
/** Torso leaning away from vertical (compensating with the trunk). */
const trunkUpright = (maxDeg, cue) => ({
  test: ({ lm, aspect }) => {
    const hips = mid(lm[LM.L_HIP], lm[LM.R_HIP]);
    const shoulders = mid(lm[LM.L_SHOULDER], lm[LM.R_SHOULDER]);
    return tiltFromVertical(hips, shoulders, aspect) > maxDeg ? cue : null;
  },
});
/** Knee on the working side should stay straight (e.g. straight leg raise). */
const kneeStraight = (minDeg, cue) => ({
  test: ({ lm, s, aspect }) => {
    const k = angle2D(lm[side(s, LM.L_HIP, LM.R_HIP)], lm[side(s, LM.L_KNEE, LM.R_KNEE)], lm[side(s, LM.L_ANKLE, LM.R_ANKLE)], aspect);
    return k < minDeg ? cue : null;
  },
});
/** Elbow on the working side should stay straight (e.g. shoulder flexion). */
const elbowStraight = (minDeg, cue) => ({
  test: ({ lm, s, aspect }) => {
    const e = angle2D(lm[side(s, LM.L_SHOULDER, LM.R_SHOULDER)], lm[side(s, LM.L_ELBOW, LM.R_ELBOW)], lm[side(s, LM.L_WRIST, LM.R_WRIST)], aspect);
    return e < minDeg ? cue : null;
  },
});

export const EXERCISES = {
  // --- Upper-body exercises first (default in UI) -----------------------------
  shoulderRaise: {
    name: "Shoulder abduction (arm raise)",
    group: "Shoulder",
    concentric: "toTarget",
    instructions: "Face the camera. Raise one arm out to the side up to shoulder height to glide or jump, then lower slowly.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_ELBOW, LM.R_ELBOW)],
    restAngle: 22,
    targetAngle: 100,
    formChecks: [trunkUpright(16, "Keep your torso upright")],
  },

  shoulderFlexion: {
    name: "Shoulder flexion (forward arm raise)",
    group: "Shoulder",
    concentric: "toTarget",
    instructions: "Stand side-on or angled to the camera, arm straight by your side. Raise the arm forwards and up to jump, then lower slowly.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_WRIST, LM.R_WRIST)],
    restAngle: 20,
    targetAngle: 125,
    formChecks: [
      elbowStraight(140, "Keep your arm straight"),
      {
        // leaning back to get the arm higher is the classic compensation
        test: ({ lm, s, aspect }) => {
          const hip = lm[side(s, LM.L_HIP, LM.R_HIP)];
          const sh = lm[side(s, LM.L_SHOULDER, LM.R_SHOULDER)];
          return tiltFromVertical(hip, sh, aspect) > 20 ? "Don't lean back, keep your trunk still" : null;
        },
      },
    ],
  },

  curl: {
    name: "Elbow flexion (bicep curl)",
    group: "Elbow",
    concentric: "toTarget", // curling the hand up is the upward/lifting phase
    instructions: "Face or angle slightly to the camera. Hold ~90–120° to RUN, curl up (≤90°) to JUMP, and extend your arm down (≥121°) to DUCK.",
    joints: (s) => [side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_ELBOW, LM.R_ELBOW), side(s, LM.L_WRIST, LM.R_WRIST)],
    restAngle: 148,
    targetAngle: 58,
    formChecks: [
      {
        test: ({ lm, s, aspect }) => {
          const sh = lm[side(s, LM.L_SHOULDER, LM.R_SHOULDER)];
          const el = lm[side(s, LM.L_ELBOW, LM.R_ELBOW)];
          return tiltFromVertical(sh, el, aspect) > 42 ? "Keep your elbow tucked in" : null;
        },
      },
    ],
  },

  // --- Lower-body & seated/lying rehab ----------------------------------------
  squat: {
    name: "Squat / sit-to-stand",
    group: "Knee / hip",
    concentric: "toRest", // squatting down loads the crouch; standing back up jumps
    instructions: "Stand side-on to the camera, whole body in frame. Bend knees to crouch, then stand back up to jump.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_KNEE, LM.R_KNEE), side(s, LM.L_ANKLE, LM.R_ANKLE)],
    restAngle: 165,
    targetAngle: 105,
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

  kneeExtension: {
    name: "Seated knee extension",
    group: "Knee",
    concentric: "toTarget",
    instructions: "Sit side-on to the camera. Straighten the knee up to jump, hold briefly, then lower.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_KNEE, LM.R_KNEE), side(s, LM.L_ANKLE, LM.R_ANKLE)],
    restAngle: 95,
    targetAngle: 158,
    formChecks: [],
  },

  // --- Hip rehab (hip OA, post hip replacement, gluteal strengthening) ---------
  hipAbduction: {
    name: "Standing hip abduction (leg out to side)",
    group: "Hip",
    concentric: "toTarget",
    instructions: "Face the camera, hold a chair or wall for balance. Keeping the leg straight, lift it out to the side to jump, then lower with control.",
    joints: (s) => [side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_ANKLE, LM.R_ANKLE)],
    restAngle: 174,
    targetAngle: 150,
    formChecks: [
      trunkUpright(14, "Stay upright, don't lean away from the leg"),
      kneeStraight(150, "Keep your leg straight"),
    ],
  },

  gluteBridge: {
    name: "Glute bridge",
    group: "Hip / lower back",
    concentric: "toTarget",
    instructions: "Lie on your back side-on to the camera, knees bent, feet flat. Lift your hips until your body is a straight line to jump, then lower.",
    joints: (s) => [side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_KNEE, LM.R_KNEE)],
    restAngle: 125,
    targetAngle: 165,
    formChecks: [],
  },

  // --- Knee rehab (post knee replacement / ACL: quads activation and flexion) --
  straightLegRaise: {
    name: "Straight leg raise (lying)",
    group: "Knee",
    concentric: "toTarget",
    instructions: "Lie on your back side-on to the camera. Tighten your thigh, keep the knee straight and lift the leg to ~45 degrees to jump, then lower slowly.",
    joints: (s) => [side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_KNEE, LM.R_KNEE)],
    restAngle: 172,
    targetAngle: 135,
    formChecks: [kneeStraight(150, "Keep your knee locked straight")],
  },

  heelSlide: {
    name: "Heel slide (knee flexion)",
    group: "Knee",
    concentric: "toTarget",
    instructions: "Lie on your back side-on to the camera, leg straight. Slide your heel in to bend the knee, then slide back out.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_KNEE, LM.R_KNEE), side(s, LM.L_ANKLE, LM.R_ANKLE)],
    restAngle: 170,
    targetAngle: 95,
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
  /**
   * enterTarget / exitTarget: hysteresis on 0..1 progress. A rep is counted on rest → target → rest.
   * plateauBand: how close to the peak (in progress units) still counts as "holding at the top".
   */
  constructor({ enterTarget = 0.65, exitTarget = 0.30, minRepMs = 260, plateauBand = 0.06 } = {}) {
    super();
    this.enterTarget = enterTarget;
    this.exitTarget = exitTarget;
    this.minRepMs = minRepMs;
    this.plateauBand = plateauBand;
    this.reset();
  }

  reset() {
    this.phase = "rest"; // "rest" | "active"
    this.count = 0;
    this.maxProgress = 0;
    this.minAfterPeak = null;
    this.peakAngle = null;
    this.repStart = 0;         // left the rest zone heading for the target
    this.leaveRestAt = null;
    this.reachTargetAt = 0;    // crossed enterTarget
    this.lastRepEnd = null;
    this.lastUnobservedToRestMs = 0;
    this.holdMs = 0;
    this.lastRom = null;
    this.samples = [];         // [t, progress] for the rep in flight, used to split phases at the end
  }

  /**
   * Feed one smoothed sample. `angle` (degrees) is optional and only used to report the
   * peak angle actually reached, which physios read more naturally than a 0..1 ROM.
   *
   * Timeline of one rep:   rest ──toTarget──▶ peak plateau (hold) ──toRest──▶ rest
   * The plateau is every sample within `plateauBand` of the rep's peak progress, so a slow
   * approach to the target counts as movement, not hold.
   */
  update(progress, tMs, angle = null) {
    const p = Math.max(-0.2, Math.min(1.3, progress));

    if (this.phase === "rest") {
      // Leaving the rest zone starts the clock for the first movement phase.
      if (p > this.exitTarget) {
        if (this.leaveRestAt == null) {
          this.leaveRestAt = tMs;
          this.samples = [];
        }
        this.samples.push([tMs, p]);
      } else {
        this.leaveRestAt = null; // dropped back into rest: not a rep attempt yet
        this.samples = [];
      }

      if (p >= this.enterTarget) {
        this.phase = "active";
        this.repStart = this.leaveRestAt ?? tMs;
        this.reachTargetAt = tMs;
        this.maxProgress = p;
        this.minAfterPeak = p;
        this.peakAngle = angle;
        this.dispatchEvent(new CustomEvent("phase", { detail: { phase: this.phase, progress: p, angle } }));
      }
    } else {
      this.samples.push([tMs, p]);
      if (p > this.maxProgress) {
        this.maxProgress = p;
        this.minAfterPeak = p;
        this.peakAngle = angle;
      } else if (this.minAfterPeak == null || p < this.minAfterPeak) {
        this.minAfterPeak = p;
      }
      // Live hold estimate for the game: time spent within the plateau band of the current peak.
      const band = this.maxProgress - this.plateauBand;
      let holdStart = null;
      for (const [t, q] of this.samples) if (q >= band) { holdStart = t; break; }
      this.holdMs = holdStart == null ? 0 : tMs - holdStart;
      this.dispatchEvent(new CustomEvent("hold", { detail: { holdMs: this.holdMs } }));

      const turnedAround =
        this.minAfterPeak != null &&
        this.minAfterPeak <= 0.45 &&
        this.maxProgress - this.minAfterPeak >= 0.35 &&
        p - this.minAfterPeak >= 0.14;

      if (p <= this.exitTarget || turnedAround) {
        const { unobservedToTargetMs, unobservedToRestMs, ...phases } = this.#splitPhases(tMs);
        const durationMs = phases.toTargetMs + phases.holdMs + phases.toRestMs;
        // Gap since the previous rep, minus the slices of movement that happen below exitTarget
        // (those were already credited to the movement phases via the stretch factor).
        const restBeforeMs =
          this.lastRepEnd == null
            ? null
            : Math.max(0, Math.round(this.repStart - this.lastRepEnd - unobservedToTargetMs - this.lastUnobservedToRestMs));
        this.lastUnobservedToRestMs = unobservedToRestMs;
        this.phase = "rest";
        this.minAfterPeak = null;
        this.leaveRestAt = null;
        this.samples = [];
        this.dispatchEvent(new CustomEvent("phase", { detail: { phase: this.phase, progress: p, angle } }));
        if (durationMs >= this.minRepMs) {
          this.count += 1;
          this.lastRom = Math.min(1.3, this.maxProgress);
          this.dispatchEvent(
            new CustomEvent("rep", {
              detail: {
                count: this.count,
                rom: this.lastRom,
                peakAngle: this.peakAngle == null ? null : Math.round(this.peakAngle),
                durationMs,
                ...phases,
                restBeforeMs,
              },
            })
          );
        }
        if (p > this.exitTarget) {
          this.leaveRestAt = tMs;
          this.samples = [[tMs, p]];
        }
        this.lastRepEnd = tMs;
        this.holdMs = 0;
      }
    }

    this.dispatchEvent(new CustomEvent("progress", { detail: { progress: p, phase: this.phase, angle } }));
  }

  /** Split the in-flight rep into toTarget / hold / toRest using the plateau around the peak. */
  #splitPhases(tEnd) {
    const band = this.maxProgress - this.plateauBand;
    let reachPeak = null, leavePeak = null;
    for (const [t, q] of this.samples) {
      if (q >= band) {
        reachPeak ??= t;
        leavePeak = t;
      }
    }
    reachPeak ??= this.reachTargetAt;
    leavePeak ??= reachPeak;
    // Movement is only observed between exitTarget and the peak; the first/last slice of the
    // range (below exitTarget) is unobserved, so stretch proportionally to estimate full-range time.
    const stretch = 1 / Math.max(0.5, 1 - this.exitTarget);
    const observedToTarget = reachPeak - this.repStart;
    const observedToRest = tEnd - leavePeak;
    return {
      toTargetMs: Math.round(observedToTarget * stretch),
      holdMs: Math.round(leavePeak - reachPeak),
      toRestMs: Math.round(observedToRest * stretch),
      unobservedToTargetMs: observedToTarget * (stretch - 1),
      unobservedToRestMs: observedToRest * (stretch - 1),
    };
  }
}

/**
 * Split a rep's movement phases into concentric (muscle shortening, the "work" phase) and
 * eccentric (lengthening, the controlled return). Which direction is which depends on the
 * exercise: for a squat the way DOWN is eccentric; for a curl the way UP (to target) is concentric.
 * Exercises set `concentric: "toTarget" | "toRest"`; default is "toTarget".
 */
export function splitPhases(ex, rep) {
  const concentricIsToTarget = (ex.concentric ?? "toTarget") === "toTarget";
  return {
    concentricMs: concentricIsToTarget ? rep.toTargetMs : rep.toRestMs,
    eccentricMs: concentricIsToTarget ? rep.toRestMs : rep.toTargetMs,
  };
}

/** Run every form check for an exercise; returns the first cue or null. */
export function checkForm(ex, ctx) {
  for (const check of ex.formChecks) {
    const cue = check.test(ctx);
    if (cue) return cue;
  }
  return null;
}
