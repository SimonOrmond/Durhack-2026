// Wires the pipeline together:
//   camera -> PoseLandmarker -> joint angle -> smoothing -> RepCounter -> events -> UI + game

import { createPoseTracker, startCamera, runDetectionLoop, loadMediaPipe } from "./pose.js";
import { angle2D, pickSide, sideVisibility, Smoother } from "./angles.js";
import { EXERCISES, progressFromAngle, RepCounter, checkForm, splitPhases } from "./exercises.js";
import { RunnerGame, RUNNER_STATES, TEMPOS, DEFAULT_TEMPO } from "./game.js";
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

const UPPER_BODY_GROUPS = new Set(["Shoulder", "Elbow", "Rotator cuff"]);
function syncExerciseBanner(trackedSide = null) {
  const el = $("exercise-banner");
  if (!el || !exercise) return;
  const sideVal = trackedSide || $("side")?.value || "auto";
  const sideLabel = sideVal === "L" ? "Left side" : sideVal === "R" ? "Right side" : "Auto side";
  const isCurl = exerciseKey === "curl";
  el.classList.toggle("is-curl", isCurl);
  el.textContent = isCurl
    ? `💪 ACTIVE MOVEMENT: BICEP CURL · ${sideLabel}`
    : `Movement: ${exercise.name} · ${sideLabel}`;
}
function syncDefaultSide(ex) {
  const sideEl = $("side");
  if (sideEl && ex) {
    sideEl.value = UPPER_BODY_GROUPS.has(ex.group) ? "R" : "auto";
  }
  syncExerciseBanner();
}

let exerciseKey = exerciseSelect.value;
let exercise = EXERCISES[exerciseKey];
syncDefaultSide(exercise);
$("instructions").textContent = exercise.instructions;
$("cue").textContent = exercise.instructions;
$("cue").className = "cue neutral";

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

let sessions = [];             // recent sessions (summaries) for this patient

/** Monday 00:00 of the current week. */
function weekStart(now = new Date()) {
  const dow = (now.getDay() + 6) % 7; // 0 = Mon
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
}

/** Sessions recorded against a prescription. */
function sessionsFor(pr) {
  return sessions.filter((s) => s.prescriptionId && String(s.prescriptionId) === String(pr._id));
}

/**
 * This week's progress for one prescription. A day counts once it has a fully completed
 * session (all prescribed sets); days with only an incomplete session are reported separately.
 */
function weekProgress(pr) {
  const mon = weekStart();
  const todayK = dateKey(new Date());
  const doneDays = new Set();
  const partialDays = new Set();
  for (const s of sessionsFor(pr)) {
    const d = new Date(s.startedAt);
    if (d < mon) continue;
    (s.completedEarly ? partialDays : doneDays).add(dateKey(d));
  }
  for (const k of doneDays) partialDays.delete(k);
  const target = pr.daysPerWeek ?? 3;
  const done = doneDays.size;
  const doneToday = doneDays.has(todayK);
  const daysLeftInWeek = 7 - ((new Date().getDay() + 6) % 7); // including today
  return {
    target,
    done,
    doneDays,
    partialDays,
    doneToday,
    weekMet: done >= target,
    outstanding: !doneToday && done < target,
    behind: target - done > daysLeftInWeek,
  };
}

function statusLabel(wp) {
  if (wp.doneToday) return { text: "✓ Done today", cls: "done" };
  if (wp.weekMet) return { text: "✓ Week target met", cls: "done" };
  const left = wp.target - wp.done;
  return { text: `To do · ${left} more day${left === 1 ? "" : "s"} this week`, cls: "todo" };
}

/** Outstanding prescriptions first, then ones already done today / for the week. */
function sortedPlan() {
  return [...plan].sort((a, b) => Number(!weekProgress(a).outstanding) - Number(!weekProgress(b).outstanding));
}

