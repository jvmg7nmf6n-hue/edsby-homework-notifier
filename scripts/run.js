import { config, isDryRun } from "./config.js";
import { karachiISODate, karachiPretty, karachiWeekday } from "./karachiTime.js";
import { loginToEdsby, scrapeChildHomework } from "./edsbyClient.js";
import { fetchSchoolEmails } from "./gmailClient.js";
import { sendFailureAlert, sendNtfy } from "./ntfy.js";
import { checkSent, recordSent } from "./dedupe.js";
import {
  recordDay,
  STATUS_FAILED,
  STATUS_NONE,
  STATUS_OK,
  STATUS_PARTIAL,
  STATUS_SKIPPED,
} from "./history.js";
import { generateDashboard } from "./dashboard.js";
import { getState, saveState } from "./stateStore.js";

function cleanCard(card) {
  return {
    source: card.source || "edsby",
    sourceId: card.sourceId || undefined,
    subject: String(card.subject || "Unknown subject").trim(),
    topics: String(card.topics || "").trim(),
    toDo: String(card.toDo || "").trim(),
    attachments: [...new Set(card.attachments || [])].sort(),
    dateISO: card.dateISO || null,
    receivedAt: card.receivedAt || undefined,
    url: card.url || undefined,
  };
}

function stableCards(cards) {
  return cards.map(cleanCard).sort((a, b) =>
    [a.dateISO, a.source, a.subject, a.toDo].join("|").localeCompare([b.dateISO, b.source, b.subject, b.toDo].join("|"))
  );
}

async function main() {
  const weekday = karachiWeekday();
  const todayISO = karachiISODate();
  const children = config.edsby.children;
  await getState(); // fail early if the encrypted state key is missing/wrong
  let sourceIssues = false;

  console.log(`Run starting. Asia/Karachi date: ${todayISO} (${weekday}). dry_run=${isDryRun()}`);
  try {
    if (weekday === "Sunday") {
      await runReminderDay(children, todayISO, "Sunday");
    } else if (weekday === "Saturday") {
      await runReminderDay(children, todayISO, "Saturday");
    } else {
      sourceIssues = await runFullCheck(children, todayISO);
    }
  } finally {
    await saveState();
    await generateDashboard();
    console.log("Encrypted state and dashboard regenerated.");
  }
  if (sourceIssues) {
    console.error("One or more configured sources failed; results were saved as partial/failed.");
    process.exitCode = 2;
  }
}

async function runReminderDay(children, todayISO, weekday) {
  for (const child of children) {
    const payload = { status: STATUS_SKIPPED, weekday };
    const dedupe = await checkSent({ childId: child.id, date: todayISO, payload });
    await recordDay({ childId: child.id, date: todayISO, status: STATUS_SKIPPED });
    if (dedupe.alreadySent) continue;
    await sendNtfy({
      title: `Homework reminder (${weekday})`,
      body: "Please review pending homework and upcoming school notices together.",
      clickUrl: config.edsby.parentHomeUrl,
      tags: ["books"],
    });
    if (!isDryRun()) await recordSent(dedupe);
  }
}

function outcomeMap(children) {
  return new Map(children.map((child) => [child.id, { child, cards: [], errors: [], successfulSources: 0 }]));
}

