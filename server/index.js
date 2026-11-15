// Express API + static file server. One process, one port, no CORS.
//
//   POST /api/login                          { username, password } -> user (no password)
//   GET  /api/exercises                      exercise catalogue (from src/exercises.js)
//   GET  /api/physios/:id/patients           patients belonging to a physio
//   GET  /api/patients/:id                   one patient
//   GET  /api/patients/:id/prescriptions     active prescriptions (?all=1 for inactive too)
//   POST /api/prescriptions                  create one (physio only; no email)
//   POST /api/patients/:id/plan-changes      apply add/edit/remove batch, then ONE summary email (physio)
//   PATCH /api/prescriptions/:id             edit sets/reps/tempo/etc. (physio only; exercise is fixed)
//   DELETE /api/prescriptions/:id            deactivate (physio only)
//   POST /api/sessions                       save a completed session (patient); adds its coins to users.coins
//   GET  /api/patients/:id/sessions          recent sessions, summaries only (?limit=20)
//   GET  /api/sessions/:id                   one full session including every rep
//   GET  /api/patients/:id/progress          aggregation: avg/best ROM per exercise per day
//
// Identity is a header, x-user-id, set by the client after login. This is intentionally
// not secure: hackathon demo with made-up accounts.

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ObjectId } from "mongodb";
import { connect, getDb, isMemory } from "./db.js";
import { seedDatabase } from "./seed.js";
import { EXERCISES } from "../src/exercises.js";
import { normaliseRep, summarise, normaliseGame, scorePerformance } from "./metrics.js";
import { sendPlanChangesEmail, emailConfigured } from "./mailer.js";
import { videoRouter } from "./videos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT) || 5173;

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- helpers ---------------------------------------------------------------
const oid = (s) => {
  try {
    return new ObjectId(String(s));
  } catch {
    return null;
  }
};
const publicUser = ({ password, ...u }) => u;
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

let dbReady = null;
function ensureDb() {
  if (!dbReady) {
    dbReady = connect().then(async (d) => {
      if (isMemory() || process.env.SEED_ON_START === "1") {
        // In-memory DB starts empty every time, so seed it here. For Atlas run `npm run seed` once.
        await seedDatabase(d);
      }
      return d;
    });
  }
  return dbReady;
}

/** Loads the requesting user from x-user-id. Optional: route decides if it's required. */
app.use(
  "/api",
  wrap(async (req, _res, next) => {
    await ensureDb();
    const id = oid(req.get("x-user-id"));
    req.user = id ? await getDb().collection("users").findOne({ _id: id }) : null;
    next();
  })
);
const requireRole = (role) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  if (role && req.user.role !== role) return res.status(403).json({ error: `Requires ${role} role` });
  next();
};

// ---- auth ------------------------------------------------------------------
app.post(
  "/api/login",
  wrap(async (req, res) => {
    const { username = "", password = "" } = req.body ?? {};
    const user = await getDb().collection("users").findOne({ username: String(username).trim().toLowerCase() });
    if (!user || user.password !== password) return res.status(401).json({ error: "Wrong username or password" });
    res.json(publicUser(user));
  })
);

// ---- exercises catalogue ---------------------------------------------------
app.get("/api/exercises", (_req, res) => {
  res.json(
    Object.entries(EXERCISES).map(([key, ex]) => ({
      key,
      name: ex.name,
      group: ex.group ?? "Other",
      instructions: ex.instructions,
      restAngle: ex.restAngle,
      targetAngle: ex.targetAngle,
    }))
  );
});

// ---- users -----------------------------------------------------------------
app.get(
  "/api/physios/:id/patients",
  requireRole(),
  wrap(async (req, res) => {
    const physioId = oid(req.params.id);
    if (!physioId) return res.status(400).json({ error: "Bad id" });
    const patients = await getDb().collection("users").find({ role: "patient", physioId }).sort({ name: 1 }).toArray();
    res.json(patients.map(publicUser));
  })
);

app.get(
  "/api/patients/:id",
  requireRole(),
  wrap(async (req, res) => {
    const u = await getDb().collection("users").findOne({ _id: oid(req.params.id), role: "patient" });
    if (!u) return res.status(404).json({ error: "Not found" });
    res.json(publicUser(u));
  })
);

// ---- prescriptions ---------------------------------------------------------
app.get(
  "/api/patients/:id/prescriptions",
  requireRole(),
  wrap(async (req, res) => {
    const patientId = oid(req.params.id);
    const filter = { patientId };
    if (!req.query.all) filter.active = true;
    const list = await getDb().collection("prescriptions").find(filter).sort({ createdAt: -1 }).toArray();
    res.json(list);
  })
);

