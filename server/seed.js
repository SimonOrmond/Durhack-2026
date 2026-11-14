// Seeds made-up physios, patients, prescriptions and a few past sessions.
// Usage: npm run seed            (upserts users, adds prescriptions/sessions if missing)
//        npm run seed -- --reset (drops the three collections first)
import { pathToFileURL } from "node:url";
import { connect, close } from "./db.js";
import { EXERCISES } from "../src/exercises.js";
import { summarise } from "./metrics.js";

const PHYSIOS = [
  { username: "dr.khan", password: "physio", name: "Dr Amira Khan", role: "physio" },
  { username: "dr.lee", password: "physio", name: "Dr Sam Lee", role: "physio" },
];

const PATIENTS = [
  { username: "alice", name: "Alice Turner", physio: "dr.khan", condition: "Post total knee replacement (6 weeks)" },
  { username: "bob", name: "Bob Okafor", physio: "dr.khan", condition: "Frozen shoulder (right)" },
  { username: "chen", name: "Chen Wei", physio: "dr.khan", condition: "ACL reconstruction (12 weeks)" },
  { username: "dana", name: "Dana Petrova", physio: "dr.lee", condition: "Hip osteoarthritis" },
  { username: "eve", name: "Eve Mensah", physio: "dr.lee", condition: "Lower back pain" },
  { username: "femi", name: "Femi Adeyemi", physio: "dr.lee", condition: "Rotator cuff repair" },
].map((p) => ({ ...p, password: "patient", role: "patient" }));

// patient username -> exercises to prescribe
const PLANS = {
  alice: [
    { exerciseKey: "heelSlide", sets: 3, reps: 10, holdSeconds: 2, durationWeeks: 6, daysPerWeek: 5, timelinePhase: "Early Phase (Wks 1–6)", notes: "Go as far as comfortable, no forcing." },
    { exerciseKey: "straightLegRaise", sets: 3, reps: 8, holdSeconds: 3, durationWeeks: 4, daysPerWeek: 4, timelinePhase: "Quads Activation (Wks 1–4)" },
    { exerciseKey: "kneeExtension", sets: 2, reps: 12, durationWeeks: 4, daysPerWeek: 3, timelinePhase: "Extension ROM (Wks 1–4)" },
  ],
  bob: [
    { exerciseKey: "shoulderFlexion", sets: 3, reps: 8, holdSeconds: 2, durationWeeks: 6, daysPerWeek: 4, timelinePhase: "Flexion Recovery (Wks 1–6)", angleOverrides: { targetAngle: 110 }, notes: "Target reduced to 110° for now." },
    { exerciseKey: "shoulderRaise", sets: 3, reps: 8, durationWeeks: 4, daysPerWeek: 3, timelinePhase: "Elevation Phase (Wks 1–4)", angleOverrides: { targetAngle: 100 } },
  ],
  chen: [
    { exerciseKey: "squat", sets: 3, reps: 10, durationWeeks: 8, daysPerWeek: 4, timelinePhase: "Strength Phase (Wks 1–8)" },
    { exerciseKey: "straightLegRaise", sets: 2, reps: 12, durationWeeks: 4, daysPerWeek: 3, timelinePhase: "Early Phase (Wks 1–4)" },
  ],
  dana: [
    { exerciseKey: "hipAbduction", sets: 3, reps: 10, holdSeconds: 2, durationWeeks: 6, daysPerWeek: 4, timelinePhase: "Abductor Control (Wks 1–6)" },
    { exerciseKey: "gluteBridge", sets: 3, reps: 10, holdSeconds: 3, durationWeeks: 6, daysPerWeek: 3, timelinePhase: "Pelvic Stability (Wks 1–6)" },
  ],
  eve: [{ exerciseKey: "gluteBridge", sets: 3, reps: 12, holdSeconds: 5, durationWeeks: 4, daysPerWeek: 5, timelinePhase: "Core Stability (Wks 1–4)" }],
  femi: [
    { exerciseKey: "rcTableSlideStage1", sets: 3, reps: 8, holdSeconds: 2, durationWeeks: 2, daysPerWeek: 5, timelinePhase: "Stage 1 (Weeks 0–2)", notes: "Stage 1 (Weeks 0-2): Keep movement minimal, smooth and pain-free (35° max)." },
    { exerciseKey: "rcExternalRotationStage2", sets: 2, reps: 8, holdSeconds: 2, durationWeeks: 4, daysPerWeek: 3, timelinePhase: "Stage 2 (Weeks 3–6)", notes: "Tuck a rolled towel under the armpit; keep rotation gentle." },
  ],
};

// Representative form cue per exercise for the fake history (matches the real cue wording).
const SEED_CUES = {
  squat: "Keep your chest up",
  curl: "Keep your elbow tucked in",
  shoulderRaise: "Keep your torso upright",
  shoulderFlexion: "Don't lean back, keep your trunk still",
  hipAbduction: "Stay upright, don't lean away from the leg",
  straightLegRaise: "Keep your knee locked straight",
  rcTableSlideStage1: "Keep your back straight, don't lean back",
  rcFlexionStage2: "Don't lean back to lift your arm",
  rcFlexionStage3: "Keep your arm straight",
  rcScaptionStage3: "Stay upright, don't lean sideways",
  rcExternalRotationStage2: "Keep your elbow glued to your ribs",
  rcExternalRotationStage3: "Keep your elbow glued to your ribs",
  rcStandingRowStage3: "Keep your elbows lower, don't flare out",
};

