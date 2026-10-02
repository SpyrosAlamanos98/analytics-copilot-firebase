// firestore-storage.js
// Saves/loads parsed report data in Firestore instead of raw files in Cloud
// Storage (Storage now requires the paid Blaze plan; Firestore stays free
// on Spark). Each report's rows are split into chunk documents so no single
// document risks the 1 MiB Firestore document-size limit.

import { db } from "./firebase-config.js";
import {
  collection, doc, setDoc, getDoc, getDocs, deleteDoc, query, orderBy, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const CHUNK_SIZE = 500; // fallback row count if size-estimation can't run
const TARGET_CHUNK_BYTES = 600 * 1024; // keep each chunk doc safely under Firestore's 1 MiB document limit

function slugify(fileName) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 300);
}

// Wide Circana/Nielsen exports can have wildly uneven row widths (some rows
// carry huge concatenated text in one column, others don't) — estimating
// chunk size from a sample of early rows can badly under-count later ones.
// This measures the ACTUAL serialized size of each row as it's added and
// cuts a new chunk the moment the running total would exceed the target,
// so no chunk can ever silently balloon past Firestore's 1 MiB limit.
function chunkRowsBySize(rows, targetBytes = TARGET_CHUNK_BYTES) {
  if (rows.length === 0) return [[]];

  const chunks = [];
  let current = [];
  let currentBytes = 2; // "[" + "]"

  rows.forEach((row) => {
    const rowBytes = JSON.stringify(row).length + 1; // +1 for the separating comma
    if (current.length > 0 && currentBytes + rowBytes > targetBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  });

  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function saveReport(uid, fileName, parsed) {
  const reportId = slugify(fileName);
  const reportRef = doc(db, "users", uid, "reports", reportId);
  const chunksRef = collection(reportRef, "chunks");

  // Clear any previous chunks (re-upload of the same filename overwrites).
  // Deletes are batched the same size-aware way as the writes below.
  const existing = await getDocs(chunksRef);
  if (!existing.empty) {
    await commitInSafeBatches(existing.docs.map((d) => ({ ref: d.ref, kind: "delete" })));
  }

  const rowChunks = chunkRowsBySize(parsed.rows);
  const chunkCount = rowChunks.length;
  const ops = rowChunks.map((slice, i) => {
    const json = JSON.stringify(slice);
    return { ref: doc(chunksRef, String(i)), kind: "set", data: { data: json }, byteSize: json.length };
  });

  // Safety check: if even a single chunk is still over Firestore's hard
  // 1 MiB document limit (extremely wide single rows), fail loudly instead
  // of silently truncating data.
  const oversized = ops.find((op) => op.byteSize > 1_000_000);
  if (oversized) {
    throw new Error(
      `Το report έχει πολύ "φαρδιές" γραμμές (πολλές στήλες) — ένα κομμάτι ξεπερνάει το όριο `
      + `Firestore ακόμα και με 1 μόνο γραμμή. Χρειάζεται διαφορετική προσέγγιση αποθήκευσης για αυτό το αρχείο.`,
    );
  }

  await commitInSafeBatches(ops);

  await setDoc(reportRef, {
    fileName,
    uploadedAt: serverTimestamp(),
    columns: parsed.columns,
    numericColumns: parsed.numericColumns,
    rowCount: parsed.rows.length,
    chunkCount,
  });

  return reportId;
}

// Firestore caps a single Commit request at ~10 MiB and 500 operations.
// Large reports can easily produce more chunk-writes than fit in one
// request, so we group operations into batches that stay safely under
// both limits and commit them one after another.
const MAX_BATCH_OPS = 400; // stay under Firestore's hard 500-op limit
const MAX_BATCH_BYTES = 8 * 1024 * 1024; // stay well under the ~10 MiB request cap

async function commitInSafeBatches(ops) {
  let batch = writeBatch(db);
  let opsInBatch = 0;
  let bytesInBatch = 0;

  for (const op of ops) {
    const opBytes = op.byteSize || 200; // rough estimate for deletes/small docs
    const wouldOverflow = opsInBatch >= MAX_BATCH_OPS || (bytesInBatch + opBytes) >= MAX_BATCH_BYTES;
    if (wouldOverflow && opsInBatch > 0) {
      await batch.commit();
      batch = writeBatch(db);
      opsInBatch = 0;
      bytesInBatch = 0;
    }

    if (op.kind === "delete") batch.delete(op.ref);
    else batch.set(op.ref, op.data);

    opsInBatch += 1;
    bytesInBatch += opBytes;
  }

  if (opsInBatch > 0) await batch.commit();
}

export async function listReports(uid) {
  const q = query(collection(db, "users", uid, "reports"), orderBy("fileName"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function loadReportData(uid, reportMeta) {
  const reportRef = doc(db, "users", uid, "reports", reportMeta.id);
  const chunksRef = collection(reportRef, "chunks");
  const snap = await getDocs(chunksRef);

  // chunk doc IDs are "0", "1", "2"... sort numerically before concatenating
  const chunkDocs = snap.docs.sort((a, b) => Number(a.id) - Number(b.id));
  let rows = [];
  chunkDocs.forEach((d) => {
    rows = rows.concat(JSON.parse(d.data().data));
  });

  return { columns: reportMeta.columns, numericColumns: reportMeta.numericColumns, rows };
}

export async function deleteReport(uid, reportId) {
  const reportRef = doc(db, "users", uid, "reports", reportId);
  const chunksRef = collection(reportRef, "chunks");
  const snap = await getDocs(chunksRef);
  await commitInSafeBatches(snap.docs.map((d) => ({ ref: d.ref, kind: "delete" })));
  await deleteDoc(reportRef);
}

export async function deleteReports(uid, reportIds, onProgress) {
  let done = 0;
  for (const id of reportIds) {
    await deleteReport(uid, id);
    done += 1;
    if (onProgress) onProgress(done, reportIds.length);
  }
}

export async function getStorageEstimateMB(reports) {
  // Rough estimate only (Firestore doesn't expose exact stored bytes client-side)
  const totalRows = reports.reduce((sum, r) => sum + (r.rowCount || 0), 0);
  const estBytes = totalRows * 120; // ~120 bytes/row heuristic
  return estBytes / (1024 * 1024);
}