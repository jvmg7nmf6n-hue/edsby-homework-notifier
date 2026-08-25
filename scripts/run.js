// Entry point (`npm run check` / `npm run check:dry`). Decides the
// Sunday-reminder vs Mon-Fri-full-check branch off the real Asia/Karachi
// calendar date -- the GitHub Actions cron already excludes Saturday at the
// schedule level (see .github/workflows/homework-check.yml), so Saturday
// never reaches this script at all in the scheduled path; workflow_dispatch
// can still trigger it manually any day, in which case Saturday falls
// through the same weekday switch as any other non-Sunday, non-explicitly-
// handled day and gets the reminder-only treatment rather than a scrape,
// since there is deliberately no Saturday homework to check.

import { config, isDryRun } from "./config.js";
import { karachiISODate, karachiWeekday, karachiPretty } from "./karachiTime.js";
import { loginToEdsby, scrapeChildHomework } from "./edsbyClient.js";
import { sendNtfy, sendFailureAlert } from "./ntfy.js";
import { checkAndRecord } from "./dedupe.js";
import { recordDay, STATUS_OK, STATUS_NONE, STATUS_FAILED, STATUS_SKIPPED } from "./history.js";
import { generateDashboard } from "./dashboard.js";

async function main() {
  const dryRun = isDryRun();
  const weekday = karachiWeekday();
  const todayISO = karachiISODate();

  console.log(`Run starting. Asia/Karachi date: ${todayISO} (${weekday}). dry_run=${dryRun}`);

  if (weekday === "Sunday") {
    await runSundayReminder();
  } else {
    await runFullCheck({ todayISO });
  }

  await generateDashboard();
  console.log("Dashboard regenerated.");
}

async function runSundayReminder() {
  await sendNtfy({
    title: "Homework Reminder (Sunday)",
    body: "Make sure any pending homework from the week is completed before Monday.",
    clickUrl: config.edsby.parentHomeUrl,
    tags: ["books"],
  });
  for (const child of config.edsby.children) {
    await recordDay({ childId: child.id, date: karachiISODate(), status: STATUS_SKIPPED });
  }
}

async function runFullCheck({ todayISO }) {
  let session;
  try {
    session = await loginToEdsby();
  } catch (err) {
    // edsbyClient.js's own catch already saved a diagnostic screenshot
    // (if the page was still open) and attached its path to the error.
    await handleChildFailure(config.edsby.children, todayISO, err, "login");
    return;
  }

  const { page, browser } = session;
  try {
    for (const child of config.edsby.children) {
      await checkOneChild(page, child, todayISO);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function checkOneChild(page, child, todayISO) {
  let result;
  try {
    result = await scrapeChildHomework(page, child, {
      maxShowOlderClicks: config.maxShowOlderClicks,
      lookbackBufferDays: config.lookbackBufferDays,
    });
  } catch (err) {
    await handleChildFailure([child], todayISO, err, `scrape (${child.name})`);
    return;
  }

  const { todaysCards } = result;
  const status = todaysCards.length ? STATUS_OK : STATUS_NONE;

  await recordDay({ childId: child.id, date: todayISO, status, cards: todaysCards });

  const { alreadySent } = await checkAndRecord({
    childId: child.id,
    date: todayISO,
    payload: todaysCards,
    dryRun: isDryRun(),
  });

  if (alreadySent) {
    console.log(`${child.name}: content for ${todayISO} already notified (hash match) -- skipping ntfy push.`);
    return;
  }

  await sendNtfy(buildHomeworkNotification(child, todayISO, todaysCards));
  console.log(
    `${child.name}: ${todaysCards.length} subject(s) today, scanned ${result.cardsScanned} card(s) across ${result.showOlderClicks} "show older" click(s).`
  );
}

function buildHomeworkNotification(child, todayISO, cards) {
  const pretty = karachiPretty(new Date(`${todayISO}T00:00:00Z`));
  if (!cards.length) {
    return {
      title: `No new homework today (${pretty})`,
      body: `Checked ${child.name}'s Edsby feed -- nothing dated today.`,
      clickUrl: child.dashboardUrl,
      tags: ["books"],
    };
  }
  const body = cards
    .map((c) => {
      const lines = [`${c.subject}`];
      if (c.topics) lines.push(`  Topics: ${c.topics}`);
      if (c.toDo) lines.push(`  To do: ${c.toDo}`);
      if (c.attachments?.length) lines.push(`  Attachments: ${c.attachments.join(", ")}`);
      return lines.join("\n");
    })
    .join("\n\n");

  return {
    title: `${child.name} -- Homework for ${pretty}`,
    body,
    clickUrl: child.dashboardUrl,
    tags: ["books"],
    priority: "default",
  };
}

async function handleChildFailure(children, todayISO, err, context) {
  console.error(`FAILED (${context}):`, err);
  if (err.screenshotPath) console.error(`Diagnostic screenshot saved: ${err.screenshotPath}`);
  for (const child of children) {
    await recordDay({ childId: child.id, date: todayISO, status: STATUS_FAILED, error: String(err?.message || err) });
  }
  await sendFailureAlert(err, context);
}

main().catch(async (err) => {
  console.error("Unhandled top-level failure:", err);
  await sendFailureAlert(err, "top-level").catch((alertErr) => {
    console.error("Additionally failed to send the failure alert itself:", alertErr);
  });
  process.exitCode = 1;
});
