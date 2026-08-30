import { createHash } from "node:crypto";

function text(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalized(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizedCourse(value) {
  return normalized(value).replace(/^grade\s+/, "");
}

export function cardFingerprint(card) {
  const payload = card.source === "gmail"
    ? [card.source, card.dateISO, card.senderEmail, card.subject, card.toDo]
    : [card.source, card.dateISO, card.course || card.subject, card.teacher, card.topics, card.toDo, ...(card.attachments || [])];
  return createHash("sha256").update(normalized(payload.join("|"))).digest("hex").slice(0, 24);
}

function directoryEntryForCourse(course, directory) {
  const target = normalizedCourse(course);
  if (!target) return null;
  return directory.find((entry) => normalizedCourse(entry.course) === target) || null;
}

function directoryEntryForText(card, directory) {
  const haystack = normalized([card.topics, card.toDo, card.rawExcerpt].join(" "));
  if (!haystack) return null;
  const scored = directory
    .map((entry) => ({
      entry,
      score: (entry.keywords || []).filter((keyword) => haystack.includes(normalized(keyword))).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
  return scored[0].entry;
}

function enrichEdsby(card, directory, gmailDirectory) {
  if (card.source !== "edsby") return { ...card };
  const usableCourse = card.course || (card.subject && card.subject !== "Unknown subject" ? card.subject : "");
  const entry = directoryEntryForCourse(usableCourse, directory) || directoryEntryForText(card, directory);
  const course = entry?.course || usableCourse || "Subject not identified by Edsby";
  const gmailEntry = gmailDirectory.get(normalizedCourse(course));
  const teacher = card.teacher || entry?.teacher || gmailEntry?.teacher || "Teacher not identified by Edsby";
  return { ...card, subject: course, course, teacher };
}

function semanticDedupe(cards) {
  const seen = new Map();
  for (const card of cards) {
    const key = cardFingerprint(card);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...card, duplicateCount: Number(card.duplicateCount || 1) });
      continue;
    }
    existing.duplicateCount += Number(card.duplicateCount || 1);
    if ((card.receivedAt || "") < (existing.receivedAt || "")) {
      const count = existing.duplicateCount;
      seen.set(key, { ...card, duplicateCount: count });
    }
  }
  return [...seen.values()];
}

function compareCards(a, b) {
  if ((a.dateISO || "") !== (b.dateISO || "")) return (a.dateISO || "").localeCompare(b.dateISO || "");
  const sourceOrder = { edsby: 0, gmail: 1 };
  if (a.source !== b.source) return (sourceOrder[a.source] ?? 9) - (sourceOrder[b.source] ?? 9);
  if (a.source === "gmail") {
    const byTime = (a.receivedAt || "").localeCompare(b.receivedAt || "");
    if (byTime) return byTime;
  }
  const bySequence = Number(a.sequence ?? Number.MAX_SAFE_INTEGER) - Number(b.sequence ?? Number.MAX_SAFE_INTEGER);
  if (bySequence) return bySequence;
  return [a.course, a.subject, a.toDo].join("|").localeCompare([b.course, b.subject, b.toDo].join("|"));
}

export function prepareCards(cards, courseDirectory = []) {
  const gmailDirectory = new Map();
  for (const card of cards) {
    if (card.source !== "gmail" || !card.course || !card.teacher) continue;
    gmailDirectory.set(normalizedCourse(card.course), { course: card.course, teacher: card.teacher });
  }
  return semanticDedupe(cards.map((card) => enrichEdsby(card, courseDirectory, gmailDirectory))).sort(compareCards);
}

export function formatCardLines(card, number) {
  if (card.source === "edsby") {
    const lines = [`${number}. [Edsby] ${text(card.course || card.subject)} — ${text(card.teacher)}`];
    if (card.topics) lines.push(`   Concepts: ${text(card.topics)}`);
    if (card.toDo) lines.push(`   Homework: ${text(card.toDo)}`);
    if (card.attachments?.length) lines.push(`   Attachments: ${[...new Set(card.attachments)].join(", ")}`);
    return lines;
  }

  const heading = card.course && card.teacher
    ? `${card.course} — ${card.teacher}`
    : card.subject;
  const lines = [`${number}. [Gmail] ${text(heading)}`];
  if (card.toDo) lines.push(`   ${text(card.toDo)}`);
  if (card.duplicateCount > 1) lines.push(`   ${card.duplicateCount} identical copies collapsed into this one item.`);
  return lines;
}

export function formatCardsByDate(cards, prettyDate) {
  const lines = [];
  let activeDate = "";
  let number = 0;
  for (const card of cards) {
    if (card.dateISO !== activeDate) {
      activeDate = card.dateISO;
      lines.push(lines.length ? "" : "", prettyDate(card.dateISO));
    }
    number += 1;
    lines.push(...formatCardLines(card, number), "");
  }
  return lines;
}

