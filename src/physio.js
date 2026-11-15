// Physio dashboard: pick a patient, send prescriptions, analyse their sessions.
import { Api, requireUser, logout } from "./api.js";
import { lineChart, barChart, stackedBars, empty, SERIES } from "./charts.js";
import { TEMPOS, DEFAULT_TEMPO, tempoSummary } from "./game.js";
import { loadVideoUrl } from "./formvideo.js";

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
  $("draft-status").textContent = "";
  loadDraft();
  $("session-detail").hidden = true;
  await Promise.all([loadPrescriptions(), loadAnalysis(), loadPatientVideos()]);
}

// ---- form-review videos --------------------------------------------------------
async function loadPatientVideos() {
  const ul = $("patient-videos");
  if (!ul || !selected) return;
  const patient = selected;
  ul.innerHTML = `<li class="muted small">Loading…</li>`;
  let list = [];
  try {
    const [vids, storage] = await Promise.all([Api.videos(patient._id), Api.videoStorage().catch(() => null)]);
    list = vids;
    if (storage) {
      $("video-storage").textContent = `· storage ${(storage.usedBytes / 1048576).toFixed(1)} of ${Math.round(storage.capBytes / 1048576)} MB used`;
    }
  } catch (err) {
    ul.innerHTML = `<li class="muted small">Couldn't load videos: ${esc(err.message)}</li>`;
    return;
  }
  if (selected !== patient) return; // switched patient meanwhile
  if (!list.length) {
    ul.innerHTML = `<li class="muted small">${esc(patient.name)} hasn't sent any videos yet.</li>`;
    return;
  }
  ul.innerHTML = "";
  for (const v of list) {
    const li = document.createElement("li");
    li.className = "video-row";
    const daysLeft = Math.max(0, Math.ceil((new Date(v.expiresAt) - Date.now()) / 86400e3));
    li.innerHTML = `
      <div class="video-row-head">
        <div><b>${esc(v.exerciseName)}</b> · set ${v.setNumber}
          <span class="muted small">${when(v.createdAt)} · ${Math.round(v.durationMs / 1000)}s · ${v.mode === "skeleton" ? "skeleton only" : "camera"} · ${(v.size / 1048576).toFixed(1)} MB · deletes in ${daysLeft}d</span></div>
        <span class="video-status ${v.status}">${v.status === "reviewed" ? "✓ Reviewed" : "New"}</span>
      </div>
      <div class="muted small" title="${esc(v.consent?.text ?? "")}">🔒 Consent given ${v.consent?.at ? when(v.consent.at) : ""}</div>
      <div class="video-actions">
        <button class="small-btn" data-play>▶ Watch</button>
        <button class="small-btn" data-del>Delete</button>
      </div>
      <form class="video-feedback-form">
        <textarea maxlength="1000" rows="2" placeholder="Feedback for ${esc(patient.name.split(" ")[0])}, e.g. keep your elbow tucked in on the way up">${esc(v.feedback ?? "")}</textarea>
        <button type="submit" class="small-btn">${v.status === "reviewed" ? "Update feedback" : "Send feedback & mark reviewed"}</button>
        <span class="muted small" data-status></span>
      </form>`;
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
        li.querySelector(".video-actions").after(el);
        el.play().catch(() => {});
        e.target.remove();
      } catch (err) {
        e.target.disabled = false;
        e.target.textContent = `Retry (${err.message})`;
      }
    });
    li.querySelector("[data-del]").addEventListener("click", async () => {
      if (!confirm("Delete this video permanently?")) return;
      await Api.deleteVideo(v._id).catch((err) => alert(err.message));
      loadPatientVideos();
    });
    li.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = li.querySelector("[data-status]");
      status.textContent = "Saving…";
      try {
        await Api.reviewVideo(v._id, li.querySelector("textarea").value);
        status.textContent = "Saved ✓";
        li.querySelector(".video-status").className = "video-status reviewed";
        li.querySelector(".video-status").textContent = "✓ Reviewed";
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });
    ul.appendChild(li);
  }
}

// ---- prescriptions & timeline (with an unsent draft) ------------------------
// Adding, editing and stopping exercises only changes a local draft. Nothing is saved or
// emailed until the physio presses "Submit changes", which sends the whole batch in one
// request so the patient gets one summary email.
let serverPlan = [];
let draft = emptyDraft();

function emptyDraft() {
  return { add: [], edit: {}, remove: [] };
}
const draftKey = () => (selected ? `physio.draft.${user._id}.${selected._id}` : null);
const draftSize = () => draft.add.length + Object.keys(draft.edit).length + draft.remove.length;