export async function seedDatabase(db, { reset = false } = {}) {
  const users = db.collection("users");
  const prescriptions = db.collection("prescriptions");
  const sessions = db.collection("sessions");

  if (reset) {
    await Promise.all([users.deleteMany({}), prescriptions.deleteMany({}), sessions.deleteMany({})]);
    console.log("[seed] cleared users, prescriptions, sessions");
  }

  // Users (upsert by username so re-running is safe)
  const now = new Date();
  for (const p of PHYSIOS) {
    await users.updateOne({ username: p.username }, { $set: { ...p, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
  }
  const physioIds = Object.fromEntries((await users.find({ role: "physio" }).toArray()).map((u) => [u.username, u._id]));
  for (const p of PATIENTS) {
    const { physio, ...doc } = p;
    await users.updateOne(
      { username: p.username },
      { $set: { ...doc, physioId: physioIds[physio], updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );
  }
  const patientDocs = await users.find({ role: "patient" }).toArray();
  const patientIds = Object.fromEntries(patientDocs.map((u) => [u.username, u._id]));
  console.log(`[seed] ${PHYSIOS.length} physios, ${PATIENTS.length} patients`);

  // Prescriptions + a few past sessions (only when the patient has none yet)
  let nPres = 0, nSess = 0;
  for (const patient of patientDocs) {
    if (await prescriptions.countDocuments({ patientId: patient._id })) continue;
    for (const plan of PLANS[patient.username] ?? []) {
      const ex = EXERCISES[plan.exerciseKey];
      const durationWeeks = plan.durationWeeks ?? 4;
      const daysPerWeek = plan.daysPerWeek ?? 3;
      const startDate = new Date(now - 7 * 86400e3);
      const endDate = new Date(startDate.getTime() + durationWeeks * 7 * 86400e3);
      const pres = {
        patientId: patient._id,
        physioId: patient.physioId,
        exerciseKey: plan.exerciseKey,
        exerciseName: ex.name,
        sets: plan.sets,
        reps: plan.reps,
        holdSeconds: plan.holdSeconds ?? 0,
        restSeconds: plan.restSeconds ?? 60,
        durationWeeks,
        daysPerWeek,
        timelinePhase: plan.timelinePhase ?? `Phase 1 (${durationWeeks} wks)`,
        startDate,
        endDate,
        angleOverrides: plan.angleOverrides ?? null,
        notes: plan.notes ?? "",
        active: true,
        createdAt: startDate,
        updatedAt: now,
      };
      const { insertedId } = await prescriptions.insertOne(pres);
      nPres++;

      // Fake history: one session a day for the last 5 days. ROM improves, tempo gets more
      // controlled (eccentric phase lengthens), form cues become rarer.
      const target = plan.angleOverrides?.targetAngle ?? ex.targetAngle;
      const cueText = SEED_CUES[plan.exerciseKey] ?? null;
      for (let d = 5; d >= 1; d--) {
        const startedAt = new Date(now - d * 86400e3 - 3600e3);
        const progressDay = 5 - d; // 0..4
        const repsArr = [];
        let t = 0;
        for (let i = 0; i < plan.reps; i++) {
          const rom = Math.min(1.1, 0.6 + progressDay * 0.07 + (Math.random() - 0.5) * 0.12);
          const concentricMs = Math.round(900 + Math.random() * 400);
          const eccentricMs = Math.round(900 + progressDay * 180 + Math.random() * 500);
          const holdMs = Math.round((plan.holdSeconds ?? 0) * 1000 * (0.7 + Math.random() * 0.4));
          const restBeforeMs = i === 0 ? null : Math.round(1200 + Math.random() * 1500);
          const durationMs = concentricMs + holdMs + eccentricMs;
          repsArr.push({
            n: i + 1,
            rom: +rom.toFixed(2),
            peakAngle: Math.round(ex.restAngle + (target - ex.restAngle) * rom),
            durationMs,
            concentricMs,
            eccentricMs,
            holdMs,
            restBeforeMs,
            cues: cueText && Math.random() < 0.25 - progressDay * 0.04 ? [cueText] : [],
          });
          t += durationMs + (restBeforeMs ?? 0);
        }
        const endedAt = new Date(startedAt.getTime() + t);
        await sessions.insertOne({
          patientId: patient._id,
          physioId: patient.physioId,
          prescriptionId: insertedId,
          exerciseKey: plan.exerciseKey,
          exerciseName: ex.name,
          startedAt,
          endedAt,
          setsCompleted: 1,
          reps: repsArr,
          summary: summarise(repsArr, startedAt, endedAt),
          source: "seed",
        });
        nSess++;
      }
    }
  }
  console.log(`[seed] ${nPres} prescriptions, ${nSess} sessions added`);
  console.log("\nAccounts (password in brackets):");
  for (const p of PHYSIOS) console.log(`  physio   ${p.username.padEnd(8)} (${p.password})  ${p.name}`);
  for (const p of PATIENTS) console.log(`  patient  ${p.username.padEnd(8)} (${p.password})  ${p.name} — ${p.physio}`);
}

// Run directly: `npm run seed` / `npm run seed:reset`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await connect();
  await seedDatabase(db, { reset: process.argv.includes("--reset") });
  await close();
}
