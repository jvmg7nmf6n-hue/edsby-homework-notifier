import { webcrypto } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const { subtle } = webcrypto;
const DEFAULT_PATH = new URL("../data/state.enc.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ITERATIONS = 310_000;
let cachedState;

function statePath() {
  return process.env.STATE_FILE || DEFAULT_PATH;
}

function encryptionKey() {
  const key = process.env.DATA_ENCRYPTION_KEY || "";
  if (key.length < 20) throw new Error("DATA_ENCRYPTION_KEY must contain at least 20 characters");
  return key;
}

function emptyState() {
  return { version: 1, history: {}, notified: {} };
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

async function deriveAesKey(passphrase, salt, usages) {
  const material = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

export async function encryptJson(value, passphrase = encryptionKey()) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, ["encrypt"]);
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptJson(envelope, passphrase = encryptionKey()) {
  if (envelope?.version !== 1 || envelope?.iterations !== ITERATIONS) throw new Error("Unsupported encrypted state format");
  try {
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const key = await deriveAesKey(passphrase, salt, ["decrypt"]);
    const plaintext = await subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToBytes(envelope.ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("Could not decrypt state; check DATA_ENCRYPTION_KEY");
  }
}

export async function getState() {
  if (cachedState) return cachedState;
  encryptionKey();
  try {
    cachedState = await decryptJson(JSON.parse(await readFile(statePath(), "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    cachedState = emptyState();
  }
  cachedState.history ||= {};
  cachedState.notified ||= {};
  return cachedState;
}

export async function saveState() {
  const envelope = await encryptJson(await getState());
  const path = statePath();
  const tempPath = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, JSON.stringify(envelope, null, 2) + "\n", { mode: 0o600 });
  await rename(tempPath, path);
  return path;
}

export function clearStateCacheForTests() {
  cachedState = undefined;
}
