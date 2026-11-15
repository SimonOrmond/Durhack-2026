// Form-review videos: a patient records one set (only after explicit consent), previews it,
// and sends it to their physio, who can watch it, leave feedback and delete it.
//
// Storage fits MongoDB Atlas free tier (M0, 512 MB) and Vercel's ~4.5 MB request/response cap:
//   videos       { patientId, physioId, prescriptionId, exerciseKey, exerciseName, setNumber, mode,
//                  mimeType, size, durationMs, chunkCount, status, consent, feedback, createdAt, expiresAt }
//   videoChunks  { videoId, n, data: Binary, expiresAt }   ≤ CHUNK_BYTES each
// The client uploads and downloads one chunk per request. Both collections have a TTL index on
// expiresAt, so clips delete themselves after RETENTION_DAYS. A global cap stops new uploads
// before the free tier fills up.

import express from "express";
import { Binary, ObjectId } from "mongodb";
import { getDb } from "./db.js";

export const VIDEO_LIMITS = {
  RETENTION_DAYS: 30,
  MAX_BYTES: 8 * 1024 * 1024, // per clip (90 s at ~300 kbps is ~3.4 MB)
  MAX_DURATION_MS: 95_000,
  CHUNK_BYTES: 1.5 * 1024 * 1024, // well under Vercel's 4.5 MB body limit
  TOTAL_CAP_BYTES: 300 * 1024 * 1024, // leave room in the 512 MB free tier for everything else
  MAX_PER_PATIENT: 20,
};

const oid = (s) => {
  try {
    return new ObjectId(String(s));
  } catch {
    return null;
  }
};
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const videos = () => getDb().collection("videos");
const chunks = () => getDb().collection("videoChunks");

let indexesReady = null;
function ensureIndexes() {
  indexesReady ??= Promise.all([
    videos().createIndex({ patientId: 1, createdAt: -1 }),
    videos().createIndex({ physioId: 1, status: 1 }),
    videos().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    chunks().createIndex({ videoId: 1, n: 1 }, { unique: true }),
    chunks().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]).catch((err) => {
    indexesReady = null;
    throw err;
  });
  return indexesReady;
}

/** Who may see a video: the patient who recorded it, or that patient's physio. */
function canView(user, v) {
  if (!user || !v) return false;
  if (user.role === "patient") return String(v.patientId) === String(user._id);
  if (user.role === "physio") return String(v.physioId) === String(user._id);
  return false;
}

const publicVideo = (v) => ({
  _id: v._id,
  patientId: v.patientId,
  physioId: v.physioId,
  prescriptionId: v.prescriptionId,
  exerciseKey: v.exerciseKey,
  exerciseName: v.exerciseName,
  setNumber: v.setNumber,
  mode: v.mode,
  mimeType: v.mimeType,
  size: v.size,
  durationMs: v.durationMs,
  chunkCount: v.chunkCount,
  status: v.status,
  consent: v.consent,
  feedback: v.feedback ?? null,
  reviewedAt: v.reviewedAt ?? null,
  createdAt: v.createdAt,
  expiresAt: v.expiresAt,
});

async function deleteVideo(_id) {
  await chunks().deleteMany({ videoId: _id });
  await videos().deleteOne({ _id });
}

