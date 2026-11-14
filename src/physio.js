// Physio dashboard: pick a patient, send prescriptions, review sessions.
import { Api, requireUser, logout } from "./api.js";

const user = requireUser("physio");
if (!user) await new Promise(() => {}); // halt this module while the browser navigates to login

const $ = (id) => document.getElementById(id);
$("user-chip").textContent = user.name;
$("logout").addEventListener("click", logout);

let exercises = [];
let patients = [];
let selected = null;

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
function fillAngleDefaults() {
  const ex = exercises.find((e) => e.key === $("p-exercise").value);
  if (!ex) return;
  $("p-rest").value = ex.restAngle;
  $("p-target").value = ex.targetAngle;
  $("p-defaults").textContent = `Defaults: rest ${ex.restAngle}°, target ${ex.targetAngle}°. Lower the target for a patient with limited range.`;
}

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
  for (const li of $("patient-list").children) li.classList.toggle("active", li.dataset.id === p._id);
  $("patient-detail").hidden = false;
  $("patient-name").textContent = p.name;
  $("patient-condition").textContent = p.condition ?? "";
  $("p-status").textContent = "";
  await Promise.all([loadPrescriptions(), loadSessions()]);
}

// ---- prescriptions ----------------------------------------------------------
async function loadPrescriptions() {
  const list = await Api.prescriptions(selected._id);
  const ul = $("prescription-list");
  ul.innerHTML = list.length ? "" : `<li class="muted">Nothing prescribed yet.</li>`;
  for (const pr of list) {
    const li = document.createElement("li");
    const deg = (v) => (v == null ? "default" : `${v}°`);
    const ov = pr.angleOverrides ? ` · angles ${deg(pr.angleOverrides.restAngle)} → ${deg(pr.angleOverrides.targetAngle)}` : "";
    li.innerHTML = `
      <div>
        <b>${esc(pr.exerciseName)}</b>
        <div class="muted">${pr.sets} × ${pr.reps}${pr.holdSeconds ? ` · hold ${pr.holdSeconds}s` : ""}${ov}</div>
        ${pr.notes ? `<div class="note">“${esc(pr.notes)}”</div>` : ""}
      </div>
      <button class="small-btn" data-stop="${pr._id}">Stop</button>`;
    li.querySelector("[data-stop]").addEventListener("click", async (e) => {
      e.target.disabled = true;
      await Api.stopPrescription(pr._id);
      loadPrescriptions();
    });
    ul.appendChild(li);
  }
}

$("prescribe-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selected) return;
  const btn = $("p-submit");
  btn.disabled = true;
  $("p-status").textContent = "Sending…";
  try {
    await Api.createPrescription({
      patientId: selected._id,
      exerciseKey: $("p-exercise").value,
      sets: $("p-sets").value,
      reps: $("p-reps").value,
      holdSeconds: $("p-hold").value,
      angleOverrides: { restAngle: $("p-rest").value, targetAngle: $("p-target").value },
      notes: $("p-notes").value,
    });
    $("p-status").textContent = `Sent to ${selected.name} ✓`;
    $("p-notes").value = "";
    await loadPrescriptions();
  } catch (err) {
    $("p-status").textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---- sessions ---------------------------------------------------------------
async function loadSessions() {
  const list = await Api.sessions(selected._id, 15);
  const tb = $("session-table").querySelector("tbody");
  tb.innerHTML = list.length ? "" : `<tr><td colspan="6" class="muted">No sessions yet.</td></tr>`;
  for (const s of list) {
    const tr = document.createElement("tr");
    const when = new Date(s.startedAt);
    tr.innerHTML = `
      <td>${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
      <td>${esc(s.exerciseName)}</td>
      <td>${s.summary.repCount}</td>
      <td>${pct(s.summary.avgRom)}</td>
      <td>${pct(s.summary.bestRom)}</td>
      <td>${s.summary.cueCount || "—"}</td>`;
    tb.appendChild(tr);
  }
}

const pct = (x) => `${Math.round(x * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Live-ish: refresh sessions every 10 s so a patient finishing on another laptop shows up.
setInterval(() => selected && loadSessions().catch(() => {}), 10000);

Promise.all([loadExercises(), loadPatients()]).catch((err) => {
  $("patient-list").innerHTML = `<li class="form-error">${esc(err.message)}</li>`;
});
