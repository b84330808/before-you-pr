import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isClaimComment, isReleaseComment } from "../src/checks/issue.ts";

describe("claim comments", () => {
  for (const body of [
    "I'd like to work on this!",
    "Can I take this one?",
    "Hi, could I be assigned to this issue?",
    "I’ll work on it this weekend.",
    "I'm working on a fix.",
    "/assign",
    ".take",
    "@rustbot claim",
    "Is this still available?",
  ]) {
    it(`claims: ${body}`, () => assert.equal(isClaimComment(body), true));
  }
  for (const body of [
    "I'd like this fixed too.",
    "Can someone work on this?",
    "> I'd like to work on this\n\nPlease read the contributing guide first.",
    "Thanks for the report!",
  ]) {
    it(`does not claim: ${body.split("\n")[0]}`, () => assert.equal(isClaimComment(body), false));
  }
  it("recognises a released claim", () => {
    assert.equal(isReleaseComment("Sorry, I'm no longer working on this, feel free to take it."), true);
    assert.equal(isReleaseComment("Still on it, PR coming soon."), false);
  });
});
