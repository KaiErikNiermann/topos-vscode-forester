import assert from "node:assert/strict";

import { collectParamNameHints, type NamedParam } from "./sig-inlay-core";

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

const PARAMS = new Map<string, readonly NamedParam[]>([
   ["\\embed", [{ name: "opts" }, { name: "target" }, { name: "caption" }]],
   ["\\cite", [{ name: "uid" }]],
   ["\\codeblock", [{ name: "lang" }, { name: "body" }]],
]);

// A hint as {label, the char it sits in front of} — easier to assert on than raw offsets.
function shape(source: string): Array<[string, string]> {
   return collectParamNameHints(source, PARAMS).map(h => [h.label, source.slice(h.offset, h.offset + 1)]);
}

console.log("\\n=== Sig Param-Name Inlay Core Tests ===\\n");

test("labels each positional brace of a known command", () => {
   assert.deepEqual(
      collectParamNameHints("\\embed{image}{#artifact:x}{cap}", PARAMS).map(h => h.label),
      ["opts:", "target:", "caption:"],
   );
});

test("hint sits just inside the opening brace", () => {
   // First hint's offset is the char immediately after `\embed{`.
   const [first] = collectParamNameHints("\\embed{image}{x}{y}", PARAMS);
   assert.equal(first!.offset, "\\embed{".length);
});

test("labels an empty argument too", () => {
   assert.deepEqual(shape("\\embed{image}{x}{}"), [
      ["opts:", "i"],
      ["target:", "x"],
      ["caption:", "}"],
   ]);
});

test("nested command inside an argument is hinted", () => {
   assert.deepEqual(
      collectParamNameHints("\\embed{image}{x}{see \\cite{r}}", PARAMS).map(h => h.label).sort(),
      ["caption:", "opts:", "target:", "uid:"],
   );
});

test("stops at the parameter count (extra braces unlabeled)", () => {
   assert.deepEqual(
      collectParamNameHints("\\cite{a}{b}", PARAMS).map(h => h.label),
      ["uid:"],
   );
});

test("a macro definition is not a call site", () => {
   assert.deepEqual(collectParamNameHints("\\def\\embed[opts][target][caption]{\\fig{\\target}}", PARAMS), []);
   assert.deepEqual(collectParamNameHints("\\let\\cite[uid]{\\uid}", PARAMS), []);
});

test("ignores commands inside comments and math", () => {
   assert.deepEqual(collectParamNameHints("% \\embed{a}{b}{c}", PARAMS), []);
   assert.deepEqual(collectParamNameHints("#{\\embed{a}{b}{c}}", PARAMS), []);
   assert.deepEqual(collectParamNameHints("##{\\cite{x}}", PARAMS), []);
});

test("unknown commands get no hints", () => {
   assert.deepEqual(collectParamNameHints("\\strong{hello} \\emph{x}", PARAMS), []);
});

test("bracket/paren args don't consume positional slots", () => {
   // \embed at a call site with a leading bracket arg: braces still map opts/target/caption.
   assert.deepEqual(
      collectParamNameHints("\\embed[k]{image}{x}{y}", PARAMS).map(h => h.label),
      ["opts:", "target:", "caption:"],
   );
});

console.log(`\\nTests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);

if (testsFailed > 0) {
   process.exitCode = 1;
}
