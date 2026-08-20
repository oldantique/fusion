import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDocs } from "../scripts/check-docs.ts";

test("docs only point at things that exist and keep single-home facts in their home", () => {
  const problems = checkDocs();
  assert.deepEqual(problems, []);
});
