import assert from "node:assert/strict";

import {
   computeSubtreeIdScanState,
   DEFAULT_SUBTREE_TEMPLATE,
   extractSubtreeReferenceIds,
   fromBase36Stem,
   MAX_BASE36_VALUE,
   nextCanonicalBase36Id,
   renderSubtreeTemplate,
   toBase36,
} from "./subtree-auto-id-core";

let testsPassed = 0;
let testsFailed = 0;

function test(name: string, fn: () => void): void {
   try {
      fn();
      testsPassed += 1;
      console.log(`✓ ${name}`);
   } catch (error) {
      testsFailed += 1;
      console.log(`✗ ${name}`);
      console.log(`  Error: ${error instanceof Error ? error.message : String(error)}`);
   }
}

console.log("\n=== Subtree Auto-ID Tests ===\n");

test("Extract subtree IDs from subtree commands with bracketed IDs", () => {
   const content = [
      "\\subtree[alpha-0001]{",
      "  \\title{A}",
      "}",
      "\\subtree[beta-0010]{\\title{B}}",
      "\\subtree{\\title{No ID}}",
   ].join("\n");

   const ids = extractSubtreeReferenceIds(content);
   assert.deepEqual(ids, ["alpha-0001", "beta-0010"]);
});

test("Compute scan state from tree names and subtree refs using canonical 4-char base36 only", () => {
   const treeIds = ["00af", "notes-about-cats", "00b9", "ABCD"];
   const subtreeIds = ["xyz", "00ba", "a0ff"];

   const state = computeSubtreeIdScanState(treeIds, subtreeIds);
   const expectedMax = Math.max(fromBase36Stem("00ba") ?? -1, fromBase36Stem("a0ff") ?? -1);

   assert.equal(state.knownCanonicalIds.has("notes-about-cats"), false);
   assert.equal(state.knownCanonicalIds.has("ABCD"), false);
   assert.equal(state.knownCanonicalIds.has("00ba"), true);
   assert.equal(state.nextCanonicalValue, expectedMax + 1);
});

test("nextCanonicalBase36Id skips used canonical IDs in sequence", () => {
   const known = new Set(["0000", "0001", "0003"]);
   const next = nextCanonicalBase36Id(known, 0);

   assert.equal(next.id, "0002");
   assert.equal(next.nextValue, (fromBase36Stem("0002") ?? 0) + 1);
});

test("Base36 encoding/decoding follows canonical 4-char format", () => {
   assert.equal(toBase36(0), "0000");
   assert.equal(toBase36(MAX_BASE36_VALUE), "zzzz");
   assert.equal(fromBase36Stem("00z0"), 1260);
});

test("nextCanonicalBase36Id throws when canonical range is exhausted", () => {
   assert.throws(() => nextCanonicalBase36Id(["zzzz"], MAX_BASE36_VALUE), /No available canonical 4-char base36/);
});

test("Render subtree template with explicit <id> placeholder", () => {
   const template = "\\subtree[<id>]{\n  \\title{$1}\n}$0";
   const rendered = renderSubtreeTemplate(template, "00ff");

   assert.equal(rendered.includes("00ff"), true);
   assert.equal(rendered.includes("<id>"), false);
});

test("Render subtree template by upgrading bare \\subtree{ to include ID", () => {
   const template = "\\subtree{\\title{$1}}";
   const rendered = renderSubtreeTemplate(template, "00ff");

   assert.equal(rendered, "\\subtree[00ff]{\\title{$1}}");
});

test("Fallback to default template when template cannot embed subtree IDs", () => {
   const template = "\\title{$1}";
   const rendered = renderSubtreeTemplate(template, "00ff");

   assert.equal(rendered, DEFAULT_SUBTREE_TEMPLATE.replace("<id>", "00ff"));
});

console.log(`\nTests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);

if (testsFailed > 0) {
   process.exitCode = 1;
}
