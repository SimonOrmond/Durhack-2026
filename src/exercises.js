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
  squat: {
    name: "Squat / sit-to-stand",
    group: "Knee / hip",
    concentric: "toRest", // standing back up is the concentric phase
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
    group: "Elbow",
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
    group: "Shoulder",
    instructions: "Face the camera. Raise one arm out to the side and up above shoulder height, then lower.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_ELBOW, LM.R_ELBOW)],
    restAngle: 20,
    targetAngle: 140,
    formChecks: [trunkUpright(15, "Keep your torso upright")],
  },

  kneeExtension: {
    name: "Seated knee extension",
    group: "Knee",
    instructions: "Sit side-on to the camera. Straighten the knee fully, hold briefly, then lower.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_KNEE, LM.R_KNEE), side(s, LM.L_ANKLE, LM.R_ANKLE)],
    restAngle: 95,
    targetAngle: 165,
    formChecks: [],
  },
  // --- Shoulder rehab (frozen shoulder, post-op ROM programmes) ---------------
  shoulderFlexion: {
    name: "Shoulder flexion (forward arm raise)",
    group: "Shoulder",
    instructions: "Stand side-on to the camera, arm straight by your side. Raise the arm forwards and up towards the ceiling, then lower slowly.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_WRIST, LM.R_WRIST)],
    restAngle: 15,
    targetAngle: 150,
    formChecks: [
      elbowStraight(150, "Keep your arm straight"),
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

  // --- Hip rehab (hip OA, post hip replacement, gluteal strengthening) ---------
  hipAbduction: {
    name: "Standing hip abduction (leg out to side)",
    group: "Hip",
    instructions: "Face the camera, hold a chair or wall for balance. Keeping the leg straight, lift it out to the side, then lower with control.",
    joints: (s) => [side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_ANKLE, LM.R_ANKLE)],
    restAngle: 175,
    targetAngle: 145,
    formChecks: [
      trunkUpright(12, "Stay upright, don't lean away from the leg"),
      kneeStraight(160, "Keep your leg straight"),
    ],
  },

  gluteBridge: {
    name: "Glute bridge",
    group: "Hip / lower back",
    instructions: "Lie on your back side-on to the camera, knees bent, feet flat. Squeeze your glutes and lift your hips until your body is a straight line, then lower.",
    joints: (s) => [side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_KNEE, LM.R_KNEE)],
    restAngle: 125,
    targetAngle: 170,
    formChecks: [],
  },

  // --- Knee rehab (post knee replacement / ACL: quads activation and flexion) --
  straightLegRaise: {
    name: "Straight leg raise (lying)",
    group: "Knee",
    instructions: "Lie on your back side-on to the camera. Tighten your thigh, keep the knee locked straight and lift the leg to about 45 degrees, then lower slowly.",
    joints: (s) => [side(s, LM.L_SHOULDER, LM.R_SHOULDER), side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_KNEE, LM.R_KNEE)],
    restAngle: 175,
    targetAngle: 130,
    formChecks: [kneeStraight(160, "Keep your knee locked straight")],
  },

  heelSlide: {
    name: "Heel slide (knee flexion)",
    group: "Knee",
    instructions: "Lie on your back side-on to the camera, leg straight. Slide your heel towards your bottom to bend the knee as far as comfortable, then slide back.",
    joints: (s) => [side(s, LM.L_HIP, LM.R_HIP), side(s, LM.L_KNEE, LM.R_KNEE), side(s, LM.L_ANKLE, LM.R_ANKLE)],
    restAngle: 175,
    targetAngle: 90,
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
  constructor({ enterTarget = 0.8, exitTarget = 0.15, minRepMs = 400, plateauBand = 0.06 } = {}) {
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
        this.peakAngle = angle;
        this.dispatchEvent(new CustomEvent("phase", { detail: { phase: this.phase } }));
      }
    } else {
      this.samples.push([tMs, p]);
      if (p > this.maxProgress) {
        this.maxProgress = p;
        this.peakAngle = angle;
      }
      // Live hold estimate for the game: time spent within the plateau band of the current peak.
      const band = this.maxProgress - this.plateauBand;
      let holdStart = null;
      for (const [t, q] of this.samples) if (q >= band) { holdStart = t; break; }
      this.holdMs = holdStart == null ? 0 : tMs - holdStart;
      this.dispatchEvent(new CustomEvent("hold", { detail: { holdMs: this.holdMs } }));

      if (p <= this.exitTarget) {
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
        this.leaveRestAt = null;
        this.samples = [];
        this.dispatchEvent(new CustomEvent("phase", { detail: { phase: this.phase } }));
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
        this.lastRepEnd = tMs;
        this.holdMs = 0;
      }
    }

    this.dispatchEvent(new CustomEvent("progress", { detail: { progress: p, phase: this.phase } }));
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
