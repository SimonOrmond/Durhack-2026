// Wires the pipeline together:
//   camera -> PoseLandmarker -> joint angle -> smoothing -> RepCounter -> events -> UI + game

import { createPoseTracker, startCamera, runDetectionLoop, loadMediaPipe, listCameras, VIRTUAL_CAM_RE } from "./pose.js";
import { angle2D, pickSide, sideVisibility, Smoother } from "./angles.js";
import { EXERCISES, progressFromAngle, RepCounter, checkForm, splitPhases } from "./exercises.js";
import { RunnerGame, RUNNER_STATES, TEMPOS, DEFAULT_TEMPO } from "./game.js";
import { Api, requireUser, logout } from "./api.js";
import { SessionRecorder } from "./session.js";
import { tempoOf, repTempoScore, tempoDirection } from "./tempo.js";
import { initMuscleDemo } from "./muscle-demo.js";
import { FormRecorder, askConsent, previewAndSend, loadVideoUrl, recordingSupported, RETENTION_DAYS } from "./formvideo.js";

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
    ? `Bicep Curl · ${sideLabel}`
    : `${exercise.name} · ${sideLabel}`;
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

const muscleDemo = initMuscleDemo({
  canvas: $("muscle-demo-canvas"),
  primaryEl: $("demo-primary-muscles"),
  secondaryEl: $("demo-secondary-muscles"),
  cuesEl: $("demo-form-cues"),
  romEl: $("demo-rom-meta"),
  tempoBadgeEl: $("demo-tempo-badge"),
  viewLabelEl: $("demo-view-label"),
  titleEl: $("demo-exercise-title"),
  playBtn: $("demo-play-toggle"),
  toggleBtn: $("toggle-muscle-demo"),
  bodyEl: $("muscle-demo-body"),
});
muscleDemo.setExercise(exerciseKey, exercise, DEFAULT_TEMPO, $("side")?.value === "L" ? "L" : "R");

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
//   ready    -> a prescription is loaded but not started yet
let setState = "free";
// True from pressing Start until the exercise is finished or stopped. While running, the
// exercise and game can't be changed (dropdowns disabled, plan cards locked) and reps count.
let running = false;
const isLocked = () => running;
let restEndsAt = 0;       // performance.now() when the rest ends
let restRemainingMs = 0;  // remaining rest while paused
let restTicker = null;
const DEFAULT_REST_S = 60;
const isUnlimited = (pr) => Boolean(pr && (pr.unlimited || pr.reps == null));
const fmtVolume = (pr) => (isUnlimited(pr) ? "Unlimited reps" : `${pr.sets} sets × ${pr.reps} reps`);

let sessions = [];             // recent sessions (summaries) for this patient
let coinBalance = null;        // users.coins: all-time coins saved on the patient's account

/** Monday 00:00 of the current week. */
function weekStart(now = new Date()) {
  const dow = (now.getDay() + 6) % 7; // 0 = Mon
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
}

/** Sessions recorded against a prescription. */
function sessionsFor(pr) {
  return sessions.filter((s) => s.prescriptionId && String(s.prescriptionId) === String(pr._id));
}

const groupOf = (pr) => EXERCISES[pr.exerciseKey]?.group || "Other";
let activePlanGroup = "All";
let activeDashGroup = "All";

function renderGroupPills(container, items, activeGroup, onSelect) {
  if (!container) return "All";
  if (items.length <= 6) {
    container.hidden = true;
    container.innerHTML = "";
    return "All";
  }
  const groups = ["All", ...new Set(items.map(groupOf))];
  const current = groups.includes(activeGroup) ? activeGroup : "All";
  container.hidden = false;
  container.innerHTML = "";
  for (const g of groups) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `group-pill${g === current ? " active" : ""}`;
    btn.textContent = g === "All" ? `All (${items.length})` : g;
    btn.addEventListener("click", () => onSelect(g));
    container.appendChild(btn);
  }
  return current;
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
  const done = doneDays.size;
  const doneToday = doneDays.has(todayK);
  if (isUnlimited(pr)) {
    return {
      target: 0,
      done,
      doneDays,
      partialDays,
      doneToday,
      weekMet: true,
      outstanding: false,
      behind: false,
      unlimited: true,
    };
  }
  const target = pr.daysPerWeek ?? 3;
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
    unlimited: false,
  };
}

function statusLabel(wp) {
  if (wp.unlimited) {
    return { text: wp.doneToday ? "✓ Practised today" : "Unlimited", cls: wp.doneToday ? "done" : "demo" };
  }
  if (wp.doneToday) return { text: "✓ Done today", cls: "done" };
  if (wp.weekMet) return { text: "✓ Week target met", cls: "done" };
  const left = wp.target - wp.done;
  return { text: `To do · ${left} more day${left === 1 ? "" : "s"} this week`, cls: "todo" };
}

/** Outstanding prescriptions first, then ones already done today / for the week. */
function sortedPlan() {
  return [...plan].sort((a, b) => Number(!weekProgress(a).outstanding) - Number(!weekProgress(b).outstanding));
}

