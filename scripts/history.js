import { getState } from "./stateStore.js";

export const STATUS_OK = "ok";
export const STATUS_NONE = "none";
export const STATUS_PARTIAL = "partial";
export const STATUS_FAILED = "failed";
export const STATUS_SKIPPED = "skipped";

export async function loadHistory() {
  return (await getState()).history;
}

export async function recordDay({ childId, date, status, cards = [], errors = [] }) {
  const state = await getState();
  state.history[childId] ||= {};
  state.history[childId][date] = {
    status,
    cards,
    errors: errors.map((error) => String(error?.message || error)),
    updatedAt: new Date().toISOString(),
  };
  return state.history;
}
