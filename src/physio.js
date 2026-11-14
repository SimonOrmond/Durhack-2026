// Physio dashboard: pick a patient, send prescriptions, analyse their sessions.
import { Api, requireUser, logout } from "./api.js";
import { lineChart, barChart, stackedBars, empty, SERIES } from "./charts.js";
import { TEMPOS, DEFAULT_TEMPO, tempoSummary } from "./game.js";

const user = requireUser("physio");
if (!user) await new Promise(() => {}); // halt this module while the browser navigates to login

const $ = (id) => document.getElementById(id);
$("user-chip").textContent = user.name;
$("logout").addEventListener("click", logout);

// Rep tempo: show the patient-facing timing (matches the speed the cave hills arrive at)
const syncTempoHint = () => { $("p-tempo-hint").textContent = tempoSummary($("p-tempo").value); };
$("p-tempo").addEventListener("change", syncTempoHint);
syncTempoHint();

let exercises = [];
let patients = [];
let selected = null;
let sessionsCache = [];
let progressCache = [];
let selectedSessionId = null;
let selectedSessionDoc = null;
let metric = "avgRom";

// ---- formatting ----------------------------------------------------------------
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const secs = (msv) => (msv == null ? "—" : `${(msv / 1000).toFixed(1)}s`);
const deg = (v) => (v == null ? "—" : `${Math.round(v)}°`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (d) => {
  const x = new Date(d);
  return `${x.toLocaleDateString([], { day: "numeric", month: "short" })} ${x.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};

// ---- exercise catalogue -> grouped <select> --------------------------------
async function loadExercises() {
  exercises = await Api.exercises();
  const sel = $("p-exercise");
  const groups = new Map();
  for (const ex of exercises) {
    if (!groups.has(ex.group)) {
      const og = document.createElement("optgroup");
      og.label = ex.group;
      groups.set(ex.group, og);
      sel.appendChild(og);
    }
    const opt = document.createElement("option");
    opt.value = ex.key;
    opt.textContent = ex.name;
    groups.get(ex.group).appendChild(opt);
  }
  sel.addEventListener("change", fillAngleDefaults);
  fillAngleDefaults();
}
// Track the currently selected exercise's default angles so we can reconstruct targetAngle from range
let _exRestAngle = 0;
let _exTargetAngle = 0;

function fillAngleDefaults() {
  const ex = exercises.find((e) => e.key === $("p-exercise").value);
  if (!ex) return;
  _exRestAngle = ex.restAngle;
  _exTargetAngle = ex.targetAngle;

  // Show fixed rest angle
  $("p-rest-display").textContent = `${ex.restAngle}°`;

  // Default range = abs difference between rest and target
  const defaultRange = Math.abs(ex.targetAngle - ex.restAngle);
  $("p-range").value = defaultRange;
  $("p-range").max = Math.min(180, defaultRange + 30); // soft cap slightly above default

  // Update the computed target display
  updateTargetDisplay();

  $("p-defaults").textContent =
    `Exercise default: rest ${ex.restAngle}°, target ${ex.targetAngle}° (${defaultRange}° range). ` +
    `Reduce the range for a patient with limited movement; increase it as they improve.`;

  // Auto-suggest timeline duration and phase based on stage metadata
  if (ex.name.includes("Stage 1")) {
    $("p-weeks").value = 2;
    $("p-phase").value = "Stage 1 (Weeks 0–2: Max Protection)";
  } else if (ex.name.includes("Stage 2")) {
    $("p-weeks").value = 4;
    $("p-phase").value = "Stage 2 (Weeks 3–6: AAROM)";
  } else if (ex.name.includes("Stage 3")) {
    $("p-weeks").value = 6;
    $("p-phase").value = "Stage 3 (Weeks 6–12: Active & Strengthening)";
  } else {
    $("p-weeks").value = 4;
    $("p-phase").value = `${ex.group || "Rehab"} Phase (4 weeks)`;
  }
}

/** Recompute and display the resulting target angle whenever the range input changes. */
function updateTargetDisplay() {
  const range = Number($("p-range").value);
  if (!Number.isFinite(range) || range <= 0) {
    $("p-target-display").textContent = "—°";
    return;
  }
  // Direction: does the exercise angle go up or down from rest to target?
  const direction = Math.sign(_exTargetAngle - _exRestAngle) || 1;
  const computed = Math.round(_exRestAngle + direction * range);
  const clamped = Math.max(0, Math.min(180, computed));
  $("p-target-display").textContent = `${clamped}°`;
}

$("p-range").addEventListener("input", updateTargetDisplay);

// ---- patients ---------------------------------------------------------------
async function loadPatients() {
  patients = await Api.patients(user._id);
  const ul = $("patient-list");
  ul.innerHTML = "";
  if (!patients.length) ul.innerHTML = `<li class="muted">No patients assigned. Run <code>npm run seed</code>.</li>`;
  for (const p of patients) {
    const li = document.createElement("li");
    li.innerHTML = `<b>${esc(p.name)}</b><span class="muted">${esc(p.condition ?? "")}</span>`;
    li.addEventListener("click", () => selectPatient(p));
    li.dataset.id = p._id;
    ul.appendChild(li);
  }
}

async function selectPatient(p) {
  selected = p;
  selectedSessionId = null;
  for (const li of $("patient-list").children) li.classList.toggle("active", li.dataset.id === p._id);
  $("patient-detail").hidden = false;
  $("patient-name").textContent = p.name;
  $("patient-condition").textContent = p.condition ?? "";
  $("p-status").textContent = "";
  $("session-detail").hidden = true;
  await Promise.all([loadPrescriptions(), loadAnalysis()]);
}

// ---- prescriptions & timeline ----------------------------------------------
async function loadPrescriptions() {
  const list = await Api.prescriptions(selected._id);
  const ul = $("prescription-list");
  ul.innerHTML = list.length ? "" : `<li class="muted">Nothing prescribed yet.</li>`;
  for (const pr of list) {
    const li = document.createElement("li");
    const d = (v) => (v == null ? "default" : `${v}°`);
    const ov = pr.angleOverrides
      ? (() => {
          const rest = pr.angleOverrides.restAngle;
          const target = pr.angleOverrides.targetAngle;
          if (rest != null && target != null) {
            const range = Math.abs(target - rest);
            return ` · range ${range}° (rest ${rest}° → target ${target}°)`;
          }
          return ` · target ${d(target)}`;
        })()
      : "";
    const weeks = pr.durationWeeks ?? 4;
    const freq = pr.daysPerWeek ?? 3;
    const phase = pr.timelinePhase ? `<span class="timeline-tag">${esc(pr.timelinePhase)}</span>` : "";

    const start = pr.startDate ? new Date(pr.startDate) : new Date(pr.createdAt || Date.now());
    const end = pr.endDate ? new Date(pr.endDate) : new Date(start.getTime() + weeks * 7 * 86400e3);
    const msSinceStart = Date.now() - start.getTime();
    const currentWeek = Math.min(weeks, Math.max(1, Math.ceil(msSinceStart / (7 * 86400e3))));
    const dateRangeStr = `${start.toLocaleDateString([], { day: "numeric", month: "short" })} – ${end.toLocaleDateString([], { day: "numeric", month: "short" })}`;

    li.innerHTML = `
      <div style="flex: 1">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <b>${esc(pr.exerciseName)}</b>
          ${phase}
          <span class="timeline-badge">Week ${currentWeek} of ${weeks} · ${freq}d/wk</span>
        </div>
        <div class="muted" style="margin-top:2px">
          ${pr.sets} sets × ${pr.reps} reps${pr.holdSeconds ? ` · hold ${pr.holdSeconds}s` : ""}${pr.sets > 1 ? ` · rest ${pr.restSeconds ?? 60}s` : ""} · ${(TEMPOS[pr.tempo] ?? TEMPOS[DEFAULT_TEMPO]).name} tempo${ov}
        </div>
        <div class="muted small" style="margin-top:3px;font-size:11px">
          📅 Timeline: ${dateRangeStr} (${weeks} weeks total)
        </div>
        ${pr.notes ? `<div class="note">“${esc(pr.notes)}”</div>` : ""}
      </div>
      <div class="pr-actions">
        <button class="small-btn" data-edit>Edit</button>
        <button class="small-btn" data-stop="${pr._id}">Stop</button>
      </div>`;
    li.querySelector("[data-stop]").addEventListener("click", async (e) => {
      e.target.disabled = true;
      await Api.stopPrescription(pr._id);
      loadPrescriptions();
    });
    li.querySelector("[data-edit]").addEventListener("click", () => openEditForm(li, pr));
    ul.appendChild(li);
  }
}

/** Inline editor for an active prescription. Exercise name/type is fixed; everything else is editable. */
function openEditForm(li, pr) {
  if (li.querySelector(".pr-edit")) return;
  const ex = exercises.find((e) => e.key === pr.exerciseKey);
  const restAngle = pr.angleOverrides?.restAngle ?? ex?.restAngle ?? 0;
  const targetAngle = pr.angleOverrides?.targetAngle ?? ex?.targetAngle ?? 0;
  const currentRange = Math.abs(targetAngle - restAngle);
  const opt = (v, label, cur) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${label}</option>`;
  const freqOpts = [1, 2, 3, 4, 5, 6, 7].map((n) => opt(n, n === 7 ? "Every day (7 days)" : `${n} day${n > 1 ? "s" : ""} / week`, pr.daysPerWeek ?? 3)).join("");
  const tempoOpts = Object.values(TEMPOS).map((t) => opt(t.key, t.name, pr.tempo ?? DEFAULT_TEMPO)).join("");

  const form = document.createElement("form");
  form.className = "prescribe-form pr-edit";
  form.innerHTML = `
    <div class="wide"><b>Editing ${esc(pr.exerciseName)}</b> <span class="muted small">(exercise can't be changed; stop it and prescribe a new one instead)</span></div>
    <label>Sets <input name="sets" type="number" min="1" max="20" value="${pr.sets}" required /></label>
    <label>Reps per set <input name="reps" type="number" min="1" max="100" value="${pr.reps}" required /></label>
    <label>Hold (s) <input name="holdSeconds" type="number" min="0" max="60" value="${pr.holdSeconds ?? 0}" /></label>
    <label>Rest between sets (s) <input name="restSeconds" type="number" min="0" max="600" value="${pr.restSeconds ?? 60}" /></label>
    <label>Duration (weeks) <input name="durationWeeks" type="number" min="1" max="52" value="${pr.durationWeeks ?? 4}" required /></label>
    <label>Target frequency <select name="daysPerWeek">${freqOpts}</select></label>
    <label>Rep tempo <select name="tempo">${tempoOpts}</select><span class="muted small" data-tempo-hint></span></label>
    <label>Reach range ° <input name="range" type="number" min="1" max="180" value="${currentRange}" />
      <span class="muted small">rest ${restAngle}° → target <span data-target>${targetAngle}</span>°</span></label>
    <label class="wide">Timeline Phase / Stage <input name="timelinePhase" maxlength="100" value="${esc(pr.timelinePhase ?? "")}" /></label>
    <label class="wide">Notes for the patient <input name="notes" maxlength="500" value="${esc(pr.notes ?? "")}" /></label>
    <div class="wide form-actions">
      <button type="submit">Save changes</button>
      <button type="button" class="small-btn" data-cancel>Cancel</button>
      <span class="muted" data-status></span>
    </div>`;

  const f = form.elements;
  const direction = Math.sign((ex?.targetAngle ?? targetAngle) - restAngle) || 1;
  const computeTarget = () => {
    const range = Number(f.range.value);
    if (!Number.isFinite(range) || range <= 0) return null;
    return Math.max(0, Math.min(180, Math.round(restAngle + direction * range)));
  };
  const syncHints = () => {
    form.querySelector("[data-tempo-hint]").textContent = tempoSummary(f.tempo.value);
    form.querySelector("[data-target]").textContent = computeTarget() ?? targetAngle;
  };
  f.tempo.addEventListener("change", syncHints);
  f.range.addEventListener("input", syncHints);
  syncHints();

  form.querySelector("[data-cancel]").addEventListener("click", () => form.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = form.querySelector("[data-status]");
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    status.textContent = "Saving…";
    try {
      const target = computeTarget();
      await Api.updatePrescription(pr._id, {
        sets: f.sets.value,
        reps: f.reps.value,
        holdSeconds: f.holdSeconds.value,
        restSeconds: f.restSeconds.value,
        durationWeeks: f.durationWeeks.value,
        daysPerWeek: f.daysPerWeek.value,
        tempo: f.tempo.value,
        timelinePhase: f.timelinePhase.value,
        notes: f.notes.value,
        angleOverrides: target == null ? null : { restAngle, targetAngle: target },
      });
      await loadPrescriptions();
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      btn.disabled = false;
    }
  });

  li.appendChild(form);
  f.sets.focus();
}

