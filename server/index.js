// Express API + static file server. One process, one port, no CORS.
//
//   POST /api/login                          { username, password } -> user (no password)
//   GET  /api/exercises                      exercise catalogue (from src/exercises.js)
//   GET  /api/physios/:id/patients           patients belonging to a physio
//   GET  /api/patients/:id                   one patient
//   GET  /api/patients/:id/prescriptions     active prescriptions (?all=1 for inactive too)
//   POST /api/prescriptions                  create (physio only)
//   DELETE /api/prescriptions/:id            deactivate (physio only)
//   POST /api/sessions                       save a completed session (patient)
//   GET  /api/patients/:id/sessions          recent sessions (?limit=20)
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

/** Loads the requesting user from x-user-id. Optional: route decides if it's required. */
app.use(
  "/api",
  wrap(async (req, _res, next) => {
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

app.post(
  "/api/prescriptions",
  requireRole("physio"),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const patientId = oid(b.patientId);
    const ex = EXERCISES[b.exerciseKey];
    if (!patientId) return res.status(400).json({ error: "patientId required" });
    if (!ex) return res.status(400).json({ error: `Unknown exerciseKey "${b.exerciseKey}"` });
    const sets = Math.max(1, Math.min(20, Number(b.sets) || 1));
    const reps = Math.max(1, Math.min(100, Number(b.reps) || 10));
    const holdSeconds = Math.max(0, Math.min(60, Number(b.holdSeconds) || 0));
    let angleOverrides = null;
    if (b.angleOverrides && typeof b.angleOverrides === "object") {
      angleOverrides = {};
      for (const k of ["restAngle", "targetAngle"]) {
        const v = Number(b.angleOverrides[k]);
        if (Number.isFinite(v) && v >= 0 && v <= 180 && v !== ex[k]) angleOverrides[k] = v;
      }
      if (!Object.keys(angleOverrides).length) angleOverrides = null;
    }
    const now = new Date();
    const doc = {
      patientId,
      physioId: req.user._id,
      exerciseKey: b.exerciseKey,
      exerciseName: ex.name,
      sets,
      reps,
      holdSeconds,
      angleOverrides,
      notes: String(b.notes ?? "").slice(0, 500),
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    const { insertedId } = await getDb().collection("prescriptions").insertOne(doc);
    res.status(201).json({ _id: insertedId, ...doc });
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

    const reps = Array.isArray(b.reps)
      ? b.reps.slice(0, 500).map((r, i) => ({
          n: i + 1,
          rom: +Math.max(0, Math.min(1.5, Number(r.rom) || 0)).toFixed(2),
          durationMs: Math.round(Number(r.durationMs) || 0),
          holdMs: Math.round(Number(r.holdMs) || 0),
          cues: Array.isArray(r.cues) ? r.cues.slice(0, 10).map(String) : [],
        }))
      : [];
    if (!reps.length) return res.status(400).json({ error: "No reps" });

    const prescriptionId = oid(b.prescriptionId);
    const patient = await getDb().collection("users").findOne({ _id: patientId });
    const startedAt = b.startedAt ? new Date(b.startedAt) : new Date();
    const doc = {
      patientId,
      physioId: patient?.physioId ?? null,
      prescriptionId,
      exerciseKey: b.exerciseKey,
      exerciseName: ex.name,
      startedAt,
      endedAt: new Date(),
      setsCompleted: Math.max(0, Number(b.setsCompleted) || 0),
      reps,
      summary: {
        repCount: reps.length,
        avgRom: +(reps.reduce((s, r) => s + r.rom, 0) / reps.length).toFixed(2),
        bestRom: +Math.max(...reps.map((r) => r.rom)).toFixed(2),
        cueCount: reps.reduce((s, r) => s + r.cues.length, 0),
      },
      source: "app",
    };
    const { insertedId } = await getDb().collection("sessions").insertOne(doc);
    res.status(201).json({ _id: insertedId, ...doc });
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

// ---- static + errors -------------------------------------------------------
app.use(express.static(ROOT, { index: "login.html", extensions: ["html"] }));
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const db = await connect();
if (isMemory() || process.env.SEED_ON_START === "1") {
  // In-memory DB starts empty every time, so seed it here. For Atlas run `npm run seed` once.
  await seedDatabase(db);
}
app.listen(PORT, () => console.log(`[server] http://localhost:${PORT}  (login page)`));
