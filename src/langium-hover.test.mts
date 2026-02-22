/**
 * Tests for the Langium-backed hover snippet finder (tasks 4–7, 8).
 *
 * Port of the findHoverTexSnippetAtOffset cases from latex-hover-core.test.ts.
 * Run with: npm run test:langium-hover
 */

import { findHoverSnippetAtOffset } from './language/hover-standalone.js';

// ── Minimal test framework ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
   try {
      await fn();
      passed++;
      console.log(`✓ ${name}`);
   } catch (e) {
      failed++;
      console.log(`✗ ${name}`);
      console.log(`  ${e instanceof Error ? e.message : e}`);
   }
}

function assertOk<T>(value: T, msg?: string): asserts value is NonNullable<T> {
   if (value === undefined || value === null) {
      throw new Error(msg ?? `Expected a defined value but got ${value}`);
   }
}

function assertEqual(actual: unknown, expected: unknown, msg?: string): void {
   if (actual !== expected) {
      throw new Error(
         `${msg ? msg + '\n' : ''}Expected: ${JSON.stringify(expected)}\nActual  : ${JSON.stringify(actual)}`,
      );
   }
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== Langium Hover Snippet Tests ===\n');

// Task 5: #{...} inline math
await test('finds inline math snippet under cursor', async () => {
   const source = '\\p{Equation #{x^2 + y^2} remains useful.}';
   const offset = source.indexOf('y^2');

   const snippet = await findHoverSnippetAtOffset(source, offset);
   assertOk(snippet, 'Expected a snippet');
   assertEqual(snippet.kind, 'math-inline');
   assertEqual(snippet.body.trim(), 'x^2 + y^2');
});

await test('inline math cursor at start of body', async () => {
   const source = '#{abc}';
   const offset = 2; // on 'a'

   const snippet = await findHoverSnippetAtOffset(source, offset);
   assertOk(snippet);
   assertEqual(snippet.kind, 'math-inline');
});

await test('inline math: start offset is before the # character', async () => {
   const source = '#{x^2}';
   const snippet = await findHoverSnippetAtOffset(source, 2);
   assertOk(snippet);
   if (snippet.start > 0) {
      throw new Error(`Expected start to be 0 but got ${snippet.start}`);
   }
});

await test('inline math: end covers the closing }', async () => {
   const source = '#{x}';
   const snippet = await findHoverSnippetAtOffset(source, 2);
   assertOk(snippet);
   assertEqual(snippet.end, source.length);
});

// Task 6: ##{...} display math
await test('finds display math snippet under cursor', async () => {
   const source = 'Before ##{\\frac{a}{b}} after';
   const offset = source.indexOf('frac');

   const snippet = await findHoverSnippetAtOffset(source, offset);
   assertOk(snippet, 'Expected a display math snippet');
   assertEqual(snippet.kind, 'math-display');
});

await test('display math body contains the math content', async () => {
   const source = '##{E = mc^2}';
   // offset 3 = 'E' (##{ is 3 chars so 'E' is at index 3)
   const snippet = await findHoverSnippetAtOffset(source, 3);
   assertOk(snippet);
   assertEqual(snippet.kind, 'math-display');
   if (!snippet.body.includes('E')) {
      throw new Error(`Expected body to contain 'E', got: ${JSON.stringify(snippet.body)}`);
   }
});

await test('display math: end covers the closing }', async () => {
   const source = '##{x}';
   const snippet = await findHoverSnippetAtOffset(source, 3);
   assertOk(snippet);
   assertEqual(snippet.end, source.length);
});

// Task 7: \tex{preamble}{body}
await test('finds \\tex block and extracts preamble argument', async () => {
   const source = '\\tex{\\get\\base/tex-preamble}{\\begin{bnf}X\\end{bnf}}';
   const offset = source.indexOf('bnf');

   const snippet = await findHoverSnippetAtOffset(source, offset);
   assertOk(snippet, 'Expected a tex snippet');
   assertEqual(snippet.kind, 'tex');
   if (!snippet.preamble?.includes('tex-preamble')) {
      throw new Error(`Expected preamble to contain 'tex-preamble', got: ${JSON.stringify(snippet.preamble)}`);
   }
});

await test('finds \\tex block and extracts body argument', async () => {
   const source = '\\tex{\\usepackage{amsmath}}{\\begin{equation}E=mc^2\\end{equation}}';
   const offset = source.indexOf('E=mc');

   const snippet = await findHoverSnippetAtOffset(source, offset);
   assertOk(snippet);
   assertEqual(snippet.kind, 'tex');
   if (!snippet.body.includes('E=mc')) {
      throw new Error(`Expected body to contain 'E=mc', got: ${JSON.stringify(snippet.body)}`);
   }
});

await test('\\tex block cursor in preamble still returns tex snippet', async () => {
   const source = '\\tex{\\usepackage{amsmath}}{E=mc^2}';
   const offset = source.indexOf('amsmath');

   const snippet = await findHoverSnippetAtOffset(source, offset);
   assertOk(snippet);
   assertEqual(snippet.kind, 'tex');
});

// Task 4: No snippet at cursor outside math/tex
await test('returns undefined when cursor is not in a math or tex block', async () => {
   const source = '\\title{Hello World}';
   const offset = 5;

   const snippet = await findHoverSnippetAtOffset(source, offset);
   if (snippet !== undefined) {
      throw new Error(`Expected undefined but got ${JSON.stringify(snippet)}`);
   }
});

await test('returns undefined for empty document', async () => {
   const snippet = await findHoverSnippetAtOffset('', 0);
   if (snippet !== undefined) {
      throw new Error(`Expected undefined but got ${JSON.stringify(snippet)}`);
   }
});

// Nested math blocks
await test('cursor inside nested display math inside \\p', async () => {
   const source = '\\p{See ##{x^2}}';
   const offset = source.indexOf('x^2');

   const snippet = await findHoverSnippetAtOffset(source, offset);
   assertOk(snippet);
   assertEqual(snippet.kind, 'math-display');
});

await test('cursor inside inline math nested in \\subtree', async () => {
   const source = '\\subtree{\\title{Test}\\p{See #{x^2}}}';
   const offset = source.indexOf('x^2');

   const snippet = await findHoverSnippetAtOffset(source, offset);
   assertOk(snippet);
   assertEqual(snippet.kind, 'math-inline');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
   process.exit(1);
}
