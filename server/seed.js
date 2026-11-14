// Seeds made-up physios, patients, prescriptions and a few past sessions.
// Usage: npm run seed            (upserts users, adds prescriptions/sessions if missing)
//        npm run seed -- --reset (drops the three collections first)
import { pathToFileURL } from "node:url";
import { connect, close } from "./db.js";
import { EXERCISES } from "../src/exercises.js";

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
    { exerciseKey: "heelSlide", sets: 3, reps: 10, holdSeconds: 2, notes: "Go as far as comfortable, no forcing." },
    { exerciseKey: "straightLegRaise", sets: 3, reps: 8, holdSeconds: 3 },
    { exerciseKey: "kneeExtension", sets: 2, reps: 12 },
  ],
  bob: [
    { exerciseKey: "shoulderFlexion", sets: 3, reps: 8, holdSeconds: 2, angleOverrides: { targetAngle: 110 }, notes: "Target reduced to 110° for now." },
    { exerciseKey: "shoulderRaise", sets: 3, reps: 8, angleOverrides: { targetAngle: 100 } },
  ],
  chen: [
    { exerciseKey: "squat", sets: 3, reps: 10 },
    { exerciseKey: "straightLegRaise", sets: 2, reps: 12 },
  ],
  dana: [
    { exerciseKey: "hipAbduction", sets: 3, reps: 10, holdSeconds: 2 },
    { exerciseKey: "gluteBridge", sets: 3, reps: 10, holdSeconds: 3 },
  ],
  eve: [{ exerciseKey: "gluteBridge", sets: 3, reps: 12, holdSeconds: 5 }],
  femi: [{ exerciseKey: "shoulderRaise", sets: 3, reps: 8, angleOverrides: { targetAngle: 90 } }],
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
      const pres = {
        patientId: patient._id,
        physioId: patient.physioId,
        exerciseKey: plan.exerciseKey,
        exerciseName: ex.name,
        sets: plan.sets,
        reps: plan.reps,
        holdSeconds: plan.holdSeconds ?? 0,
        angleOverrides: plan.angleOverrides ?? null,
        notes: plan.notes ?? "",
        active: true,
        createdAt: new Date(now - 7 * 86400e3),
        updatedAt: now,
      };
      const { insertedId } = await prescriptions.insertOne(pres);
      nPres++;

      // Fake history: one session a day for the last 5 days, ROM improving slightly
      for (let d = 5; d >= 1; d--) {
        const startedAt = new Date(now - d * 86400e3 - 3600e3);
        const repsArr = [];
        for (let i = 0; i < plan.reps; i++) {
          const rom = Math.min(1.1, 0.6 + (5 - d) * 0.07 + (Math.random() - 0.5) * 0.12);
          repsArr.push({
            n: i + 1,
            rom: +rom.toFixed(2),
            durationMs: 1200 + Math.round(Math.random() * 800),
            holdMs: Math.round((plan.holdSeconds ?? 0) * 1000 * (0.7 + Math.random() * 0.4)),
            cues: Math.random() < 0.15 ? ["Keep your trunk still"] : [],
          });
        }
        await sessions.insertOne({
          patientId: patient._id,
          physioId: patient.physioId,
          prescriptionId: insertedId,
          exerciseKey: plan.exerciseKey,
          exerciseName: ex.name,
          startedAt,
          endedAt: new Date(startedAt.getTime() + repsArr.length * 2000),
          setsCompleted: 1,
          reps: repsArr,
          summary: {
            repCount: repsArr.length,
            avgRom: +(repsArr.reduce((s, r) => s + r.rom, 0) / repsArr.length).toFixed(2),
            bestRom: +Math.max(...repsArr.map((r) => r.rom)).toFixed(2),
            cueCount: repsArr.reduce((s, r) => s + r.cues.length, 0),
          },
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
