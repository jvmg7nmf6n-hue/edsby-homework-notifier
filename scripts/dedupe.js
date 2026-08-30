import { createHash } from "node:crypto";
import { getState } from "./stateStore.js";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function contentHash(payload) {
  return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex").slice(0, 24);
}

export async function checkSent({ childId, date, payload }) {
  const state = await getState();
  const key = `${childId}:${date}`;
  const hash = contentHash(payload);
  return { alreadySent: state.notified[key]?.hash === hash, key, hash };
}

// Record only AFTER the downstream notification succeeds. This makes retries
// reliable if ntfy is temporarily unavailable.
export async function recordSent({ key, hash }) {
  const state = await getState();
  state.notified[key] = { hash, sentAt: new Date().toISOString() };
}

export async function checkNewCards({ childId, date, cards, fingerprint }) {
  const state = await getState();
  state.seenCards ||= {};
  const key = `${childId}:${date}`;
  const seen = new Set(state.seenCards[key]?.fingerprints || []);
  const fingerprints = cards.map(fingerprint);
  const newCards = cards.filter((_, index) => !seen.has(fingerprints[index]));
  return { key, newCards, fingerprints };
}

export async function recordSeenCards({ key, fingerprints }) {
  const state = await getState();
  state.seenCards ||= {};
  const previous = new Set(state.seenCards[key]?.fingerprints || []);
  for (const fingerprint of fingerprints) previous.add(fingerprint);
  state.seenCards[key] = { fingerprints: [...previous].slice(-200), updatedAt: new Date().toISOString() };
}
