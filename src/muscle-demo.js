// Hevy-style interactive anatomical muscle focus & movement demonstrator.
// Renders a live 2D kinematic animation for all 16 exercises in EXERCISES, highlighting
// primary target muscles (glowing coral) and secondary stabilisers (amber) at the
// prescribed movement tempo and target range of motion.

import { EXERCISES } from "./exercises.js";
import { tempoOf, DEFAULT_TEMPO } from "./tempo.js";

/**
 * Muscle & kinematic metadata for every exercise in EXERCISES.
 * Each muscle tag maps to a drawn anatomical region in the canvas renderer.
 */
export const EXERCISE_MUSCLE_MAP = {
  shoulderRaise: {
    view: "front",
    viewLabel: "Front View · Coronal Plane",
    anim: "shoulderAbduction",
    primaryLabels: ["Lateral Deltoid", "Supraspinatus"],
    secondaryLabels: ["Upper Trapezius", "Serratus Anterior"],
    primaryZones: ["deltoidLat", "supraspinatus"],
    secondaryZones: ["upperTrap", "serratus"],
    cues: [
      "Stand tall facing the camera with arms relaxed by your sides.",
      "Lead smoothly out sideways to shoulder height (~90–100°) without shrugging.",
      "Lower slowly under full control back to your hip.",
    ],
  },
  shoulderFlexion: {
    view: "side",
    viewLabel: "Side View · Sagittal Plane",
    anim: "shoulderFlexion",
    primaryLabels: ["Anterior Deltoid", "Clavicular Pectoralis"],
    secondaryLabels: ["Serratus Anterior", "Biceps Brachii"],
    primaryZones: ["deltoidAnt", "pectoralis"],
    secondaryZones: ["serratus", "biceps"],
    cues: [
      "Stand side-on with your elbow straight and thumb pointing forward/up.",
      "Raise your straight arm forward and overhead without arching your lower back.",
      "Control the descent along the exact same arc.",
    ],
  },
  curl: {
    view: "side",
    viewLabel: "Side View · Elbow Hinge",
    anim: "elbowFlexion",
    primaryLabels: ["Biceps Brachii", "Brachialis"],
    secondaryLabels: ["Brachioradialis", "Anterior Forearm"],
    primaryZones: ["biceps"],
    secondaryZones: ["forearm"],
    cues: [
      "Keep your upper arm tucked steady against your ribs.",
      "Curl your hand toward your shoulder smoothly without swinging your torso.",
      "Extend your arm down with control until nearly straight.",
    ],
  },
  squat: {
    view: "side",
    viewLabel: "Side View · Squat Pattern",
    anim: "squat",
    primaryLabels: ["Quadriceps", "Gluteus Maximus"],
    secondaryLabels: ["Hamstrings", "Core Stabilisers"],
    primaryZones: ["quads", "gluteMax"],
    secondaryZones: ["hamstrings", "core"],
    cues: [
      "Stand side-on with feet shoulder-width apart and chest tall.",
      "Sit your hips back and down as though lowering onto a chair.",
      "Push smoothly through your heels to return to standing.",
    ],
  },
  kneeExtension: {
    view: "side-seated",
    viewLabel: "Seated Side View · Knee Hinge",
    anim: "kneeExtension",
    primaryLabels: ["Quadriceps (VMO & Rectus Femoris)"],
    secondaryLabels: ["Tibialis Anterior", "Core Stabilisers"],
    primaryZones: ["quads"],
    secondaryZones: ["tibialis", "core"],
    cues: [
      "Sit upright with your thigh fully supported on the chair.",
      "Straighten your knee smoothly until your leg is locked flat.",
      "Squeeze the front thigh briefly, then lower without dropping.",
    ],
  },
  hipAbduction: {
    view: "front",
    viewLabel: "Front View · Coronal Hip Lift",
    anim: "hipAbduction",
    primaryLabels: ["Gluteus Medius", "Gluteus Minimus"],
    secondaryLabels: ["Tensor Fasciae Latae", "Core Obliques"],
    primaryZones: ["gluteMed"],
    secondaryZones: ["core", "quads"],
    cues: [
      "Face the camera lightly holding a chair or counter for balance.",
      "Keep toes pointing forward and lift your straight leg out to the side.",
      "Keep your torso completely upright—don't lean sideways to cheat.",
    ],
  },
  gluteBridge: {
    view: "supine",
    viewLabel: "Lying Side View · Posterior Chain",
    anim: "gluteBridge",
    primaryLabels: ["Gluteus Maximus", "Hamstrings"],
    secondaryLabels: ["Erector Spinae", "Deep Core"],
    primaryZones: ["gluteMax", "hamstrings"],
    secondaryZones: ["core"],
    cues: [
      "Lie on your back side-on with knees bent and feet flat on the floor.",
      "Press through your heels and squeeze glutes to lift hips into a straight line.",
      "Avoid overarching your low back; lower slowly to the mat.",
    ],
  },
  straightLegRaise: {
    view: "supine",
    viewLabel: "Lying Side View · Knee / Hip Control",
    anim: "straightLegRaise",
    primaryLabels: ["Quadriceps", "Iliopsoas (Hip Flexor)"],
    secondaryLabels: ["Lower Abdominals"],
    primaryZones: ["quads", "hipFlexor"],
    secondaryZones: ["core"],
    cues: [
      "Lie flat on your back and tighten your thigh to lock the knee straight.",
      "Lift the straight leg slowly to ~45° (about opposite-knee height).",
      "Lower under slow eccentric control until your heel taps gently.",
    ],
  },
  heelSlide: {
    view: "supine",
    viewLabel: "Lying Side View · Knee Mobility",
    anim: "heelSlide",
    primaryLabels: ["Hamstrings", "Hip Flexors"],
    secondaryLabels: ["Quadriceps (Control)"],
    primaryZones: ["hamstrings", "hipFlexor"],
    secondaryZones: ["quads"],
    cues: [
      "Lie flat with legs extended along the floor/mat.",
      "Gently slide your heel toward your glutes, letting your knee bend comfortably.",
      "Slide back out smoothly until the leg rests straight again.",
    ],
  },
  rcTableSlideStage1: {
    view: "side-seated",
    viewLabel: "Seated Table View · Stage 1 Protection",
    anim: "tableSlide",
    primaryLabels: ["Supraspinatus (Assisted)", "Anterior Deltoid"],
    secondaryLabels: ["Serratus Anterior", "Scapular Stabilisers"],
    primaryZones: ["supraspinatus", "deltoidAnt"],
    secondaryZones: ["serratus"],
    cues: [
      "Sit beside a table with your forearm resting lightly on a towel.",
      "Gently glide your hand forward up to ~35° without lifting the arm yourself.",
      "Return slowly—keep the shoulder relaxed and completely pain-free.",
    ],
  },
  rcFlexionStage2: {
    view: "side",
    viewLabel: "Side View · Stage 2 Control",
    anim: "shoulderFlexion",
    primaryLabels: ["Anterior Deltoid", "Supraspinatus"],
    secondaryLabels: ["Middle Trapezius", "Serratus Anterior"],
    primaryZones: ["deltoidAnt", "supraspinatus"],
    secondaryZones: ["midTrap", "serratus"],
    cues: [
      "Raise your arm forward cleanly up to shoulder height (90°).",
      "Keep your shoulder blade down away from your ear.",
      "Do not lean your torso backward; lower along a smooth path.",
    ],
  },
  rcFlexionStage3: {
    view: "side",
    viewLabel: "Side View · Stage 3 Overhead",
    anim: "shoulderFlexion",
    primaryLabels: ["Anterior Deltoid", "Supraspinatus", "Lower Trapezius"],
    secondaryLabels: ["Serratus Anterior", "Infraspinatus"],
    primaryZones: ["deltoidAnt", "supraspinatus", "midTrap"],
    secondaryZones: ["serratus", "infraspinatus"],
    cues: [
      "Elevate your straight arm forward past shoulder height to ~125°.",
      "Keep your ribcage stacked over your hips without arching.",
      "Lower slowly for the full eccentric count.",
    ],
  },
  rcScaptionStage3: {
    view: "front",
    viewLabel: "Front 30° Plane · 'Full Can'",
    anim: "scaption",
    primaryLabels: ["Supraspinatus", "Anterior & Lateral Deltoid"],
    secondaryLabels: ["Serratus Anterior", "Lower Trapezius"],
    primaryZones: ["supraspinatus", "deltoidLat", "deltoidAnt"],
    secondaryZones: ["serratus", "midTrap"],
    cues: [
      "Point thumb upward ('full can') and angle arm ~30° forward of sideways.",
      "Lift smoothly to shoulder height (90°) and pause for the prescribed hold.",
      "Keep neck muscles soft—zero shoulder hitching.",
    ],
  },
  rcExternalRotationStage2: {
    view: "front",
    viewLabel: "Front View · Tucked Rotator Cuff",
    anim: "externalRotation",
    primaryLabels: ["Infraspinatus", "Teres Minor"],
    secondaryLabels: ["Posterior Deltoid", "Rhomboids"],
    primaryZones: ["infraspinatus", "deltoidPost"],
    secondaryZones: ["rhomboids"],
    cues: [
      "Pin your elbow firmly at 90° against a folded towel at your ribs.",
      "Rotate forearm smoothly outward away from your belly (up to ~30°).",
      "Keep your elbow glued to your side throughout the return.",
    ],
  },
  rcExternalRotationStage3: {
    view: "front",
    viewLabel: "Front View · Resisted Rotation",
    anim: "externalRotationBand",
    primaryLabels: ["Infraspinatus", "Teres Minor"],
    secondaryLabels: ["Posterior Deltoid", "Middle Trapezius"],
    primaryZones: ["infraspinatus", "deltoidPost"],
    secondaryZones: ["midTrap"],
    cues: [
      "Hold light band or weight with elbow bent 90° and tucked into ribs.",
      "Rotate forearm outward up to ~50°, keeping shoulder blades gently set back.",
      "Resist the band smoothly as you rotate back to neutral.",
    ],
  },
  rcStandingRowStage3: {
    view: "side",
    viewLabel: "Side View · Scapular Retraction",
    anim: "standingRow",
    primaryLabels: ["Rhomboids", "Middle Trapezius", "Posterior Deltoid"],
    secondaryLabels: ["Latissimus Dorsi", "Biceps", "Infraspinatus"],
    primaryZones: ["rhomboids", "midTrap", "deltoidPost"],
    secondaryZones: ["lats", "biceps", "infraspinatus"],
    cues: [
      "Stand tall facing anchor point with arms extended forward.",
      "Pull elbows straight back past your ribs, pinching shoulder blades together.",
      "Keep elbows low by your sides and head relaxed—no shrugging.",
    ],
  },
};