/** Validate + clamp the editable fields of a prescription (shared by create and edit). */
function prescriptionFields(b, ex) {
  const durationWeeks = Math.max(1, Math.min(52, Number(b.durationWeeks) || 4));
  let angleOverrides = null;
  if (b.angleOverrides && typeof b.angleOverrides === "object") {
    angleOverrides = {};
    for (const k of ["restAngle", "targetAngle"]) {
      const v = Number(b.angleOverrides[k]);
      if (Number.isFinite(v) && v >= 0 && v <= 180 && v !== ex[k]) angleOverrides[k] = v;
    }
    if (!Object.keys(angleOverrides).length) angleOverrides = null;
  }
  const unlimited = Boolean(b.unlimited || b.reps === null || b.reps === "");
  return {
    sets: Math.max(1, Math.min(20, Number(b.sets) || 1)),
    reps: unlimited ? null : Math.max(1, Math.min(100, Number(b.reps) || 10)),
    unlimited,
    holdSeconds: Math.max(0, Math.min(60, Number(b.holdSeconds) || 0)),
    restSeconds: b.restSeconds === undefined || b.restSeconds === "" ? 60 : Math.max(0, Math.min(600, Number(b.restSeconds) || 0)),
    durationWeeks,
    daysPerWeek: Math.max(1, Math.min(7, Number(b.daysPerWeek) || 3)),
    timelinePhase: String(b.timelinePhase ?? "").slice(0, 100),
    tempo: ["slow", "medium", "fast"].includes(b.tempo) ? b.tempo : "slow",
    angleOverrides,
    notes: String(b.notes ?? "").slice(0, 500),
  };
}

app.post(
  "/api/prescriptions",
  requireRole("physio"),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const patientId = oid(b.patientId);
    const ex = EXERCISES[b.exerciseKey];
    if (!patientId) return res.status(400).json({ error: "patientId required" });
    if (!ex) return res.status(400).json({ error: `Unknown exerciseKey "${b.exerciseKey}"` });
    const fields = prescriptionFields(b, ex);
    const now = new Date();
    const startDate = b.startDate ? new Date(b.startDate) : now;
    const endDate = new Date(startDate.getTime() + fields.durationWeeks * 7 * 86400e3);
    const doc = {
      patientId,
      physioId: req.user._id,
      exerciseKey: b.exerciseKey,
      exerciseName: ex.name,
      ...fields,
      startDate,
      endDate,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    // No email here: the physio page batches changes and submits them through
    // POST /api/patients/:id/plan-changes, which sends a single summary email.
    const { insertedId } = await getDb().collection("prescriptions").insertOne(doc);
    res.status(201).json({ _id: insertedId, ...doc });
  })
);

