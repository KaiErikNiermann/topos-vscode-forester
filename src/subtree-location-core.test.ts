import assert from "node:assert/strict";

import {
   findSubtreeDeclaration,
   findSubtreeDeclarations,
   mayContainSubtree,
} from "./subtree-location-core";

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

console.log("\n=== Subtree Location Tests ===\n");

const PARENT = [
   "\\title{Parent}",
   "\\p{Prose that mentions 009k in passing.}",
   "",
   "\\subtree[009k]{",
   "  \\title{A subtree}",
   "}",
   "",
   "\\subtree[00zz]{\\title{Another}}",
].join("\n");

test("Finds an inline subtree declaration by id", () => {
   const declaration = findSubtreeDeclaration(PARENT, "009k");
   assert.ok(declaration);
   assert.equal(declaration.id, "009k");
   assert.deepEqual(declaration.start, { line: 3, character: 0 });
   // `\subtree[009k]` is 14 characters wide.
   assert.deepEqual(declaration.end, { line: 3, character: 14 });
   assert.deepEqual(declaration.idStart, { line: 3, character: 9 });
   assert.deepEqual(declaration.idEnd, { line: 3, character: 13 });
});

test("Prose mentioning the id does not win over the declaration", () => {
   const declaration = findSubtreeDeclaration(PARENT, "009k");
   assert.ok(declaration);
   assert.equal(declaration.start.line, 3);
});

test("Finds a subtree declared on a line with other content", () => {
   const declaration = findSubtreeDeclaration(PARENT, "00zz");
   assert.ok(declaration);
   assert.deepEqual(declaration.idStart, { line: 7, character: 9 });
});

test("Returns null for an id that is not declared as a subtree", () => {
   assert.equal(findSubtreeDeclaration(PARENT, "abcd"), null);
   assert.equal(findSubtreeDeclaration(PARENT, ""), null);
});

test("Ignores a bare \\subtree{...} with no address", () => {
   const declarations = findSubtreeDeclarations("\\subtree{\\title{No id}}");
   assert.equal(declarations.length, 0);
});

test("Ignores an empty or whitespace-only address", () => {
   const declarations = findSubtreeDeclarations("\\subtree[]{}\n\\subtree[   ]{}");
   assert.equal(declarations.length, 0);
});

test("Trims a padded address and still points at the id itself", () => {
   const declaration = findSubtreeDeclaration("\\subtree[  009k  ]{", "009k");
   assert.ok(declaration);
   assert.deepEqual(declaration.idStart, { line: 0, character: 11 });
   assert.deepEqual(declaration.idEnd, { line: 0, character: 15 });
});

test("Tolerates whitespace between \\subtree and its bracket", () => {
   const declaration = findSubtreeDeclaration("\\subtree\n[009k]{", "009k");
   assert.ok(declaration);
   assert.deepEqual(declaration.start, { line: 0, character: 0 });
   assert.deepEqual(declaration.idStart, { line: 1, character: 1 });
});

test("Lists every declaration in source order", () => {
   const ids = findSubtreeDeclarations(PARENT).map((declaration) => declaration.id);
   assert.deepEqual(ids, ["009k", "00zz"]);
});

test("Handles CRLF line endings", () => {
   const declaration = findSubtreeDeclaration("\\title{P}\r\n\\subtree[009k]{\r\n", "009k");
   assert.ok(declaration);
   assert.deepEqual(declaration.start, { line: 1, character: 0 });
});

test("Nested subtrees are each addressable", () => {
   const nested = ["\\subtree[outr]{", "  \\subtree[innr]{", "  }", "}"].join("\n");
   const inner = findSubtreeDeclaration(nested, "innr");
   assert.ok(inner);
   assert.deepEqual(inner.start, { line: 1, character: 2 });
});

test("Pre-filter rejects files that cannot contain the declaration", () => {
   assert.equal(mayContainSubtree(PARENT, "009k"), true);
   assert.equal(mayContainSubtree(PARENT, "zzzz"), false);
   assert.equal(mayContainSubtree("\\title{No subtrees here}", "009k"), false);
});

console.log(`\n=== ${testsPassed} passed, ${testsFailed} failed ===\n`);

if (testsFailed > 0) {
   process.exit(1);
}