function loadDraft() {
  draft = emptyDraft();
  try {
    const raw = localStorage.getItem(draftKey());
    if (raw) {
      const d = JSON.parse(raw);
      draft = { add: Array.isArray(d.add) ? d.add : [], edit: d.edit && typeof d.edit === "object" ? d.edit : {}, remove: Array.isArray(d.remove) ? d.remove : [] };
    }
  } catch {}
}
function saveDraft() {
  try {
    if (draftSize()) localStorage.setItem(draftKey(), JSON.stringify(draft));
    else localStorage.removeItem(draftKey());
  } catch {}
}
/** Drop draft edits/removals that point at exercises no longer active on the server. */
function pruneDraft() {
  const ids = new Set(serverPlan.map((p) => String(p._id)));
  for (const id of Object.keys(draft.edit)) if (!ids.has(id)) delete draft.edit[id];
  draft.remove = draft.remove.filter((id) => ids.has(id));
  saveDraft();
}

/** Record an edit to a saved prescription; dropped again if it matches what is saved. */
function setEdit(pr, fields) {
  const id = String(pr._id);
  const ex = exercises.find((x) => x.key === pr.exerciseKey);
  const norm = (o) => {
    const unlimited = Boolean(o.unlimited || o.reps == null || o.reps === "");
    return JSON.stringify([
      Number(o.sets), unlimited ? null : Number(o.reps), Number(o.holdSeconds) || 0, Number(o.restSeconds ?? 60),
      Number(o.durationWeeks) || 4, Number(o.daysPerWeek) || 3, o.tempo || DEFAULT_TEMPO,
      String(o.timelinePhase ?? ""), String(o.notes ?? ""),
      o.angleOverrides?.restAngle ?? ex?.restAngle, o.angleOverrides?.targetAngle ?? ex?.targetAngle,
    ]);
  };
  if (norm(fields) !== norm(pr)) draft.edit[id] = fields;
  else delete draft.edit[id];
}

async function loadPrescriptions() {
  const patient = selected;
  const list = await Api.prescriptions(patient._id);
  if (selected !== patient) return;
  serverPlan = list;
  pruneDraft();
  renderPlan();
}

function planRow(pr, { badge = "", removing = false } = {}) {
  const li = document.createElement("li");
  if (badge) li.classList.add(`draft-${badge.toLowerCase()}`);
  const d = (v) => (v == null ? "default" : `${v}°`);
  const ov = pr.angleOverrides
    ? (() => {
        const rest = pr.angleOverrides.restAngle;
        const target = pr.angleOverrides.targetAngle;
        if (rest != null && target != null) return ` · range ${Math.abs(target - rest)}° (rest ${rest}° → target ${target}°)`;
        return ` · target ${d(target)}`;
      })()
    : "";
  const weeks = Number(pr.durationWeeks) || 4;
  const freq = Number(pr.daysPerWeek) || 3;
  const phase = pr.timelinePhase ? `<span class="timeline-tag">${esc(pr.timelinePhase)}</span>` : "";
  const start = pr.startDate ? new Date(pr.startDate) : new Date(pr.createdAt || Date.now());
  const end = new Date(start.getTime() + weeks * 7 * 86400e3);
  const currentWeek = Math.min(weeks, Math.max(1, Math.ceil((Date.now() - start.getTime()) / (7 * 86400e3))));
  const dateRangeStr = `${start.toLocaleDateString([], { day: "numeric", month: "short" })} – ${end.toLocaleDateString([], { day: "numeric", month: "short" })}`;
  const unlimited = pr.unlimited || pr.reps == null || pr.reps === "";
  const sets = Number(pr.sets) || 1;
  const badgeHtml = badge ? `<span class="draft-badge ${badge.toLowerCase()}">${badge}</span>` : "";

  li.innerHTML = `
    <div style="flex: 1">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${badgeHtml}
        <b class="pr-name">${esc(pr.exerciseName)}</b>
        ${phase}
        <span class="timeline-badge">${badge === "NEW" ? `${weeks} weeks` : `Week ${currentWeek} of ${weeks}`} · ${freq}d/wk</span>
      </div>
      <div class="muted pr-detail" style="margin-top:2px">
        ${unlimited ? "Unlimited reps" : `${sets} sets × ${pr.reps} reps`}${Number(pr.holdSeconds) ? ` · hold ${pr.holdSeconds}s` : ""}${sets > 1 ? ` · rest ${pr.restSeconds ?? 60}s` : ""} · ${(TEMPOS[pr.tempo] ?? TEMPOS[DEFAULT_TEMPO]).name} tempo${ov}
      </div>
      <div class="muted small" style="margin-top:3px;font-size:11px">
        📅 Timeline: ${badge === "NEW" ? `starts when you submit (${weeks} weeks)` : `${dateRangeStr} (${weeks} weeks total)`}
      </div>
      ${pr.notes ? `<div class="note">“${esc(pr.notes)}”</div>` : ""}
    </div>
    <div class="pr-actions"></div>`;
  return li;
}

