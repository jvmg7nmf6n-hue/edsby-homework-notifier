// Small, committed JSON log of what has already been pushed to ntfy for a
// given (childId, date) -- so a manual retry/workflow re-run never spams a
// duplicate notification for content already sent. Keyed on a content hash,
// not just the date, so an EDITED post (new/changed homework for a day
// already notified) still gets a fresh push -- only byte-identical content
// is treated as "already sent."

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const LOG_PATH = new URL("../data/notified.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function contentHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

async function loadLog() {
  try {
    const raw = await readFile(LOG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    // A corrupted log must never crash the whole run -- treat as empty
    // (worst case: one duplicate notification), but say so loudly.
    console.error(`WARNING: ${LOG_PATH} is corrupted (${err.message}) -- treating as empty.`);
    return {};
  }
}

async function saveLog(log) {
  await mkdir(dirname(LOG_PATH), { recursive: true });
  await writeFile(LOG_PATH, JSON.stringify(log, null, 2) + "\n");
}

/** Returns { alreadySent, key, hash } -- alreadySent is true iff this exact
 * content (by hash) was already recorded as sent for childId/date. */
export async function checkAndRecord({ childId, date, payload, dryRun }) {
  const log = await loadLog();
  const key = `${childId}:${date}`;
  const hash = contentHash(payload);
  const existing = log[key];
  const alreadySent = existing?.hash === hash;

  if (!alreadySent && !dryRun) {
    log[key] = { hash, sentAt: new Date().toISOString() };
    await saveLog(log);
  }
  return { alreadySent, key, hash };
}
