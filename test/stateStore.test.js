import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearStateCacheForTests,
  decryptJson,
  encryptJson,
  getState,
  saveState,
} from "../scripts/stateStore.js";
import { checkSent, recordSent } from "../scripts/dedupe.js";

const KEY = "test-only-key-with-more-than-twenty-characters";

test("encrypted envelope round-trips without plaintext", async () => {
  const payload = { child: "Sample Student", homework: "Read chapter 4" };
  const envelope = await encryptJson(payload, KEY);
  assert.equal(JSON.stringify(envelope).includes("Sample Student"), false);
  assert.deepEqual(await decryptJson(envelope, KEY), payload);
  await assert.rejects(() => decryptJson(envelope, "wrong-key-with-more-than-twenty-chars"), /Could not decrypt/);
});

test("dedupe is recorded only after an explicit successful send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "school-monitor-"));
  process.env.STATE_FILE = join(dir, "state.enc.json");
  process.env.DATA_ENCRYPTION_KEY = KEY;
  clearStateCacheForTests();

  const input = { childId: "sample", date: "2026-08-27", payload: [{ subject: "Math" }] };
  const first = await checkSent(input);
  assert.equal(first.alreadySent, false);
  assert.equal((await checkSent(input)).alreadySent, false);
  await recordSent(first);
  assert.equal((await checkSent(input)).alreadySent, true);

  await saveState();
  assert.equal((await readFile(process.env.STATE_FILE, "utf8")).includes("Math"), false);
  assert.ok((await getState()).notified[first.key]);
});