function actionBtn(li, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "small-btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  li.querySelector(".pr-actions").appendChild(b);
  return b;
}

function renderPlan() {
  const ul = $("prescription-list");
  ul.innerHTML = "";
  const removing = new Set(draft.remove);
  for (const pr of serverPlan) {
    const id = String(pr._id);
    const edit = draft.edit[id];
    if (removing.has(id)) {
      const li = planRow(pr, { badge: "REMOVING" });
      actionBtn(li, "Undo", () => {
        draft.remove = draft.remove.filter((x) => x !== id);
        changed();
      });
      ul.appendChild(li);
      continue;
    }
    const shown = edit ? { ...pr, ...edit } : pr;
    const li = planRow(shown, { badge: edit ? "EDITED" : "" });
    actionBtn(li, "Edit", () =>
      openEditForm(li, shown, (fields) => {
        setEdit(pr, fields);
        changed();
      })
    );
    if (edit) {
      actionBtn(li, "Undo edit", () => {
        delete draft.edit[id];
        changed();
      });
    }
    actionBtn(li, "Stop", () => {
      draft.remove.push(id);
      changed();
    });
    ul.appendChild(li);
  }
  draft.add.forEach((a, i) => {
    const li = planRow(a, { badge: "NEW" });
    actionBtn(li, "Edit", () =>
      openEditForm(li, a, (fields) => {
        draft.add[i] = { ...a, ...fields };
        changed();
      })
    );
    actionBtn(li, "Remove", () => {
      draft.add.splice(i, 1);
      changed();
    });
    ul.appendChild(li);
  });
  if (!ul.children.length) ul.innerHTML = `<li class="muted">Nothing prescribed yet.</li>`;
  renderDraftBar();
}

function changed() {
  saveDraft();
  $("draft-status").textContent = "";
  renderPlan();
}

function renderDraftBar() {
  const n = draftSize();
  $("plan-draft-bar").hidden = n === 0;
  if (!n) return;
  const parts = [
    draft.add.length && `${draft.add.length} new`,
    Object.keys(draft.edit).length && `${Object.keys(draft.edit).length} changed`,
    draft.remove.length && `${draft.remove.length} removed`,
  ].filter(Boolean);
  $("draft-count").textContent = `${n} unsent change${n === 1 ? "" : "s"}`;
  $("draft-summary").textContent = `${parts.join(" · ")}. ${selected.name.split(" ")[0]} won't see these (or get an email) until you submit.`;
}

$("draft-discard").addEventListener("click", () => {
  if (!draftSize() || !confirm("Discard all unsent changes to this plan?")) return;
  draft = emptyDraft();
  changed();
});

$("draft-submit").addEventListener("click", async () => {
  if (!selected || !draftSize()) return;
  const patient = selected;
  const btn = $("draft-submit");
  const status = $("draft-status");
  btn.disabled = true;
  $("draft-discard").disabled = true;
  status.textContent = "Submitting…";
  try {
    const res = await Api.planChanges(patient._id, {
      add: draft.add.map(({ exerciseName, ...a }) => a),
      edit: Object.entries(draft.edit).map(([id, f]) => ({ id, ...f })),
      remove: draft.remove,
    });
    draft = emptyDraft();
    saveDraft();
    const mail = res.email;
    const parts = [res.added && `${res.added} added`, res.edited && `${res.edited} changed`, res.removed && `${res.removed} removed`].filter(Boolean).join(", ");
    status.textContent =
      `Plan updated for ${patient.name} ✓ (${parts || "no changes"})` +
      (mail?.sent ? ` · 📧 one summary email sent to ${mail.to}` : mail?.error ? ` · ⚠ email failed: ${mail.error}` : mail?.skipped ? ` · email not sent (${mail.skipped})` : "");
    await loadPrescriptions();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    if (err.status === 409) await loadPrescriptions().catch(() => {});
  } finally {
    btn.disabled = false;
    $("draft-discard").disabled = false;
  }
});

