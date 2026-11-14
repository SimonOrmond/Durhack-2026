// Wires the pipeline together:
//   camera -> PoseLandmarker -> joint angle -> smoothing -> RepCounter -> events -> UI + game

import { createPoseTracker, startCamera, runDetectionLoop, loadMediaPipe } from "./pose.js";
import { angle2D, pickSide, sideVisibility, Smoother } from "./angles.js";
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
  let sessions = [];
  try {
    if (user.role === "patient") {
      [plan, sessions] = await Promise.all([
        Api.prescriptions(user._id),
        Api.sessions(user._id, 100).catch(() => []),
      ]);
    } else {
      plan = [];
    }
  } catch (err) {
    el.innerHTML = `<div class="form-error">${err.message}</div>`;
    return;
  }
  if (!plan.length) {
    el.innerHTML = `<div class="muted small">${user.role === "patient" ? "Nothing prescribed yet. Use Free play below." : "Signed in as a physio: use Free play to try exercises."}</div>`;
    renderPatientTimeline([], sessions);
    return;
  }
  el.innerHTML = "";
  for (const pr of plan) {
    const card = document.createElement("div");
    card.className = "plan-card";
    card.dataset.id = pr._id;
    const ov = pr.angleOverrides?.targetAngle ? ` · target ${pr.angleOverrides.targetAngle}°` : "";
    const rest = pr.sets > 1 ? ` · rest ${pr.restSeconds ?? DEFAULT_REST_S}s` : "";
    const weeks = pr.durationWeeks ?? 4;
    const freq = pr.daysPerWeek ?? 3;
    const phaseTag = pr.timelinePhase ? `<span class="timeline-tag">${esc(pr.timelinePhase)}</span>` : "";
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:start;gap:6px">
        <b>${esc(pr.exerciseName)}</b>
        <span class="timeline-badge">${weeks} wks · ${freq}d/wk</span>
      </div>
      ${phaseTag ? `<div style="margin:2px 0">${phaseTag}</div>` : ""}
      <span class="muted">${pr.sets} sets × ${pr.reps} reps${pr.holdSeconds ? ` · hold ${pr.holdSeconds}s` : ""}${rest}${ov}</span>
      ${pr.notes ? `<span class="note">“${esc(pr.notes)}”</span>` : ""}`;
    card.addEventListener("click", () => applyPrescription(pr));
    el.appendChild(card);
  }

  // Pre-select first prescription if none active yet
  if (plan.length && !activePrescription) {
    const firstPr = plan[0];
    activePrescription = firstPr;
    exerciseKey = firstPr.exerciseKey;
    exercise = { ...EXERCISES[exerciseKey], ...(firstPr.angleOverrides ?? {}) };
    exerciseSelect.value = exerciseKey;
    $("instructions").textContent = exercise.instructions + (firstPr.notes ? ` Physio note: ${firstPr.notes}` : "");
    game.setConcentric(exercise.concentric);
    game.setHoldTargetMs((firstPr.holdSeconds || 2) * 1000);
    recorder.start(exerciseKey, firstPr);
    $("set-progress").hidden = false;
    $("sp-exercise").textContent = firstPr.exerciseName;
    $("sp-sets").textContent = firstPr.sets;
    $("sp-reps").textContent = firstPr.reps;
    $("finish").hidden = false;
    for (const c of el.children) c.classList.toggle("active", c.dataset?.id === firstPr._id);
    if ($("start")) $("start").textContent = `Start ${firstPr.exerciseName}`;
  }

  renderPatientTimeline(plan, sessions);
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderPatientTimeline(planList, sessionsList) {
  const container = $("timeline-section");
  if (!container) return;
  if (user.role !== "patient") {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  // 1. Group sessions by calendar day
  const sessionsByDay = new Map();
  for (const s of sessionsList) {
    const d = new Date(s.startedAt);
    const k = dateKey(d);
    if (!sessionsByDay.has(k)) sessionsByDay.set(k, { date: d, sessions: [] });
    sessionsByDay.get(k).sessions.push(s);
  }
  const totalDaysDone = sessionsByDay.size;
  let totalRepsAllTime = 0;
  for (const s of sessionsList) totalRepsAllTime += s.summary?.repCount ?? (s.reps?.length || 0);

  // Badge pill
  const badgeEl = $("timeline-stats-badge");
  if (badgeEl) {
    badgeEl.innerHTML = `<span class="badge-pill">🔥 ${totalDaysDone} completed workout ${totalDaysDone === 1 ? "day" : "days"} · ${totalRepsAllTime} total reps</span>`;
  }

  // 2. Weekly Activity Grid (Monday - Sunday of current week)
  const now = new Date();
  const dayOfWeek = (now.getDay() + 6) % 7; // 0 = Mon, 6 = Sun
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);

  const weekLabelEl = $("calendar-week-label");
  if (weekLabelEl) {
    weekLabelEl.textContent = `${monday.toLocaleDateString([], { day: "numeric", month: "short" })} – ${sunday.toLocaleDateString([], { day: "numeric", month: "short" })}`;
  }

  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const weekGridEl = $("week-grid");
  let daysCompletedThisWeek = 0;

  if (weekGridEl) {
    weekGridEl.innerHTML = "";
    for (let i = 0; i < 7; i++) {
      const colDate = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      const k = dateKey(colDate);
      const isDone = sessionsByDay.has(k);
      const isToday = k === dateKey(now);
      const isFuture = colDate.setHours(0, 0, 0, 0) > now.setHours(0, 0, 0, 0);
      if (isDone) daysCompletedThisWeek++;

      const col = document.createElement("div");
      col.className = `day-col${isDone ? " completed" : ""}${isToday ? " today" : ""}`;
      const doneIcon = isDone ? "✓" : isToday ? "Today" : isFuture ? "·" : "—";
      const checkClass = isDone ? "day-check" : "day-check pending";

      col.innerHTML = `
        <div class="day-name">${dayNames[i]}</div>
        <div class="day-num">${colDate.getDate()}</div>
        <div class="${checkClass}">${doneIcon}</div>
      `;
      weekGridEl.appendChild(col);
    }
  }

  const targetFreq = planList.length ? Math.max(...planList.map((p) => p.daysPerWeek || 3)) : 3;
  const weekSummaryEl = $("week-summary");
  if (weekSummaryEl) {
    weekSummaryEl.textContent = `${daysCompletedThisWeek} of ${targetFreq} target days this week (${Math.min(100, Math.round((daysCompletedThisWeek / targetFreq) * 100))}%)`;
  }

  // 3. Programme Timeline of Prescribed Exercises
  const timelineGrid = $("timeline-cards-grid");
  if (timelineGrid) {
    if (!planList.length) {
      timelineGrid.innerHTML = `<div class="muted small">No active prescribed programme yet. Use Free play above.</div>`;
    } else {
      timelineGrid.innerHTML = "";
      for (const pr of planList) {
        const weeks = pr.durationWeeks ?? 4;
        const freq = pr.daysPerWeek ?? 3;
        const phase = pr.timelinePhase || "Active Phase";
        const start = pr.startDate ? new Date(pr.startDate) : new Date(pr.createdAt || Date.now());
        const end = pr.endDate ? new Date(pr.endDate) : new Date(start.getTime() + weeks * 7 * 86400e3);
        const msSinceStart = Date.now() - start.getTime();
        const activeWeek = Math.min(weeks, Math.max(1, Math.ceil(msSinceStart / (7 * 86400e3))));

        // Unique days completed for this exercise
        const exSessions = sessionsList.filter((s) => s.exerciseKey === pr.exerciseKey);
        const daysDoneForEx = new Set(exSessions.map((s) => dateKey(new Date(s.startedAt)))).size;
        const totalTargetDays = weeks * freq;
        const progressPct = Math.min(100, Math.round((daysDoneForEx / Math.max(1, totalTargetDays)) * 100));

        const item = document.createElement("div");
        item.className = "timeline-item";
        item.title = "Click to start this exercise";
        item.innerHTML = `
          <div class="timeline-item-head">
            <div>
              <b style="font-size:14px">${esc(pr.exerciseName)}</b>
              <div style="display:flex;gap:6px;align-items:center;margin-top:3px;flex-wrap:wrap">
                <span class="timeline-tag">${esc(phase)}</span>
                <span class="timeline-badge">Week ${activeWeek} of ${weeks}</span>
              </div>
            </div>
            <span class="muted small" style="text-align:right">
              ${daysDoneForEx} / ${totalTargetDays} days<br>
              <b style="color:var(--accent)">${progressPct}%</b>
            </span>
          </div>
          <div class="timeline-bar-wrap">
            <div class="timeline-bar-fill" style="width: ${progressPct}%"></div>
          </div>
          <div class="muted small" style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;font-size:11px">
            <span>${pr.sets} sets × ${pr.reps} reps · ${freq} days/wk</span>
            <span>Ends ${end.toLocaleDateString([], { day: "numeric", month: "short" })}</span>
          </div>
        `;
        item.addEventListener("click", () => applyPrescription(pr));
        timelineGrid.appendChild(item);
      }
    }
  }

  // 4. Completed Workout Days History Log
  const historyList = $("completed-days-list");
  const historyCount = $("history-count");
  if (historyList) {
    const sortedDays = [...sessionsByDay.entries()].sort((a, b) => b[1].date - a[1].date);
    if (historyCount) historyCount.textContent = `${sortedDays.length} workout days logged`;

    if (!sortedDays.length) {
      historyList.innerHTML = `<li class="muted small">No workout days recorded yet. Complete a set above to log your first day!</li>`;
    } else {
      historyList.innerHTML = "";
      for (const [k, dayObj] of sortedDays.slice(0, 10)) {
        const d = dayObj.date;
        const isToday = k === dateKey(new Date());
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const isYesterday = k === dateKey(yesterday);

        const dateTitle = isToday
          ? "Today"
          : isYesterday
          ? "Yesterday"
          : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

        let dayReps = 0;
        let romSum = 0;
        let romCount = 0;
        const exMap = new Map();

        for (const s of dayObj.sessions) {
          const reps = s.summary?.repCount ?? (s.reps?.length || 0);
          dayReps += reps;
          if (s.summary?.avgRom) {
            romSum += s.summary.avgRom;
            romCount++;
          }
          exMap.set(s.exerciseName, (exMap.get(s.exerciseName) || 0) + reps);
        }

        const exSummaryStr = [...exMap.entries()]
          .map(([name, reps]) => `${name} (${reps} reps)`)
          .join(" · ");
        const avgRomStr = romCount ? ` · Avg ROM ${Math.round((romSum / romCount) * 100)}%` : "";

        const li = document.createElement("li");
        li.className = "completed-day-row";
        li.innerHTML = `
          <div>
            <div class="day-title">${esc(dateTitle)} <span class="muted small" style="font-weight:400;margin-left:4px">${d.toLocaleDateString([], { day: "numeric", month: "short" })}</span></div>
            <div class="day-detail">${esc(exSummaryStr)}${avgRomStr}</div>
          </div>
          <span class="day-badge">✓ ${dayReps} reps</span>
        `;
        historyList.appendChild(li);
      }
    }
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
  game.setConcentric(exercise.concentric);
  game.setHoldTargetMs((pr.holdSeconds || 2) * 1000);
  recorder.start(exerciseKey, pr);
  $("set-progress").hidden = false;
  $("sp-exercise").textContent = pr.exerciseName;
  $("sp-sets").textContent = pr.sets;
  $("sp-reps").textContent = pr.reps;
  $("finish").hidden = false;
  if ($("start")) $("start").textContent = loop ? "Exercise in progress" : `Start ${pr.exerciseName}`;

  if (loop) {
    startSet();
  } else {
    setState = "ready";
    game.pause("waiting");
    setStatus(`Selected: ${pr.exerciseName}. Click Start exercise to begin.`);
  }
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
  game.setResting(setState === "resting" || setState === "done");
}

/** Begin the next set: fresh rep counter, reps count again. */
function startSet() {
  const pr = activePrescription;
  setState = "working";
  if (loop && !loop.paused) {
    game.resume();
  } else {
    game.pause("waiting");
  }
  counter.reset();
  smoother.reset();
  $("reps").textContent = "0";
  updateSetProgress();
  flashCue(`Set ${recorder.setsCompleted + 1} of ${pr.sets}: ${pr.reps} reps. Go!`, "good");
  cueTimer = performance.now() + 2500;
  if ($("start")) $("start").textContent = "Exercise in progress";
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
  game.pause("resting");
  game.restText = `Rest ${(pr.restSeconds ?? DEFAULT_REST_S)}s · relax your arm`;
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
  game.restText = `Rest ${fmtClock(left)} · relax your arm`;
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
  game.pause("done");
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
    loadPlan();
  } catch (err) {
    flashCue(`Could not save session: ${err.message}`, "warn");
    cueTimer = performance.now() + 8000;
  }
  // Prescription stays displayed in the "done" state; the next click on a plan card or the
  // Free play dropdown starts something new. Manual finish (button) ends it the same way.
  if (setState !== "done") {
    setState = "done";
    game.pause("done");
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
game.setConcentric(exercise.concentric);

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
  if (setState !== "resting" && setState !== "done") game.onPhase(e.detail);
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

let lockedSide = null;      // locks to L or R while a rep is underway so side doesn't flip mid-rep
let lastTrackedSide = null; // tracks the last side fed into smoother so switching L<->R resets the filter

function resetCounters() {
  if (loop?.paused) setPaused(false);
  counter.reset();
  smoother.reset();
  game.reset();
  lockedSide = null;
  lastTrackedSide = null;
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
    game.resume();
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
  game.setConcentric(exercise.concentric);
  game.setResting(false);
  recorder.start(exerciseKey, null); // free play is still recorded
  game.resume();
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
  const fsRatio = exercise.foreshortenRatio ?? 0;
  const [la, lb, lc] = exercise.joints("L");
  const [ra, rb, rc] = exercise.joints("R");
  const visL = sideVisibility(landmarks, [la, lb, lc]);
  const visR = sideVisibility(landmarks, [ra, rb, rc]);

  let s;
  if (lockedSide && (lockedSide === "L" ? visL : visR) >= 0.4) {
    s = lockedSide;
  } else if (visL >= 0.5 && visR >= 0.5 && Math.abs(visL - visR) < 0.25) {
    // Both sides are clearly in frame (e.g. facing camera): track whichever limb is actively moving!
    const progL = progressFromAngle(exercise, angle2D(landmarks[la], landmarks[lb], landmarks[lc], aspect, fsRatio));
    const progR = progressFromAngle(exercise, angle2D(landmarks[ra], landmarks[rb], landmarks[rc], aspect, fsRatio));
    if (Math.abs(progL - progR) > 0.14) {
      s = progL > progR ? "L" : "R";
    } else {
      s = lastTrackedSide ?? (visL >= visR ? "L" : "R");
    }
  } else {
    s = pickSide(landmarks, [la, lb, lc], [ra, rb, rc]);
  }

  if (lastTrackedSide && s !== lastTrackedSide) {
    smoother.reset(); // don't blend old side's angle when switching between left and right limb
  }
  lastTrackedSide = s;

  const [a, b, c] = exercise.joints(s);
  const activeVis = s === "L" ? visL : visR;
  if (activeVis < 0.35) {
    $("status").textContent = "Move into frame so the active joints are clearly visible.";
    drawSetOverlay();
    return;
  }

  const rawAngle = exercise.calcAngle
    ? exercise.calcAngle({ lm: landmarks, s, aspect, a, b, c })
    : angle2D(landmarks[a], landmarks[b], landmarks[c], aspect, fsRatio);
  const angle = smoother.push(rawAngle);
  const progress = progressFromAngle(exercise, angle);
  counter.update(progress, timestampMs, angle);

  // Lock onto this side while the limb is mid-rep; release the lock once back at rest
  if (counter.phase === "active" || progress > 0.32) {
    lockedSide = s;
  } else if (progress < 0.18) {
    lockedSide = null;
  }

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
    const left = loop?.paused ? restRemainingMs : Math.max(0, restEndsAt - performance.now());
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
    game.pause("paused");
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
    if (setState === "resting") {
      restEndsAt = performance.now() + restRemainingMs;
      game.pause("resting");
    } else if (setState === "done") {
      game.pause("done");
    } else {
      game.resume();
    }
    loop.resume();
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

// ---- Start Exercise & Camera ----
function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

async function startExercise() {
  const btn = $("start");
  if (loop && !loop.paused) {
    flashCue("Exercise is already in progress!", "good");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Starting camera…";
  try {
    if (!loop) {
      setStatus("Starting camera… (allow camera access in browser prompt)");
      await startCamera(video);
      const { landmarker, mp } = await createPoseTracker({ onStatus: setStatus });
      drawer = new mp.DrawingUtils(octx);
      connections = mp.PoseLandmarker.POSE_CONNECTIONS;
      loop = runDetectionLoop(landmarker, video, onFrame);
      $("pause").disabled = false;
    } else if (loop.paused) {
      setPaused(false);
    }
    btn.textContent = "Exercise in progress";
    btn.disabled = false;

    // Start exercise and game now that camera has started
    if (activePrescription) {
      if (setState !== "working" && setState !== "resting") {
        startSet();
      } else {
        game.resume();
      }
    } else {
      setState = "free";
      game.resume();
      flashCue("Camera active! Do your reps in front of the screen.", "good");
    }
    setStatus("Exercise active · follow the movement on screen");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, "error");
    flashCue(err.message, "warn");
    cueTimer = performance.now() + 15000;
    btn.disabled = false;
    btn.textContent = "Retry start";
  }
}

$("start").addEventListener("click", startExercise);

// Module is loaded: enable the Start exercise button.
$("start").disabled = false;
if (!$("start").textContent.startsWith("Start ")) {
  $("start").textContent = "Start exercise";
}
setStatus("Ready. Choose an exercise or click Start exercise.");
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