const DEG = Math.PI / 180;
const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)));
const lerp = (a, b, t) => a + (b - a) * t;
const vec = (p, len, rad) => [p[0] + Math.cos(rad) * len, p[1] + Math.sin(rad) * len];

function drawCapsule(ctx, a, b, rA, rB, fill, stroke = "#475569", lineWidth = 1.4) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ang = Math.atan2(dy, dx);
  const nx = -dy / len;
  const ny = dx / len;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(a[0] + nx * rA, a[1] + ny * rA);
  ctx.lineTo(b[0] + nx * rB, b[1] + ny * rB);
  ctx.arc(b[0], b[1], rB, ang + Math.PI / 2, ang - Math.PI / 2, true);
  ctx.lineTo(a[0] - nx * rA, a[1] - ny * rA);
  ctx.arc(a[0], a[1], rA, ang - Math.PI / 2, ang + Math.PI / 2, true);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draws an anatomical muscle belly aligned between bone endpoints a -> b.
 * offsetNormal shifts perpendicular to the limb axis (+1 left side of ray, -1 right).
 */
function drawMuscleBelly(ctx, a, b, tStart, tEnd, thickness, offsetNormal, role, contraction) {
  if (!role) return;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ang = Math.atan2(dy, dx);
  const nx = -dy / len;
  const ny = dx / len;

  const midT = (tStart + tEnd) * 0.5;
  const span = Math.max(8, (tEnd - tStart) * len * 0.52);
  const cx = a[0] + dx * midT + nx * offsetNormal;
  const cy = a[1] + dy * midT + ny * offsetNormal;

  const isPrimary = role === "primary";
  const intensity = (isPrimary ? 0.55 : 0.34) + contraction * (isPrimary ? 0.45 : 0.34);
  const baseRgb = isPrimary ? "244, 63, 94" : "245, 158, 11";
  const hiRgb = isPrimary ? "253, 164, 175" : "253, 230, 138";

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang);

  // Outer anatomical glow
  const glow = ctx.createRadialGradient(0, 0, thickness * 0.2, 0, 0, Math.max(span, thickness) * 1.45);
  glow.addColorStop(0, `rgba(${baseRgb}, ${Math.min(0.92, intensity * 0.85)})`);
  glow.addColorStop(0.55, `rgba(${baseRgb}, ${Math.min(0.45, intensity * 0.38)})`);
  glow.addColorStop(1, `rgba(${baseRgb}, 0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(0, 0, span * 1.35, thickness * 1.85, 0, 0, Math.PI * 2);
  ctx.fill();

  // Muscle belly fiber shape
  ctx.beginPath();
  ctx.ellipse(0, 0, span, thickness, 0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${baseRgb}, ${Math.min(0.95, intensity)})`;
  ctx.fill();
  ctx.strokeStyle = `rgba(${hiRgb}, ${Math.min(0.95, 0.4 + contraction * 0.55)})`;
  ctx.lineWidth = isPrimary ? 1.4 : 1;
  ctx.stroke();

  // Subtle muscle striation lines (Hevy-style anatomical cue)
  ctx.strokeStyle = `rgba(255, 255, 255, ${0.14 + contraction * 0.22})`;
  ctx.lineWidth = 0.8;
  for (let s = -1; s <= 1; s++) {
    ctx.beginPath();
    ctx.moveTo(-span * 0.55, s * thickness * 0.32);
    ctx.quadraticCurveTo(0, s * thickness * 0.52, span * 0.55, s * thickness * 0.32);
    ctx.stroke();
  }
  ctx.restore();
}

