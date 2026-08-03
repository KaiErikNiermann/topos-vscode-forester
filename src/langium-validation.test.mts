/**
 * Validation tests for names that Forester and LaTeX both claim.
 *
 * \tag is Forester's frontmatter tagging command and amsmath's equation-number
 * macro. Inside math the LaTeX reading wins (the compiler emits it as a TeX
 * control sequence rather than resolving it), so the Forester-side checks must
 * stand down there — while still firing for genuinely misplaced uses.
 *
 * Run with: pnpm run test:langium-validation
 */

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import type { Document } from './language/generated/ast.js';
import { createForesterServices } from './language/forester-module.js';

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

// ── Harness ──────────────────────────────────────────────────────────────────

const services = createForesterServices(EmptyFileSystem);
const parse = parseHelper<Document>(services.Forester);

async function diagnosticsFor(source: string): Promise<string[]> {
    const doc = await parse(source, { validation: true });
    return (doc.diagnostics ?? []).map((d) => d.message);
}

/** Assert that nothing complains about the shadowed name. */
async function assertNoStructuralComplaint(source: string): Promise<void> {
    const offending = (await diagnosticsFor(source)).filter((m) => m.includes('\\tag'));
    if (offending.length > 0) {
        throw new Error(
            `Expected no \\tag diagnostics, got:\n  ${offending.join('\n  ')}`,
        );
    }
}

async function assertStructuralComplaint(source: string): Promise<void> {
    const messages = await diagnosticsFor(source);
    if (!messages.some((m) => m.includes('Structural command \\tag'))) {
        throw new Error(
            `Expected a structural-command error for \\tag, got:\n  ${messages.join('\n  ') || '(none)'}`,
        );
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

await test('\\tag in display math is left to LaTeX', async () => {
    await assertNoStructuralComplaint('\\title{x}\n##{ E = mc^2 \\tag{1} }\n');
});

// The container walk finds \p's BraceArg before noticing the math in between,
// which is exactly how this used to be reported as a structural error.
await test('\\tag in inline math nested in \\p{…} is left to LaTeX', async () => {
    await assertNoStructuralComplaint('\\title{x}\n\\p{inline #{a \\tag{i}} here}\n');
});

await test('\\tag inside a TeX brace group is left to LaTeX', async () => {
    await assertNoStructuralComplaint('\\title{x}\n##{ \\frac{a \\tag{1}}{b} }\n');
});

await test('\\tag in an align body is left to LaTeX', async () => {
    await assertNoStructuralComplaint(
        '\\title{x}\n##{\n  \\begin{align}\n    y &= 2x \\tag{lin}\n  \\end{align}\n}\n',
    );
});

await test('a real frontmatter \\tag is accepted', async () => {
    await assertNoStructuralComplaint('\\title{x}\n\\tag{real}\n');
});

await test('\\forester/tag is a known command, in math and out', async () => {
    await assertNoStructuralComplaint('\\title{x}\n##{ x \\forester/tag{draft} }\n');
    await assertNoStructuralComplaint('\\title{x}\n\\forester/tag{draft}\n');
});

// The shadow must not swallow the diagnostic it was carved out of: outside
// math, \tag in rendered content is still the mistake it always was.
await test('\\tag misplaced in rendered content still errors', async () => {
    await assertStructuralComplaint('\\title{x}\n\\p{oops \\tag{bad}}\n');
});

await test('\\taxon in rendered content still errors (shadow is \\tag-only)', async () => {
    const messages = await diagnosticsFor('\\title{x}\n##{ \\taxon{nope} }\n\\p{\\taxon{bad}}\n');
    if (!messages.some((m) => m.includes('Structural command \\taxon'))) {
        throw new Error(
            `Expected a structural-command error for \\taxon, got:\n  ${messages.join('\n  ') || '(none)'}`,
        );
    }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
