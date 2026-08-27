import test from "node:test";
import assert from "node:assert/strict";
import { gmailMessageToCard } from "../scripts/gmailClient.js";

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
