// Persisted day-by-day record (committed JSON, small and text-diffable) that
// the dashboard's history strip reads from. Separate from dedupe.js's own
// notified-log -- this stores the actual CONTENT for display, not just a
// hash. Every day this script runs gets exactly one entry per child,
// overwriting any earlier entry for the same date (so a same-day re-run
// updates the record rather than duplicating it).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const HISTORY_PATH = new URL("../data/history.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export const STATUS_OK = "ok"; // homework found
export const STATUS_NONE = "none"; // ran fine, nothing posted today
export const STATUS_FAILED = "failed"; // the run itself errored
export const STATUS_SKIPPED = "skipped"; // Sunday reminder-only day, no scrape attempted

export async function loadHistory() {
  try {
    return JSON.parse(await readFile(HISTORY_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.error(`WARNING: ${HISTORY_PATH} is corrupted (${err.message}) -- treating as empty.`);
    return {};
  }
}

export async function recordDay({ childId, date, status, cards = [], error = null }) {
  const history = await loadHistory();
  history[childId] ||= {};
  history[childId][date] = { status, cards, error, updatedAt: new Date().toISOString() };
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
  return history;
}
