// Emails the patient ONE summary when a physio submits a batch of plan changes
// (exercises added, edited and removed together).
// Sends through Gmail with an App Password. Configure in .env:
//   GMAIL_USER          the Gmail address that sends the email
//   GMAIL_APP_PASSWORD  a 16-character App Password (Google Account > Security > App passwords)
//   EMAIL_TO            optional: send every email here instead of the patient's own address (demo mode)
//   APP_URL             optional: link in the email (defaults to the deployed app URL)
// If GMAIL_USER / GMAIL_APP_PASSWORD are missing, emails are skipped and the app works as before.

import nodemailer from "nodemailer";
import { EXERCISES } from "../src/exercises.js";
import { tempoOf } from "../src/tempo.js";

let transporter = null;

export function emailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, "") },
    });
  }
  return transporter;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDate = (d) => new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** Plain list of [label, value] rows describing a prescription. */
function summaryRows(pr) {
  const ex = EXERCISES[pr.exerciseKey] ?? {};
  const t = tempoOf(pr.tempo);
  const rest = pr.angleOverrides?.restAngle ?? ex.restAngle;
  const target = pr.angleOverrides?.targetAngle ?? ex.targetAngle;
  const rows = [
    ["Exercise", pr.exerciseName],
    ["Sets × reps", pr.unlimited || pr.reps == null ? "Unlimited reps" : `${pr.sets} sets × ${pr.reps} reps`],
    ["Tempo", `${t.name}: ${t.up}s up · ${t.hold}s hold · ${t.down}s down`],
  ];
  if (pr.holdSeconds) rows.push(["Hold at the top", `${pr.holdSeconds}s`]);
  if (pr.sets > 1) rows.push(["Rest between sets", `${pr.restSeconds ?? 60}s`]);
  rows.push(["How often", `${pr.daysPerWeek ?? 3} days per week`]);
  rows.push(["Programme", `${pr.durationWeeks ?? 4} weeks · ${fmtDate(pr.startDate)} to ${fmtDate(pr.endDate)}`]);
  if (rest != null && target != null) rows.push(["Range of motion", `${rest}° → ${target}° (${Math.abs(target - rest)}° of movement)`]);
  if (pr.timelinePhase) rows.push(["Stage", pr.timelinePhase]);
  return rows;
}

const DEFAULT_APP_URL = "https://durhack-2026.vercel.app";

function resolveAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.trim();
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.trim()}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.trim()}`;
  }
  return DEFAULT_APP_URL;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const shortLine = (pr) => {
  const t = tempoOf(pr.tempo);
  const dose = pr.unlimited || pr.reps == null ? "unlimited reps" : `${pr.sets} × ${pr.reps}`;
  return `${dose} · ${t.name.toLowerCase()} tempo · ${pr.daysPerWeek ?? 3} days/week`;
};

/** [label, before, after] for every summary row that differs between two versions. */
export function changedRows(before, after) {
  const a = new Map(summaryRows(before));
  const bRows = summaryRows(after);
  const out = [];
  for (const [k, v] of bRows) if (a.get(k) !== v) out.push([k, a.get(k) ?? "—", v]);
  for (const [k, v] of a) if (!bRows.some(([k2]) => k2 === k)) out.push([k, v, "—"]);
  if ((before.notes ?? "") !== (after.notes ?? "")) out.push(["Note", before.notes || "—", after.notes || "—"]);
  return out;
}

/** Build subject / text / html for a batch of changes (exported for tests). */
export function buildPlanChangesEmail({ patient, physio, added = [], edited = [], removed = [], plan = [] }) {
  const appUrl = resolveAppUrl();
  // Link to the login page (signs out anyone already signed in), then on to the patient dashboard.
  const loginUrl = `${appUrl.replace(/\/+$/, "")}/login.html?fresh=1&next=${encodeURIComponent("/index.html#dashboard")}`;
  const first = String(patient?.name ?? "there").split(" ")[0];
  const physioName = physio?.name ?? "Your physio";
  const edits = edited.map((e) => ({ ...e, rows: changedRows(e.before, e.after) })).filter((e) => e.rows.length);

  const counts = [
    added.length && `${added.length} new`,
    edits.length && `${edits.length} changed`,
    removed.length && `${removed.length} removed`,
  ].filter(Boolean);
  const subject =
    added.length && !edits.length && !removed.length
      ? `${physioName} set your exercise plan: ${plural(added.length, "new exercise")}`
      : `${physioName} updated your exercise plan (${counts.join(", ") || "no changes"})`;

  // ---- plain text ----
  const lines = [`Hi ${first},`, "", `${physioName} has updated your exercise plan.`];
  if (added.length) {
    lines.push("", `NEW EXERCISES (${added.length})`);
    for (const pr of added) {
      lines.push("", `• ${pr.exerciseName}`, ...summaryRows(pr).slice(1).map(([k, v]) => `  ${k}: ${v}`));
      const ins = EXERCISES[pr.exerciseKey]?.instructions;
      if (ins) lines.push(`  How to do it: ${ins}`);
      if (pr.notes) lines.push(`  Note from ${physioName}: "${pr.notes}"`);
    }
  }
  if (edits.length) {
    lines.push("", `CHANGED (${edits.length})`);
    for (const e of edits) lines.push("", `• ${e.after.exerciseName}`, ...e.rows.map(([k, a, b]) => `  ${k}: ${a} → ${b}`));
  }
  if (removed.length) {
    lines.push("", `REMOVED (${removed.length})`, ...removed.map((pr) => `• ${pr.exerciseName} (you no longer need to do this)`));
  }
  lines.push("", `YOUR PLAN NOW (${plan.length})`, ...(plan.length ? plan.map((pr) => `• ${pr.exerciseName}: ${shortLine(pr)}`) : ["• No exercises at the moment"]));
  lines.push("", `Start your exercises: ${loginUrl}`);
  const text = lines.join("\n");

  // ---- HTML ----
  const section = (title, color, body) =>
    `<h3 style="margin:22px 0 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:${color}">${esc(title)}</h3>${body}`;
  const table = (rows) =>
    `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 10px 6px 0;color:#6b778c;white-space:nowrap;vertical-align:top;border-bottom:1px solid #eef1f5">${esc(k)}</td><td style="padding:6px 0;font-weight:600;border-bottom:1px solid #eef1f5">${esc(v)}</td></tr>`
      )
      .join("")}</table>`;
  const card = (inner, border) => `<div style="border:1px solid ${border};border-radius:10px;padding:12px 14px;margin:0 0 10px">${inner}</div>`;

  const addedHtml = added
    .map((pr) => {
      const ex = EXERCISES[pr.exerciseKey] ?? {};
      return card(
        `<div style="font-size:16px;font-weight:700;margin-bottom:6px">🆕 ${esc(pr.exerciseName)}</div>${table(summaryRows(pr).slice(1))}` +
          (ex.instructions ? `<p style="margin:10px 0 0;font-size:13.5px"><b>How to do it:</b> ${esc(ex.instructions)}</p>` : "") +
          (pr.notes
            ? `<div style="margin:10px 0 0;padding:8px 10px;background:#fff7e6;border-left:3px solid #f2b84b;border-radius:4px;font-size:13.5px"><b>Note from ${esc(physioName)}:</b> “${esc(pr.notes)}”</div>`
            : ""),
        "#cfeee2"
      );
    })
    .join("");
  const editedHtml = edits
    .map((e) =>
      card(
        `<div style="font-size:15px;font-weight:700;margin-bottom:6px">✏️ ${esc(e.after.exerciseName)}</div>` +
          `<table style="width:100%;border-collapse:collapse;font-size:14px">${e.rows
            .map(
              ([k, a, b]) =>
                `<tr><td style="padding:5px 10px 5px 0;color:#6b778c;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:5px 0"><span style="color:#8f9bb0;text-decoration:line-through">${esc(a)}</span> → <b>${esc(b)}</b></td></tr>`
            )
            .join("")}</table>`,
        "#e3e7ee"
      )
    )
    .join("");
  const removedHtml = `<ul style="margin:0;padding-left:20px;font-size:14px">${removed
    .map((pr) => `<li style="margin:3px 0"><b>${esc(pr.exerciseName)}</b> <span style="color:#6b778c">: you no longer need to do this</span></li>`)
    .join("")}</ul>`;
  const planHtml = plan.length
    ? `<ul style="margin:0;padding-left:20px;font-size:14px">${plan
        .map((pr) => `<li style="margin:3px 0"><b>${esc(pr.exerciseName)}</b> <span style="color:#6b778c">· ${esc(shortLine(pr))}</span></li>`)
        .join("")}</ul>`
    : `<p style="margin:0;font-size:14px;color:#6b778c">No exercises at the moment.</p>`;

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:580px;margin:0 auto;color:#1c2330">
    <div style="background:#0f1218;color:#e8ecf3;padding:18px 22px;border-radius:12px 12px 0 0">
      <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#4fd1a0;font-weight:700">Exercise plan update</div>
      <div style="font-size:21px;font-weight:700;margin-top:4px">${esc(counts.join(" · ") || "Your plan")}</div>
      <div style="font-size:13px;color:#8f9bb0;margin-top:2px">from ${esc(physioName)}</div>
    </div>
    <div style="border:1px solid #e3e7ee;border-top:none;padding:18px 22px;border-radius:0 0 12px 12px">
      <p style="margin:0">Hi ${esc(first)},<br>${esc(physioName)} has updated your exercise plan. Here's what changed:</p>
      ${added.length ? section(`New exercises (${added.length})`, "#047857", addedHtml) : ""}
      ${edits.length ? section(`Changed (${edits.length})`, "#b45309", editedHtml) : ""}
      ${removed.length ? section(`Removed (${removed.length})`, "#be123c", removedHtml) : ""}
      ${section(`Your plan now (${plan.length})`, "#334155", planHtml)}
      <p style="margin:22px 0 4px;text-align:center">
        <a href="${esc(loginUrl)}" style="display:inline-block;background:#4fd1a0;color:#0f1218;text-decoration:none;font-weight:700;padding:11px 22px;border-radius:8px">Start your exercises</a>
      </p>
      <p style="margin:14px 0 0;font-size:12px;color:#8f9bb0;text-align:center">Follow the cave hills at your prescribed tempo, finish every rep, and collect coins along the way.</p>
    </div>
  </div>`;

  return { subject, text, html, physioName };
}

/**
 * Send ONE email for a batch of plan changes: what was added (full details), what changed
 * (old → new), what was removed, and the full plan afterwards.
 * Resolves to { sent, to?, skipped?, error? }; never throws, so mail can't block saving.
 */
export async function sendPlanChangesEmail(changes) {
  if (!emailConfigured()) return { sent: false, skipped: "Email not configured (set GMAIL_USER and GMAIL_APP_PASSWORD in .env)" };
  const to = process.env.EMAIL_TO || changes.patient?.email;
  if (!to) return { sent: false, skipped: "Patient has no email address (or set EMAIL_TO in .env)" };
  const { subject, text, html, physioName } = buildPlanChangesEmail(changes);
  try {
    await getTransporter().sendMail({ from: `"${physioName} via TheraPlay" <${process.env.GMAIL_USER}>`, to, subject, text, html });
    return { sent: true, to };
  } catch (err) {
    console.error("[mail] failed:", err.message);
    return { sent: false, error: err.message };
  }
}
