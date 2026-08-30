import test from "node:test";
import assert from "node:assert/strict";
import { extractEdsbyMetadata } from "../scripts/edsbyClient.js";

test("Edsby card context extracts course and teacher before assignment sections", () => {
  const metadata = extractEdsbyMetadata([
    "7-K Mathematics",
    "Ms Khadija Aqeel",
    "Topics Covered",
    "Linear equations",
    "To Do",
    "Workbook D1 question 9",
    "Date: Aug 28",
  ].join("\n"));
  assert.equal(metadata.course, "7-K Mathematics");
  assert.equal(metadata.teacher, "Ms Khadija Aqeel");
});

test("Edsby metadata never mistakes Topics Covered for a course", () => {
  const metadata = extractEdsbyMetadata("Topics Covered\nFractions\nTo Do\nWorkbook page 7\nDate: Aug 28");
  assert.equal(metadata.course, "");
});