// Changes are kept per patient in this browser, but warn before leaving with unsent ones.
window.addEventListener("beforeunload", (e) => {
  if (selected && draftSize()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/** Inline editor for a plan item (saved or draft). Exercise name/type is fixed; everything else is editable.
 *  Saving only updates the draft via onSave(fields). */
function openEditForm(li, pr, onSave) {
  if (li.querySelector(".pr-edit")) return;
  const ex = exercises.find((e) => e.key === pr.exerciseKey);
  const restAngle = pr.angleOverrides?.restAngle ?? ex?.restAngle ?? 0;
  const targetAngle = pr.angleOverrides?.targetAngle ?? ex?.targetAngle ?? 0;
  const currentRange = Math.abs(targetAngle - restAngle);
  const unlimited = pr.unlimited || pr.reps == null || pr.reps === "";
  const opt = (v, label, cur) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${label}</option>`;
  const freqOpts = [1, 2, 3, 4, 5, 6, 7].map((n) => opt(n, n === 7 ? "Every day (7 days)" : `${n} day${n > 1 ? "s" : ""} / week`, pr.daysPerWeek ?? 3)).join("");
  const tempoOpts = Object.values(TEMPOS).map((t) => opt(t.key, t.name, pr.tempo ?? DEFAULT_TEMPO)).join("");

  const form = document.createElement("form");
  form.className = "prescribe-form pr-edit";
  form.innerHTML = `
    <div class="wide"><b>Editing ${esc(pr.exerciseName)}</b> <span class="muted small">(exercise can't be changed; stop it and add a new one instead)</span></div>
    <label>Sets <input name="sets" type="number" min="1" max="20" value="${esc(pr.sets)}" required /></label>
    <label>Reps per set <input name="reps" type="number" min="1" max="100" value="${unlimited ? "" : esc(pr.reps)}" placeholder="Unlimited" /></label>
    <label>Hold (s) <input name="holdSeconds" type="number" min="0" max="60" value="${esc(pr.holdSeconds ?? 0)}" /></label>
    <label>Rest between sets (s) <input name="restSeconds" type="number" min="0" max="600" value="${esc(pr.restSeconds ?? 60)}" /></label>
    <label>Duration (weeks) <input name="durationWeeks" type="number" min="1" max="52" value="${esc(pr.durationWeeks ?? 4)}" required /></label>
    <label>Target frequency <select name="daysPerWeek">${freqOpts}</select></label>
    <label>Rep tempo <select name="tempo">${tempoOpts}</select><span class="muted small" data-tempo-hint></span></label>
    <label>Reach range ° <input name="range" type="number" min="1" max="180" value="${currentRange}" />
      <span class="muted small">rest ${restAngle}° → target <span data-target>${targetAngle}</span>°</span></label>
    <label class="wide">Timeline Phase / Stage <input name="timelinePhase" maxlength="100" value="${esc(pr.timelinePhase ?? "")}" /></label>
    <label class="wide">Notes for the patient <input name="notes" maxlength="500" value="${esc(pr.notes ?? "")}" /></label>
    <div class="wide form-actions">
      <button type="submit">Save to draft</button>
      <button type="button" class="small-btn" data-cancel>Cancel</button>
      <span class="muted small">Not sent until you submit the plan.</span>
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
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const target = computeTarget();
    onSave({
      sets: Number(f.sets.value),
      reps: f.reps.value === "" ? null : Number(f.reps.value),
      unlimited: f.reps.value === "",
      holdSeconds: Number(f.holdSeconds.value) || 0,
      restSeconds: f.restSeconds.value === "" ? 60 : Number(f.restSeconds.value),
      durationWeeks: Number(f.durationWeeks.value),
      daysPerWeek: Number(f.daysPerWeek.value),
      tempo: f.tempo.value,
      timelinePhase: f.timelinePhase.value,
      notes: f.notes.value,
      angleOverrides: target == null ? null : sameAngles(ex, restAngle, target) ? null : { restAngle, targetAngle: target },
    });
  });

  li.appendChild(form);
  f.sets.focus();
}

/** True when the angles are just the exercise defaults (so no override is needed). */
const sameAngles = (ex, rest, target) => ex && rest === ex.restAngle && target === ex.targetAngle;

$("prescribe-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!selected) return;
  const ex = exercises.find((x) => x.key === $("p-exercise").value);
  if (!ex) return;
  const range = Number($("p-range").value);
  let angleOverrides = null;
  if (Number.isFinite(range) && range > 0) {
    const direction = Math.sign(_exTargetAngle - _exRestAngle) || 1;
    const target = Math.max(0, Math.min(180, Math.round(_exRestAngle + direction * range)));
    if (!sameAngles(ex, _exRestAngle, target)) angleOverrides = { restAngle: _exRestAngle, targetAngle: target };
  }
  draft.add.push({
    exerciseKey: ex.key,
    exerciseName: ex.name,
    sets: Number($("p-sets").value),
    reps: Number($("p-reps").value),
    unlimited: false,
    holdSeconds: Number($("p-hold").value) || 0,
    restSeconds: $("p-rest-secs").value === "" ? 60 : Number($("p-rest-secs").value),
    durationWeeks: Number($("p-weeks").value),
    daysPerWeek: Number($("p-frequency").value),
    timelinePhase: $("p-phase").value,
    tempo: $("p-tempo").value,
    angleOverrides,
    notes: $("p-notes").value,
  });
  changed();
  $("p-notes").value = "";
  $("p-status").textContent = `Added ${ex.name} to the draft. Add more, then press Submit changes.`;
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