async function collectEdsby(outcomes, todayISO) {
  if (!config.edsby.enabled) return;
  let session;
  try {
    session = await loginToEdsby();
  } catch (error) {
    for (const outcome of outcomes.values()) outcome.errors.push(new Error(`Edsby: ${error.message}`));
    return;
  }

  const { page, browser } = session;
  try {
    for (const outcome of outcomes.values()) {
      try {
        const result = await scrapeChildHomework(page, outcome.child, {
          maxShowOlderClicks: config.maxShowOlderClicks,
          lookbackBufferDays: config.lookbackBufferDays,
        });
        outcome.cards.push(...result.todaysCards);
        outcome.successfulSources++;
        console.log(
          `${outcome.child.name}: Edsby found ${result.todaysCards.length} item(s); scanned ${result.cardsScanned} card(s) with ${result.showOlderClicks} pagination click(s).`
        );
      } catch (error) {
        outcome.errors.push(new Error(`Edsby: ${error.message}`));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function collectGmail(outcomes, todayISO) {
  if (!config.gmail.enabled) return;
  const target = outcomes.get(config.gmail.childId);
  if (!target) throw new Error("GMAIL_CHILD_ID does not match a configured child");
  try {
    const cards = await fetchSchoolEmails({ fromISO: todayISO, toISO: todayISO });
    target.cards.push(...cards);
    target.successfulSources++;
    console.log(`${target.child.name}: Gmail found ${cards.length} matching message(s).`);
  } catch (error) {
    target.errors.push(new Error(`Gmail: ${error.message}`));
  }
}

async function runFullCheck(children, todayISO) {
  if (!config.edsby.enabled && !config.gmail.enabled) throw new Error("At least one source (Edsby or Gmail) must be enabled");
  const outcomes = outcomeMap(children);
  if (config.gmail.enabled && !outcomes.has(config.gmail.childId)) {
    throw new Error("GMAIL_CHILD_ID does not match a configured child");
  }

  // Gmail and browser scraping are independent, so overlap their network time.
  await Promise.all([collectEdsby(outcomes, todayISO), collectGmail(outcomes, todayISO)]);

  for (const outcome of outcomes.values()) await finishChild(outcome, todayISO);
  return [...outcomes.values()].some((outcome) => outcome.errors.length > 0);
}

async function finishChild(outcome, todayISO) {
  const cards = stableCards(outcome.cards);
  const status = outcome.errors.length
    ? outcome.successfulSources > 0
      ? STATUS_PARTIAL
      : STATUS_FAILED
    : cards.length
      ? STATUS_OK
      : STATUS_NONE;
  const payload = { status, cards, errors: outcome.errors.map((error) => error.message) };

  await recordDay({ childId: outcome.child.id, date: todayISO, status, cards, errors: outcome.errors });
  const dedupe = await checkSent({ childId: outcome.child.id, date: todayISO, payload });
  if (dedupe.alreadySent) {
    console.log(`${outcome.child.name}: identical ${todayISO} update already sent.`);
    return;
  }

  await sendNtfy(buildNotification(outcome.child, todayISO, status, cards, outcome.errors));
  if (!isDryRun()) await recordSent(dedupe);
}

export function buildNotification(child, todayISO, status, cards, errors = []) {
  const pretty = karachiPretty(new Date(`${todayISO}T00:00:00Z`));
  const sourceSummary = [...new Set(cards.map((card) => card.source))].join(" + ");
  const body = [];
  if (status === STATUS_FAILED) body.push("No school data could be collected.");
  else if (!cards.length) body.push("No new matching homework, progress, or announcement items were found.");
  else {
    for (const card of cards) {
      body.push(`[${card.source === "gmail" ? "Gmail" : "Edsby"}] ${card.subject}`);
      if (card.topics) body.push(`  ${card.topics}`);
      if (card.toDo) body.push(`  ${card.toDo}`);
      if (card.attachments?.length) body.push(`  Attachments: ${card.attachments.join(", ")}`);
      body.push("");
    }
  }
  if (errors.length) {
    body.push("Partial check warning:");
    for (const error of errors) body.push(`- ${error.message}`);
  }
  return {
    title:
      status === STATUS_FAILED
        ? `School check failed (${pretty})`
        : `${child.name} — ${cards.length} school update${cards.length === 1 ? "" : "s"} (${pretty})`,
    body: body.join("\n").trim(),
    clickUrl: child.dashboardUrl,
    tags: errors.length ? ["warning", "books"] : ["books"],
    priority: status === STATUS_FAILED ? "high" : "default",
    sourceSummary,
  };
}

main().catch(async (error) => {
  console.error("Unhandled top-level failure:", error);
  await sendFailureAlert(error, "top-level").catch((alertError) => {
    console.error("Additionally failed to send the failure alert:", alertError.message);
  });
  process.exitCode = 1;
});