export function videoRouter({ requireRole, exercises }) {
  const r = express.Router();
  const needUser = requireRole();

  r.use(wrap(async (_req, _res, next) => {
    await ensureIndexes();
    next();
  }));

  // Limits for the client (so the recorder knows the caps).
  r.get("/videos/limits", (_req, res) => res.json(VIDEO_LIMITS));

  // 1) Patient starts an upload. Requires explicit consent captured in the UI.
  r.post(
    "/videos",
    requireRole("patient"),
    wrap(async (req, res) => {
      const b = req.body ?? {};
      if (b.consent?.given !== true || !b.consent?.text) {
        return res.status(400).json({ error: "Recording consent is required before a video can be sent." });
      }
      const size = Math.round(Number(b.size) || 0);
      const durationMs = Math.round(Number(b.durationMs) || 0);
      if (size <= 0 || size > VIDEO_LIMITS.MAX_BYTES) return res.status(400).json({ error: `Video must be under ${VIDEO_LIMITS.MAX_BYTES / 1048576} MB.` });
      if (durationMs > VIDEO_LIMITS.MAX_DURATION_MS) return res.status(400).json({ error: "Video is too long." });
      const mimeType = String(b.mimeType || "").split(";")[0];
      if (!/^video\/(webm|mp4)$/.test(mimeType)) return res.status(400).json({ error: "Unsupported video format." });
      if (!req.user.physioId) return res.status(400).json({ error: "You don't have a physio to send this to." });

      // Free-tier guards: overall cap and per-patient cap.
      const [{ total = 0 } = {}] = await videos().aggregate([{ $group: { _id: null, total: { $sum: "$size" } } }]).toArray();
      if (total + size > VIDEO_LIMITS.TOTAL_CAP_BYTES) {
        return res.status(507).json({ error: "Video storage is full. Ask your physio to delete reviewed videos." });
      }
      const mine = await videos().countDocuments({ patientId: req.user._id });
      if (mine >= VIDEO_LIMITS.MAX_PER_PATIENT) {
        return res.status(429).json({ error: `You can keep up to ${VIDEO_LIMITS.MAX_PER_PATIENT} videos. Delete an old one first.` });
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + VIDEO_LIMITS.RETENTION_DAYS * 86400e3);
      const ex = exercises[b.exerciseKey];
      const doc = {
        patientId: req.user._id,
        physioId: req.user.physioId,
        prescriptionId: oid(b.prescriptionId),
        exerciseKey: ex ? b.exerciseKey : null,
        exerciseName: ex?.name ?? "Exercise",
        setNumber: Math.max(1, Math.round(Number(b.setNumber) || 1)),
        mode: b.mode === "skeleton" ? "skeleton" : "camera",
        mimeType,
        size,
        durationMs,
        chunkCount: Math.ceil(size / VIDEO_LIMITS.CHUNK_BYTES),
        status: "uploading",
        consent: {
          given: true,
          text: String(b.consent.text).slice(0, 1000),
          at: b.consent.at ? new Date(b.consent.at) : now,
          userAgent: String(req.get("user-agent") || "").slice(0, 200),
        },
        createdAt: now,
        expiresAt,
      };
      const { insertedId } = await videos().insertOne(doc);
      res.status(201).json({ _id: insertedId, chunkCount: doc.chunkCount, chunkBytes: VIDEO_LIMITS.CHUNK_BYTES });
    })
  );

  // 2) Patient uploads chunk n (raw bytes).
  r.put(
    "/videos/:id/chunks/:n",
    requireRole("patient"),
    express.raw({ type: "application/octet-stream", limit: Math.ceil(VIDEO_LIMITS.CHUNK_BYTES) + 1024 }),
    wrap(async (req, res) => {
      const _id = oid(req.params.id);
      const n = Number(req.params.n);
      const v = _id && (await videos().findOne({ _id }));
      if (!v || String(v.patientId) !== String(req.user._id)) return res.status(404).json({ error: "Not found" });
      if (v.status !== "uploading") return res.status(409).json({ error: "Upload already finished" });
      if (!Number.isInteger(n) || n < 0 || n >= v.chunkCount) return res.status(400).json({ error: "Bad chunk number" });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Empty chunk" });
      await chunks().updateOne(
        { videoId: _id, n },
        { $set: { videoId: _id, n, data: new Binary(req.body), expiresAt: v.expiresAt } },
        { upsert: true }
      );
      res.json({ ok: true, n });
    })
  );

  // 3) Patient finishes the upload: every chunk must be there.
  r.post(
    "/videos/:id/complete",
    requireRole("patient"),
    wrap(async (req, res) => {
      const _id = oid(req.params.id);
      const v = _id && (await videos().findOne({ _id }));
      if (!v || String(v.patientId) !== String(req.user._id)) return res.status(404).json({ error: "Not found" });
      const have = await chunks().countDocuments({ videoId: _id });
      if (have !== v.chunkCount) return res.status(400).json({ error: `Upload incomplete (${have}/${v.chunkCount} parts)` });
      await videos().updateOne({ _id }, { $set: { status: "submitted", submittedAt: new Date() } });
      res.json({ ok: true });
    })
  );

  // List a patient's videos (the patient themself, or their physio).
  r.get(
    "/patients/:id/videos",
    needUser,
    wrap(async (req, res) => {
      const patientId = oid(req.params.id);
      if (req.user.role === "patient" && String(req.user._id) !== String(patientId)) return res.status(403).json({ error: "Forbidden" });
      const filter = { patientId, status: { $in: ["submitted", "reviewed"] } };
      if (req.user.role === "physio") filter.physioId = req.user._id;
      const list = await videos().find(filter).sort({ createdAt: -1 }).limit(50).toArray();
      res.json(list.map(publicVideo));
    })
  );

  // Download chunk n (the client joins them into one playable Blob).
  r.get(
    "/videos/:id/chunks/:n",
    needUser,
    wrap(async (req, res) => {
      const _id = oid(req.params.id);
      const v = _id && (await videos().findOne({ _id }));
      if (!canView(req.user, v)) return res.status(404).json({ error: "Not found" });
      const c = await chunks().findOne({ videoId: _id, n: Number(req.params.n) });
      if (!c) return res.status(404).json({ error: "Missing part" });
      res.set("content-type", "application/octet-stream");
      res.set("cache-control", "private, no-store");
      res.send(Buffer.from(c.data.buffer));
    })
  );

  // Physio feedback / mark reviewed.
  r.patch(
    "/videos/:id",
    requireRole("physio"),
    wrap(async (req, res) => {
      const _id = oid(req.params.id);
      const v = _id && (await videos().findOne({ _id }));
      if (!canView(req.user, v)) return res.status(404).json({ error: "Not found" });
      const update = { status: "reviewed", reviewedAt: new Date(), feedback: String(req.body?.feedback ?? "").slice(0, 1000) };
      await videos().updateOne({ _id }, { $set: update });
      res.json(publicVideo({ ...v, ...update }));
    })
  );

  // Delete: the patient can withdraw their video, the physio can delete after review.
  r.delete(
    "/videos/:id",
    needUser,
    wrap(async (req, res) => {
      const _id = oid(req.params.id);
      const v = _id && (await videos().findOne({ _id }));
      if (!canView(req.user, v)) return res.status(404).json({ error: "Not found" });
      await deleteVideo(_id);
      res.json({ ok: true });
    })
  );

  // Storage used, for the physio dashboard.
  r.get(
    "/videos/storage",
    requireRole("physio"),
    wrap(async (_req, res) => {
      const [{ total = 0, count = 0 } = {}] = await videos()
        .aggregate([{ $group: { _id: null, total: { $sum: "$size" }, count: { $sum: 1 } } }])
        .toArray();
      res.json({ usedBytes: total, count, capBytes: VIDEO_LIMITS.TOTAL_CAP_BYTES });
    })
  );

  return r;
}