async function loadPlan() {
  const el = $("plan");
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
  renderDashboard();
  renderWeeklyRx();
  if (!plan.length) {
    el.innerHTML = `<div class="muted small">${user.role === "patient" ? "Nothing prescribed yet. Use Free play above." : "Signed in as a physio: use Free play to try exercises."}</div>`;
    renderPatientTimeline([], sessions);
    return;
  }
  el.innerHTML = "";
  for (const pr of sortedPlan()) {
    const wp = weekProgress(pr);
    const st = statusLabel(wp);
    const card = document.createElement("div");
    card.className = `plan-card${wp.outstanding ? "" : " done"}${activePrescription?._id === pr._id ? " active" : ""}`;
    card.dataset.id = pr._id;
    const ov = pr.angleOverrides?.targetAngle ? ` · target ${pr.angleOverrides.targetAngle}°` : "";
    const rest = pr.sets > 1 ? ` · rest ${pr.restSeconds ?? DEFAULT_REST_S}s` : "";
    const phaseTag = pr.timelinePhase ? `<span class="timeline-tag">${esc(pr.timelinePhase)}</span>` : "";
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:start;gap:6px">
        <b>${esc(pr.exerciseName)}</b>
        <span class="timeline-badge">${wp.done}/${wp.target} this week</span>
      </div>
      ${phaseTag ? `<div style="margin:2px 0">${phaseTag}</div>` : ""}
      <span class="muted">${pr.sets} sets × ${pr.reps} reps${pr.holdSeconds ? ` · hold ${pr.holdSeconds}s` : ""}${rest} · ${(TEMPOS[pr.tempo] ?? TEMPOS[DEFAULT_TEMPO]).name} tempo${ov}</span>
      <span class="task-status ${st.cls}">${st.text}</span>
      ${pr.notes ? `<span class="note">“${esc(pr.notes)}”</span>` : ""}`;
    card.addEventListener("click", () => applyPrescription(pr));
    el.appendChild(card);
  }

  // Pre-select the first outstanding prescription if none is active yet
  if (plan.length && !activePrescription) {
    const firstPr = sortedPlan()[0];
    if (firstPr.exerciseKey !== "curl" && game.mode === "runner") {
      game.setMode("glider");
      if (gameModeSelect) gameModeSelect.value = "glider";
      syncGameHelp("glider");
      syncModeConstraints("glider");
      drawIdleZoneOverlay();
    }
    activePrescription = firstPr;
    exerciseKey = firstPr.exerciseKey;
    exercise = { ...EXERCISES[exerciseKey], ...(firstPr.angleOverrides ?? {}) };
    exerciseSelect.value = exerciseKey;
    syncDefaultSide(exercise);
    $("instructions").textContent = exercise.instructions + (firstPr.notes ? ` Physio note: ${firstPr.notes}` : "");
    game.setConcentric(exercise.concentric);
    game.setHoldTargetMs((firstPr.holdSeconds || 2) * 1000);
    game.setTempo(firstPr.tempo);
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

/** Open the Exercise page with a prescription loaded. */
function goExercise(pr) {
  location.hash = "#exercise";
  if (pr && (activePrescription?._id !== pr._id || setState === "done")) applyPrescription(pr);
}

// ---- Dashboard: today's tasks + headline numbers ----
function renderDashboard() {
  const now = new Date();
  const hour = now.getHours();
  const first = String(user.name ?? "").split(" ")[0];
  $("dash-greeting").textContent = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${first ? `, ${first}` : ""}`;
  $("dash-date").textContent = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  const wps = plan.map((pr) => weekProgress(pr));
  const dueToday = wps.filter((wp) => wp.outstanding).length;
  const doneToday = wps.filter((wp) => wp.doneToday).length;
  const weekDone = wps.reduce((n, wp) => n + Math.min(wp.done, wp.target), 0);
  const weekTarget = wps.reduce((n, wp) => n + wp.target, 0);
  const totalReps = sessions.reduce((n, s) => n + (s.summary?.repCount ?? 0), 0);

  $("dash-today").textContent = plan.length ? (dueToday ? `${dueToday} to do` : "All done ✓") : "—";
  $("dash-today-sub").textContent = plan.length ? `${doneToday} completed today` : "nothing prescribed";
  $("dash-week").textContent = weekTarget ? `${Math.round((weekDone / weekTarget) * 100)}%` : "—";
  $("dash-week-sub").textContent = weekTarget ? `${weekDone} of ${weekTarget} exercise days` : "";
  $("dash-reps").textContent = totalReps;

  const ul = $("dash-tasks");
  ul.innerHTML = "";
  if (!plan.length) {
    ul.innerHTML = `<li class="muted small">${user.role === "patient" ? "Nothing prescribed yet. You can still try exercises on the Exercise page." : "Signed in as a physio."}</li>`;
    return;
  }
  for (const pr of sortedPlan()) {
    const wp = weekProgress(pr);
    const st = statusLabel(wp);
    const li = document.createElement("li");
    li.className = `task-row${wp.outstanding ? "" : " done"}`;
    li.innerHTML = `
      <div class="task-check">${wp.outstanding ? "○" : "✓"}</div>
      <div class="task-body">
        <b>${esc(pr.exerciseName)}</b>
        <div class="muted small">${pr.sets} sets × ${pr.reps} reps · ${(TEMPOS[pr.tempo] ?? TEMPOS[DEFAULT_TEMPO]).name} tempo · ${wp.done}/${wp.target} days this week</div>
        <span class="task-status ${st.cls}">${st.text}</span>
      </div>
      <button class="${wp.outstanding ? "btn-start" : ""}">${wp.outstanding ? "Start" : "Do again"}</button>`;
    li.querySelector("button").addEventListener("click", () => goExercise(pr));
    ul.appendChild(li);
  }
}

// ---- Progress: per-prescription weekly completion (e.g. 2 of 3 days) ----
function renderWeeklyRx() {
  const el = $("weekly-rx");
  if (!el) return;
  if (!plan.length) {
    el.innerHTML = `<div class="muted small">No active prescriptions.</div>`;
    return;
  }
  const mon = weekStart();
  const todayK = dateKey(new Date());
  const dayNames = ["M", "T", "W", "T", "F", "S", "S"];
  el.innerHTML = "";
  for (const pr of plan) {
    const wp = weekProgress(pr);
    const pct = Math.min(100, Math.round((wp.done / Math.max(1, wp.target)) * 100));
    const dots = dayNames
      .map((n, i) => {
        const k = dateKey(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
        const cls = wp.doneDays.has(k) ? "done" : wp.partialDays.has(k) ? "partial" : k === todayK ? "today" : "";
        return `<span class="rx-dot ${cls}" title="${k}">${n}</span>`;
      })
      .join("");
    const row = document.createElement("div");
    row.className = "rx-row";
    row.innerHTML = `
      <div class="rx-head">
        <b>${esc(pr.exerciseName)}</b>
        <span class="${wp.weekMet ? "rx-met" : wp.behind ? "rx-behind" : "muted small"}">${wp.done} of ${wp.target} days${wp.weekMet ? " ✓" : wp.behind ? " · behind" : ""}</span>
      </div>
      <div class="timeline-bar-wrap"><div class="timeline-bar-fill" style="width:${pct}%"></div></div>
      <div class="rx-dots">${dots}</div>`;
    el.appendChild(row);
  }
}

// ---- Views (Dashboard / Exercise / Progress) via the URL hash ----
const VIEWS = user.role === "patient" ? ["dashboard", "exercise", "progress"] : ["exercise"];
for (const a of document.querySelectorAll("#view-tabs a")) a.hidden = !VIEWS.includes(a.dataset.view);
function showView() {
  const want = location.hash.slice(1);
  const view = VIEWS.includes(want) ? want : VIEWS[0];
  for (const sec of document.querySelectorAll("section.view")) sec.hidden = sec.dataset.view !== view;
  for (const a of document.querySelectorAll("#view-tabs a")) a.classList.toggle("active", a.dataset.view === view);
  document.body.dataset.view = view;
  // Leaving the Exercise page mid-set: pause so reps can't count off-screen.
  if (view !== "exercise" && loop && !loop.paused) setPaused(true);
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", showView);

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
      const daySessions = isDone ? sessionsByDay.get(k).sessions : [];
      const allIncomplete = isDone && daySessions.length > 0 && daySessions.every((s) => s.completedEarly);
      const doneIcon = isDone ? (allIncomplete ? "⚠" : "✓") : isToday ? "Today" : isFuture ? "·" : "—";
      const checkClass = isDone ? (allIncomplete ? "day-check incomplete" : "day-check") : "day-check pending";

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
      timelineGrid.innerHTML = `<div class="muted small">No active prescribed programme yet.</div>`;
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
        item.addEventListener("click", () => goExercise(pr));
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
      historyList.innerHTML = `<li class="muted small">No workout days recorded yet. Complete an exercise to log your first day!</li>`;
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

        // Determine whether any sessions that day were completed early
        const anyIncomplete = dayObj.sessions.some((s) => s.completedEarly);
        const allDayIncomplete = dayObj.sessions.length > 0 && dayObj.sessions.every((s) => s.completedEarly);
        const incompleteSessions = dayObj.sessions.filter((s) => s.completedEarly);
        const incompleteDetail = incompleteSessions
          .map((s) => `${s.exerciseName}: ${s.setsCompleted}/${s.setsPrescribed} sets`)
          .join(", ");

        const dayBadge = allDayIncomplete
          ? `<span class="day-badge incomplete">⚠ Incomplete (${incompleteSessions[0].setsCompleted}/${incompleteSessions[0].setsPrescribed} sets)</span>`
          : anyIncomplete
          ? `<span class="day-badge partial">⚠ Partial · ${dayReps} reps</span>`
          : `<span class="day-badge">✓ ${dayReps} reps</span>`;

        const incompleteNote = anyIncomplete
          ? `<div class="day-detail warn-text" style="color:var(--warn);font-size:11px;margin-top:2px">Incomplete: ${esc(incompleteDetail)}</div>`
          : ``;

        const li = document.createElement("li");
        li.className = "completed-day-row";
        li.innerHTML = `
          <div>
            <div class="day-title">${esc(dateTitle)} <span class="muted small" style="font-weight:400;margin-left:4px">${d.toLocaleDateString([], { day: "numeric", month: "short" })}</span></div>
            <div class="day-detail">${esc(exSummaryStr)}${avgRomStr}</div>
            ${incompleteNote}
          </div>
          ${dayBadge}
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
  if (pr.exerciseKey !== "curl" && game.mode === "runner") {
    if (gameModeSelect) gameModeSelect.value = "glider";
    game.setMode("glider");
    syncModeConstraints("glider");
    syncGameHelp("glider");
  }
  activePrescription = pr;
  exerciseKey = pr.exerciseKey;
  exercise = { ...EXERCISES[exerciseKey], ...(pr.angleOverrides ?? {}) };
  exerciseSelect.value = exerciseKey;
  syncDefaultSide(exercise);
  $("instructions").textContent = exercise.instructions + (pr.notes ? ` Physio note: ${pr.notes}` : "");
  for (const c of $("plan").children) c.classList.toggle("active", c.dataset?.id === pr._id);
  stopRestTimer();
  resetCounters();
  game.setConcentric(exercise.concentric);
  game.setHoldTargetMs((pr.holdSeconds || 2) * 1000);
  game.setTempo(pr.tempo);
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
  // Manual finish: if the patient hasn't completed all prescribed sets, warn before saving.
  if (!activePrescription) return finishSession();
  const setsPrescribed = activePrescription.sets ?? null;
  const setsCompleted = recorder.setsCompleted ?? 0;
  if (setsPrescribed != null && setsCompleted < setsPrescribed) {
    const confirmed = window.confirm(
      `You have only completed ${setsCompleted} of ${setsPrescribed} set${setsPrescribed === 1 ? '' : 's'}.
` +
      `This session will be marked as INCOMPLETE in your timeline.

Save anyway?`
    );
    if (!confirmed) return;
  }
  await finishSession(false);
});
loadPlan();

const counter = new RepCounter();
const smoother = new Smoother(0.35);
const game = new RunnerGame($("game"));
const gameModeSelect = $("game-mode");

const GLIDER_STATES = {
  high: { state: "high", label: "HIGH ↑", short: "HIGH", color: "#a855f7", rgb: "168, 85, 247" },
  mid: { state: "mid", label: "MID GLIDE", short: "MID", color: "#4fd1a0", rgb: "79, 209, 160" },
  low: { state: "low", label: "LOW REST", short: "LOW", color: "#60a5fa", rgb: "96, 165, 250" },
};

function getAngleVisualState(mode, angle, progress, concentric) {
  if (mode === "runner") {
    return RUNNER_STATES[RunnerGame.stateFromAngle(angle, progress, concentric)];
  }
  if (progress >= 0.67) return GLIDER_STATES.high;
  if (progress >= 0.33) return GLIDER_STATES.mid;
  return GLIDER_STATES.low;
}

function syncGameHelp(mode) {
  const el = $("game-help");
  if (!el) return;
  el.innerHTML =
    mode === "runner"
      ? "<b>Bicep Curl only:</b> <b>≤90°</b> Jump (green) · <b>90–121°</b> Run (blue) · <b>≥121°</b> Duck (amber)"
      : "<b>Gradually raise &amp; lower</b> to follow the cave humps (longer hump = slower rep) · Collect <b>coins</b> &amp; beat your <b>PB</b>";
}

function syncModeConstraints(mode) {
  for (const opt of exerciseSelect.querySelectorAll("option")) {
    opt.disabled = mode === "runner" && opt.value !== "curl";
  }
  if (mode === "runner" && exerciseKey !== "curl") {
    activePrescription = null;
    setState = "free";
    document.body.classList.remove("resting");
    $("set-progress").hidden = true;
    for (const c of $("plan").children) c.classList?.remove("active");
    exerciseSelect.value = "curl";
    exerciseKey = "curl";
    exercise = EXERCISES.curl;
    syncDefaultSide(exercise);
    $("instructions").textContent = exercise.instructions;
    resetCounters();
    flashCue("Movement set to Bicep Curl for Dino Runner", "good");
    game.setConcentric(exercise.concentric);
    game.setTempo(DEFAULT_TEMPO);
    game.setResting(false);
    if (recorder.active) recorder.start(exerciseKey, null);
  }
  const labelEl = $("gauge-label");
  if (labelEl) {
    labelEl.innerHTML =
      mode === "runner"
        ? "<span>Duck ≥121°</span><span>Run 90–121°</span><span>Jump ≤90°</span>"
        : "<span>Rest (0%)</span><span>Glide</span><span>Target (100%)</span>";
  }
  $("gauge-track")?.classList.toggle("runner-zones", mode === "runner");
  if (mode !== "runner") {
    $("phase").style.color = "";
    $("gauge").style.backgroundColor = "";
  }
}

game.setConcentric(exercise.concentric);
game.setMode(gameModeSelect?.value ?? "glider");
syncModeConstraints(game.mode);
syncGameHelp(game.mode);
gameModeSelect?.addEventListener("change", () => {
  game.setMode(gameModeSelect.value);
  syncModeConstraints(game.mode);
  syncGameHelp(game.mode);
});

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
  const active = e.detail.phase === "active";
  if (game.mode !== "runner") {
    $("phase").textContent = active ? "At target ↑" : "Rest";
    $("phase").classList.toggle("active-phase", active);
  }
  $("gauge").classList.toggle("at-target", active);
  if (setState !== "resting" && setState !== "done") {
    game.onPhase(e.detail);
    if (active && game.mode !== "runner") {
      flashCue("Target reached! Lower with control", "good");
      cueTimer = performance.now() + 900;
    }
  }
});
counter.addEventListener("hold", (e) => game.onHold(e.detail));
counter.addEventListener("progress", (e) => {
  $("gauge").style.width = `${Math.max(0, Math.min(1, e.detail.progress)) * 100}%`;
  game.onProgress(e.detail);
});

function setNeutralCue() {
  const el = $("cue");
  el.textContent = $("instructions").textContent || exercise.instructions;
  el.className = "cue neutral";
  cueTimer = 0;
}

function flashCue(text, kind) {
  const el = $("cue");
  el.textContent = text;
  el.className = `cue ${kind}`;
  cueTimer = performance.now() + 1200;
}

let lockedSide = null;      // locks to L or R while a rep is underway so side doesn't flip mid-rep
let lastTrackedSide = null; // tracks the last side fed into smoother so switching L<->R resets the filter
let prevRawL = null;
let prevRawR = null;
let velL = 0;
let velR = 0;
let lockedStaticFrames = 0;
let lastZoneDir = 1;

function drawCanvasText(ctx, text, x, y, isMirror, { color = "#fff", font = "bold 11px system-ui", align = "center", baseline = "middle" } = {}) {
  ctx.save();
  ctx.translate(x, y);
  if (isMirror) ctx.scale(-1, 1);
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawAngleZonesOverlay(ctx, pa, pb, pc, visState, ex, mode, isMirror) {
  const baseAng = Math.atan2(pa[1] - pb[1], pa[0] - pb[0]);
  const foreAng = Math.atan2(pc[1] - pb[1], pc[0] - pb[0]);
  const diff = ((foreAng - baseAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (Math.abs(diff) > 0.25 && Math.abs(diff) < 2.85) {
    lastZoneDir = diff >= 0 ? 1 : -1;
  }
  const dir = lastZoneDir;
  const rad = Math.max(54, Math.min(92, Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) * 0.55));
  const degToRad = Math.PI / 180;

  let zones;
  let boundaries;
  if (mode === "runner") {
    zones = [
      { ...RUNNER_STATES.jumping, minDeg: 25, maxDeg: 90 },
      { ...RUNNER_STATES.running, minDeg: 90, maxDeg: 121 },
      { ...RUNNER_STATES.ducking, minDeg: 121, maxDeg: 170 },
    ];
    boundaries = [90, 121];
  } else {
    const angAt = (p) => ex.restAngle + p * (ex.targetAngle - ex.restAngle);
    const span = (p0, p1) => {
      const a0 = angAt(p0);
      const a1 = angAt(p1);
      return [Math.max(8, Math.min(a0, a1)), Math.min(176, Math.max(a0, a1))];
    };
    const [l0, l1] = span(0, 0.33);
    const [m0, m1] = span(0.33, 0.67);
    const [h0, h1] = span(0.67, 1.0);
    zones = [
      { ...GLIDER_STATES.low, minDeg: l0, maxDeg: l1 },
      { ...GLIDER_STATES.mid, minDeg: m0, maxDeg: m1 },
      { ...GLIDER_STATES.high, minDeg: h0, maxDeg: h1 },
    ];
    boundaries = [angAt(0.33), angAt(0.67)];
  }

  for (const z of zones) {
    if (z.maxDeg - z.minDeg < 3) continue;
    const a0 = baseAng + dir * z.minDeg * degToRad;
    const a1 = baseAng + dir * z.maxDeg * degToRad;
    const isActive = z.state === visState.state;

    ctx.beginPath();
    ctx.moveTo(pb[0], pb[1]);
    ctx.arc(pb[0], pb[1], rad, a0, a1, dir < 0);
    ctx.closePath();
    ctx.fillStyle = `rgba(${z.rgb}, ${isActive ? 0.34 : 0.14})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(pb[0], pb[1], rad, a0, a1, dir < 0);
    ctx.strokeStyle = isActive ? z.color : `rgba(${z.rgb}, 0.45)`;
    ctx.lineWidth = isActive ? 3.5 : 1.5;
    ctx.stroke();

    const midA = baseAng + dir * ((z.minDeg + z.maxDeg) / 2) * degToRad;
    const lr = rad * 0.72;
    drawCanvasText(ctx, z.short, pb[0] + Math.cos(midA) * lr, pb[1] + Math.sin(midA) * lr, isMirror, {
      color: isActive ? "#ffffff" : `rgba(${z.rgb}, 0.92)`,
      font: isActive ? "bold 11px system-ui" : "600 10px system-ui",
    });
  }

  // Dashed transition boundary rays
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  ctx.lineWidth = 1.5;
  for (const deg of boundaries) {
    const ra = baseAng + dir * deg * degToRad;
    ctx.beginPath();
    ctx.moveTo(pb[0], pb[1]);
    ctx.lineTo(pb[0] + Math.cos(ra) * (rad + 6), pb[1] + Math.sin(ra) * (rad + 6));
    ctx.stroke();
  }
  ctx.restore();

  // Inner live angle arc
  ctx.beginPath();
  ctx.arc(pb[0], pb[1], 28, baseAng, foreAng, diff < 0);
  ctx.strokeStyle = visState.color;
  ctx.lineWidth = 3;
  ctx.stroke();
}

function resetCounters() {
  if (loop?.paused) setPaused(false);
  counter.reset();
  smoother.reset();
  game.reset();
  lockedSide = null;
  lastTrackedSide = null;
  prevRawL = null;
  prevRawR = null;
  velL = 0;
  velR = 0;
  lockedStaticFrames = 0;
  $("reps").textContent = "0";
  $("rom").textContent = "—";
  $("phase").textContent = "—";
  $("phase").style.color = "";
  $("phase").classList.remove("active-phase");
  if ($("angle")?.parentElement) $("angle").parentElement.style.color = "";
  $("gauge").style.width = "0%";
  $("gauge").style.backgroundColor = "";
  $("gauge").classList.remove("at-target");
  setNeutralCue();
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
  syncDefaultSide(exercise);
  $("instructions").textContent = exercise.instructions;
  resetCounters();
  game.setConcentric(exercise.concentric);
  game.setTempo(DEFAULT_TEMPO);
  game.setResting(false);
  recorder.start(exerciseKey, null); // free play is still recorded
  game.resume();
});
recorder.start(exerciseKey, null);
$("reset").addEventListener("click", resetAll);
$("side")?.addEventListener("change", () => {
  lockedSide = null;
  lastTrackedSide = null;
  lockedStaticFrames = 0;
  smoother.reset();
  counter.reset();
  $("phase").textContent = "Rest";
  $("phase").classList.remove("active-phase");
  $("gauge").classList.remove("at-target");
  syncExerciseBanner();
});
$("mirror").addEventListener("change", (e) => document.body.classList.toggle("mirror", e.target.checked));
document.body.classList.toggle("mirror", $("mirror").checked);
$("debug").addEventListener("change", (e) => $("debug-out").classList.toggle("hidden", !e.target.checked));