function drawMusclePatch(ctx, x, y, rx, ry, rotRad, role, contraction) {
  if (!role) return;
  const p0 = [x - Math.cos(rotRad) * rx, y - Math.sin(rotRad) * rx];
  const p1 = [x + Math.cos(rotRad) * rx, y + Math.sin(rotRad) * rx];
  drawMuscleBelly(ctx, p0, p1, 0.04, 0.96, ry, 0, role, contraction);
}

function drawHead(ctx, center, tilt = 0, radius = 14) {
  ctx.save();
  ctx.translate(center[0], center[1]);
  ctx.rotate(tilt);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#253047";
  ctx.fill();
  ctx.strokeStyle = "#52627d";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Ear / brow landmark hint
  ctx.beginPath();
  ctx.arc(radius * 0.25, -radius * 0.05, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = "#64748b";
  ctx.fill();
  ctx.restore();
}

function drawJointDot(ctx, p, active = false) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(p[0], p[1], active ? 4.8 : 3, 0, Math.PI * 2);
  ctx.fillStyle = active ? "#34d399" : "#94a3b8";
  ctx.fill();
  if (active) {
    ctx.strokeStyle = "rgba(52, 211, 153, 0.5)";
    ctx.lineWidth = 5;
    ctx.stroke();
  }
  ctx.restore();
}

function drawAngleArc(ctx, pivot, pa, pc, currentDeg) {
  const a1 = Math.atan2(pa[1] - pivot[1], pa[0] - pivot[0]);
  const a2 = Math.atan2(pc[1] - pivot[1], pc[0] - pivot[0]);
  let diff = a2 - a1;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const r = 24;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pivot[0], pivot[1]);
  ctx.arc(pivot[0], pivot[1], r, a1, a1 + diff, diff < 0);
  ctx.closePath();
  ctx.fillStyle = "rgba(52, 211, 153, 0.16)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(pivot[0], pivot[1], r, a1, a1 + diff, diff < 0);
  ctx.strokeStyle = "#34d399";
  ctx.lineWidth = 2;
  ctx.stroke();

  const mid = a1 + diff * 0.5;
  const lx = pivot[0] + Math.cos(mid) * (r + 16);
  const ly = pivot[1] + Math.sin(mid) * (r + 14);
  ctx.font = "700 11px 'JetBrains Mono', ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#a7f3d0";
  ctx.fillText(`${Math.round(currentDeg)}°`, lx, ly);
  ctx.restore();
}

/**
 * Returns normalized 0..1 progress and current phase label given elapsed time and tempo.
 */
function sampleTempoCycle(elapsedS, tempoKey, exercise) {
  const t = tempoOf(tempoKey);
  const up = Math.max(0.5, t.up);
  const hold = Math.max(0.25, t.hold);
  const down = Math.max(0.5, t.down);
  const rest = Math.max(0.5, t.rest);
  const total = up + hold + down + rest;
  const c = ((elapsedS % total) + total) % total;

  const isConcentricToRest = (exercise?.concentric ?? "toTarget") === "toRest";

  if (c < up) {
    const p = easeInOutSine(c / up);
    return {
      progress: p,
      phaseLabel: isConcentricToRest ? "LOWER (ECCENTRIC) ↓" : "LIFT (CONCENTRIC) ↑",
      phaseColor: "#34d399",
    };
  }
  if (c < up + hold) {
    return {
      progress: 1,
      phaseLabel: "HOLD PEAK ●",
      phaseColor: "#f43f5e",
    };
  }
  if (c < up + hold + down) {
    const p = 1 - easeInOutSine((c - up - hold) / down);
    return {
      progress: p,
      phaseLabel: isConcentricToRest ? "STAND (CONCENTRIC) ↑" : "LOWER (ECCENTRIC) ↓",
      phaseColor: "#60a5fa",
    };
  }
  return {
    progress: 0,
    phaseLabel: "REST & RESET",
    phaseColor: "#94a3b8",
  };
}

