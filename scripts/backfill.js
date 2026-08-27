import { config, isDryRun } from "./config.js";
import { karachiISODate, karachiPretty } from "./karachiTime.js";
import { loginToEdsby, scrapeChildHomeworkRange } from "./edsbyClient.js";
import { fetchSchoolEmails } from "./gmailClient.js";
import { sendFailureAlert, sendNtfy } from "./ntfy.js";
import { checkSent, recordSent } from "./dedupe.js";
import { getState, saveState } from "./stateStore.js";

const FROM_DATE = process.env.FROM_DATE;
const TO_DATE = process.env.TO_DATE || karachiISODate();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateDates() {
  if (!ISO_DATE.test(FROM_DATE || "") || !ISO_DATE.test(TO_DATE) || FROM_DATE > TO_DATE) {
    throw new Error("FROM_DATE and TO_DATE must form a valid ascending YYYY-MM-DD range");
  }
  const rangeDays = Math.round((Date.parse(`${TO_DATE}T00:00:00Z`) - Date.parse(`${FROM_DATE}T00:00:00Z`)) / 86_400_000);
  if (rangeDays > 31) throw new Error("Backfill range cannot exceed 31 days");
}

async function main() {
  validateDates();
  if (!config.edsby.enabled && !config.gmail.enabled) throw new Error("At least one source (Edsby or Gmail) must be enabled");
  await getState();
  console.log(`Backfill digest: ${FROM_DATE} to ${TO_DATE}. dry_run=${isDryRun()}`);

  let edsbySession = null;
  let edsbyLoginError = null;
  if (config.edsby.enabled) {
    try {
      edsbySession = await loginToEdsby();
    } catch (error) {
      edsbyLoginError = error;
    }
  }

  try {
    for (const child of config.edsby.children) {
      await backfillOneChild(edsbySession?.page, edsbyLoginError, child);
    }
  } finally {
    if (edsbySession) await edsbySession.browser.close().catch(() => {});
    await saveState();
  }
}

async function backfillOneChild(page, loginError, child) {
  const cards = [];
  const errors = [];
  let successfulSources = 0;

  if (config.edsby.enabled) {
    if (loginError) errors.push(new Error(`Edsby: ${loginError.message}`));
    else {
      try {
        const result = await scrapeChildHomeworkRange(page, child, {
          fromISO: FROM_DATE,
          toISO: TO_DATE,
          maxShowOlderClicks: 60,
          lookbackBufferDays: 3,
        });
        cards.push(...result.cards);
        successfulSources++;
        console.log(`${child.name}: Edsby returned ${result.cards.length} item(s) from ${result.cardsScanned} scanned cards.`);
      } catch (error) {
        errors.push(new Error(`Edsby: ${error.message}`));
      }
    }
  }

  if (config.gmail.enabled && child.id === config.gmail.childId) {
    try {
      const gmailCards = await fetchSchoolEmails({ fromISO: FROM_DATE, toISO: TO_DATE });
      cards.push(...gmailCards);
      successfulSources++;
      console.log(`${child.name}: Gmail returned ${gmailCards.length} matching message(s).`);
    } catch (error) {
      errors.push(new Error(`Gmail: ${error.message}`));
    }
  }

  if (!successfulSources && errors.length) {
    await sendFailureAlert(new Error(errors.map((error) => error.message).join("; ")), `backfill (${child.name})`);
    return;
  }

  cards.sort((a, b) => [a.dateISO, a.source, a.subject].join("|").localeCompare([b.dateISO, b.source, b.subject].join("|")));
  const payload = { cards, errors: errors.map((error) => error.message) };
  const dedupe = await checkSent({ childId: child.id, date: `backfill:${FROM_DATE}:${TO_DATE}`, payload });
  if (dedupe.alreadySent) {
    console.log(`${child.name}: identical digest already sent.`);
    return;
  }
  await sendNtfy(buildDigestNotification(child, cards, errors));
  if (!isDryRun()) await recordSent(dedupe);
}

function buildDigestNotification(child, cards, errors) {
  const fromPretty = karachiPretty(new Date(`${FROM_DATE}T00:00:00Z`));
  const toPretty = karachiPretty(new Date(`${TO_DATE}T00:00:00Z`));
  const lines = cards.length ? [] : [`No matching school updates found for ${fromPretty} through ${toPretty}.`];
  let activeDate = "";
  for (const card of cards) {
    if (card.dateISO !== activeDate) {
      activeDate = card.dateISO;
      lines.push("", prettyDate(card.dateISO));
    }
    lines.push(`[${card.source === "gmail" ? "Gmail" : "Edsby"}] ${card.subject}`);
    if (card.toDo) lines.push(`  ${card.toDo}`);
  }
  if (errors.length) {
    lines.push("", "Partial check warning:", ...errors.map((error) => `- ${error.message}`));
  }
  return {
    title: `${child.name} — school digest (${fromPretty}–${toPretty})`,
    body: lines.join("\n").trim(),
    clickUrl: child.dashboardUrl,
    tags: errors.length ? ["warning", "books"] : ["books"],
  };
}

function prettyDate(iso) {
  return karachiPretty(new Date(`${iso}T00:00:00Z`));
}

main().catch(async (error) => {
  console.error("Backfill failed:", error);
  await sendFailureAlert(error, "backfill top-level").catch(() => {});
  process.exitCode = 1;
});
