import test from "node:test";
import assert from "node:assert/strict";
import {
  gmailMessageToCard,
  isAllowedSchoolSender,
  parseEdsbyNotificationSubject,
} from "../scripts/gmailClient.js";

test("Gmail metadata becomes a bounded, normalized school card", () => {
  const card = gmailMessageToCard({
    id: "abc123",
    internalDate: String(Date.parse("2026-08-27T10:30:00Z")),
    snippet: "  Homework&nbsp;is due &amp; bring a ruler.  ",
    payload: { headers: [
      { name: "Subject", value: "Math announcement" },
      { name: "From", value: "Teacher <teacher@school.example>" },
    ] },
  });
  assert.equal(card.source, "gmail");
  assert.equal(card.subject, "Math announcement");
  assert.equal(card.toDo, "Homework is due & bring a ruler.");
  assert.equal(card.dateISO, "2026-08-27");
  assert.match(card.url, /abc123$/);
});

test("Edsby email becomes a compact teacher/course update without login boilerplate", () => {
  const card = gmailMessageToCard({
    id: "edsby-1",
    internalDate: String(Date.parse("2026-08-28T04:30:00Z")),
    snippet:
      "Hi Muhammad Salman, Ms Khadija Aqeel made a new post in 7-K Mathematics " +
      "Click here to view this notification in Edsby To Log in to Edsby Your Edsby server address is: headstart.edsby.com",
    payload: { headers: [
      { name: "Subject", value: "Edsby Notification: Ms Khadija Aqeel in 7-K Mathematics" },
      { name: "From", value: "Edsby <notifications@headstart.edsby.com>" },
    ] },
  });
  assert.equal(card.teacher, "Ms Khadija Aqeel");
  assert.equal(card.course, "7-K Mathematics");
  assert.equal(card.toDo, "Made a new post — open Edsby for the complete details.");
  assert.doesNotMatch(card.toDo, /server address|log in/i);
});

test("school sender allowlist rejects unrelated Gmail such as YouTube", () => {
  const domains = ["headstart.edu.pk", "headstart.edsby.com", "edsby.com"];
  assert.equal(isAllowedSchoolSender("Teacher <teacher@headstart.edu.pk>", domains), true);
  assert.equal(isAllowedSchoolSender("Edsby <notify@headstart.edsby.com>", domains), true);
  assert.equal(isAllowedSchoolSender("YouTube <no-reply@youtube.com>", domains), false);
});

test("Edsby subject parser preserves teacher and course names", () => {
  assert.deepEqual(parseEdsbyNotificationSubject("Edsby Notification: Ms. Arooj Malik in 7-K Mandarin"), {
    teacher: "Ms. Arooj Malik",
    course: "7-K Mandarin",
  });
});
