import test from "node:test";
import assert from "node:assert/strict";
import { formatCardLines, prepareCards } from "../scripts/cardPresentation.js";

const courses = [
  {
    course: "7-K Mathematics",
    teacher: "Ms Khadija Aqeel",
    keywords: ["linear equations", "simple inequalities", "exercise 5A", "exercise 5B"],
  },
  {
    course: "7-K Mandarin",
    teacher: "Ms. Arooj Malik",
    keywords: ["characters of new words"],
  },
];

test("unknown Edsby homework is enriched with configured course and teacher", () => {
  const [card] = prepareCards([{
    source: "edsby",
    subject: "Unknown subject",
    dateISO: "2026-08-28",
    toDo: "Workbook D1 page 45. Assessment from linear equations and simple inequalities, exercise 5A and 5B.",
    attachments: [],
  }], courses);
  assert.equal(card.course, "7-K Mathematics");
  assert.equal(card.teacher, "Ms Khadija Aqeel");
  assert.match(formatCardLines(card, 1)[0], /^1\. \[Edsby\] 7-K Mathematics — Ms Khadija Aqeel$/);
});

test("identical Gmail notifications collapse and retain the earliest receipt time", () => {
  const base = {
    source: "gmail",
    senderEmail: "notifications@headstart.edsby.com",
    subject: "Edsby Notification: Ms. Muniba Akhlaq in 7-K Programming",
    course: "7-K Programming",
    teacher: "Ms. Muniba Akhlaq",
    toDo: "Posted a journal entry — open Edsby for the complete details.",
    dateISO: "2026-08-28",
    attachments: [],
  };
  const cards = prepareCards([
    { ...base, sourceId: "late", receivedAt: "2026-08-28T10:00:00.000Z" },
    { ...base, sourceId: "early", receivedAt: "2026-08-28T08:00:00.000Z" },
    { ...base, sourceId: "latest", receivedAt: "2026-08-28T11:00:00.000Z" },
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].sourceId, "early");
  assert.equal(cards[0].duplicateCount, 3);
  assert.match(formatCardLines(cards[0], 2).at(-1), /3 identical copies collapsed/);
});

test("Gmail messages are ordered earliest first and every item is numbered", () => {
  const cards = prepareCards([
    { source: "gmail", senderEmail: "a@headstart.edu.pk", subject: "Later", toDo: "Later", dateISO: "2026-08-29", receivedAt: "2026-08-29T10:00:00Z" },
    { source: "gmail", senderEmail: "a@headstart.edu.pk", subject: "Earlier", toDo: "Earlier", dateISO: "2026-08-29", receivedAt: "2026-08-29T08:00:00Z" },
  ]);
  assert.deepEqual(cards.map((card) => card.subject), ["Earlier", "Later"]);
  assert.match(formatCardLines(cards[0], 1)[0], /^1\. \[Gmail\]/);
  assert.match(formatCardLines(cards[1], 2)[0], /^2\. \[Gmail\]/);
});

test("generic textbook wording is clarified without inventing a title", () => {
  const lines = formatCardLines({
    source: "edsby",
    course: "7-K Science",
    teacher: "Ms Maham Javaid",
    toDo: "Revise the concepts from your textbook and complete Workbook pages 5, 6 and 7.",
  }, 1);
  assert.match(lines[1], /Science textbook \(exact title not stated in the Edsby post\)/);
  assert.match(lines[1], /complete Science workbook pages 5, 6 and 7/);
});
