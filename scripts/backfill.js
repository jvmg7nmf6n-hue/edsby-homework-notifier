// One-off historical digest: scrapes a date range (not just "today") and
// sends ONE consolidated ntfy push covering the whole range, grouped by day.
// Separate from the daily run.js flow -- not run on a schedule, only via
// `npm run backfill` / a manual workflow_dispatch with explicit from/to
// dates. Uses its own dedupe key ("backfill:...") so it never collides with
// or gets skipped by the daily job's own per-day dedupe log.

import { config, isDryRun } from "./config.js";
import { karachiISODate, karachiPretty } from "./karachiTime.js";
import { loginToEdsby, scrapeChildHomeworkRange } from "./edsbyClient.js";
import { sendNtfy, sendFailureAlert } from "./ntfy.js";
import { checkAndRecord } from "./dedupe.js";

const FROM_DATE = process.env.FROM_DATE;
const TO_DATE = process.env.TO_DATE || karachiISODate();
// Wider than the daily job's default (3) and the click cap is raised too --
// paging back 7-10 real days needs more "Show Older Posts" clicks than the
// daily "just today, with a small safety buffer" case ever does.
const LOOKBACK_BUFFER_DAYS = 3;
const MAX_SHOW_OLDER_CLICKS = 60;

if (!FROM_DATE) {
  console.error("FROM_DATE env var is required (YYYY-MM-DD, Asia/Karachi calendar date).");
  process.exit(1);
}

async function main() {
  console.log(`Backfill digest: ${FROM_DATE} to ${TO_DATE}. dry_run=${isDryRun()}`);

  let session;
  try {
    session = await loginToEdsby();
  } catch (err) {
    console.error("FAILED (login):", err);
    await sendFailureAlert(err, "backfill login");
    process.exitCode = 1;
    return;
  }

  const { page, browser } = session;
  try {
    for (const child of config.edsby.children) {
      await backfillOneChild(page, child);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function backfillOneChild(page, child) {
  let result;
  try {
    result = await scrapeChildHomeworkRange(page, child, {
      fromISO: FROM_DATE,
      toISO: TO_DATE,
      maxShowOlderClicks: MAX_SHOW_OLDER_CLICKS,
      lookbackBufferDays: LOOKBACK_BUFFER_DAYS,
    });
  } catch (err) {
    console.error(`FAILED (backfill scrape, ${child.name}):`, err);
    await sendFailureAlert(err, `backfill scrape (${child.name})`);
    return;
  }

  console.log(
    `${child.name}: ${result.cards.length} card(s) in range, scanned ${result.cardsScanned} total across ${result.showOlderClicks} "show older" click(s).`
  );

  // Full diagnostic dump of EVERY scanned card -- subject, the raw "Date:"
  // text as Edsby actually rendered it, and what we parsed that into --
  // so a suspiciously-empty range result is verifiable from the workflow
  // log itself, not just a trust-me count.
  console.log(`${child.name}: raw dump of all ${result.allCards.length} scanned card(s):`);
  for (const c of result.allCards) {
    console.log(
      `  subject="${c.subject}" rawDate="${c.rawDateText}" parsedISO=${c.dateISO} toDo="${(c.toDo || "").slice(0, 60)}"`
    );
  }

  const dedupeKey = `backfill:${FROM_DATE}:${TO_DATE}`;
  const { alreadySent } = await checkAndRecord({
    childId: child.id,
    date: dedupeKey,
    payload: result.cards,
    dryRun: isDryRun(),
  });
  if (alreadySent) {
    console.log(`${child.name}: this exact backfill range/content was already sent -- skipping ntfy push.`);
    return;
  }

  await sendNtfy(buildDigestNotification(child, result.cards));
}

function buildDigestNotification(child, cards) {
  const fromPretty = karachiPretty(new Date(`${FROM_DATE}T00:00:00Z`));
  const toPretty = karachiPretty(new Date(`${TO_DATE}T00:00:00Z`));

  if (!cards.length) {
    return {
      title: `${child.name} -- Homework digest`,
      body: `No homework found on Edsby for ${fromPretty} through ${toPretty}.`,
      clickUrl: child.dashboardUrl,
      tags: ["books"],
    };
  }

  const byDate = new Map();
  for (const card of cards) {
    if (!byDate.has(card.dateISO)) byDate.set(card.dateISO, []);
    byDate.get(card.dateISO).push(card);
  }

  const body = [...byDate.entries()]
    .map(([dateISO, dayCards]) => {
      const pretty = karachiPretty(new Date(`${dateISO}T00:00:00Z`));
      const lines = dayCards.map((c) => {
        const parts = [`  ${c.subject}`];
        if (c.topics) parts.push(`    Topics: ${c.topics}`);
        if (c.toDo) parts.push(`    To do: ${c.toDo}`);
        if (c.attachments?.length) parts.push(`    Attachments: ${c.attachments.join(", ")}`);
        return parts.join("\n");
      });
      return `${pretty}\n${lines.join("\n")}`;
    })
    .join("\n\n");

  return {
    title: `${child.name} -- Homework digest (${fromPretty}–${toPretty})`,
    body,
    clickUrl: child.dashboardUrl,
    tags: ["books"],
  };
}

main().catch(async (err) => {
  console.error("Unhandled top-level failure:", err);
  await sendFailureAlert(err, "backfill top-level").catch(() => {});
  process.exitCode = 1;
});