$("prescribe-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selected) return;
  const btn = $("p-submit");
  btn.disabled = true;
  $("p-status").textContent = "Sending…";
  try {
    const created = await Api.createPrescription({
      patientId: selected._id,
      exerciseKey: $("p-exercise").value,
      sets: $("p-sets").value,
      reps: $("p-reps").value,
      holdSeconds: $("p-hold").value,
      restSeconds: $("p-rest-secs").value,
      durationWeeks: $("p-weeks").value,
      daysPerWeek: $("p-frequency").value,
      timelinePhase: $("p-phase").value,
      tempo: $("p-tempo").value,
      angleOverrides: (() => {
        const range = Number($("p-range").value);
        if (!Number.isFinite(range) || range <= 0) return null;
        const direction = Math.sign(_exTargetAngle - _exRestAngle) || 1;
        const computedTarget = Math.max(0, Math.min(180, Math.round(_exRestAngle + direction * range)));
        // Always send restAngle (fixed) + the computed targetAngle
        return { restAngle: _exRestAngle, targetAngle: computedTarget };
      })(),
      notes: $("p-notes").value,
    });
    const mail = created.email;
    $("p-status").textContent =
      `Sent to ${selected.name} ✓` +
      (mail?.sent ? ` · 📧 summary emailed to ${mail.to}` : mail?.error ? ` · ⚠ email failed: ${mail.error}` : mail?.skipped ? ` · email not sent (${mail.skipped})` : "");
    $("p-notes").value = "";
    await loadPrescriptions();
  } catch (err) {
    $("p-status").textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---- analysis: latest-session tiles, progress chart, sessions table ---------
async function loadAnalysis() {
  [sessionsCache, progressCache] = await Promise.all([Api.sessions(selected._id, 30), Api.progress(selected._id, 60)]);
  renderTiles();
  renderExerciseFilter();
  renderProgress();
  renderSessions();
}

function renderTiles() {
  const latest = sessionsCache[0];
  const s = latest?.summary;
  const el = $("tiles");
  if (!s) {
    el.innerHTML = `<div class="muted small">No sessions yet.</div>`;
    $("tiles-caption").textContent = "";
    return;
  }
  const tile = (label, value, sub = "") =>
    `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
  el.innerHTML =
    tile("Reps", s.repCount, latest.setsCompleted ? `${latest.setsCompleted} set${latest.setsCompleted > 1 ? "s" : ""}` : "") +
    tile("Avg ROM", pct(s.avgRom), s.avgPeakAngle != null ? `peak ${deg(s.avgPeakAngle)}` : "") +
    tile("Best ROM", pct(s.bestRom), s.bestPeakAngle != null ? deg(s.bestPeakAngle) : "") +
    tile("Tempo", secs(s.avgDurationMs), s.tempoRepsPerMin != null ? `${s.tempoRepsPerMin} reps/min` : "per rep") +
    tile("Concentric", secs(s.avgConcentricMs), "avg per rep") +
    tile("Eccentric", secs(s.avgEccentricMs), "avg per rep") +
    tile("Hold", secs(s.avgHoldMs), "avg at target") +
    tile("Form cues", s.cueCount ?? 0, s.cueBreakdown?.[0] ? esc(s.cueBreakdown[0].cue) : "");
  $("tiles-caption").textContent = `Latest session · ${latest.exerciseName} · ${when(latest.startedAt)}`;
}

function renderExerciseFilter() {
  const sel = $("f-exercise");
  const keys = [...new Map(progressCache.map((r) => [r.exerciseKey, r.exerciseName])).entries()];
  const keep = keys.some(([k]) => k === sel.value) ? sel.value : keys[0]?.[0];
  sel.innerHTML = keys.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join("");
  if (keep) sel.value = keep;
  sel.disabled = !keys.length;
}

const METRICS = {
  avgRom: { label: "Avg ROM", fmt: pct, extra: (r) => `${r.reps} reps · best ${pct(r.bestRom)}` },
  avgPeakAngle: { label: "Avg peak angle", fmt: deg, extra: (r) => `${r.reps} reps` },
  avgDurationMs: { label: "Tempo (s per rep)", fmt: secs, extra: (r) => `${r.reps} reps` },
  avgConcentricMs: { label: "Concentric time", fmt: secs, extra: (r) => `eccentric ${secs(r.avgEccentricMs)}` },
  avgEccentricMs: { label: "Eccentric time", fmt: secs, extra: (r) => `concentric ${secs(r.avgConcentricMs)}` },
  avgHoldMs: { label: "Hold time", fmt: secs, extra: (r) => `${r.reps} reps` },
  cues: { label: "Form cues", fmt: (v) => `${Math.round(v)}`, extra: (r) => `${r.reps} reps` },
};

function renderProgress() {
  const key = $("f-exercise").value;
  const m = METRICS[metric];
  const rows = progressCache.filter((r) => r.exerciseKey === key && r[metric] != null);
  $("progress-title").textContent = `${m.label} over time`;
  if (!rows.length) return empty($("progress-chart"), "No sessions for this exercise yet");
  lineChart($("progress-chart"), {
    points: rows.map((r) => ({ x: new Date(r.day), y: r[metric], extra: m.extra(r) })),
    fmt: m.fmt,
    color: SERIES.blue,
    label: m.label,
  });
}
$("f-exercise").addEventListener("change", renderProgress);
$("f-metric").addEventListener("change", (e) => {
  metric = e.target.value;
  renderProgress();
});

function renderSessions() {
  const tb = $("session-table").querySelector("tbody");
  tb.innerHTML = sessionsCache.length ? "" : `<tr><td colspan="9" class="muted">No sessions yet.</td></tr>`;
  for (const s of sessionsCache) {
    const tr = document.createElement("tr");
    tr.dataset.id = s._id;
    const isIncomplete = s.completedEarly === true;
    tr.className = [s._id === selectedSessionId ? "active" : "", isIncomplete ? "session-incomplete" : ""].filter(Boolean).join(" ");
    const sm = s.summary;
    const incompleteTag = isIncomplete
      ? `<span class="incomplete-tag" title="${s.setsCompleted}/${s.setsPrescribed} sets completed">⚠ Incomplete</span>`
      : "";
    tr.innerHTML = `
      <td>${when(s.startedAt)}${incompleteTag}</td>
      <td>${esc(s.exerciseName)}</td>
      <td>${sm.repCount}</td>
      <td>${pct(sm.avgRom)}${sm.avgPeakAngle != null ? ` <span class="muted">${deg(sm.avgPeakAngle)}</span>` : ""}</td>
      <td>${secs(sm.avgDurationMs)}</td>
      <td>${secs(sm.avgConcentricMs)}</td>
      <td>${secs(sm.avgEccentricMs)}</td>
      <td>${secs(sm.avgHoldMs)}</td>
      <td>${sm.cueCount || "—"}</td>`;
    tr.addEventListener("click", () => showSession(s._id));
    tb.appendChild(tr);
  }
}

function renderSessionCharts(s) {
  if (!s || $("session-detail").hidden) return;
  const labels = s.reps.map((r) => `${r.n}`);
  barChart($("rom-chart"), { values: s.reps.map((r) => r.rom), labels, fmt: pct, color: SERIES.blue, refLine: 1 });
  stackedBars($("tempo-chart"), {
    labels,
    fmt: secs,
    series: [
      { name: "Concentric", color: SERIES.blue, values: s.reps.map((r) => r.concentricMs || 0) },
      { name: "Hold", color: SERIES.aqua, values: s.reps.map((r) => r.holdMs || 0) },
      { name: "Eccentric", color: SERIES.orange, values: s.reps.map((r) => r.eccentricMs || 0) },
    ],
  });
}

// ---- one session, rep by rep -------------------------------------------------
async function showSession(id) {
  selectedSessionId = id;
  for (const tr of $("session-table").querySelectorAll("tbody tr")) tr.classList.toggle("active", tr.dataset.id === id);
  const s = await Api.session(id);
  selectedSessionDoc = s;
  const box = $("session-detail");
  box.hidden = false;
  const sm = s.summary;
  $("sd-title").textContent = `${s.exerciseName} · ${when(s.startedAt)}`;
  $("sd-sub").textContent =
    `${sm.repCount} reps · avg ROM ${pct(sm.avgRom)} · ${secs(sm.avgDurationMs)} per rep` +
    (sm.tempoRepsPerMin != null ? ` · ${sm.tempoRepsPerMin} reps/min` : "") +
    (sm.avgRestMs != null ? ` · ${secs(sm.avgRestMs)} rest between reps` : "");
  renderSessionCharts(s);
  // table view: exact numbers, and the accessible alternative to the charts
  const tb = $("rep-table").querySelector("tbody");
  tb.innerHTML = "";
  for (const r of s.reps) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.n}</td><td>${pct(r.rom)}</td><td>${deg(r.peakAngle)}</td><td>${secs(r.concentricMs)}</td><td>${secs(r.holdMs)}</td><td>${secs(r.eccentricMs)}</td><td>${secs(r.durationMs)}</td><td>${r.restBeforeMs != null ? secs(r.restBeforeMs) : "—"}</td><td class="muted">${esc(r.cues.join(", ")) || "—"}</td>`;
    tb.appendChild(tr);
  }
  $("cue-summary").textContent = sm.cueBreakdown?.length
    ? "Form cues: " + sm.cueBreakdown.map((c) => `${c.cue} ×${c.count}`).join(" · ")
    : "No form cues fired in this session.";
  $("rep-table").hidden = true;
  $("rep-table-toggle").textContent = `Show rep table (${s.reps.length})`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
$("rep-table-toggle").addEventListener("click", () => {
  const t = $("rep-table");
  t.hidden = !t.hidden;
  $("rep-table-toggle").textContent = `${t.hidden ? "Show" : "Hide"} rep table (${t.querySelectorAll("tbody tr").length})`;
});
$("sd-close").addEventListener("click", () => {
  $("session-detail").hidden = true;
  selectedSessionId = null;
  selectedSessionDoc = null;
  renderSessions();
});

// Live-ish: refresh analysis every 10 s so a patient finishing on another laptop shows up.
setInterval(() => {
  if (selected) loadAnalysis().catch(() => {});
}, 10000);
window.addEventListener("resize", () => {
  if (!selected) return;
  renderProgress();
  renderSessionCharts(selectedSessionDoc);
});

Promise.all([loadExercises(), loadPatients()]).catch((err) => {
  $("patient-list").innerHTML = `<li class="form-error">${esc(err.message)}</li>`;
});