// Apply a batch of plan changes (add / edit / remove) for one patient, then send ONE email
// summarising everything. Body: { add: [{exerciseKey, ...fields}], edit: [{id, ...fields}], remove: [id] }
// Everything is validated before anything is written, so a bad item can't half-apply the batch.
const EDITABLE_FIELDS = ["sets", "reps", "unlimited", "holdSeconds", "restSeconds", "durationWeeks", "daysPerWeek", "timelinePhase", "tempo", "angleOverrides", "notes"];
app.post(
  "/api/patients/:id/plan-changes",
  requireRole("physio"),
  wrap(async (req, res) => {
    const db = getDb();
    const col = db.collection("prescriptions");
    const patientId = oid(req.params.id);
    const patient = patientId && (await db.collection("users").findOne({ _id: patientId, role: "patient" }));
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    const b = req.body ?? {};
    const adds = Array.isArray(b.add) ? b.add.slice(0, 30) : [];
    const edits = Array.isArray(b.edit) ? b.edit.slice(0, 50) : [];
    const removes = Array.isArray(b.remove) ? b.remove.slice(0, 50) : [];
    if (!adds.length && !edits.length && !removes.length) return res.status(400).json({ error: "No changes to submit" });

    // ---- validate ----
    for (const a of adds) if (!EXERCISES[a?.exerciseKey]) return res.status(400).json({ error: `Unknown exercise "${a?.exerciseKey}"` });
    const ids = [...edits.map((e) => e?.id), ...removes].map(oid);
    if (ids.some((x) => !x)) return res.status(400).json({ error: "Bad prescription id" });
    const existing = await col.find({ _id: { $in: ids }, patientId, active: true }).toArray();
    const byId = new Map(existing.map((p) => [String(p._id), p]));
    for (const x of ids) if (!byId.has(String(x))) return res.status(409).json({ error: "One of the exercises was changed or stopped elsewhere. Reload and try again." });

    // ---- apply ----
    const now = new Date();
    const added = [];
    for (const a of adds) {
      const ex = EXERCISES[a.exerciseKey];
      const fields = prescriptionFields(a, ex);
      const doc = {
        patientId,
        physioId: req.user._id,
        exerciseKey: a.exerciseKey,
        exerciseName: ex.name,
        ...fields,
        startDate: now,
        endDate: new Date(now.getTime() + fields.durationWeeks * 7 * 86400e3),
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      const { insertedId } = await col.insertOne(doc);
      added.push({ _id: insertedId, ...doc });
    }
    const removeSet = new Set(removes.map(String));
    const edited = [];
    for (const e of edits) {
      if (removeSet.has(String(e.id))) continue; // removing wins over editing
      const before = byId.get(String(e.id));
      const ex = EXERCISES[before.exerciseKey];
      const merged = { ...before };
      for (const k of EDITABLE_FIELDS) if (k in e) merged[k] = e[k];
      const fields = prescriptionFields(merged, ex);
      const startDate = before.startDate ? new Date(before.startDate) : new Date(before.createdAt);
      const update = { ...fields, endDate: new Date(startDate.getTime() + fields.durationWeeks * 7 * 86400e3), updatedAt: now };
      await col.updateOne({ _id: before._id }, { $set: update });
      edited.push({ before, after: { ...before, ...update } });
    }
    const removed = removes.map((id) => byId.get(String(id)));
    if (removed.length) await col.updateMany({ _id: { $in: removed.map((p) => p._id) } }, { $set: { active: false, updatedAt: now } });

    // ---- one email ----
    const plan = await col.find({ patientId, active: true }).sort({ createdAt: 1 }).toArray();
    const email = await sendPlanChangesEmail({ patient, physio: req.user, added, edited, removed, plan });
    if (email.sent) console.log(`[mail] plan update sent to ${email.to} (+${added.length} ~${edited.length} -${removed.length})`);
    else console.log(`[mail] not sent: ${email.skipped ?? email.error}`);
    res.json({ added: added.length, edited: edited.length, removed: removed.length, email });
  })
);

// Edit an active prescription. The exercise (key/name), patient and start date can't change;
// any editable field left out of the body keeps its current value.
app.patch(
  "/api/prescriptions/:id",
  requireRole("physio"),
  wrap(async (req, res) => {
    const col = getDb().collection("prescriptions");
    const _id = oid(req.params.id);
    const existing = _id && (await col.findOne({ _id, active: true }));
    if (!existing) return res.status(404).json({ error: "Not found" });
    const ex = EXERCISES[existing.exerciseKey];
    if (!ex) return res.status(400).json({ error: `Unknown exerciseKey "${existing.exerciseKey}"` });

    const b = req.body ?? {};
    const editable = ["sets", "reps", "unlimited", "holdSeconds", "restSeconds", "durationWeeks", "daysPerWeek", "timelinePhase", "tempo", "angleOverrides", "notes"];
    const merged = { ...existing };
    for (const k of editable) if (k in b) merged[k] = b[k];
    const fields = prescriptionFields(merged, ex);
    const startDate = existing.startDate ? new Date(existing.startDate) : new Date(existing.createdAt);
    const endDate = new Date(startDate.getTime() + fields.durationWeeks * 7 * 86400e3);
    const update = { ...fields, endDate, updatedAt: new Date() };
    await col.updateOne({ _id }, { $set: update });
    res.json({ ...existing, ...update });
  })
);

app.delete(
  "/api/prescriptions/:id",
  requireRole("physio"),
  wrap(async (req, res) => {
    const r = await getDb()
      .collection("prescriptions")
      .updateOne({ _id: oid(req.params.id) }, { $set: { active: false, updatedAt: new Date() } });
    if (!r.matchedCount) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  })
);

// ---- sessions --------------------------------------------------------------
app.post(
  "/api/sessions",
  requireRole(),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const patientId = req.user.role === "patient" ? req.user._id : oid(b.patientId);
    if (!patientId) return res.status(400).json({ error: "patientId required" });
    const ex = EXERCISES[b.exerciseKey];
    if (!ex) return res.status(400).json({ error: `Unknown exerciseKey "${b.exerciseKey}"` });

    const reps = Array.isArray(b.reps) ? b.reps.slice(0, 500).map(normaliseRep) : [];
    if (!reps.length) return res.status(400).json({ error: "No reps" });

    const prescriptionId = oid(b.prescriptionId);
    const patient = await getDb().collection("users").findOne({ _id: patientId });
    const startedAt = b.startedAt ? new Date(b.startedAt) : new Date();
    const endedAt = new Date();
    const setsCompleted = Math.max(0, Number(b.setsCompleted) || 0);
    const setsPrescribed = b.setsPrescribed != null ? Number(b.setsPrescribed) : null;
    const completedEarly = setsPrescribed != null && setsCompleted < setsPrescribed;
    const prescription = prescriptionId ? await getDb().collection("prescriptions").findOne({ _id: prescriptionId }) : null;
    const game = normaliseGame(b.game);
    const perf = scorePerformance(reps, {
      tempo: prescription?.tempo ?? "slow",
      setsPrescribed: prescription?.sets ?? setsPrescribed,
      repsPerSet: prescription?.reps ?? null,
      game,
    });
    const doc = {
      patientId,
      physioId: patient?.physioId ?? null,
      prescriptionId,
      exerciseKey: b.exerciseKey,
      exerciseName: ex.name,
      startedAt,
      endedAt,
      setsCompleted,
      setsPrescribed,
      completedEarly,
      reps,
      summary: summarise(reps, startedAt, endedAt),
      game,
      performance: perf,
      source: "app",
    };
    const { insertedId } = await getDb().collection("sessions").insertOne(doc);
    // Running coin balance on the patient: users.coins (each session's coins also stay on the session).
    let coinTotal = null;
    if (game?.coins) {
      const u = await getDb()
        .collection("users")
        .findOneAndUpdate({ _id: patientId }, { $inc: { coins: game.coins } }, { returnDocument: "after", projection: { coins: 1 } });
      coinTotal = (u?.value ?? u)?.coins ?? null; // driver v5 returns { value }, v6 returns the doc
    }
    res.status(201).json({ _id: insertedId, ...doc, coinTotal });
  })
);

