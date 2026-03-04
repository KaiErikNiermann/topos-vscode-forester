import assert from "node:assert/strict";

import {
   collectTagClosureHints,
   DEFAULT_TAG_CLOSURE_HINT_TAGS,
   formatSubtreeTooltip,
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

// --- Subtree metadata tests ---

test("subtree hint has full metadata (id, taxon, title)", () => {
   const source = "\\subtree[006u]{\\taxon{Example}\\title{Modal formulas}}";
   const hints = collectTagClosureHints(source);
   const subtreeHint = hints.find(h => h.label === "subtree");
   assert.ok(subtreeHint);
   assert.deepEqual(subtreeHint.subtreeMetadata, {
      id: "006u",
      taxon: "Example",
      title: "Modal formulas",
   });
});

test("subtree hint with ID only", () => {
   const source = "\\subtree[006u]{\\p{body}}";
   const hints = collectTagClosureHints(source);
   const subtreeHint = hints.find(h => h.label === "subtree");
   assert.ok(subtreeHint);
   assert.equal(subtreeHint.subtreeMetadata?.id, "006u");
   assert.equal(subtreeHint.subtreeMetadata?.taxon, undefined);
   assert.equal(subtreeHint.subtreeMetadata?.title, undefined);
});

test("subtree hint with taxon only", () => {
   const source = "\\subtree{\\taxon{Theorem}\\p{body}}";
   const hints = collectTagClosureHints(source);
   const subtreeHint = hints.find(h => h.label === "subtree");
   assert.ok(subtreeHint);
   assert.equal(subtreeHint.subtreeMetadata?.id, undefined);
   assert.equal(subtreeHint.subtreeMetadata?.taxon, "Theorem");
});

test("subtree hint with title only", () => {
   const source = "\\subtree{\\title{My Title}\\p{body}}";
   const hints = collectTagClosureHints(source);
   const subtreeHint = hints.find(h => h.label === "subtree");
   assert.ok(subtreeHint);
   assert.equal(subtreeHint.subtreeMetadata?.title, "My Title");
});

test("subtree hint with no metadata", () => {
   const source = "\\subtree{\\p{body}}";
   const hints = collectTagClosureHints(source);
   const subtreeHint = hints.find(h => h.label === "subtree");
   assert.ok(subtreeHint);
   assert.equal(subtreeHint.subtreeMetadata?.id, undefined);
   assert.equal(subtreeHint.subtreeMetadata?.taxon, undefined);
   assert.equal(subtreeHint.subtreeMetadata?.title, undefined);
});

test("nested subtree scoping: outer metadata not polluted by inner", () => {
   const source = "\\subtree[001]{\\title{Outer}\\subtree[002]{\\title{Inner}}}";
   const hints = collectTagClosureHints(source);
   // The outer subtree hint is the last one with label "subtree"
   const subtreeHints = hints.filter(h => h.label === "subtree");
   assert.equal(subtreeHints.length, 2);
   // Inner subtree hint comes first (pushed during recursive parseRegion)
   assert.equal(subtreeHints[0].subtreeMetadata?.id, "002");
   assert.equal(subtreeHints[0].subtreeMetadata?.title, "Inner");
   // Outer subtree hint
   assert.equal(subtreeHints[1].subtreeMetadata?.id, "001");
   assert.equal(subtreeHints[1].subtreeMetadata?.title, "Outer");
});

test("non-subtree commands have no subtreeMetadata", () => {
   const source = "\\p{\\taxon{X}\\title{Y}}";
   const hints = collectTagClosureHints(source);
   const pHint = hints.find(h => h.label === "p");
   assert.ok(pHint);
   assert.equal(pHint.subtreeMetadata, undefined);
});

test("formatSubtreeTooltip with all fields", () => {
   assert.equal(
      formatSubtreeTooltip({ id: "006u", taxon: "Example", title: "Modal formulas" }),
      "subtree id=006u | taxon=Example | title=Modal formulas",
   );
});

test("formatSubtreeTooltip with id only", () => {
   assert.equal(formatSubtreeTooltip({ id: "abc" }), "subtree id=abc");
});

test("formatSubtreeTooltip with no fields", () => {
   assert.equal(formatSubtreeTooltip({}), "Closes \\subtree{...}");
});

test("formatSubtreeTooltip with taxon and title only", () => {
   assert.equal(
      formatSubtreeTooltip({ taxon: "Theorem", title: "Main result" }),
      "subtree taxon=Theorem | title=Main result",
   );
});

console.log(`\\nTests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);

if (testsFailed > 0) {
   process.exitCode = 1;
}
