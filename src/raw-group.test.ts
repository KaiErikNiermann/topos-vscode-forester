import assert from "node:assert/strict";

import { findRawGroupSpans, findVerbatimSpans, isInSpans, rawGroupEnd } from "./raw-group";

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

/** The offsets `text` marks with ⟦…⟧, and the text with the markers removed. */
function marked(text: string): { source: string; start: number; end: number } {
   const start = text.indexOf("⟦");
   const end = text.indexOf("⟧") - 1;
   return { source: text.replace(/[⟦⟧]/g, ""), start, end };
}

test("a raw group is one verbatim span, delimiters included", () => {
   const spans = findVerbatimSpans("\\texfig!{\\def\\st{pick}}");
   assert.equal(spans.length, 1);
   assert.deepEqual(spans[0], { startOffset: 7, endOffset: 23 });
});

test("\\startverb…\\stopverb is a verbatim span", () => {
   const source = "before \\startverb \\def\\st{x} \\stopverb after";
   const spans = findVerbatimSpans(source);
   assert.equal(spans.length, 1);
   assert.equal(source.slice(spans[0]!.startOffset, spans[0]!.endOffset), "\\startverb \\def\\st{x} \\stopverb");
});

test("a ``` fence is a verbatim span", () => {
   const source = "a\n```lean\ndef st := 1\n```\nb";
   const spans = findVerbatimSpans(source);
   assert.equal(spans.length, 1);
   assert.equal(source.slice(spans[0]!.startOffset, spans[0]!.endOffset), "```lean\ndef st := 1\n```");
});

test("an unterminated herald or fence runs to end of input", () => {
   assert.deepEqual(findVerbatimSpans("x \\startverb never closed"), [{ startOffset: 2, endOffset: 25 }]);
   assert.deepEqual(findVerbatimSpans("x ```open"), [{ startOffset: 2, endOffset: 9 }]);
});

test("an unterminated raw group is not a span — the '!' stays ordinary text", () => {
   assert.deepEqual(findVerbatimSpans("\\texfig!{ never closed"), []);
});

test("spans come out in source order and do not overlap", () => {
   const source = "!{a} mid \\startverb b \\stopverb end !{c}";
   const spans = findVerbatimSpans(source);
   assert.equal(spans.length, 3);
   for (let i = 1; i < spans.length; i++) {
      assert.ok(spans[i]!.startOffset >= spans[i - 1]!.endOffset, "spans overlap");
   }
});

test("a `!{` inside a verbatim block does not open a nested span", () => {
   const spans = findVerbatimSpans("\\startverb !{ \\stopverb");
   assert.equal(spans.length, 1);
   assert.equal(spans[0]!.endOffset, 23);
});

test("the reported case: a TikZ \\def in a texfig is inside a span, the forest's own is not", () => {
   const { source, start, end } = marked(
      "\\def\\st{such that}\n\\texfig!{\n  \\ifnum\\i=#3\\relax⟦\\def\\st{pick}⟧\\else\\def\\st{skip}\\fi\n}",
   );
   const spans = findVerbatimSpans(source);
   assert.equal(isInSpans(spans, start), true, "the figure-internal \\def should be excluded");
   assert.equal(isInSpans(spans, end), true);
   assert.equal(isInSpans(spans, source.indexOf("\\def\\st{such that}")), false, "the real binding should survive");
});

test("findRawGroupSpans still sees only raw groups", () => {
   const source = "!{a} \\startverb b \\stopverb";
   assert.equal(findRawGroupSpans(source).length, 1);
   assert.equal(findVerbatimSpans(source).length, 2);
});

test("rawGroupEnd is unchanged: escaped braces do not count", () => {
   assert.equal(rawGroupEnd("!{\\{ \\} }", 0), 9);
   assert.equal(rawGroupEnd("!{unterminated", 0), null);
   assert.equal(rawGroupEnd("x{y}", 0), null);
});

console.log(`\nTests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);

if (testsFailed > 0) {
   process.exitCode = 1;
}
