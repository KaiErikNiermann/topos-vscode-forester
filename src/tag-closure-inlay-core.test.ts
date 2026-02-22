import assert from "node:assert/strict";

import {
   collectTagClosureHints,
   DEFAULT_TAG_CLOSURE_HINT_TAGS,
} from "./tag-closure-inlay-core";

let testsPassed = 0;
let testsFailed = 0;

function test(name: string, fn: () => void): void {
   try {
      fn();
      testsPassed += 1;
      console.log(`PASS ${name}`);
   } catch (error) {
      testsFailed += 1;
      console.log(`FAIL ${name}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
   }
}

console.log("\\n=== Tag Closure Inlay Core Tests ===\\n");

test("default tag list matches expected presets", () => {
   assert.deepEqual(
      [...DEFAULT_TAG_CLOSURE_HINT_TAGS],
      ["ol", "ul", "li", "p", "subtree", "##", "tex", "texmath", "solution"],
   );
});

test("adds hints for nested structural commands", () => {
   const source = "\\ul{before \\li{item} after}";
   const hints = collectTagClosureHints(source);

   assert.deepEqual(
      hints.map(h => h.label),
      ["li", "ul"],
   );
});

test("supports optional parameters before subtree body", () => {
   const source = "\\subtree[abc123]{\\p{hello}}";
   const hints = collectTagClosureHints(source);

   assert.deepEqual(
      hints.map(h => h.label),
      ["p", "subtree"],
   );
});

test("respects configurable allowlist", () => {
   const source = "\\ul{\\li{a}}";
   const hints = collectTagClosureHints(source, {
      enabledTags: ["ul"],
   });

   assert.deepEqual(
      hints.map(h => h.label),
      ["ul"],
   );
});

test("normalizes leading backslash in configured tags", () => {
   const source = "\\ul{\\li{a}}";
   const hints = collectTagClosureHints(source, {
      enabledTags: ["\\li"],
   });

   assert.deepEqual(
      hints.map(h => h.label),
      ["li"],
   );
});

test("includes display math block closure when ## is enabled", () => {
   const source = "\\p{before ##{\\alpha + \\beta} after}";
   const hints = collectTagClosureHints(source);

   assert.deepEqual(
      hints.map(h => h.label),
      ["##", "p"],
   );
});

test("does not annotate commands inside ## or # blocks", () => {
   const source = "\\p{##{\\ul{x} \\li{y}} #{\\subtree{z}}}";
   const hints = collectTagClosureHints(source);

   assert.deepEqual(
      hints.map(h => h.label),
      ["##", "p"],
   );
});

test("does not annotate commands inside tex and texmath bodies", () => {
   const source = "\\p{\\tex{\\usepackage{x}}{\\ul{hidden}} \\texmath{\\li{hidden}}}";
   const hints = collectTagClosureHints(source);

   assert.deepEqual(
      hints.map(h => h.label),
      ["tex", "texmath", "p"],
   );
});

test("tex command hint points at the last argument close", () => {
   const source = "\\tex{preamble}{body}";
   const hints = collectTagClosureHints(source, {
      enabledTags: ["tex"],
   });

   assert.equal(hints.length, 1);
   assert.equal(hints[0].label, "tex");
   assert.equal(hints[0].offset, source.lastIndexOf("}"));
});

console.log(`\\nTests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);

if (testsFailed > 0) {
   process.exitCode = 1;
}
