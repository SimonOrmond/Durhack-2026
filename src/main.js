// Wires the pipeline together:
//   camera -> PoseLandmarker -> joint angle -> smoothing -> RepCounter -> events -> UI + game

import { createPoseTracker, startCamera, runDetectionLoop, loadMediaPipe } from "./pose.js";
import { angle2D, pickSide, Smoother } from "./angles.js";
import { EXERCISES, progressFromAngle, RepCounter, checkForm, splitPhases } from "./exercises.js";
import { RunnerGame } from "./game.js";
import { Api, requireUser, logout } from "./api.js";
import { SessionRecorder } from "./session.js";

// Must be signed in (any role: physios can try the patient view too).
const user = requireUser();
if (!user) await new Promise(() => {}); // halt this module while the browser navigates to login

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const octx = overlay.getContext("2d");
let drawer = null;        // mp.DrawingUtils, created once MediaPipe has loaded
let connections = null;   // mp.PoseLandmarker.POSE_CONNECTIONS
let loop = null;          // detection loop controller, set after Start camera

// ---- UI setup ----
const exerciseSelect = $("exercise");
{
  const groups = new Map();
  for (const [key, ex] of Object.entries(EXERCISES)) {
    const g = ex.group ?? "Other";
    if (!groups.has(g)) {
      const og = document.createElement("optgroup");
      og.label = g;
      groups.set(g, og);
      exerciseSelect.appendChild(og);
    }
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = ex.name;
    groups.get(g).appendChild(opt);
  }
}

let exerciseKey = exerciseSelect.value;
let exercise = EXERCISES[exerciseKey];
$("instructions").textContent = exercise.instructions;

$("user-chip").textContent = user.name;
$("logout").addEventListener("click", logout);

// ---- Prescriptions (from the physio) + session recording ----
const recorder = new SessionRecorder();
let plan = [];                 // active prescriptions for this patient
let activePrescription = null; // the one being performed, or null for free play

// Set state machine for a prescription:
//   working  -> reps count toward the current set
//   resting  -> rest timer between sets; reps are ignored
//   done     -> all sets complete, session saved; reps ignored until a new exercise is chosen
//   free     -> no prescription: every rep counts and is recorded as free play
let setState = "free";
let restEndsAt = 0;       // performance.now() when the rest ends
let restRemainingMs = 0;  // remaining rest while paused
let restTicker = null;
const DEFAULT_REST_S = 60;

