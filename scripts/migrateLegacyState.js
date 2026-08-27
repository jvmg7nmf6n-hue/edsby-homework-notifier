import { readFile } from "node:fs/promises";
import { getState, saveState } from "./stateStore.js";

async function readJson(path) {
  try {
    return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

const history = await readJson("../data/history.json");
const notified = await readJson("../data/notified.json");
if (!Object.keys(history).length && !Object.keys(notified).length) {
  throw new Error("No legacy data/history.json or data/notified.json records were found");
}

const state = await getState();
state.history = { ...history, ...state.history };
state.notified = { ...notified, ...state.notified };
const path = await saveState();
console.log(`Migrated legacy records into encrypted state: ${path}`);
console.log("Verify the encrypted app, then remove the legacy plaintext files and scrub them from public Git history.");