// ---- Per-frame processing ----
function onFrame({ landmarks, timestampMs, fps }) {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  octx.clearRect(0, 0, overlay.width, overlay.height);

  if (!landmarks) {
    prevRawL = null;
    prevRawR = null;
    velL = 0;
    velR = 0;
    lockedStaticFrames = 0;
    $("status").textContent = "No person detected. Step back so your whole body is in frame.";
    drawSetOverlay();
    return;
  }

  const aspect = video.videoWidth / video.videoHeight;
  const sidePref = $("side")?.value || (UPPER_BODY_GROUPS.has(exercise.group) ? "R" : "auto");
  const [la, lb, lc] = exercise.joints("L");
  const [ra, rb, rc] = exercise.joints("R");
  const visL = sideVisibility(landmarks, [la, lb, lc]);
  const visR = sideVisibility(landmarks, [ra, rb, rc]);

  const rawL = visL >= 0.3
    ? (exercise.calcAngle ? exercise.calcAngle({ lm: landmarks, s: "L", aspect, a: la, b: lb, c: lc }) : angle2D(landmarks[la], landmarks[lb], landmarks[lc], aspect))
    : null;
  const rawR = visR >= 0.3
    ? (exercise.calcAngle ? exercise.calcAngle({ lm: landmarks, s: "R", aspect, a: ra, b: rb, c: rc }) : angle2D(landmarks[ra], landmarks[rb], landmarks[rc], aspect))
    : null;
  velL = rawL != null && prevRawL != null ? velL * 0.65 + Math.abs(rawL - prevRawL) * 0.35 : velL * 0.65;
  velR = rawR != null && prevRawR != null ? velR * 0.65 + Math.abs(rawR - prevRawR) * 0.35 : velR * 0.65;
  prevRawL = rawL;
  prevRawR = rawR;

  let s;
  if (sidePref === "L" || sidePref === "R") {
    s = sidePref;
    lockedSide = null;
    lockedStaticFrames = 0;
  } else if (lockedSide && (lockedSide === "L" ? visL : visR) >= 0.4) {
    const lockedVel = lockedSide === "L" ? velL : velR;
    const otherSide = lockedSide === "L" ? "R" : "L";
    const otherVel = otherSide === "L" ? velL : velR;
    const otherVis = otherSide === "L" ? visL : visR;
    if (lockedVel < 0.7 && otherVel > 1.8 && otherVis >= 0.5) {
      lockedStaticFrames += 1;
    } else {
      lockedStaticFrames = 0;
    }
    if (lockedStaticFrames >= 15) {
      // Stationary arm (e.g. hand resting on chin) was locked while the other arm is actively exercising.
      lockedSide = null;
      lockedStaticFrames = 0;
      counter.reset();
      smoother.reset();
      $("phase").textContent = "Rest";
      $("phase").classList.remove("active-phase");
      $("gauge").classList.remove("at-target");
      s = otherSide;
    } else {
      s = lockedSide;
    }
  } else {
    lockedStaticFrames = 0;
    if (visL >= 0.45 && visR >= 0.45) {
      if (Math.abs(velL - velR) > 1.0) {
        s = velL > velR ? "L" : "R";
      } else {
        s = lastTrackedSide ?? (visL >= visR ? "L" : "R");
      }
    } else {
      s = pickSide(landmarks, [la, lb, lc], [ra, rb, rc]);
    }
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

  const rawAngle = (s === "L" ? rawL : rawR) ?? (
    exercise.calcAngle
      ? exercise.calcAngle({ lm: landmarks, s, aspect, a, b, c })
      : angle2D(landmarks[a], landmarks[b], landmarks[c], aspect)
  );
  const angle = smoother.push(rawAngle);
  const progress = progressFromAngle(exercise, angle);
  counter.update(progress, timestampMs, angle);

  // Lock onto this side while the limb is mid-rep; release the lock once back at rest
  if (counter.phase === "active" || progress > 0.32) {
    lockedSide = s;
  } else if (progress < 0.22) {
    lockedSide = null;
    lockedStaticFrames = 0;
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
    setNeutralCue();
  }

  // Only the three joints that define this exercise are drawn, to keep the view clean.
  // The full 33-point skeleton is shown only when Debug is ticked.
  if (!$("debug-out").classList.contains("hidden")) {
    drawer.drawConnectors(landmarks, connections, { color: "rgba(255,255,255,0.35)", lineWidth: 1 });
    drawer.drawLandmarks(landmarks, { color: "rgba(255,255,255,0.5)", radius: 2 });
  }
  const W = overlay.width, H = overlay.height;
  const px = (lm) => [lm.x * W, lm.y * H];
  const pa = px(landmarks[a]);
  const pb = px(landmarks[b]);
  const pc = px(landmarks[c]);
  const isMirror = document.body.classList.contains("mirror");
  const visState = getAngleVisualState(game.mode, angle, progress, exercise.concentric);

  drawAngleZonesOverlay(octx, pa, pb, pc, visState, exercise, game.mode, isMirror);

  octx.strokeStyle = visState.color;
  octx.lineWidth = 5;
  octx.beginPath();
  octx.moveTo(...pa);
  octx.lineTo(...pb);
  octx.lineTo(...pc);
  octx.stroke();
  for (const pt of [pa, pb, pc]) {
    octx.fillStyle = visState.color;
    octx.beginPath();
    octx.arc(pt[0], pt[1], 7, 0, Math.PI * 2);
    octx.fill();
  }

  // Color-coded angle + state pill at the joint vertex (un-mirrored if mirror is on)
  const [bx, by] = pb;
  const badgeText = `${exerciseKey === "curl" ? "BICEP CURL · " : ""}${Math.round(angle)}° · ${visState.label}`;
  octx.save();
  octx.translate(bx, by - 20);
  if (isMirror) octx.scale(-1, 1);
  octx.font = "bold 15px system-ui";
  const tw = octx.measureText(badgeText).width;
  const rx = 12;
  octx.fillStyle = "rgba(10, 14, 22, 0.82)";
  octx.fillRect(rx, -14, tw + 16, 26);
  octx.strokeStyle = visState.color;
  octx.lineWidth = 2;
  octx.strokeRect(rx, -14, tw + 16, 26);
  octx.fillStyle = visState.color;
  octx.textBaseline = "middle";
  octx.fillText(badgeText, rx + 8, -1);
  octx.restore();

  const angleEl = $("angle");
  angleEl.textContent = Math.round(angle);
  if (angleEl.parentElement) angleEl.parentElement.style.color = visState.color;
  const phaseEl = $("phase");
  if (game.mode === "runner") {
    phaseEl.textContent = visState.label;
    phaseEl.style.color = visState.color;
    phaseEl.classList.remove("active-phase");
    $("gauge").style.backgroundColor = visState.color;
  } else {
    phaseEl.style.color = "";
    $("gauge").style.backgroundColor = "";
  }
  syncExerciseBanner(s);
  const moveLabel = exerciseKey === "curl" ? "Bicep curl" : exercise.name;
  $("status").textContent = `${moveLabel} (${s === "L" ? "left" : "right"} side) · ${fps.toFixed(0)} fps`;
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
      counter.minAfterPeak = null;
      counter.holdMs = 0;
      $("phase").textContent = "Rest";
      $("phase").classList.remove("active-phase");
      $("gauge").classList.remove("at-target");
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

showView();

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
