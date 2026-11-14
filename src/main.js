// Wires the pipeline together:
//   camera -> PoseLandmarker -> joint angle -> smoothing -> RepCounter -> events -> UI + game

import { createPoseTracker, startCamera, runDetectionLoop, loadMediaPipe } from "./pose.js";
import { angle2D, pickSide, Smoother } from "./angles.js";
import { EXERCISES, progressFromAngle, RepCounter, checkForm } from "./exercises.js";
import { RunnerGame } from "./game.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const octx = overlay.getContext("2d");
let drawer = null;        // mp.DrawingUtils, created once MediaPipe has loaded
let connections = null;   // mp.PoseLandmarker.POSE_CONNECTIONS

// ---- UI setup ----
const exerciseSelect = $("exercise");
for (const [key, ex] of Object.entries(EXERCISES)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = ex.name;
  exerciseSelect.appendChild(opt);
}

let exerciseKey = exerciseSelect.value;
let exercise = EXERCISES[exerciseKey];
$("instructions").textContent = exercise.instructions;

const counter = new RepCounter();
const smoother = new Smoother(0.35);
const game = new RunnerGame($("game"));

let lastCue = null;
let cueTimer = 0;

// ---- Events out of the pipeline -> UI + game ----
counter.addEventListener("rep", (e) => {
  $("reps").textContent = e.detail.count;
  $("rom").textContent = `${Math.round(e.detail.rom * 100)}%`;
  game.onRep(e.detail);
  flashCue("Nice rep!", "good");
});
counter.addEventListener("phase", (e) => {
  $("phase").textContent = e.detail.phase === "active" ? "At target" : "Rest";
});
counter.addEventListener("hold", (e) => game.onHold(e.detail));
counter.addEventListener("progress", (e) => {
  $("gauge").style.width = `${Math.max(0, Math.min(1, e.detail.progress)) * 100}%`;
  game.onProgress(e.detail);
});

function flashCue(text, kind) {
  const el = $("cue");
  el.textContent = text;
  el.className = `cue ${kind}`;
  cueTimer = performance.now() + 1200;
}

function resetAll() {
  counter.reset();
  smoother.reset();
  game.reset();
  $("reps").textContent = "0";
  $("rom").textContent = "—";
  $("phase").textContent = "—";
  $("gauge").style.width = "0%";
}

exerciseSelect.addEventListener("change", () => {
  exerciseKey = exerciseSelect.value;
  exercise = EXERCISES[exerciseKey];
  $("instructions").textContent = exercise.instructions;
  resetAll();
});
$("reset").addEventListener("click", resetAll);
$("mirror").addEventListener("change", (e) => document.body.classList.toggle("mirror", e.target.checked));
document.body.classList.toggle("mirror", $("mirror").checked);
$("debug").addEventListener("change", (e) => $("debug-out").classList.toggle("hidden", !e.target.checked));

// ---- Per-frame processing ----
function onFrame({ landmarks, timestampMs, fps }) {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  octx.clearRect(0, 0, overlay.width, overlay.height);

  if (!landmarks) {
    $("status").textContent = "No person detected. Step back so your whole body is in frame.";
    return;
  }

  const aspect = video.videoWidth / video.videoHeight;
  const [ia, ib, ic] = exercise.joints("L");
  const [ra, rb, rc] = exercise.joints("R");
  const s = pickSide(landmarks, [ia, ib, ic], [ra, rb, rc]);
  const [a, b, c] = exercise.joints(s);

  const rawAngle = angle2D(landmarks[a], landmarks[b], landmarks[c], aspect);
  const angle = smoother.push(rawAngle);
  const progress = progressFromAngle(exercise, angle);
  counter.update(progress, timestampMs);

  // Form feedback (only while moving through the rep, so it doesn't nag at rest)
  if (progress > 0.3) {
    const cue = checkForm(exercise, { lm: landmarks, s, aspect });
    if (cue && cue !== lastCue) flashCue(cue, "warn");
    lastCue = cue;
  }
  if (cueTimer && performance.now() > cueTimer) {
    $("cue").innerHTML = "&nbsp;";
    $("cue").className = "cue";
    cueTimer = 0;
  }

  // Draw skeleton + highlight the three joints that define this exercise
  drawer.drawConnectors(landmarks, connections, { color: "rgba(255,255,255,0.5)", lineWidth: 2 });
  drawer.drawLandmarks(landmarks, { color: "rgba(255,255,255,0.7)", radius: 3 });
  const W = overlay.width, H = overlay.height;
  const px = (lm) => [lm.x * W, lm.y * H];
  octx.strokeStyle = "#ff6ad5";
  octx.lineWidth = 5;
  octx.beginPath();
  octx.moveTo(...px(landmarks[a]));
  octx.lineTo(...px(landmarks[b]));
  octx.lineTo(...px(landmarks[c]));
  octx.stroke();
  for (const i of [a, b, c]) {
    octx.fillStyle = "#ff6ad5";
    octx.beginPath();
    octx.arc(...px(landmarks[i]), 7, 0, Math.PI * 2);
    octx.fill();
  }
  // Angle label at the vertex (un-mirrored text if mirror is on)
  const [bx, by] = px(landmarks[b]);
  octx.save();
  if (document.body.classList.contains("mirror")) {
    octx.translate(W, 0);
    octx.scale(-1, 1);
    octx.fillStyle = "#fff";
    octx.font = "bold 20px system-ui";
    octx.fillText(`${Math.round(angle)}°`, W - bx + 12, by - 12);
  } else {
    octx.fillStyle = "#fff";
    octx.font = "bold 20px system-ui";
    octx.fillText(`${Math.round(angle)}°`, bx + 12, by - 12);
  }
  octx.restore();

  $("angle").textContent = Math.round(angle);
  $("status").textContent = `Tracking (${s === "L" ? "left" : "right"} side) · ${fps.toFixed(0)} fps`;

  if (!$("debug-out").classList.contains("hidden")) {
    $("debug-out").textContent = JSON.stringify(
      {
        exercise: exerciseKey,
        side: s,
        rawAngle: +rawAngle.toFixed(1),
        smoothedAngle: +angle.toFixed(1),
        progress: +progress.toFixed(2),
        phase: counter.phase,
        reps: counter.count,
        holdMs: Math.round(counter.holdMs),
        fps: +fps.toFixed(1),
        visibility: Object.fromEntries([a, b, c].map((i) => [i, +(landmarks[i].visibility ?? 0).toFixed(2)])),
      },
      null,
      2
    );
  }
}

// ---- Start ----
function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

$("start").addEventListener("click", async () => {
  const btn = $("start");
  btn.disabled = true;
  btn.textContent = "Starting…";
  try {
    setStatus("Requesting camera… (allow it in the Chrome prompt)");
    await startCamera(video);
    const { landmarker, mp } = await createPoseTracker({ onStatus: setStatus });
    drawer = new mp.DrawingUtils(octx);
    connections = mp.PoseLandmarker.POSE_CONNECTIONS;
    runDetectionLoop(landmarker, video, onFrame);
    btn.textContent = "Running";
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, "error");
    flashCue(err.message, "warn");
    cueTimer = performance.now() + 15000;
    btn.disabled = false;
    btn.textContent = "Retry camera";
  }
});

// Module is loaded: enable the button (it starts disabled in the HTML so a click before
// scripts are ready can't silently do nothing). Warm the MediaPipe download in the background.
$("start").disabled = false;
$("start").textContent = "Start camera";
setStatus("Ready. Click Start camera.");
loadMediaPipe(() => {}).catch(() => {});
