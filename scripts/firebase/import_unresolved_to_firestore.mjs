import fs from "node:fs";
import admin from "firebase-admin";

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT || "./serviceAccountKey.json";
const unresolvedPath = process.env.UNRESOLVED_JSON_PATH || "./data/review/unresolved_stations.json";
const collectionName = process.env.FIRESTORE_COLLECTION || "stations";

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
const unresolvedRows = JSON.parse(fs.readFileSync(unresolvedPath, "utf8"));

if (!Array.isArray(unresolvedRows)) {
  throw new Error("Unresolved JSON must be an array.");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
let batch = db.batch();
let ops = 0;
let written = 0;

for (const row of unresolvedRows) {
  const stationId = String(row.station_result_id || "").trim();
  if (!stationId) continue;

  const ref = db.collection(collectionName).doc(stationId);
  batch.set(
    ref,
    {
      ...row,
      station_result_id: stationId,
      status: "pending",
      latitude: null,
      longitude: null,
      reviewer: null,
      saved_at_utc: null,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  ops += 1;
  written += 1;

  if (ops >= 400) {
    await batch.commit();
    console.log(`Committed ${written} rows...`);
    batch = db.batch();
    ops = 0;
  }
}

if (ops > 0) {
  await batch.commit();
}

console.log(`Import complete: ${written} rows into '${collectionName}'.`);