export function initMuscleDemo({
  canvas,
  primaryEl,
  secondaryEl,
  cuesEl,
  romEl,
  tempoBadgeEl,
  viewLabelEl,
  titleEl,
  playBtn,
  toggleBtn,
  bodyEl,
}) {
  if (!canvas) {
    return { setExercise: () => {}, setPaused: () => {} };
  }
  const ctx = canvas.getContext("2d");
  const W = 360;
  const H = 250;

  let currentKey = "shoulderRaise";
  let currentEx = EXERCISES.shoulderRaise;
  let currentTempo = DEFAULT_TEMPO;
  let currentSide = "R";
  let paused = false;
  let collapsed = false;
  let elapsedS = 0.6;
  let lastTs = performance.now();

  function roleFor(zone) {
    const meta = EXERCISE_MUSCLE_MAP[currentKey];
    if (!meta) return null;
    if (meta.primaryZones.includes(zone)) return "primary";
    if (meta.secondaryZones.includes(zone)) return "secondary";
    return null;
  }

  function renderMetadata() {
    const meta = EXERCISE_MUSCLE_MAP[currentKey] ?? EXERCISE_MUSCLE_MAP.shoulderRaise;
    const t = tempoOf(currentTempo);
    const restAng = currentEx?.restAngle ?? 0;
    const targetAng = currentEx?.targetAngle ?? 90;

    if (titleEl) titleEl.textContent = currentEx?.name ?? currentKey;
    if (viewLabelEl) viewLabelEl.textContent = meta.viewLabel;
    if (tempoBadgeEl) tempoBadgeEl.textContent = `${t.name} tempo · ${t.up}s-${t.hold}s-${t.down}s`;
    if (romEl) {
      const romSpan = Math.abs(targetAng - restAng);
      romEl.textContent = `Target range: ${restAng}° → ${targetAng}° (${romSpan}° sweep)`;
    }
    if (primaryEl) {
      primaryEl.innerHTML = meta.primaryLabels
        .map((m) => `<span class="muscle-pill primary"><span class="pill-dot"></span>${m}</span>`)
        .join("");
    }
    if (secondaryEl) {
      secondaryEl.innerHTML = meta.secondaryLabels
        .map((m) => `<span class="muscle-pill secondary"><span class="pill-dot"></span>${m}</span>`)
        .join("");
    }
    if (cuesEl) {
      cuesEl.innerHTML = meta.cues.map((c) => `<li>${c}</li>`).join("");
    }
  }

  function resizeHiDPI() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawBackground(meta, cycle, angleDeg) {
    ctx.fillStyle = "#080c14";
    ctx.fillRect(0, 0, W, H);

    // Subtle clinical coordinate grid
    ctx.strokeStyle = "rgba(148, 163, 184, 0.06)";
    ctx.lineWidth = 1;
    for (let x = 24; x < W; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 24; y < H; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // Floor or exercise mat line
    const floorY = meta.view === "supine" ? 196 : 226;
    ctx.strokeStyle = meta.view === "supine" ? "rgba(52, 211, 153, 0.28)" : "rgba(148, 163, 184, 0.22)";
    ctx.lineWidth = meta.view === "supine" ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(22, floorY);
    ctx.lineTo(W - 22, floorY);
    ctx.stroke();

    // Top-left live phase pill
    ctx.save();
    ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
    ctx.strokeStyle = cycle.phaseColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(10, 10, 164, 24, 999);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = cycle.phaseColor;
    ctx.font = "700 10.5px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(cycle.phaseLabel, 20, 22);
    ctx.restore();

    // Top-right contraction meter & angle readout
    ctx.save();
    ctx.fillStyle = "#94a3b8";
    ctx.font = "600 10.5px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(`${Math.round(angleDeg)}°`, W - 12, 22);
    ctx.restore();
  }

  // ---- Pose & anatomy drawers by view ----

  function drawStandingFront(meta, p, angleDeg) {
    const cx = W * 0.5;
    const mirror = currentSide === "L" ? -1 : 1; // R raises viewer's left-or-right cleanly; keep consistent Anatomical right on left or right side
    const s = mirror; // working side (+1 = right side of canvas so plenty of sweep room)
    const shY = 82;
    const hipY = 144;
    const shW = 24;
    const hipW = 16;

    const lSh = [cx - s * shW, shY];
    const rSh = [cx + s * shW, shY];
    const lHip = [cx - s * hipW, hipY];
    const rHip = [cx + s * hipW, hipY];
    const neck = [cx, shY - 12];
    const head = [cx, shY - 31];

    // Torso anatomical block
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(lSh[0] - s * 4, shY - 4);
    ctx.lineTo(rSh[0] + s * 4, shY - 4);
    ctx.lineTo(rHip[0] + s * 2, hipY + 8);
    ctx.lineTo(lHip[0] - s * 2, hipY + 8);
    ctx.closePath();
    ctx.fillStyle = "#1f293d";
    ctx.fill();
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();

    drawHead(ctx, head, 0, 13);

    // Non-working leg & arm
    const lKnee = [lHip[0] - s * 3, hipY + 40];
    const lAnkle = [lHip[0] - s * 5, 222];
    const lElbow = [lSh[0] - s * 9, shY + 33];
    const lWrist = [lSh[0] - s * 12, shY + 64];

    // Support chair/bar cue for hipAbduction
    if (meta.anim === "hipAbduction") {
      ctx.strokeStyle = "#475569";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lWrist[0] - s * 12, lWrist[1] + 2);
      ctx.lineTo(lWrist[0] - s * 12, 226);
      ctx.moveTo(lWrist[0] - s * 22, lWrist[1] + 2);
      ctx.lineTo(lWrist[0] + s * 4, lWrist[1] + 2);
      ctx.stroke();
    }

    drawCapsule(ctx, lHip, lKnee, 9, 6.5, "#1e293b");
    drawCapsule(ctx, lKnee, lAnkle, 6.5, 4.5, "#1e293b");
    drawCapsule(ctx, lSh, lElbow, 6.5, 5, "#1e293b");
    drawCapsule(ctx, lElbow, lWrist, 5, 3.8, "#1e293b");

    // Torso muscle highlights
    drawMusclePatch(ctx, cx, shY + 42, 11, 18, 0, roleFor("core"), p);
    drawMusclePatch(ctx, rSh[0] - s * 10, shY - 8, 9, 4.5, s * -0.35, roleFor("upperTrap"), p);
    drawMusclePatch(ctx, rSh[0] - s * 9, shY + 12, 11, 5.5, s * 0.25, roleFor("midTrap"), p);
    drawMusclePatch(ctx, rSh[0] - s * 8, shY + 16, 8, 8, 0, roleFor("rhomboids"), p);
    drawMusclePatch(ctx, rSh[0] - s * 2, shY + 26, 6, 12, s * 0.2, roleFor("serratus"), p);
    drawMusclePatch(ctx, rSh[0] - s * 3, shY - 4, 8, 5, s * -0.15, roleFor("supraspinatus"), p);
    drawMusclePatch(ctx, rHip[0] + s * 4, hipY - 2, 7, 10, 0, roleFor("gluteMed"), p);

    // Working side limbs depend on anim
    let rElbow, rWrist, rKnee, rAnkle, ghostA, ghostB, ghostC, pivot, pa, pc;

    if (meta.anim === "hipAbduction") {
      // Static relaxed right arm
      rElbow = [rSh[0] + s * 8, shY + 32];
      rWrist = [rSh[0] + s * 11, shY + 62];
      drawCapsule(ctx, rSh, rElbow, 6.5, 5, "#233046");
      drawCapsule(ctx, rElbow, rWrist, 5, 3.8, "#233046");

      // Working leg lifts outward from nearly plumb (6 deg) to target (~30 deg)
      const restAb = Math.max(4, 180 - (currentEx?.restAngle ?? 174));
      const targAb = Math.max(20, 180 - (currentEx?.targetAngle ?? 150));
      const abDeg = lerp(restAb, targAb, p);
      const radFromDown = s > 0 ? Math.PI / 2 - abDeg * DEG : Math.PI / 2 + abDeg * DEG;
      rKnee = vec(rHip, 40, radFromDown);
      rAnkle = vec(rHip, 78, radFromDown);

      // Ghost target leg
      const gRad = s > 0 ? Math.PI / 2 - targAb * DEG : Math.PI / 2 + targAb * DEG;
      const gAnkle = vec(rHip, 78, gRad);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(244, 63, 94, 0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(rHip[0], rHip[1]);
      ctx.lineTo(gAnkle[0], gAnkle[1]);
      ctx.stroke();
      ctx.restore();

      drawCapsule(ctx, rHip, rKnee, 9.5, 7, "#27354d");
      drawCapsule(ctx, rKnee, rAnkle, 7, 4.8, "#27354d");
      drawMuscleBelly(ctx, rHip, rKnee, 0.15, 0.85, 6.5, -s * 3.5, roleFor("quads"), p);

      pivot = rHip;
      pa = rSh;
      pc = rAnkle;
    } else if (meta.anim === "externalRotation" || meta.anim === "externalRotationBand") {
      // Standing leg calm
      rKnee = [rHip[0] + s * 3, hipY + 40];
      rAnkle = [rHip[0] + s * 5, 222];
      drawCapsule(ctx, rHip, rKnee, 9.5, 7, "#233046");
      drawCapsule(ctx, rKnee, rAnkle, 7, 4.8, "#233046");

      // Upper arm pinned vertical against ribs, elbow tucked at 90 deg
      rElbow = [rSh[0] + s * 5, shY + 36];
      const maxLat = meta.anim === "externalRotationBand" ? 36 : 26;
      const reachX = lerp(4, maxLat, p) * s;
      // Forearm swings laterally outward from pointing straight at camera (small foreshortened segment) to pointing outward
      rWrist = [rElbow[0] + reachX, rElbow[1] - lerp(8, 2, p)];

      // Towel pad under elbow
      ctx.fillStyle = "rgba(148, 163, 184, 0.45)";
      ctx.fillRect(Math.min(rElbow[0], rSh[0]) - (s > 0 ? 4 : -1), rElbow[1] - 10, 5, 11);

      // Resistance band for Stage 3
      if (meta.anim === "externalRotationBand") {
        ctx.save();
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(lHip[0] - s * 36, rElbow[1] + 2);
        ctx.lineTo(rWrist[0], rWrist[1]);
        ctx.stroke();
        ctx.fillStyle = "#38bdf8";
        ctx.beginPath();
        ctx.arc(lHip[0] - s * 36, rElbow[1] + 2, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Ghost target forearm
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(244, 63, 94, 0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(rElbow[0], rElbow[1]);
      ctx.lineTo(rElbow[0] + maxLat * s, rElbow[1] - 2);
      ctx.stroke();
      ctx.restore();

      drawCapsule(ctx, rSh, rElbow, 7, 5.2, "#27354d");
      drawCapsule(ctx, rElbow, rWrist, 5, 4, "#2d3d59");

      drawMuscleBelly(ctx, rSh, rElbow, 0.05, 0.55, 6.5, s * 2, roleFor("deltoidPost"), p);
      drawMusclePatch(ctx, rSh[0] - s * 4, shY + 12, 8.5, 6.5, s * 0.25, roleFor("infraspinatus"), p);

      pivot = rElbow;
      pa = rSh;
      pc = rWrist;
      // Custom outward angle arc cue
      ctx.save();
      ctx.strokeStyle = "#34d399";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(rElbow[0], rElbow[1]);
      ctx.lineTo(rElbow[0] + s * 4, rElbow[1] - 8);
      ctx.stroke();
      ctx.restore();
      drawJointDot(ctx, rSh, false);
      drawJointDot(ctx, rElbow, true);
      drawJointDot(ctx, rWrist, false);
      return;
    } else {
      // shoulderAbduction or scaption
      rKnee = [rHip[0] + s * 3, hipY + 40];
      rAnkle = [rHip[0] + s * 5, 222];
      drawCapsule(ctx, rHip, rKnee, 9.5, 7, "#233046");
      drawCapsule(ctx, rKnee, rAnkle, 7, 4.8, "#233046");

      const restA = currentEx?.restAngle ?? 20;
      const targA = currentEx?.targetAngle ?? 95;
      const armDeg = lerp(restA, targA, p);
      // 0 deg = straight down alongside hip; 90 deg = horizontal sideways
      const rad = s > 0 ? Math.PI / 2 - armDeg * DEG : Math.PI / 2 + armDeg * DEG;
      const lenScale = meta.anim === "scaption" ? 0.92 : 1; // subtle 30 deg forward foreshortening
      rElbow = vec(rSh, 34 * lenScale, rad);
      rWrist = vec(rSh, 64 * lenScale, rad);

      // Ghost target pose
      const gRad = s > 0 ? Math.PI / 2 - targA * DEG : Math.PI / 2 + targA * DEG;
      const gWrist = vec(rSh, 64 * lenScale, gRad);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(244, 63, 94, 0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(rSh[0], rSh[1]);
      ctx.lineTo(gWrist[0], gWrist[1]);
      ctx.stroke();
      ctx.restore();

      drawCapsule(ctx, rSh, rElbow, 7, 5.2, "#27354d");
      drawCapsule(ctx, rElbow, rWrist, 5.2, 4, "#27354d");

      drawMuscleBelly(ctx, rSh, rElbow, 0.0, 0.48, 7, -s * 2.5, roleFor("deltoidLat"), p);
      drawMuscleBelly(ctx, rSh, rElbow, 0.05, 0.45, 6.2, s * 1.5, roleFor("deltoidAnt"), p);

      pivot = rSh;
      pa = rHip;
      pc = rElbow;
    }

    if (pivot && pa && pc) {
      drawAngleArc(ctx, pivot, pa, pc, angleDeg);
      drawJointDot(ctx, pa, false);
      drawJointDot(ctx, pivot, true);
      drawJointDot(ctx, pc, false);
    }
  }

  function drawStandingSide(meta, p, angleDeg) {
    // Facing right (+X direction is forward)
    const cx = 148;
    const baseAnkleY = 222;
    let ankle, knee, hip, sh, head, elbow, wrist, pivot, pa, pc;

    if (meta.anim === "squat") {
      // Squat kinematics: knee angle moves from restAngle (165) to targetAngle (105)
      ankle = [cx, baseAnkleY];
      const shinTilt = lerp(4, 24, p) * DEG; // forward tibia angle
      knee = vec(ankle, 42, -Math.PI / 2 + shinTilt);
      const kneeAngle = lerp(currentEx?.restAngle ?? 165, currentEx?.targetAngle ?? 105, p);
      // Interior angle at knee between ankle->knee and knee->hip
      const thighAngle = -Math.PI / 2 + shinTilt - (180 - kneeAngle) * DEG;
      hip = vec(knee, 44, thighAngle);
      const torsoLean = lerp(5, 28, p) * DEG;
      sh = vec(hip, 60, -Math.PI / 2 + torsoLean);
      head = vec(sh, 20, -Math.PI / 2 + torsoLean * 0.7);
      elbow = vec(sh, 32, Math.PI / 2 - lerp(10, 38, p) * DEG);
      wrist = vec(elbow, 28, lerp(30, -15, p) * DEG);

      pivot = knee;
      pa = hip;
      pc = ankle;
    } else {
      // Upright side-on standing
      ankle = [cx, baseAnkleY];
      knee = [cx + 2, 180];
      hip = [cx, 138];
      sh = [cx, 78];
      head = [cx + 2, 54];

      if (meta.anim === "elbowFlexion") {
        // Upper arm vertical slightly forward, elbow hinges from restAngle (148) to targetAngle (58)
        elbow = [sh[0] + 4, sh[1] + 36];
        const uaAng = Math.atan2(sh[1] - elbow[1], sh[0] - elbow[0]); // pointing up to shoulder
        const angDeg = lerp(currentEx?.restAngle ?? 148, currentEx?.targetAngle ?? 58, p);
        const fAng = uaAng + angDeg * DEG; // forward & upward curl!
        wrist = vec(elbow, 31, fAng);

        // Ghost target forearm
        const gFAng = uaAng + (currentEx?.targetAngle ?? 58) * DEG;
        const gWrist = vec(elbow, 31, gFAng);
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "rgba(244, 63, 94, 0.35)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(elbow[0], elbow[1]);
        ctx.lineTo(gWrist[0], gWrist[1]);
        ctx.stroke();
        ctx.restore();

        pivot = elbow;
        pa = sh;
        pc = wrist;
      } else if (meta.anim === "standingRow") {
        // Elastic band attached forward on right wall (x=295)
        const armDrop = 26;
        const fwdReach = lerp(54, 18, p);
        const pullBack = lerp(0, 26, p);
        const elAngle = lerp(165, 80, p);
        elbow = [sh[0] + lerp(32, -20, p), sh[1] + lerp(16, 26, p)];
        wrist = [elbow[0] + lerp(28, 30, p), elbow[1] - lerp(4, 2, p)];

        // Resistance band
        const anchor = [295, sh[1] + 20];
        ctx.save();
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(anchor[0], anchor[1]);
        ctx.lineTo(wrist[0], wrist[1]);
        ctx.stroke();
        ctx.fillStyle = "#38bdf8";
        ctx.beginPath();
        ctx.arc(anchor[0], anchor[1], 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        pivot = elbow;
        pa = sh;
        pc = wrist;
      } else {
        // shoulderFlexion (stages 2, 3, general)
        const restA = currentEx?.restAngle ?? 18;
        const targA = currentEx?.targetAngle ?? 120;
        const armDeg = lerp(restA, targA, p);
        const rad = Math.PI / 2 - armDeg * DEG; // 0 = down, 90 = straight forward (+X), 180 = straight up
        elbow = vec(sh, 35, rad);
        wrist = vec(sh, 67, rad);

        const gRad = Math.PI / 2 - targA * DEG;
        const gWrist = vec(sh, 67, gRad);
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "rgba(244, 63, 94, 0.35)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sh[0], sh[1]);
        ctx.lineTo(gWrist[0], gWrist[1]);
        ctx.stroke();
        ctx.restore();

        pivot = sh;
        pa = hip;
        pc = wrist;
      }
    }

    // Draw lower body
    drawCapsule(ctx, hip, knee, 10.5, 7.5, "#1f293d");
    drawCapsule(ctx, knee, ankle, 7, 4.8, "#1f293d");
    // Foot
    drawCapsule(ctx, ankle, [ankle[0] + 15, ankle[1] + 2], 4.5, 3, "#1f293d");

    // Torso
    drawCapsule(ctx, hip, sh, 11.5, 13.5, "#233046");
    drawHead(ctx, head, 0, 12.5);

    // Torso & lower-body muscle overlays (body faces +X; hip->knee points +Y so -normal is +X anterior)
    drawMuscleBelly(ctx, hip, knee, 0.14, 0.86, 7.5, -4.5, roleFor("quads"), p);
    drawMuscleBelly(ctx, hip, knee, 0.14, 0.86, 6.5, 5, roleFor("hamstrings"), p);
    drawMusclePatch(ctx, hip[0] - 8, hip[1] - 4, 9, 9, 0.2, roleFor("gluteMax"), p);
    drawMuscleBelly(ctx, hip, sh, 0.2, 0.68, 7.5, 3, roleFor("core"), p);
    drawMusclePatch(ctx, sh[0] + 7, sh[1] + 12, 8, 6.5, -0.2, roleFor("pectoralis"), p);
    drawMusclePatch(ctx, sh[0] - 3, sh[1] + 22, 6.5, 11, 0.2, roleFor("serratus"), p);
    drawMusclePatch(ctx, sh[0] - 6, sh[1] + 24, 9, 13, 0.15, roleFor("lats"), p);
    drawMusclePatch(ctx, sh[0] - 6, sh[1] + 8, 8.5, 6.5, 0.1, roleFor("rhomboids"), p);
    drawMusclePatch(ctx, sh[0] - 5, sh[1] + 2, 9, 5.5, 0.1, roleFor("midTrap"), p);
    drawMusclePatch(ctx, sh[0] - 4, sh[1] + 7, 7, 5, 0, roleFor("infraspinatus"), p);
    drawMusclePatch(ctx, sh[0] + 1, sh[1] - 5, 7, 4.5, -0.1, roleFor("supraspinatus"), p);

    // Arm & arm muscles (sh->elbow points +Y at rest so -normal is +X anterior)
    drawCapsule(ctx, sh, elbow, 7.2, 5.4, "#2a3852");
    drawCapsule(ctx, elbow, wrist, 5.4, 4, "#2a3852");

    drawMuscleBelly(ctx, sh, elbow, 0.0, 0.42, 7.2, -2.5, roleFor("deltoidAnt"), p);
    drawMuscleBelly(ctx, sh, elbow, 0.0, 0.42, 7.2, 3.5, roleFor("deltoidPost"), p);
    drawMuscleBelly(ctx, sh, elbow, 0.28, 0.85, 6.4, -4.2, roleFor("biceps"), p);
    drawMuscleBelly(ctx, elbow, wrist, 0.15, 0.78, 4.6, -2.8, roleFor("forearm"), p);

    drawAngleArc(ctx, pivot, pa, pc, angleDeg);
    drawJointDot(ctx, pa, false);
    drawJointDot(ctx, pivot, true);
    drawJointDot(ctx, pc, false);
  }

  function drawSeatedSide(meta, p, angleDeg) {
    const hip = [124, 152];
    const seatY = 162;

    // Chair / Plinth
    ctx.save();
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(92, 108);
    ctx.lineTo(92, seatY);
    ctx.lineTo(176, seatY);
    ctx.moveTo(100, seatY);
    ctx.lineTo(100, 226);
    ctx.moveTo(166, seatY);
    ctx.lineTo(166, 226);
    ctx.stroke();
    ctx.restore();

    let knee = [174, 152];
    let ankle, sh, head, elbow, wrist, pivot, pa, pc;

    if (meta.anim === "tableSlide") {
      // Draw Table in front of seated patient
      const tableY = 128;
      ctx.save();
      ctx.fillStyle = "rgba(51, 65, 85, 0.45)";
      ctx.fillRect(178, tableY, 128, 8);
      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(186, tableY + 8);
      ctx.lineTo(186, 226);
      ctx.moveTo(294, tableY + 8);
      ctx.lineTo(294, 226);
      ctx.stroke();
      ctx.restore();

      const lean = lerp(0, 14, p) * DEG;
      sh = vec(hip, 58, -Math.PI / 2 + lean);
      head = vec(sh, 19, -Math.PI / 2 + lean * 0.6);
      ankle = [178, 220];

      const slideX = lerp(206, 268, p);
      wrist = [slideX, tableY - 4];
      elbow = [lerp(sh[0] + 22, sh[0] + 44, p), tableY - 5];

      // Towel pad under hand
      ctx.fillStyle = "#38bdf8";
      ctx.fillRect(wrist[0] - 10, tableY - 3, 22, 4);

      pivot = sh;
      pa = hip;
      pc = elbow;
    } else {
      // kneeExtension
      sh = [120, 92];
      head = [122, 68];
      elbow = [128, 126];
      wrist = [150, 150];

      const restK = currentEx?.restAngle ?? 95;
      const targK = currentEx?.targetAngle ?? 158;
      const kDeg = lerp(restK, targK, p);
      // thigh vector from knee->hip is PI (pointing left); extension sweeps downward shin from ~95° up toward 158° straight (+X)
      const shinRad = Math.PI - kDeg * DEG; // 95° -> +85° (down); 158° -> +22° (almost horizontal forward)
      ankle = vec(knee, 48, shinRad);

      // Ghost target shin
      const gRad = Math.PI - targK * DEG;
      const gAnkle = vec(knee, 48, gRad);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(244, 63, 94, 0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(knee[0], knee[1]);
      ctx.lineTo(gAnkle[0], gAnkle[1]);
      ctx.stroke();
      ctx.restore();

      pivot = knee;
      pa = hip;
      pc = ankle;
    }

    drawCapsule(ctx, hip, knee, 10.5, 7.8, "#1f293d");
    drawCapsule(ctx, knee, ankle, 7, 4.8, "#1f293d");
    drawCapsule(ctx, hip, sh, 11.5, 13, "#233046");
    drawHead(ctx, head, 0, 12.5);

    drawMuscleBelly(ctx, hip, knee, 0.14, 0.86, 7.8, -5, roleFor("quads"), p);
    drawMuscleBelly(ctx, knee, ankle, 0.15, 0.82, 4.8, -4.2, roleFor("tibialis"), p);
    drawMuscleBelly(ctx, hip, sh, 0.2, 0.72, 7, 3, roleFor("core"), p);
    drawMusclePatch(ctx, sh[0] + 1, sh[1] - 4, 7.5, 4.8, -0.1, roleFor("supraspinatus"), p);
    drawMusclePatch(ctx, sh[0] - 2, sh[1] + 22, 6.5, 11, 0.2, roleFor("serratus"), p);

    drawCapsule(ctx, sh, elbow, 7, 5.2, "#2a3852");
    drawCapsule(ctx, elbow, wrist, 5.2, 4, "#2a3852");
    drawMuscleBelly(ctx, sh, elbow, 0.0, 0.45, 7, -2.5, roleFor("deltoidAnt"), p);

    drawAngleArc(ctx, pivot, pa, pc, angleDeg);
    drawJointDot(ctx, pa, false);
    drawJointDot(ctx, pivot, true);
    drawJointDot(ctx, pc, false);
  }

  function drawSupine(meta, p, angleDeg) {
    const matY = 186;
    const head = [64, matY - 12];
    let sh = [94, matY - 10];
    let hip, knee, ankle, pivot, pa, pc;

    // Arm resting politely alongside torso
    const elbow = [126, matY - 6];
    const wrist = [154, matY - 4];

    if (meta.anim === "gluteBridge") {
      // Ankles fixed flat, knees bent; hips rise into straight line with sh->knee
      ankle = [278, matY - 3];
      knee = [238, matY - 48];
      const bridgeY = lerp(matY - 8, (sh[1] + knee[1]) * 0.5 - 3, p);
      hip = [166, bridgeY];

      // Ghost top bridge
      const gHipY = (sh[1] + knee[1]) * 0.5 - 3;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(244, 63, 94, 0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sh[0], sh[1]);
      ctx.lineTo(166, gHipY);
      ctx.lineTo(knee[0], knee[1]);
      ctx.stroke();
      ctx.restore();

      pivot = hip;
      pa = sh;
      pc = knee;
    } else if (meta.anim === "straightLegRaise") {
      hip = [168, matY - 8];
      const liftDeg = lerp(8, 45, p); // rest 8 deg, target 45 deg
      knee = vec(hip, 52, -liftDeg * DEG);
      ankle = vec(hip, 102, -liftDeg * DEG);

      // Ghost 45 deg raised leg
      const gAnkle = vec(hip, 102, -45 * DEG);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(244, 63, 94, 0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hip[0], hip[1]);
      ctx.lineTo(gAnkle[0], gAnkle[1]);
      ctx.stroke();
      ctx.restore();

      // Opposite bent stabilizing leg subtly behind
      drawCapsule(ctx, hip, [220, matY - 44], 8, 6, "rgba(30, 41, 59, 0.55)", null);
      drawCapsule(ctx, [220, matY - 44], [254, matY - 4], 6, 4.5, "rgba(30, 41, 59, 0.55)", null);

      pivot = hip;
      pa = sh;
      pc = knee;
    } else {
      // heelSlide: heel slides closer to hip along matY, knee rises cleanly
      hip = [168, matY - 8];
      const thigh = 50;
      const shin = 48;
      const targetK = lerp(currentEx?.restAngle ?? 170, currentEx?.targetAngle ?? 95, p);
      // Place ankle along matY at distance computed by law of cosines!
      const d = Math.sqrt(thigh * thigh + shin * shin - 2 * thigh * shin * Math.cos(targetK * DEG));
      ankle = [hip[0] + d, matY - 4];
      // Knee triangle height h above baseline
      const a = (thigh * thigh - shin * shin + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, thigh * thigh - a * a));
      knee = [hip[0] + a, hip[1] - h];

      pivot = knee;
      pa = hip;
      pc = ankle;
    }

    drawCapsule(ctx, sh, hip, 12.5, 11.5, "#233046");
    drawHead(ctx, head, -Math.PI / 2, 12);
    drawCapsule(ctx, sh, elbow, 6, 4.5, "#1e293b");
    drawCapsule(ctx, elbow, wrist, 4.5, 3.5, "#1e293b");

    drawCapsule(ctx, hip, knee, 10, 7.5, "#27354d");
    drawCapsule(ctx, knee, ankle, 7, 4.8, "#27354d");
    drawCapsule(ctx, ankle, [ankle[0] + 6, ankle[1] - 11], 4.5, 3, "#27354d");

    // Muscle highlights in supine view
    drawMuscleBelly(ctx, hip, knee, 0.14, 0.85, 7, -4.5, roleFor("quads"), p);
    drawMuscleBelly(ctx, hip, knee, 0.14, 0.85, 6.5, 4.5, roleFor("hamstrings"), p);
    drawMusclePatch(ctx, hip[0] - 4, hip[1] + 4, 9, 7, 0.1, roleFor("gluteMax"), p);
    drawMusclePatch(ctx, hip[0] + 4, hip[1] - 4, 7.5, 5, -0.35, roleFor("hipFlexor"), p);
    drawMuscleBelly(ctx, sh, hip, 0.25, 0.78, 6.5, -4.5, roleFor("core"), p);

    drawAngleArc(ctx, pivot, pa, pc, angleDeg);
    drawJointDot(ctx, pa, false);
    drawJointDot(ctx, pivot, true);
    drawJointDot(ctx, pc, false);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - lastTs) / 1000));
    lastTs = now;
    if (!paused) elapsedS += dt;

    // Skip heavy canvas draw when hidden or collapsed
    if (collapsed || canvas.offsetParent === null) return;

    resizeHiDPI();
    const meta = EXERCISE_MUSCLE_MAP[currentKey] ?? EXERCISE_MUSCLE_MAP.shoulderRaise;
    const cycle = sampleTempoCycle(elapsedS, currentTempo, currentEx);
    const restAng = currentEx?.restAngle ?? 0;
    const targetAng = currentEx?.targetAngle ?? 90;
    const angleDeg = lerp(restAng, targetAng, cycle.progress);

    drawBackground(meta, cycle, angleDeg);

    if (meta.view === "front") {
      drawStandingFront(meta, cycle.progress, angleDeg);
    } else if (meta.view === "side-seated") {
      drawSeatedSide(meta, cycle.progress, angleDeg);
    } else if (meta.view === "supine") {
      drawSupine(meta, cycle.progress, angleDeg);
    } else {
      drawStandingSide(meta, cycle.progress, angleDeg);
    }
  }

  if (playBtn) {
    playBtn.addEventListener("click", () => {
      paused = !paused;
      playBtn.textContent = paused ? "▶ Play" : "⏸ Pause";
      playBtn.setAttribute("aria-pressed", String(paused));
    });
  }

  if (toggleBtn && bodyEl) {
    toggleBtn.addEventListener("click", () => {
      collapsed = !collapsed;
      bodyEl.hidden = collapsed;
      toggleBtn.textContent = collapsed ? "Show guide" : "Hide guide";
      toggleBtn.setAttribute("aria-expanded", String(!collapsed));
    });
  }

  renderMetadata();
  requestAnimationFrame(frame);

  return {
    setExercise(key, exObj, tempoKey = DEFAULT_TEMPO, side = "R") {
      currentKey = key in EXERCISE_MUSCLE_MAP ? key : "shoulderRaise";
      currentEx = exObj ?? EXERCISES[currentKey];
      currentTempo = tempoKey ?? DEFAULT_TEMPO;
      currentSide = side === "L" ? "L" : "R";
      renderMetadata();
    },
    setSide(side) {
      currentSide = side === "L" ? "L" : "R";
    },
    setPaused(nextPaused) {
      paused = Boolean(nextPaused);
      if (playBtn) playBtn.textContent = paused ? "▶ Play" : "⏸ Pause";
    },
    setCollapsed(nextCollapsed) {
      collapsed = Boolean(nextCollapsed);
      if (bodyEl) bodyEl.hidden = collapsed;
      if (toggleBtn) {
        toggleBtn.textContent = collapsed ? "Show guide" : "Hide guide";
        toggleBtn.setAttribute("aria-expanded", String(!collapsed));
      }
    },
  };
}