app.get(
  "/api/sessions/:id",
  requireRole(),
  wrap(async (req, res) => {
    const s = await getDb().collection("sessions").findOne({ _id: oid(req.params.id) });
    if (!s) return res.status(404).json({ error: "Not found" });
    res.json(s);
  })
);

app.get(
  "/api/patients/:id/sessions",
  requireRole(),
  wrap(async (req, res) => {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const list = await getDb()
      .collection("sessions")
      .find({ patientId: oid(req.params.id) }, { projection: { reps: 0 } }) // summaries only; reps are large
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
    res.json(list);
  })
);

/** Aggregation: per exercise, per day -> avg ROM, best ROM, reps, cue count. Powers the progress chart. */
app.get(
  "/api/patients/:id/progress",
  requireRole(),
  wrap(async (req, res) => {
    const patientId = oid(req.params.id);
    const days = Math.min(365, Number(req.query.days) || 30);
    const since = new Date(Date.now() - days * 86400e3);
    const rows = await getDb()
      .collection("sessions")
      .aggregate([
        { $match: { patientId, startedAt: { $gte: since } } },
        { $unwind: "$reps" },
        {
          $group: {
            _id: { exerciseKey: "$exerciseKey", day: { $dateTrunc: { date: "$startedAt", unit: "day" } } },
            exerciseName: { $first: "$exerciseName" },
            avgRom: { $avg: "$reps.rom" },
            bestRom: { $max: "$reps.rom" },
            avgPeakAngle: { $avg: "$reps.peakAngle" },
            avgDurationMs: { $avg: "$reps.durationMs" },
            avgConcentricMs: { $avg: "$reps.concentricMs" },
            avgEccentricMs: { $avg: "$reps.eccentricMs" },
            avgHoldMs: { $avg: "$reps.holdMs" },
            reps: { $sum: 1 },
            cues: { $sum: { $size: "$reps.cues" } },
            sessions: { $addToSet: "$_id" },
          },
        },
        {
          $project: {
            _id: 0,
            exerciseKey: "$_id.exerciseKey",
            exerciseName: 1,
            day: "$_id.day",
            avgRom: { $round: ["$avgRom", 2] },
            bestRom: 1,
            avgPeakAngle: { $round: ["$avgPeakAngle", 0] },
            avgDurationMs: { $round: ["$avgDurationMs", 0] },
            avgConcentricMs: { $round: ["$avgConcentricMs", 0] },
            avgEccentricMs: { $round: ["$avgEccentricMs", 0] },
            avgHoldMs: { $round: ["$avgHoldMs", 0] },
            reps: 1,
            cues: 1,
            sessions: { $size: "$sessions" },
          },
        },
        { $sort: { exerciseKey: 1, day: 1 } },
      ])
      .toArray();
    res.json(rows);
  })
);

// ---- form-review videos (consented, chunked, auto-expiring; see videos.js) ----
app.use("/api", videoRouter({ requireRole, exercises: EXERCISES }));

// ---- static + errors -------------------------------------------------------
app.use(express.static(ROOT, { index: "login.html", extensions: ["html"] }));
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

if (!process.env.VERCEL) {
  await ensureDb();
  app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}  (login page)`);
    console.log(
      emailConfigured()
        ? `[mail] prescription emails ON (from ${process.env.GMAIL_USER}${process.env.EMAIL_TO ? `, all sent to ${process.env.EMAIL_TO}` : ""})`
        : "[mail] prescription emails OFF (set GMAIL_USER and GMAIL_APP_PASSWORD in .env)"
    );
  });
}

export default app;
