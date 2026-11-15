// Emails the patient a summary when a physio prescribes (or edits) an exercise.
// Sends through Gmail with an App Password. Configure in .env:
//   GMAIL_USER          the Gmail address that sends the email
//   GMAIL_APP_PASSWORD  a 16-character App Password (Google Account > Security > App passwords)
//   EMAIL_TO            optional: send every email here instead of the patient's own address (demo mode)
//   APP_URL             optional: link in the email (defaults to http://localhost:PORT)
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

/**
 * Send the prescription summary. kind: "new" | "updated".
 * Resolves to { sent, to?, skipped?, error? }; never throws, so a mail problem can't block a prescription.
 */
export async function sendPrescriptionEmail({ kind = "new", prescription: pr, patient, physio }) {
  if (!emailConfigured()) return { sent: false, skipped: "Email not configured (set GMAIL_USER and GMAIL_APP_PASSWORD in .env)" };
  const to = process.env.EMAIL_TO || patient?.email;
  if (!to) return { sent: false, skipped: "Patient has no email address (or set EMAIL_TO in .env)" };

  const ex = EXERCISES[pr.exerciseKey] ?? {};
  const appUrl = resolveAppUrl();
  // Link to the login page (signs out anyone already signed in), then on to the patient dashboard.
  const loginUrl = `${appUrl.replace(/\/+$/, "")}/login.html?fresh=1&next=${encodeURIComponent("/index.html#dashboard")}`;
  const first = String(patient?.name ?? "there").split(" ")[0];
  const physioName = physio?.name ?? "Your physio";
  const isNew = kind === "new";
  const subject = isNew ? `New exercise from ${physioName}: ${pr.exerciseName}` : `${physioName} updated your exercise: ${pr.exerciseName}`;
  const rows = summaryRows(pr);

  const text = [
    `Hi ${first},`,
    "",
    isNew ? `${physioName} has prescribed a new exercise for you.` : `${physioName} has updated one of your exercises.`,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(ex.instructions ? ["", `How to do it: ${ex.instructions}`] : []),
    ...(pr.notes ? ["", `Note from ${physioName}: "${pr.notes}"`] : []),
    "",
    `Start your exercises: ${loginUrl}`,
  ].join("\n");

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1c2330">
    <div style="background:#0f1218;color:#e8ecf3;padding:18px 22px;border-radius:12px 12px 0 0">
      <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#4fd1a0;font-weight:700">${isNew ? "New exercise" : "Exercise updated"}</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px">${esc(pr.exerciseName)}</div>
      <div style="font-size:13px;color:#8f9bb0;margin-top:2px">from ${esc(physioName)}</div>
    </div>
    <div style="border:1px solid #e3e7ee;border-top:none;padding:18px 22px;border-radius:0 0 12px 12px">
      <p style="margin:0 0 14px">Hi ${esc(first)},<br>${isNew ? `${esc(physioName)} has prescribed a new exercise for you.` : `${esc(physioName)} has updated one of your exercises.`} Here's your plan:</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${rows
          .map(
            ([k, v]) =>
              `<tr><td style="padding:7px 10px 7px 0;color:#6b778c;white-space:nowrap;vertical-align:top;border-bottom:1px solid #eef1f5">${esc(k)}</td><td style="padding:7px 0;font-weight:600;border-bottom:1px solid #eef1f5">${esc(v)}</td></tr>`
          )
          .join("")}
      </table>
      ${ex.instructions ? `<p style="margin:16px 0 0;font-size:14px"><b>How to do it:</b> ${esc(ex.instructions)}</p>` : ""}
      ${pr.notes ? `<div style="margin:14px 0 0;padding:10px 12px;background:#fff7e6;border-left:3px solid #f2b84b;border-radius:4px;font-size:14px"><b>Note from ${esc(physioName)}:</b> “${esc(pr.notes)}”</div>` : ""}
      <p style="margin:20px 0 4px;text-align:center">
        <a href="${esc(loginUrl)}" style="display:inline-block;background:#4fd1a0;color:#0f1218;text-decoration:none;font-weight:700;padding:11px 22px;border-radius:8px">Start your exercises</a>
      </p>
      <p style="margin:14px 0 0;font-size:12px;color:#8f9bb0;text-align:center">Follow the cave hills at your prescribed tempo, finish every rep, and collect coins along the way.</p>
    </div>
  </div>`;

  try {
    await getTransporter().sendMail({ from: `"${physioName} via TheraPlay" <${process.env.GMAIL_USER}>`, to, subject, text, html });
    return { sent: true, to };
  } catch (err) {
    console.error("[mail] failed:", err.message);
    return { sent: false, error: err.message };
  }
}