async function loadPlan() {
  const el = $("plan");
  try {
    plan = user.role === "patient" ? await Api.prescriptions(user._id) : [];
  } catch (err) {
    el.innerHTML = `<div class="form-error">${err.message}</div>`;
    return;
  }
  if (!plan.length) {
    el.innerHTML = `<div class="muted small">${user.role === "patient" ? "Nothing prescribed yet. Use Free play below." : "Signed in as a physio: use Free play to try exercises."}</div>`;
    return;
  }
  el.innerHTML = "";
  for (const pr of plan) {
    const card = document.createElement("div");
    card.className = "plan-card";
    card.dataset.id = pr._id;
    const ov = pr.angleOverrides?.targetAngle ? ` · target ${pr.angleOverrides.targetAngle}°` : "";
    const rest = pr.sets > 1 ? ` · rest ${pr.restSeconds ?? DEFAULT_REST_S}s` : "";
    card.innerHTML = `<b>${esc(pr.exerciseName)}</b>
      <span class="muted">${pr.sets} sets × ${pr.reps} reps${pr.holdSeconds ? ` · hold ${pr.holdSeconds}s` : ""}${rest}${ov}</span>
      ${pr.notes ? `<span class="note">“${esc(pr.notes)}”</span>` : ""}`;
    card.addEventListener("click", () => applyPrescription(pr));
    el.appendChild(card);
  }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Load a prescription: set the exercise, apply the physio's angle overrides, start recording. */
async function applyPrescription(pr) {
  if (recorder.active && recorder.reps.length) await finishSession(true);
  stopRestTimer();
  activePrescription = pr;
  exerciseKey = pr.exerciseKey;
  exercise = { ...EXERCISES[exerciseKey], ...(pr.angleOverrides ?? {}) };
  exerciseSelect.value = exerciseKey;
  $("instructions").textContent = exercise.instructions + (pr.notes ? ` Physio note: ${pr.notes}` : "");
  for (const c of $("plan").children) c.classList.toggle("active", c.dataset?.id === pr._id);
  stopRestTimer();
  resetCounters();
  recorder.start(exerciseKey, pr);
  $("set-progress").hidden = false;
  $("sp-exercise").textContent = pr.exerciseName;
  $("sp-sets").textContent = pr.sets;
  $("sp-reps").textContent = pr.reps;
  $("finish").hidden = false;
  startSet();
}

function updateSetProgress() {
  if (!activePrescription) return;
  const pr = activePrescription;
  const done = setState === "done";
  const inSet = done ? pr.reps : Math.min(pr.reps, Math.max(0, recorder.repsInCurrentSet(pr.reps)));
  $("sp-set").textContent = done ? pr.sets : Math.min(pr.sets, recorder.setsCompleted + 1);
  $("sp-rep").textContent = inSet;
  $("sp-state").textContent = setState === "resting" ? "Resting" : setState === "done" ? "Complete" : "Go";
  $("skip-rest").hidden = setState !== "resting";
  document.body.classList.toggle("resting", setState === "resting");
}

/** Begin the next set: fresh rep counter, reps count again. */
function startSet() {
  const pr = activePrescription;
  setState = "working";
  counter.reset();
  smoother.reset();
  $("reps").textContent = "0";
  updateSetProgress();
  flashCue(`Set ${recorder.setsCompleted + 1} of ${pr.sets}: ${pr.reps} reps. Go!`, "good");
  cueTimer = performance.now() + 2500;
}

/** Called after each counted rep while a prescription is being worked: handles set boundaries. */
function onPrescribedRep(tempo = "") {
  const pr = activePrescription;
  const inSet = recorder.repsInCurrentSet(pr.reps);
  if (inSet >= pr.reps) {
    recorder.completeSet();
    updateSetProgress();
    if (recorder.setsCompleted >= pr.sets) {
      completeSession();
    } else {
      startRest();
    }
    return;
  }
  if (tempo) flashCue(`Rep ${inSet} of ${pr.reps} · ${tempo}`, "good");
  updateSetProgress();
}

/** Rest between sets: countdown on the video and in the progress bar; reps are ignored. */
function startRest() {
  const pr = activePrescription;
  setState = "resting";
  restEndsAt = performance.now() + (pr.restSeconds ?? DEFAULT_REST_S) * 1000;
  counter.reset();
  flashCue(`Set ${recorder.setsCompleted} of ${pr.sets} done! Rest.`, "good");
  cueTimer = performance.now() + 3000;
  updateSetProgress();
  stopRestTimer();
  restTicker = setInterval(tickRest, 200);
  tickRest();
}
function tickRest() {
  if (setState !== "resting") return stopRestTimer();
  if (loop?.paused) return; // countdown frozen while paused
  const left = Math.max(0, restEndsAt - performance.now());
  $("sp-rest").textContent = `Rest ${fmtClock(left)}`;
  if (left <= 0) {
    stopRestTimer();
    startSet();
  }
}
function stopRestTimer() {
  if (restTicker) clearInterval(restTicker);
  restTicker = null;
  $("sp-rest").textContent = "";
}
const fmtClock = (msv) => {
  const s = Math.ceil(msv / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
$("skip-rest").addEventListener("click", () => {
  if (setState === "resting") {
    stopRestTimer();
    startSet();
  }
});

/** All sets done: stop counting, save, tell the patient it went to the physio. */
async function completeSession() {
  const pr = activePrescription;
  setState = "done";
  stopRestTimer();
  updateSetProgress();
  $("finish").hidden = true;
  flashCue(`All ${pr.sets} sets complete! Sending to your physio…`, "good");
  cueTimer = performance.now() + 8000;
  const saved = await finishSession(true);
  if (saved) {
    flashCue(`All ${pr.sets} sets complete · sent to your physio ✓  (${saved.summary.repCount} reps, avg ROM ${Math.round(saved.summary.avgRom * 100)}%)`, "good");
    cueTimer = performance.now() + 10000;
    $("sp-rest").textContent = "Sent ✓";
  }
}

/**
 * Save the session to the API. Returns the saved document (or null).
 * silent=true: no "saved" cue (caller shows its own). Used by completeSession and when
 * switching exercise with reps already recorded.
 */
async function finishSession(silent = false) {
  if (!recorder.active || !recorder.reps.length) {
    if (!silent) flashCue("No reps recorded yet", "warn");
    return null;
  }
  const pr = activePrescription;
  let saved = null;
  try {
    saved = await recorder.save();
    if (!silent) {
      flashCue(`Session saved ✓ ${saved.summary.repCount} reps, avg ROM ${Math.round(saved.summary.avgRom * 100)}%`, "good");
      cueTimer = performance.now() + 6000;
    }
    if (pr) {
      const card = [...$("plan").children].find((c) => c.dataset?.id === pr._id);
      card?.classList.add("done");
      card?.classList.remove("active");
    }
  } catch (err) {
    flashCue(`Could not save session: ${err.message}`, "warn");
    cueTimer = performance.now() + 8000;
  }
  // Prescription stays displayed in the "done" state; the next click on a plan card or the
  // Free play dropdown starts something new. Manual finish (button) ends it the same way.
  if (setState !== "done") {
    setState = "done";
    stopRestTimer();
    updateSetProgress();
    $("finish").hidden = true;
  }
  return saved;
}

$("finish").addEventListener("click", async () => {
  // Manual finish: counts the partial set so far, saves, stops counting.
  if (!activePrescription) return finishSession();
  await finishSession(false);
});
loadPlan();

const counter = new RepCounter();
const smoother = new Smoother(0.35);
const game = new RunnerGame($("game"));

let lastCue = null;
let cueTimer = 0;

// ---- Events out of the pipeline -> UI + game ----
counter.addEventListener("rep", (e) => {
  // Reps only count while working a set or in free play. During rest / after completion they're ignored.
  if (setState === "resting" || setState === "done") return;
  const rep = { ...e.detail, ...splitPhases(exercise, e.detail) };
  $("reps").textContent = rep.count;
  $("rom").textContent = `${Math.round(rep.rom * 100)}%`;
  game.onRep(rep);
  recorder.addRep(rep);
  const tempo = `${(rep.concentricMs / 1000).toFixed(1)}s up · ${(rep.eccentricMs / 1000).toFixed(1)}s down`;
  if (activePrescription && setState === "working") onPrescribedRep(tempo);
  else flashCue(`Nice rep! ${tempo}`, "good");
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

function resetCounters() {
  if (loop?.paused) setPaused(false);
  counter.reset();
  smoother.reset();
  game.reset();
  $("reps").textContent = "0";
  $("rom").textContent = "—";
  $("phase").textContent = "—";
  $("gauge").style.width = "0%";
}

/** Reset button: clears counters and abandons the current session without saving. */
function resetAll() {
  stopRestTimer();
  resetCounters();
  recorder.reset();
  if (activePrescription) {
    recorder.start(activePrescription.exerciseKey, activePrescription);
    $("finish").hidden = false;
    startSet();
  } else {
    setState = "free";
    recorder.start(exerciseKey, null);
  }
}

exerciseSelect.addEventListener("change", async () => {
  if (recorder.active && recorder.reps.length) await finishSession(true);
  stopRestTimer();
  activePrescription = null;
  setState = "free";
  document.body.classList.remove("resting");
  $("set-progress").hidden = true;
  for (const c of $("plan").children) c.classList?.remove("active");
  exerciseKey = exerciseSelect.value;
  exercise = EXERCISES[exerciseKey];
  $("instructions").textContent = exercise.instructions;
  resetCounters();
  recorder.start(exerciseKey, null); // free play is still recorded
});
recorder.start(exerciseKey, null);
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
    drawSetOverlay();
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
  counter.update(progress, timestampMs, angle);

  // Form feedback (only while moving through the rep, so it doesn't nag at rest)
  if (progress > 0.3) {
    const cue = checkForm(exercise, { lm: landmarks, s, aspect });
    if (cue && cue !== lastCue) {
      flashCue(cue, "warn");
      recorder.noteCue(cue);
    }
    lastCue = cue;
  }
  if (cueTimer && performance.now() > cueTimer) {
    $("cue").innerHTML = "&nbsp;";
    $("cue").className = "cue";
    cueTimer = 0;
  }

  // Only the three joints that define this exercise are drawn, to keep the view clean.
  // The full 33-point skeleton is shown only when Debug is ticked.
  if (!$("debug-out").classList.contains("hidden")) {
    drawer.drawConnectors(landmarks, connections, { color: "rgba(255,255,255,0.35)", lineWidth: 1 });
    drawer.drawLandmarks(landmarks, { color: "rgba(255,255,255,0.5)", radius: 2 });
  }
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
  drawSetOverlay();

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

/** Big rest countdown / completion banner on the camera view (readable from across the room). */
function drawSetOverlay() {
  if (!activePrescription || (setState !== "resting" && setState !== "done")) return;
  const W = overlay.width, H = overlay.height;
  if (!W || !H) return;
  octx.save();
  if (document.body.classList.contains("mirror")) {
    octx.translate(W, 0);
    octx.scale(-1, 1);
  }
  octx.fillStyle = "rgba(15, 18, 24, 0.6)";
  octx.fillRect(0, 0, W, H);
  octx.textAlign = "center";
  octx.fillStyle = "#fff";
  if (setState === "resting") {
    const left = Math.max(0, restEndsAt - performance.now());
    octx.font = `bold ${Math.round(H * 0.22)}px system-ui`;
    octx.fillText(fmtClock(left), W / 2, H / 2 + H * 0.06);
    octx.font = `600 ${Math.round(H * 0.06)}px system-ui`;
    octx.fillStyle = "#4fd1a0";
    octx.fillText(`REST · next: set ${recorder.setsCompleted + 1} of ${activePrescription.sets}`, W / 2, H / 2 - H * 0.16);
  } else {
    octx.font = `bold ${Math.round(H * 0.1)}px system-ui`;
    octx.fillStyle = "#4fd1a0";
    octx.fillText("ALL SETS COMPLETE", W / 2, H / 2 - H * 0.02);
    octx.font = `${Math.round(H * 0.05)}px system-ui`;
    octx.fillStyle = "#fff";
    octx.fillText("Sent to your physio ✓  Pick your next exercise", W / 2, H / 2 + H * 0.08);
  }
  octx.restore();
}

// ---- Pause / resume ----
// Pausing freezes pose processing and the game. The camera keeps streaming so
// resume is instant. Rep count and score are kept; the smoother and any
// half-finished rep are reset so stale angles can't trigger a phantom rep.
function setPaused(paused) {
  if (!loop) return;
  if (paused) {
    if (setState === "resting") restRemainingMs = Math.max(0, restEndsAt - performance.now());
    loop.pause();
    game.pause();
    drawPausedVideoOverlay();
    setStatus("Paused");
    $("pause").textContent = "Resume";
  } else {
    smoother.reset();
    if (counter.phase === "active") {
      counter.phase = "rest";
      counter.holdMs = 0;
      $("phase").textContent = "Rest";
    }
    if (setState === "resting") restEndsAt = performance.now() + restRemainingMs;
    loop.resume();
    game.resume();
    setStatus("Resumed");
    $("pause").textContent = "Pause";
  }
  document.body.classList.toggle("paused", paused);
}

function togglePause() {
  if (!loop) return;
  setPaused(!loop.paused);
}

function drawPausedVideoOverlay() {
  const W = overlay.width, H = overlay.height;
  if (!W || !H) return;
  octx.save();
  if (document.body.classList.contains("mirror")) {
    octx.translate(W, 0);
    octx.scale(-1, 1);
  }
  octx.fillStyle = "rgba(15, 18, 24, 0.55)";
  octx.fillRect(0, 0, W, H);
  octx.fillStyle = "#fff";
  octx.font = "bold 40px system-ui";
  octx.textAlign = "center";
  octx.fillText("PAUSED", W / 2, H / 2);
  octx.restore();
}

$("pause").addEventListener("click", togglePause);
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea, button")) return;
  if (e.code === "Space" || e.key.toLowerCase() === "p") {
    e.preventDefault();
    togglePause();
  }
});

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
    loop = runDetectionLoop(landmarker, video, onFrame);
    btn.textContent = "Running";
    $("pause").disabled = false;
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

// Debug handle: lets tests and teammates poke the pipeline from the console, e.g.
// __physio.counter.dispatchEvent(new CustomEvent("rep", { detail: { count: 1, rom: 0.9, durationMs: 1200, holdMs: 0 } }))
window.__physio = {
  counter,
  recorder,
  game,
  get setState() { return setState; },
  skipRest: () => $("skip-rest").click(),
  get exercise() { return exercise; },
  get activePrescription() { return activePrescription; },
};