function renderPlanCards() {
  const el = $("plan");
  if (!el) return;
  if (!plan.length) {
    el.classList.remove("plan-strip");
    renderGroupPills($("plan-group-pills"), [], "All", () => {});
    el.innerHTML = `<div class="muted small">${user.role === "patient" ? "Nothing prescribed yet. Pick any exercise above." : "Signed in as a physio: pick any exercise above."}</div>`;
    return;
  }
  activePlanGroup = renderGroupPills($("plan-group-pills"), plan, activePlanGroup, (g) => {
    activePlanGroup = g;
    renderPlanCards();
  });
  const items = sortedPlan().filter((pr) => activePlanGroup === "All" || groupOf(pr) === activePlanGroup);
  el.classList.toggle("plan-strip", plan.length > 4);
  el.innerHTML = "";
  for (const pr of items) {
    const wp = weekProgress(pr);
    const st = statusLabel(wp);
    const card = document.createElement("div");
    card.className = `plan-card${!wp.unlimited && !wp.outstanding ? " done" : ""}${activePrescription?._id === pr._id ? " active" : ""}`;
    card.dataset.id = pr._id;
    if (wp.unlimited) {
      card.innerHTML = `
        <b class="plan-card-title" title="${esc(pr.exerciseName)}">${esc(pr.exerciseName)}</b>
        <div class="plan-card-meta">
          <span class="task-status ${st.cls}">${st.text}</span>
          <span class="muted small">${esc(groupOf(pr))}</span>
        </div>`;
    } else {
      const ov = pr.angleOverrides?.targetAngle ? ` · target ${pr.angleOverrides.targetAngle}°` : "";
      const rest = pr.sets > 1 ? ` · rest ${pr.restSeconds ?? DEFAULT_REST_S}s` : "";
      const phaseTag = pr.timelinePhase ? `<span class="timeline-tag">${esc(pr.timelinePhase)}</span>` : "";
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:start;gap:6px">
          <b>${esc(pr.exerciseName)}</b>
          <span class="timeline-badge">${wp.done}/${wp.target} this week</span>
        </div>
        ${phaseTag ? `<div style="margin:2px 0">${phaseTag}</div>` : ""}
        <span class="muted">${fmtVolume(pr)}${pr.holdSeconds ? ` · hold ${pr.holdSeconds}s` : ""}${rest} · ${(TEMPOS[pr.tempo] ?? TEMPOS[DEFAULT_TEMPO]).name} tempo${ov}</span>
        <span class="task-status ${st.cls}">${st.text}</span>
        ${pr.notes ? `<span class="note">“${esc(pr.notes)}”</span>` : ""}`;
    }
    card.addEventListener("click", () => applyPrescription(pr));
    el.appendChild(card);
  }
}

async function loadPlan() {
  const el = $("plan");
  try {
    if (user.role === "patient") {
      let me;
      [plan, sessions, me] = await Promise.all([
        Api.prescriptions(user._id),
        Api.sessions(user._id, 100).catch(() => []),
        Api.patient(user._id).catch(() => null),
      ]);
      coinBalance = me?.coins ?? null;
    } else {
      plan = [];
    }
  } catch (err) {
    el.innerHTML = `<div class="form-error">${err.message}</div>`;
    return;
  }
  renderDashboard();
  renderPerformance();
  loadMyVideos();
  renderWeeklyRx();
  renderPlanCards();
  if (!plan.length) {
    renderPatientTimeline([], sessions);
    return;
  }

  // Pre-select the first outstanding prescription if none is active yet (never mid-exercise)
  if (plan.length && !activePrescription && !running) {
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
    muscleDemo.setExercise(exerciseKey, exercise, firstPr.tempo, $("side")?.value === "L" ? "L" : "R");
    recorder.start(exerciseKey, firstPr);
    $("set-progress").hidden = false;
    $("sp-exercise").textContent = firstPr.exerciseName;
    $("sp-sets").textContent = isUnlimited(firstPr) ? "1" : firstPr.sets;
    $("sp-reps").textContent = isUnlimited(firstPr) ? "∞" : firstPr.reps;
    $("finish").hidden = false;
    for (const c of el.children) c.classList.toggle("active", c.dataset?.id === firstPr._id);
    setState = "ready";
    syncLock();
  }

  renderPatientTimeline(plan, sessions);
}

/** Open the Exercise page with a prescription loaded. */
function goExercise(pr) {
  location.hash = "#exercise";
  if (pr && (activePrescription?._id !== pr._id || setState === "done")) applyPrescription(pr);
}

/** Tell the patient why they can't switch right now. */
function warnLocked() {
  const name = activePrescription?.exerciseName ?? exercise?.name ?? "the current exercise";
  flashCue(`Finish or stop ${name} before switching exercise or game.`, "warn");
  cueTimer = performance.now() + 4000;
}

/** Keep the Start/Stop button and the switching controls in step with `running` / `setState`. */
function syncLock() {
  const locked = isLocked();
  exerciseSelect.disabled = locked;
  if (gameModeSelect) gameModeSelect.disabled = locked;
  document.body.classList.toggle("exercise-locked", locked);
  const btn = $("start");
  if (!btn || btn.dataset.busy) return;
  btn.classList.toggle("btn-stop", running);
  if (running) {
    btn.textContent = "■ Stop exercise";
  } else if (activePrescription && setState === "done") {
    const allSets = isUnlimited(activePrescription)
      ? recorder.reps.length > 0
      : recorder.setsCompleted >= (activePrescription.sets ?? 1);
    btn.textContent = allSets
      ? `✓ Complete · Do ${activePrescription.exerciseName} again`
      : `↻ Restart ${activePrescription.exerciseName}`;
  } else if (activePrescription) {
    btn.textContent = `▶ Start ${activePrescription.exerciseName}`;
  } else {
    btn.textContent = `▶ Start ${exercise?.name ?? "exercise"} (free play)`;
  }
  syncRecordButton();
}

// ---- Dashboard: performance score, metrics and coaching tips ----

/**
 * Scores for one saved session. New sessions carry `performance` + `game` from the server;
 * older ones get tempo accuracy / completion estimated from their summary averages.
 */
function sessionPerf(s) {
  const pr = plan.find((p) => String(p._id) === String(s.prescriptionId));
  const tempo = s.performance?.tempo ?? pr?.tempo ?? DEFAULT_TEMPO;
  const sum = s.summary ?? {};
  const tempoAccuracy = s.performance?.tempoAccuracy ?? (sum.repCount ? repTempoScore(sum.avgConcentricMs, sum.avgEccentricMs, tempo) : null);
  const target = pr && !isUnlimited(pr) && pr.reps ? pr.sets * pr.reps : null;
  const completion =
    s.performance?.completion ??
    (target ? Math.min(1, (sum.repCount ?? 0) / target) : s.setsPrescribed ? Math.min(1, (s.setsCompleted ?? 0) / s.setsPrescribed) : null);
  const g = s.game ?? null;
  return {
    s,
    tempo,
    tempoAccuracy,
    completion,
    tunnelPct: g?.tunnelPct ?? null,
    hits: g?.hits ?? null,
    coins: g?.coins ?? null,
    coinsOffered: g?.coinsOffered ?? null,
    score: s.performance?.score ?? null,
  };
}

/** Same weighting as the server: tempo 40%, completion 40%, tunnel 20% (over whichever exist). */
function overallScore(p) {
  if (p.score != null) return p.score;
  const parts = [[p.tempoAccuracy, 0.4], [p.completion, 0.4], [p.tunnelPct, 0.2]].filter(([v]) => v != null);
  const w = parts.reduce((a, [, x]) => a + x, 0);
  return w ? Math.round((parts.reduce((a, [v, x]) => a + v * x, 0) / w) * 100) : null;
}

const mean = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);

function setBar(id, v) {
  const el = $(id);
  if (!el) return;
  el.style.width = `${v == null ? 0 : Math.round(Math.min(1, v) * 100)}%`;
  el.className = v == null ? "" : v >= 0.85 ? "good" : v >= 0.6 ? "ok" : "low";
}

function renderPerformance() {
  if (!$("perf-score")) return;
  const mon = weekStart();
  const lastMon = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() - 7);
  const all = sessions.map(sessionPerf);
  const thisWeek = all.filter((p) => new Date(p.s.startedAt) >= mon);
  const lastWeek = all.filter((p) => new Date(p.s.startedAt) >= lastMon && new Date(p.s.startedAt) < mon);
  // Score this week's sessions; if there are none yet, fall back to the 5 most recent.
  const recent = thisWeek.length ? thisWeek : all.slice(0, 5);
  $("perf-period").textContent = thisWeek.length ? "this week" : recent.length ? "recent sessions" : "";

  const score = mean(recent.map(overallScore));
  const tempoAcc = mean(recent.map((p) => p.tempoAccuracy));
  const completion = mean(recent.map((p) => p.completion));
  const withGame = recent.filter((p) => p.tunnelPct != null);
  const tunnel = mean(withGame.map((p) => p.tunnelPct));
  const coinsWeek = thisWeek.reduce((n, p) => n + (p.coins ?? 0), 0);
  const coinsAll = coinBalance ?? all.reduce((n, p) => n + (p.coins ?? 0), 0);
  const coinsOffered = recent.reduce((n, p) => n + (p.coinsOffered ?? 0), 0);
  const coinRate = coinsOffered ? recent.reduce((n, p) => n + (p.coins ?? 0), 0) / coinsOffered : null;

  // Big score ring
  const ring = $("perf-ring");
  $("perf-score").textContent = score == null ? "—" : Math.round(score);
  ring.style.setProperty("--p", score == null ? 0 : Math.round(score));
  ring.className = `perf-ring ${score == null ? "" : score >= 85 ? "good" : score >= 60 ? "ok" : "low"}`;
  $("perf-grade").textContent =
    score == null ? "No sessions yet" : score >= 90 ? "Excellent! ⭐" : score >= 75 ? "Great work" : score >= 60 ? "Good effort" : "Keep practising";
  const lastScore = mean(lastWeek.map(overallScore));
  const trendEl = $("perf-trend");
  if (score != null && lastScore != null && thisWeek.length) {
    const d = Math.round(score - lastScore);
    trendEl.textContent = d > 0 ? `▲ ${d} vs last week` : d < 0 ? `▼ ${-d} vs last week` : "Same as last week";
    trendEl.className = d > 0 ? "small trend-up" : d < 0 ? "small trend-down" : "muted small";
  } else {
    trendEl.textContent = "";
  }

  // Metric tiles
  $("perf-tempo").textContent = pct(tempoAcc);
  setBar("perf-tempo-bar", tempoAcc);
  $("perf-tempo-sub").textContent = tempoAcc == null ? "no reps yet" : "match to prescribed speed";
  $("perf-completion").textContent = pct(completion);
  setBar("perf-completion-bar", completion);
  $("perf-completion-sub").textContent = completion == null ? "no prescribed sessions" : "of prescribed reps";
  $("perf-tunnel").textContent = pct(tunnel);
  setBar("perf-tunnel-bar", tunnel);
  $("perf-tunnel-sub").textContent = tunnel == null ? "play Cave Glider to track" : `${withGame.reduce((n, p) => n + (p.hits ?? 0), 0)} wall bumps`;
  $("perf-coins").textContent = coinsWeek;
  setBar("perf-coins-bar", coinRate);
  $("perf-coins-sub").textContent = coinRate == null ? `${coinsAll} all time` : `${pct(coinRate)} collected · ${coinsAll} all time`;

  renderCoachTips({ recent, tempoAcc, completion, tunnel, coinRate });
}

/** Short, specific tips from the recent sessions: tunnel control, tempo, completion, coins. */
function renderCoachTips({ recent, tempoAcc, completion, tunnel, coinRate }) {
  const ul = $("coach-tips");
  if (!ul) return;
  const tips = []; // [kind, text]  kind: warn | good | info
  if (!recent.length) {
    tips.push(["info", "Complete an exercise to start earning a performance score and coins."]);
  } else {
    // Tunnel: look at the latest Cave Glider session first, then the recent average.
    const lastGlide = recent.find((p) => p.tunnelPct != null);
    if (lastGlide && (lastGlide.tunnelPct < 0.8 || (lastGlide.hits ?? 0) >= 3)) {
      tips.push([
        "warn",
        `Your dino drifted outside the tunnel ${lastGlide.hits ?? 0} time${lastGlide.hits === 1 ? "" : "s"} last session ` +
          `(inside ${pct(lastGlide.tunnelPct)} of the time) on ${lastGlide.s.exerciseName}. ` +
          `Move more smoothly and try to follow the dashed line through the middle of the tunnel.`,
      ]);
    } else if (tunnel != null && tunnel >= 0.9) {
      tips.push(["good", `Great control: your dino stayed inside the tunnel ${pct(tunnel)} of the time.`]);
    }

    // Tempo: say which way they're off, using the most recent session's averages.
    const last = recent[0];
    const dir = tempoDirection(last.s.summary?.avgConcentricMs, last.s.summary?.avgEccentricMs, last.tempo);
    const t = tempoOf(last.tempo);
    const actualS = ((last.s.summary?.avgConcentricMs ?? 0) + (last.s.summary?.avgEccentricMs ?? 0)) / 1000;
    if (dir === "too fast") {
      tips.push(["warn", `Your ${last.s.exerciseName} reps were too quick (about ${actualS.toFixed(1)}s up and down vs ${t.up + t.down}s prescribed). Slow down and let the hills set your pace.`]);
    } else if (dir === "too slow") {
      tips.push(["warn", `Your ${last.s.exerciseName} reps were slower than prescribed (about ${actualS.toFixed(1)}s vs ${t.up + t.down}s). Try to keep up with the hills.`]);
    } else if (tempoAcc != null && tempoAcc >= 0.8) {
      tips.push(["good", `Your tempo is spot on (${pct(tempoAcc)} accurate). Keep it up!`]);
    }

    // Completion
    const short = recent.find((p) => p.completion != null && p.completion < 1);
    if (short) {
      tips.push(["warn", `You finished ${pct(short.completion)} of your reps on ${short.s.exerciseName}. Try to complete every set, as finishing them is what builds strength.`]);
    } else if (completion != null && completion >= 1) {
      tips.push(["good", "You've completed every prescribed rep. Brilliant consistency!"]);
    }

    // Coins
    if (coinRate != null && coinRate < 0.5) {
      tips.push(["info", `You collected ${pct(coinRate)} of the coins. Coins sit along the hill shape, so a full, steady range of motion picks them up.`]);
    }
    if (!tips.length) tips.push(["good", "Solid sessions. Keep going to push your score higher!"]);
  }
  const icon = { warn: "⚠", good: "★", info: "💡" };
  ul.innerHTML = tips.map(([k, text]) => `<li class="tip ${k}"><span class="tip-icon">${icon[k]}</span><span>${esc(text)}</span></li>`).join("");
}

// ---- Dashboard: today's tasks + headline numbers ----
function renderDashTasks() {
  const ul = $("dash-tasks");
  if (!ul) return;
  ul.innerHTML = "";
  if (!plan.length) {
    renderGroupPills($("dash-group-pills"), [], "All", () => {});
    ul.classList.remove("compact");
    ul.innerHTML = `<li class="muted small">${user.role === "patient" ? "Nothing prescribed yet. You can still try exercises on the Exercise page." : "Signed in as a physio."}</li>`;
    return;
  }
  activeDashGroup = renderGroupPills($("dash-group-pills"), plan, activeDashGroup, (g) => {
    activeDashGroup = g;
    renderDashTasks();
  });
  ul.classList.toggle("compact", plan.length > 4);
  const items = sortedPlan().filter((pr) => activeDashGroup === "All" || groupOf(pr) === activeDashGroup);
  for (const pr of items) {
    const wp = weekProgress(pr);
    const st = statusLabel(wp);
    const li = document.createElement("li");
    li.className = `task-row${!wp.unlimited && !wp.outstanding ? " done" : ""}`;
    const tempoName = (TEMPOS[pr.tempo] ?? TEMPOS[DEFAULT_TEMPO]).name;
    const sub = wp.unlimited
      ? `${esc(groupOf(pr))} · Unlimited reps · ${tempoName} tempo`
      : `${fmtVolume(pr)} · ${tempoName} tempo · ${wp.done}/${wp.target} days this week`;
    const isAction = wp.unlimited || wp.outstanding;
    li.innerHTML = `
      <div class="task-check">${wp.unlimited ? (wp.doneToday ? "✓" : "•") : wp.outstanding ? "○" : "✓"}</div>
      <div class="task-body">
        <b>${esc(pr.exerciseName)}</b>
        <div class="muted small">${sub}</div>
        ${wp.unlimited && !wp.doneToday ? "" : `<span class="task-status ${st.cls}">${st.text}</span>`}
      </div>
      <button class="${isAction ? "btn-start" : ""}">${isAction ? "Start" : "Do again"}</button>`;
    li.querySelector("button").addEventListener("click", () => goExercise(pr));
    ul.appendChild(li);
  }
}

function renderDashboard() {
  const now = new Date();
  const hour = now.getHours();
  const first = String(user.name ?? "").split(" ")[0];
  $("dash-greeting").textContent = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${first ? `, ${first}` : ""}`;
  $("dash-date").textContent = now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  const wps = plan.map((pr) => weekProgress(pr));
  const allUnlimited = plan.length > 0 && plan.every(isUnlimited);
  const dueToday = wps.filter((wp) => wp.outstanding).length;
  const doneToday = wps.filter((wp) => wp.doneToday).length;
  const finiteWps = wps.filter((wp) => !wp.unlimited);
  const weekDone = finiteWps.reduce((n, wp) => n + Math.min(wp.done, wp.target), 0);
  const weekTarget = finiteWps.reduce((n, wp) => n + wp.target, 0);
  const totalReps = sessions.reduce((n, s) => n + (s.summary?.repCount ?? 0), 0);

  if (allUnlimited) {
    $("dash-today").textContent = "Demo mode";
    $("dash-today-sub").textContent = doneToday ? `${doneToday} practised today` : "pick any exercise below";
    $("dash-week").textContent = `${plan.length} exercises`;
    $("dash-week-sub").textContent = "unlimited reps enabled";
  } else {
    $("dash-today").textContent = plan.length ? (dueToday ? `${dueToday} to do` : "All done ✓") : "—";
    $("dash-today-sub").textContent = plan.length ? `${doneToday} completed today` : "nothing prescribed";
    $("dash-week").textContent = weekTarget ? `${Math.round((weekDone / weekTarget) * 100)}%` : "—";
    $("dash-week-sub").textContent = weekTarget ? `${weekDone} of ${weekTarget} exercise days` : "";
  }
  $("dash-reps").textContent = totalReps;

  renderDashTasks();
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
  const allUnlimited = plan.every(isUnlimited);
  const rows = allUnlimited ? plan.filter((pr) => weekProgress(pr).done > 0) : plan;
  if (allUnlimited && !rows.length) {
    el.innerHTML = `<div class="muted small">Demo mode: all ${plan.length} exercises have unlimited reps. Completed exercises appear here this week.</div>`;
    return;
  }
  if (allUnlimited) {
    const note = document.createElement("div");
    note.className = "muted small";
    note.textContent = `Demo mode: showing ${rows.length} of ${plan.length} exercises practised this week (unlimited reps).`;
    el.appendChild(note);
  }
  for (const pr of rows) {
    const wp = weekProgress(pr);
    const pct = wp.unlimited ? Math.min(100, wp.done * 20) : Math.min(100, Math.round((wp.done / Math.max(1, wp.target)) * 100));
    const dots = dayNames
      .map((n, i) => {
        const k = dateKey(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
        const cls = wp.doneDays.has(k) ? "done" : wp.partialDays.has(k) ? "partial" : k === todayK ? "today" : "";
        return `<span class="rx-dot ${cls}" title="${k}">${n}</span>`;
      })
      .join("");
    const rightText = wp.unlimited
      ? `${wp.done} day${wp.done === 1 ? "" : "s"} this week · unlimited`
      : `${wp.done} of ${wp.target} days${wp.weekMet ? " ✓" : wp.behind ? " · behind" : ""}`;
    const rightCls = wp.unlimited ? "muted small" : wp.weekMet ? "rx-met" : wp.behind ? "rx-behind" : "muted small";
    const row = document.createElement("div");
    row.className = "rx-row";
    row.innerHTML = `
      <div class="rx-head">
        <b>${esc(pr.exerciseName)}</b>
        <span class="${rightCls}">${rightText}</span>
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

  const allUnlimited = planList.length > 0 && planList.every(isUnlimited);
  const targetFreq = planList.length ? Math.max(...planList.map((p) => p.daysPerWeek || 3)) : 3;
  const weekSummaryEl = $("week-summary");
  if (weekSummaryEl) {
    weekSummaryEl.textContent = allUnlimited
      ? `${daysCompletedThisWeek} active ${daysCompletedThisWeek === 1 ? "day" : "days"} this week · Demo mode (unlimited)`
      : `${daysCompletedThisWeek} of ${targetFreq} target days this week (${Math.min(100, Math.round((daysCompletedThisWeek / targetFreq) * 100))}%)`;
  }

  // 3. Programme Timeline of Prescribed Exercises
  const timelineGrid = $("timeline-cards-grid");
  if (timelineGrid) {
    if (!planList.length) {
      timelineGrid.innerHTML = `<div class="muted small">No active prescribed programme yet.</div>`;
    } else {
      timelineGrid.innerHTML = "";
      for (const pr of planList) {
        const unlimited = isUnlimited(pr);
        const weeks = pr.durationWeeks ?? 4;
        const freq = pr.daysPerWeek ?? 3;
        const phase = pr.timelinePhase || (unlimited ? "Open Demo" : "Active Phase");
        const start = pr.startDate ? new Date(pr.startDate) : new Date(pr.createdAt || Date.now());
        const end = pr.endDate ? new Date(pr.endDate) : new Date(start.getTime() + weeks * 7 * 86400e3);
        const msSinceStart = Date.now() - start.getTime();
        const activeWeek = Math.min(weeks, Math.max(1, Math.ceil(msSinceStart / (7 * 86400e3))));

        // Unique days completed for this exercise
        const exSessions = sessionsList.filter((s) => s.exerciseKey === pr.exerciseKey);
        const daysDoneForEx = new Set(exSessions.map((s) => dateKey(new Date(s.startedAt)))).size;
        const totalTargetDays = weeks * freq;
        const progressPct = unlimited
          ? Math.min(100, daysDoneForEx * 20)
          : Math.min(100, Math.round((daysDoneForEx / Math.max(1, totalTargetDays)) * 100));

        const item = document.createElement("div");
        item.className = "timeline-item";
        item.title = "Click to start this exercise";
        item.innerHTML = unlimited
          ? `
          <div class="timeline-item-head">
            <div>
              <b style="font-size:14px">${esc(pr.exerciseName)}</b>
              <div style="display:flex;gap:6px;align-items:center;margin-top:3px;flex-wrap:wrap">
                <span class="timeline-tag">${esc(groupOf(pr))}</span>
              </div>
            </div>
            <span class="muted small" style="text-align:right">
              ${daysDoneForEx} day${daysDoneForEx === 1 ? "" : "s"} logged<br>
              <b style="color:var(--accent)">Anytime</b>
            </span>
          </div>
          <div class="timeline-bar-wrap">
            <div class="timeline-bar-fill" style="width: ${progressPct}%"></div>
          </div>
          <div class="muted small" style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;font-size:11px">
            <span>Unlimited reps</span>
            <span>Demo</span>
          </div>`
          : `
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
            <span>${fmtVolume(pr)} · ${freq} days/wk</span>
            <span>Ends ${end.toLocaleDateString([], { day: "numeric", month: "short" })}</span>
          </div>`;
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
  if (!isLocked()) recArmed = null;
  if (isLocked()) {
    if (pr._id !== activePrescription?._id) warnLocked();
    return;
  }
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
  muscleDemo.setExercise(exerciseKey, exercise, pr.tempo, $("side")?.value === "L" ? "L" : "R");
  if (!running) muscleDemo.setCollapsed(false);
  recorder.start(exerciseKey, pr);
  $("set-progress").hidden = false;
  $("sp-exercise").textContent = pr.exerciseName;
  $("sp-sets").textContent = isUnlimited(pr) ? "1" : pr.sets;
  $("sp-reps").textContent = isUnlimited(pr) ? "∞" : pr.reps;
  $("finish").hidden = false;

  // Loading an exercise never starts it: the patient presses Start when they're ready.
  setState = "ready";
  game.pause("waiting");
  updateSetProgress();
  setStatus(`Selected: ${pr.exerciseName}. Press Start when you're ready.`);
  syncLock();
}

function updateSetProgress() {
  if (!activePrescription) return;
  const pr = activePrescription;
  const unlimited = isUnlimited(pr);
  const done = setState === "done" && (unlimited ? recorder.reps.length > 0 : recorder.setsCompleted >= pr.sets); // finished every set
  const stopped = setState === "done" && !done; // stopped early
  const inSet = unlimited
    ? recorder.reps.length
    : done ? pr.reps : Math.min(pr.reps, Math.max(0, recorder.repsInCurrentSet(pr.reps)));
  $("sp-set").textContent = unlimited ? "1" : done ? pr.sets : Math.min(pr.sets, recorder.setsCompleted + 1);
  $("sp-rep").textContent = inSet;
  $("sp-state").textContent =
    setState === "resting" ? "Resting" : done ? "Complete ✓" : stopped ? "Stopped" : setState === "ready" ? "Ready" : "Go";
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
  flashCue(
    isUnlimited(pr)
      ? "Unlimited reps · Go! Press Finish & save whenever you're done."
      : `Set ${recorder.setsCompleted + 1} of ${pr.sets}: ${pr.reps} reps. Go!`,
    "good"
  );
  cueTimer = performance.now() + 2500;
  // Patient consented to record "the next set": it starts now.
  if (recArmed && running) {
    const c = recArmed;
    recArmed = null;
    beginRecording(c);
  }
  syncLock();
  syncRecordButton();
}

/** Called after each counted rep while a prescription is being worked: handles set boundaries. */
function onPrescribedRep(tempo = "") {
  const pr = activePrescription;
  if (isUnlimited(pr)) {
    if (tempo) flashCue(`Rep ${recorder.reps.length} · ${tempo}`, "good");
    updateSetProgress();
    return;
  }
  const inSet = recorder.repsInCurrentSet(pr.reps);
  if (inSet >= pr.reps) {
    recorder.completeSet();
    if (formRec.recording) finishRecording(); // the recorded set is done: preview, then send or discard
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
// ---- Form-review recording (consent first; nothing is sent until the patient presses Send) ----
// var (not const): syncLock() may run before this line during start-up.
var formRec = new FormRecorder({ video, overlay, badgeHost: video.parentElement });
var recArmed = null; // consent given for "the next set"; recording starts when that set starts

const currentSetNumber = () => (isUnlimited(activePrescription) ? 1 : Math.min(activePrescription?.sets ?? 1, recorder.setsCompleted + 1));

function syncRecordButton() {
  const btn = $("record-set");
  if (!btn || !formRec) return;
  const can = user.role === "patient" && !!activePrescription && recordingSupported() && setState !== "done";
  btn.hidden = !can && !formRec.recording;
  btn.classList.toggle("recording", formRec.recording);
  btn.textContent = formRec.recording
    ? "■ Stop recording"
    : recArmed
    ? "🎥 Records next set · cancel"
    : "🎥 Record set for physio";
}

function beginRecording(c) {
  const pr = activePrescription;
  formRec.start({
    mode: c.mode,
    meta: {
      prescriptionId: pr?._id ?? null,
      exerciseKey: pr?.exerciseKey ?? exerciseKey,
      exerciseName: pr?.exerciseName ?? exercise.name,
      setNumber: currentSetNumber(),
      consent: c.consent,
    },
    onAutoStop: () => {
      flashCue("Recording reached the 90 second limit.", "warn");
      finishRecording();
    },
  });
  if (loop?.paused) formRec.pause();
  flashCue("● Recording this set for your physio", "good");
  cueTimer = performance.now() + 2500;
  syncRecordButton();
}

/** Stop recording, then let the patient preview and choose Send or Discard. */
async function finishRecording() {
  const clip = await formRec.stop();
  syncRecordButton();
  if (!clip) return;
  const result = await previewAndSend(clip);
  flashCue(result === "sent" ? "Video sent to your physio ✓" : "Recording discarded. Nothing was sent.", result === "sent" ? "good" : "warn");
  cueTimer = performance.now() + 4000;
  if (result === "sent") loadMyVideos();
}

$("record-set")?.addEventListener("click", async () => {
  if (formRec.recording) return finishRecording();
  if (recArmed) {
    recArmed = null;
    flashCue("Recording cancelled.", "warn");
    return syncRecordButton();
  }
  const c = await askConsent({ exerciseName: activePrescription?.exerciseName ?? exercise.name, setNumber: currentSetNumber() });
  if (!c) return; // no consent: nothing is recorded
  if (running && setState === "working") {
    beginRecording(c);
  } else {
    recArmed = c;
    flashCue(setState === "resting" ? "Recording will start with your next set." : "Recording will start when you press Start.", "good");
    cueTimer = performance.now() + 3500;
    syncRecordButton();
  }
});

/** Progress page: the patient's sent videos, review status and physio feedback. */
async function loadMyVideos() {
  const ul = $("my-videos");
  if (!ul) return;
  if (user.role !== "patient") return ($("form-reviews-card").hidden = true);
  let list = [];
  try {
    list = await Api.videos(user._id);
  } catch (err) {
    ul.innerHTML = `<li class="muted small">Couldn't load videos: ${esc(err.message)}</li>`;
    return;
  }
  if (!list.length) {
    ul.innerHTML = `<li class="muted small">No videos yet. On the Exercise page, press <b>🎥 Record set for physio</b> during a prescribed exercise to send one for a form check.</li>`;
    return;
  }
  ul.innerHTML = "";
  for (const v of list) {
    const li = document.createElement("li");
    li.className = "video-row";
    const when = new Date(v.createdAt).toLocaleDateString([], { day: "numeric", month: "short" });
    const daysLeft = Math.max(0, Math.ceil((new Date(v.expiresAt) - Date.now()) / 86400e3));
    li.innerHTML = `
      <div class="video-row-head">
        <div><b>${esc(v.exerciseName)}</b> · set ${v.setNumber} <span class="muted small">${when} · ${Math.round(v.durationMs / 1000)}s · ${v.mode === "skeleton" ? "skeleton only" : "camera"} · deletes in ${daysLeft}d</span></div>
        <span class="video-status ${v.status}">${v.status === "reviewed" ? "✓ Reviewed" : "Awaiting review"}</span>
      </div>
      ${v.feedback ? `<div class="video-feedback"><b>Physio feedback:</b> ${esc(v.feedback)}</div>` : ""}
      <div class="video-actions">
        <button class="small-btn" data-play>▶ Watch</button>
        <button class="small-btn" data-del>Delete</button>
      </div>`;
    li.querySelector("[data-play]").addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Loading…";
      try {
        const url = await loadVideoUrl(v);
        const el = document.createElement("video");
        el.className = "video-player";
        el.src = url;
        el.controls = true;
        el.playsInline = true;
        li.appendChild(el);
        el.play().catch(() => {});
        e.target.remove();
      } catch (err) {
        e.target.disabled = false;
        e.target.textContent = `Retry (${err.message})`;
      }
    });
    li.querySelector("[data-del]").addEventListener("click", async () => {
      if (!confirm("Delete this video? Your physio will no longer be able to see it.")) return;
      await Api.deleteVideo(v._id).catch((err) => alert(err.message));
      loadMyVideos();
    });
    ul.appendChild(li);
  }
}

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
  running = false;
  game.pause("done");
  stopRestTimer();
  updateSetProgress();
  $("finish").hidden = true;
  syncLock();
  setStatus(`${pr.exerciseName} complete ✓ · choose your next exercise`);
  flashCue(`All ${pr.sets} sets complete! Sending to your physio…`, "good");
  cueTimer = performance.now() + 8000;
  const saved = await finishSession(true);
  if (saved) {
    const perf = saved.performance;
    const extra = perf ? ` · Score ${perf.score} · tempo ${Math.round(perf.tempoAccuracy * 100)}%${saved.game ? ` · 🪙 ${saved.game.coins}` : ""}` : "";
    flashCue(`All ${pr.sets} sets complete · sent to your physio ✓  (${saved.summary.repCount} reps, avg ROM ${Math.round(saved.summary.avgRom * 100)}%${extra})`, "good");
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
    saved = await recorder.save({ game: game.getStats() });
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

/**
 * Stop the running exercise (Stop button / Finish & save). Saves whatever reps were done;
 * a prescription stopped before all sets asks first, since it's logged as incomplete.
 * Afterwards the exercise and game can be changed again.
 */
async function stopExercise() {
  if (activePrescription && setState !== "done" && !isUnlimited(activePrescription)) {
    const setsPrescribed = activePrescription.sets ?? null;
    const setsCompleted = recorder.setsCompleted ?? 0;
    if (recorder.reps.length && setsPrescribed != null && setsCompleted < setsPrescribed) {
      const confirmed = window.confirm(
        `You have only completed ${setsCompleted} of ${setsPrescribed} set${setsPrescribed === 1 ? "" : "s"}.\n` +
          `This session will be marked as INCOMPLETE in your timeline.\n\nStop and save anyway?`
      );
      if (!confirmed) return;
    }
  }
  running = false;
  if (loop?.paused) setPaused(false);
  stopRestTimer();
  recArmed = null;
  if (formRec.recording) finishRecording(); // offer the partial set for preview / send / discard
  const hadReps = recorder.reps.length > 0;
  if (hadReps) await finishSession(false);
  if (activePrescription) {
    if (hadReps) {
      setState = "done";
      game.pause("done");
    } else {
      // Nothing recorded: just go back to "ready" for the same prescription.
      setState = "ready";
      recorder.start(activePrescription.exerciseKey, activePrescription);
      $("finish").hidden = false;
      game.pause("waiting");
      flashCue("Stopped. No reps were recorded.", "warn");
    }
    updateSetProgress();
  } else {
    setState = "free";
    recorder.start(exerciseKey, null);
    game.pause("waiting");
    if (!hadReps) flashCue("Stopped.", "warn");
  }
  document.body.classList.remove("resting");
  setStatus("Stopped · you can now change exercise or game");
  syncLock();
}

$("finish").addEventListener("click", () => {
  if (running) return stopExercise();
  if (!activePrescription) return finishSession();
  flashCue("Press Start to begin this exercise.", "warn");
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
    muscleDemo.setExercise(exerciseKey, exercise, DEFAULT_TEMPO, $("side")?.value === "L" ? "L" : "R");
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
  if (isLocked()) {
    gameModeSelect.value = game.mode;
    return warnLocked();
  }
  game.setMode(gameModeSelect.value);
  syncModeConstraints(game.mode);
  syncGameHelp(game.mode);
});

let lastCue = null;
let cueTimer = 0;

// ---- Events out of the pipeline -> UI + game ----
counter.addEventListener("rep", (e) => {
  // Reps only count once Start is pressed, while working a set or in free play.
  // Before starting, during rest and after completion they're ignored.
  if (!running || setState === "resting" || setState === "done" || setState === "ready") return;
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
    if (running) {
      startSet(); // restart the same exercise from set 1
    } else {
      setState = "ready";
      game.pause("waiting");
      updateSetProgress();
    }
  } else {
    setState = "free";
    recorder.start(exerciseKey, null);
    if (running) game.resume();
    else game.pause("waiting");
  }
  syncLock();
}

exerciseSelect.addEventListener("change", async () => {
  if (isLocked()) {
    exerciseSelect.value = exerciseKey;
    return warnLocked();
  }
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
  muscleDemo.setExercise(exerciseKey, exercise, DEFAULT_TEMPO, $("side")?.value === "L" ? "L" : "R");
  if (!running) muscleDemo.setCollapsed(false);
  recorder.start(exerciseKey, null); // free play is still recorded
  game.pause("waiting"); // starts when the patient presses Start
  setStatus(`Free play: ${exercise.name}. Press Start when you're ready.`);
  syncLock();
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
  muscleDemo.setSide($("side")?.value === "L" ? "L" : "R");
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
    formRec.pause(); // recording pauses too (also when the patient leaves the Exercise tab)
    drawPausedVideoOverlay();
    setStatus("Paused");
    $("pause").textContent = "Resume";
  } else {
    smoother.reset();
    formRec.resume();
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
    } else if (!running || setState === "ready") {
      game.pause("waiting");
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

// ---- Camera selection & hot-swap ----
const CAM_STORAGE_KEY = "physio.cameraId";
const cameraSelect = $("camera-select");

async function populateCameraSelect(activeStream = null) {
  if (!cameraSelect) return;
  const devices = await listCameras();
  const savedId = localStorage.getItem(CAM_STORAGE_KEY) || "";
  const activeId = activeStream?.getVideoTracks?.()?.[0]?.getSettings?.()?.deviceId || "";
  const currentVal = activeId || savedId || cameraSelect.value || "";

  cameraSelect.innerHTML = "";
  const autoOpt = document.createElement("option");
  autoOpt.value = "";
  autoOpt.textContent = "Built-in webcam (Auto)";
  cameraSelect.appendChild(autoOpt);

  devices.forEach((d, idx) => {
    if (!d.deviceId) return;
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    const raw = d.label || `Camera ${idx + 1}`;
    opt.textContent = VIRTUAL_CAM_RE.test(raw) ? `${raw} (Virtual)` : raw;
    cameraSelect.appendChild(opt);
  });

  if (currentVal && [...cameraSelect.options].some((o) => o.value === currentVal)) {
    cameraSelect.value = currentVal;
  } else {
    cameraSelect.value = "";
  }
}

if (cameraSelect) {
  populateCameraSelect().catch(() => {});
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    populateCameraSelect(video.srcObject).catch(() => {});
  });
  cameraSelect.addEventListener("change", async () => {
    const id = cameraSelect.value || "";
    if (id) localStorage.setItem(CAM_STORAGE_KEY, id);
    else localStorage.removeItem(CAM_STORAGE_KEY);
    if (video.srcObject) {
      try {
        setStatus("Switching camera…");
        const stream = await startCamera(video, id || null);
        await populateCameraSelect(stream);
        setStatus(running ? "Exercise active · camera switched" : "Camera ready.");
      } catch (err) {
        setStatus(`Error: ${err.message}`, "error");
        flashCue(err.message, "warn");
      }
    }
  });
}

// ---- Start Exercise & Camera ----
function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

async function startExercise() {
  const btn = $("start");
  if (btn.dataset.busy) return;
  if (running) return stopExercise();
  // Finished prescription: "Do again" reloads it fresh (new recording, set 1).
  if (activePrescription && setState === "done") await applyPrescription(activePrescription);
  btn.disabled = true;
  btn.dataset.busy = "1";
  btn.textContent = "Starting camera…";
  try {
    if (!loop) {
      setStatus("Starting camera… (allow camera access in browser prompt)");
      const chosenCam = cameraSelect?.value || localStorage.getItem(CAM_STORAGE_KEY) || null;
      const stream = await startCamera(video, chosenCam);
      await populateCameraSelect(stream);
      const { landmarker, mp } = await createPoseTracker({ onStatus: setStatus });
      drawer = new mp.DrawingUtils(octx);
      connections = mp.PoseLandmarker.POSE_CONNECTIONS;
      loop = runDetectionLoop(landmarker, video, onFrame);
      $("pause").disabled = false;
    } else if (loop.paused) {
      setPaused(false);
    }
    delete btn.dataset.busy;
    btn.disabled = false;
    running = true;
    muscleDemo.setCollapsed(true);
    game.resetStats(); // coins / tunnel accuracy are tallied per run

    // Start exercise and game now that camera has started
    if (activePrescription) {
      startSet();
    } else {
      setState = "free";
      if (!recorder.active || recorder.saved) recorder.start(exerciseKey, null);
      game.resume();
      flashCue("Camera active! Do your reps in front of the screen.", "good");
    }
    setStatus("Exercise active · follow the movement on screen");
    syncLock();
  } catch (err) {
    console.error(err);
    delete btn.dataset.busy;
    running = false;
    setStatus(`Error: ${err.message}`, "error");
    flashCue(err.message, "warn");
    cueTimer = performance.now() + 15000;
    btn.disabled = false;
    syncLock();
    btn.textContent = "Retry start";
  }
}

$("start").addEventListener("click", startExercise);

// Module is loaded: enable the Start exercise button.
$("start").disabled = false;
syncLock();
setStatus("Ready. Choose an exercise or click Start exercise.");
loadMediaPipe(() => {}).catch(() => {});

document.addEventListener("click", (e) => {
  const more = document.querySelector(".toolbar-more[open]");
  if (more && !more.contains(e.target)) more.open = false;
});

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
