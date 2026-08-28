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

// ── Raw groups ───────────────────────────────────────────────────────────────

// The whole point of !{…}: a LaTeX figure body uses '%' comments, bracket
// options, '&' and '\\' row separators, and '#1' parameters, every one of which
// forester's own syntax otherwise claims.
const TIKZ_BODY = String.raw`\import{base-macros}
\texfig!{
  \begin{tikzpicture}[
    over/.style={decorate, decoration={brace, raise=#1}, thick},
  ]
    % an ordinary LaTeX comment
    \matrix (M) [matrix of math nodes, column sep=0pt] {
      a_1 & , & \ldots & , & a_n \\
    };
    \draw[over] (M-1-1.north west) -- (M-1-5.north east);
  \end{tikzpicture}
}
\p{prose after the figure}
`;

async function foreignDiagnostics(source: string): Promise<string[]> {
    // The workspace index is empty in a headless test, so \import{base-macros}
    // is legitimately unresolvable; that says nothing about the raw group.
    return (await diagnosticsFor(source)).filter((m) => !m.includes('base-macros'));
}

await test('a raw TikZ body produces no diagnostics', async () => {
    const messages = await foreignDiagnostics(TIKZ_BODY);
    if (messages.length > 0) {
        throw new Error(`Expected none, got:\n  ${messages.join('\n  ')}`);
    }
});

await test('a raw body parses without lexer or parser errors', async () => {
    const doc = await parse(TIKZ_BODY);
    const { lexerErrors, parserErrors } = doc.parseResult;
    if (lexerErrors.length > 0 || parserErrors.length > 0) {
        throw new Error(
            `lexer: ${lexerErrors.map((e) => e.message).join('; ')}\n`
            + `parser: ${parserErrors.map((e) => e.message).join('; ')}`,
        );
    }
});

// A raw group is an argument form, so the command and what follows it must
// still be seen as ordinary structure.
await test('the figure and the prose after it stay separate nodes', async () => {
    const doc = await parse(TIKZ_BODY);
    const types = doc.parseResult.value.nodes.map((n) => n.$type);
    if (types.join(',') !== 'Command,Command,Command') {
        throw new Error(`Expected three commands, got: ${types.join(',')}`);
    }
});

// Unbalanced brackets are exactly what the bracket matcher would otherwise
// flag, and it works on raw text rather than the AST.
await test('unbalanced TeX delimiters inside a raw group are not flagged', async () => {
    const messages = await foreignDiagnostics(
        String.raw`\p{x}` + '\n' + String.raw`\texfig!{ \draw (0,1] -- \left. \right) ; }` + '\n',
    );
    if (messages.length > 0) {
        throw new Error(`Expected none, got:\n  ${messages.join('\n  ')}`);
    }
});

// The body ends at the brace matching the opener, so a group left open should
// fail loudly rather than swallowing the rest of the file.
await test('an unterminated raw group is a parse error', async () => {
    const doc = await parse(String.raw`\texfig!{ \draw (a) -- (b);` + '\n');
    if (doc.parseResult.parserErrors.length === 0 && (doc.diagnostics ?? []).length === 0) {
        throw new Error('Expected an unterminated raw group to be reported');
    }
});

// ── Handrolled-macro detection ───────────────────────────────────────────────
//
// End-to-end: the IndexedContent hook must invert the document's own \def table and
// checkHandrolledMacro must then fire on the expansion. Both halves are exercised
// here because the fixture and the usage live in one document.

const HANDROLL_DOC = String.raw`\def\N{\notation{009A}{\mathbb{N}}}
\p{prose about #{\mathbb{N}} here}
`;

await test('a handrolled documented symbol is reported', async () => {
    const messages = await diagnosticsFor(HANDROLL_DOC);
    if (!messages.some((m) => m.includes('expansion of \\N'))) {
        throw new Error(`Expected a handrolled-macro diagnostic, got:\n  ${messages.join('\n  ') || '(none)'}`);
    }
});

await test('the diagnostic carries the code and replacement a quick-fix needs', async () => {
    const doc = await parse(HANDROLL_DOC, { validation: true });
    const hit = (doc.diagnostics ?? []).find((d) => d.code === 'handrolled-macro');
    if (!hit) { throw new Error('no diagnostic with code handrolled-macro'); }
    const data = hit.data as { replacement?: string | null } | undefined;
    if (data?.replacement !== '\\N') {
        throw new Error(`Expected replacement \\N, got ${JSON.stringify(data)}`);
    }
});

await test('using the macro itself is clean', async () => {
    const messages = await diagnosticsFor(String.raw`\def\N{\notation{009A}{\mathbb{N}}}
\p{prose about #{\N} here}
`);
    if (messages.some((m) => m.includes('expansion of'))) {
        throw new Error(`Expected no handrolled-macro diagnostic, got:\n  ${messages.join('\n  ')}`);
    }
});

await test('a raw group is never flagged — forester expands nothing there', async () => {
    const messages = await diagnosticsFor(String.raw`\def\N{\notation{009A}{\mathbb{N}}}
\texfig!{ $\mathbb{N}$ }
`);
    if (messages.some((m) => m.includes('expansion of'))) {
        throw new Error(`Expected no diagnostic inside a raw group, got:\n  ${messages.join('\n  ')}`);
    }
});

await test('a file-scoped pragma silences the report', async () => {
    const messages = await diagnosticsFor(String.raw`\def\N{\notation{009A}{\mathbb{N}}}
% macro-check: allow \mathbb{N}
\p{prose about #{\mathbb{N}} here}
`);
    if (messages.some((m) => m.includes('expansion of'))) {
        throw new Error(`Expected the pragma to silence it, got:\n  ${messages.join('\n  ')}`);
    }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
