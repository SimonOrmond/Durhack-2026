// MongoDB connection. Uses MONGODB_URI (Atlas) when set, otherwise spins up an
// in-memory MongoDB so the app runs with zero setup. Same driver, same code paths.
import "dotenv/config";
import { MongoClient } from "mongodb";

let client = null;
let db = null;
let memServer = null;

export async function connect() {
  if (db) return db;

  let uri = process.env.MONGODB_URI;
  if (!uri) {
    if (process.env.VERCEL) {
      throw new Error("MONGODB_URI is not set. Add MONGODB_URI in your Vercel Project Settings -> Environment Variables.");
    }
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    memServer = await MongoMemoryServer.create();
    uri = memServer.getUri();
    console.warn("[db] MONGODB_URI not set — using in-memory MongoDB (data is lost on restart)");
  } else {
    console.log("[db] connecting to MongoDB Atlas…");
  }

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(process.env.DB_NAME || "physio");
  await ensureIndexes(db);
  console.log(`[db] connected to database "${db.databaseName}"`);
  return db;
}

async function ensureIndexes(db) {
  await db.collection("users").createIndex({ username: 1 }, { unique: true });
  await db.collection("users").createIndex({ physioId: 1 });
  await db.collection("prescriptions").createIndex({ patientId: 1, active: 1 });
  // Sessions are queried per patient, newest first, and aggregated over time.
  await db.collection("sessions").createIndex({ patientId: 1, startedAt: -1 });
  await db.collection("sessions").createIndex({ prescriptionId: 1 });
}

/** True when running on the in-memory fallback (no MONGODB_URI). */
export function isMemory() {
  return !!memServer;
}

export function getDb() {
  if (!db) throw new Error("Database not connected. Call connect() first.");
  return db;
}

export async function close() {
  await client?.close();
  await memServer?.stop();
  client = db = memServer = null;
}
