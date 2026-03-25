import fs from "node:fs";
import path from "node:path";
import admin from "firebase-admin";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(scriptDir, "../..");

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT || path.join(repoRoot, "serviceAccountKey.json");
const unresolvedPath =
  process.env.UNRESOLVED_JSON_PATH || path.join(repoRoot, "data/review/unresolved_stations_rich.json");
const unresolvedCsvPath =
  process.env.UNRESOLVED_CSV_PATH || path.join(repoRoot, "data/review/stations_no_coordinates.csv");
const collectionName = process.env.FIRESTORE_COLLECTION || "stations";

function hasValue(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return s !== "" && s !== "null" && s !== "nan" && s !== "none";
}

function sanitizeSourceRow(row) {
  const clean = { ...row };
  delete clean.status;
  delete clean.latitude;
  delete clean.longitude;
  delete clean.saved_at_utc;
  delete clean.reviewer;
  delete clean.updated_at;
  return clean;
}

function parseCsv(content) {
  const rows = [];
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return rows;

  function parseLine(line) {
    const values = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        values.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    values.push(cur);
    return values;
  }

  const headers = parseLine(lines[0]).map((h) => h.trim());
  for (let i = 1; i < lines.length; i += 1) {
    const vals = parseLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = vals[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function loadSourceRows() {
  if (fs.existsSync(unresolvedCsvPath)) {
    const raw = fs.readFileSync(unresolvedCsvPath, "utf8");
    const rows = parseCsv(raw);
    console.log(`Loaded CSV source: ${unresolvedCsvPath} (${rows.length} rows)`);
    return rows;
  }
  if (fs.existsSync(unresolvedPath)) {
    const rows = JSON.parse(fs.readFileSync(unresolvedPath, "utf8"));
    if (!Array.isArray(rows)) throw new Error("Unresolved JSON must be an array.");
    console.log(`Loaded JSON source: ${unresolvedPath} (${rows.length} rows)`);
    return rows;
  }
  throw new Error(`No source file found. Checked:\n- ${unresolvedCsvPath}\n- ${unresolvedPath}`);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
const unresolvedRows = loadSourceRows();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

let batch = db.batch();
let ops = 0;
let created = 0;
let updated = 0;
let preservedDone = 0;
let skippedNoId = 0;

for (const row of unresolvedRows) {
  const stationId = String(row.station_result_id || "").trim();
  if (!stationId) {
    skippedNoId += 1;
    continue;
  }

  const ref = db.collection(collectionName).doc(stationId);
  const snap = await ref.get();
  const source = sanitizeSourceRow(row);

  if (!snap.exists) {
    batch.set(
      ref,
      {
        ...source,
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
    created += 1;
    ops += 1;
  } else {
    const existing = snap.data() || {};
    const status = String(existing.status || "").toLowerCase();
    const hasCoords = hasValue(existing.latitude) && hasValue(existing.longitude);
    if (status === "done" || hasCoords) {
      preservedDone += 1;
      continue;
    }

    const patch = {
      ...source,
      station_result_id: stationId,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (!hasValue(existing.status)) {
      patch.status = "pending";
    }

    batch.set(ref, patch, { merge: true });
    updated += 1;
    ops += 1;
  }

  if (ops >= 350) {
    await batch.commit();
    console.log(
      `Committed chunk. created=${created}, updated=${updated}, preserved_done=${preservedDone}, skipped_no_id=${skippedNoId}`,
    );
    batch = db.batch();
    ops = 0;
  }
}

if (ops > 0) {
  await batch.commit();
}

console.log(
  `Done. created=${created}, updated=${updated}, preserved_done=${preservedDone}, skipped_no_id=${skippedNoId}, total_input=${unresolvedRows.length}`,
);
