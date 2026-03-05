/**
 * Tests for forester diagnostic parsing
 *
 * Run with: npx tsx src/forester-diagnostics.test.ts
 */

// Minimal VS Code stubs for testing
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

// We can't import the module directly since it imports vscode,
// so we extract and test the pure parsing logic inline.

// ── Copied from forester-diagnostics.ts (pure parsing functions) ──

interface ParsedDiagnosticTest {
    filePath: string;
    line: number;
    message: string;
    severity: string;
    code: string;
}

function parseAsaiDiagnosticsTest(output: string): ParsedDiagnosticTest[] {
    const results: ParsedDiagnosticTest[] = [];
    const blocks = output.split(/(?=\s*￫\s)/);
    for (const block of blocks) {
        const parsed = parseAsaiBlockTest(block);
        if (parsed) { results.push(parsed); }
    }
    return results;
}

function parseAsaiBlockTest(block: string): ParsedDiagnosticTest | null {
    const headerMatch = block.match(/￫\s+(error|warning|info|bug)\[([^\]]+)\]/);
    if (!headerMatch) { return null; }
    const severity = headerMatch[1];
    const code = headerMatch[2];
    if (severity === "info" && code === "log") { return null; }

    const fileMatch = block.match(/￭\s+(.+\.tree)\b/);
    if (!fileMatch) { return null; }
    const filePath = fileMatch[1].trim();

    const lineMatch = block.match(/^\s*(\d+)\s*\|/m);
    const line = lineMatch ? parseInt(lineMatch[1], 10) - 1 : 0;

    const caretMatch = block.match(/^\s*\^\s*(.*)$/m);
    let message = caretMatch ? caretMatch[1].trim() : code;

    const latexError = extractLatexErrorTest(block);
    if (latexError) { message = latexError; }

    return { filePath, line, message, severity, code };
}

function extractLatexErrorTest(block: string): string | null {
    const errorLines = block.match(/^\t*!\s+(.+)$/gm);
    if (!errorLines || errorLines.length === 0) { return null; }
    const firstError = errorLines[0].replace(/^\t*!\s+/, "").trim();
    const lineContext = block.match(/^\t*l\.(\d+)\s+(.*)$/m);
    if (lineContext) {
        const texLine = lineContext[1];
        const context = lineContext[2].trim();
        return `LaTeX error: ${firstError} (at l.${texLine}: ${context})`;
    }
    return `LaTeX error: ${firstError}`;
}

// ── Test framework ──

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        passed++;
        console.log(`✓ ${name}`);
    } catch (e: any) {
        failed++;
        console.log(`✗ ${name}`);
        console.log(`  ${e.message}`);
    }
}

function assertEqual(actual: any, expected: any, label = "") {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        throw new Error(`${label}\n  Expected: ${e}\n  Actual:   ${a}`);
    }
}

// ── Tests ──

console.log("=== Forester Diagnostics Parser Tests ===\n");

test("Parse LaTeX compilation error", () => {
    const output = ` ￫ info[log]
 ￮
 ￮ Building ./build/resources/31dbb42201f1cf39c88a29472ff3bc2f.svg

 ￫ error[external_error]
 ￭ /home/user/notes/trees/test-tex-error.tree
 2 | \\tex{
   ^ Encountered fatal LaTeX error:

\tThis is pdfTeX, Version 3.141592653
\t restricted \\write18 enabled.
\t(./job.tex
\t! Undefined control sequence.
\tl.18   \\undefinedcommand
\t                         {this will fail}
\tNo pages of output.

 while running \`latex -halt-on-error -interaction=nonstopmode job.tex\` in directory \`./_tmp/440/\`.
 ￮ `;

    const diags = parseAsaiDiagnosticsTest(output);
    assertEqual(diags.length, 1, "Should find 1 diagnostic");
    assertEqual(diags[0].filePath, "/home/user/notes/trees/test-tex-error.tree");
    assertEqual(diags[0].line, 1); // 0-indexed, line 2 in output
    assertEqual(diags[0].severity, "error");
    assertEqual(diags[0].code, "external_error");
    // Should extract the specific LaTeX error
    assertEqual(diags[0].message.includes("Undefined control sequence"), true, "Should contain LaTeX error");
    assertEqual(diags[0].message.includes("l.18"), true, "Should contain LaTeX line number");
});

test("Skip info[log] messages", () => {
    const output = ` ￫ info[log]
 ￮
 ￮ Building ./build/resources/abc123.svg
`;
    const diags = parseAsaiDiagnosticsTest(output);
    assertEqual(diags.length, 0, "info[log] should be skipped");
});

test("Parse warning diagnostic", () => {
    const output = ` ￫ warning[broken_link]
 ￭ /home/user/notes/trees/0001.tree
 5 | \\transclude{nonexistent}
   ^ Potentially broken link to \`nonexistent\`
 ￮ `;

    const diags = parseAsaiDiagnosticsTest(output);
    assertEqual(diags.length, 1);
    assertEqual(diags[0].severity, "warning");
    assertEqual(diags[0].code, "broken_link");
    assertEqual(diags[0].line, 4); // 0-indexed
    assertEqual(diags[0].message, "Potentially broken link to `nonexistent`");
});

test("Parse multiple diagnostics", () => {
    const output = ` ￫ error[external_error]
 ￭ /home/user/notes/trees/a.tree
 3 | \\tex{}{\\bad}
   ^ Encountered fatal LaTeX error:

\t! Undefined control sequence.
\tl.5   \\bad

 ￮

 ￫ warning[broken_link]
 ￭ /home/user/notes/trees/b.tree
 10 | \\transclude{missing}
    ^ Potentially broken link
 ￮ `;

    const diags = parseAsaiDiagnosticsTest(output);
    assertEqual(diags.length, 2, "Should find 2 diagnostics");
    assertEqual(diags[0].filePath.endsWith("a.tree"), true);
    assertEqual(diags[1].filePath.endsWith("b.tree"), true);
});

test("LaTeX error extraction - Missing $ inserted", () => {
    const block = `\t! Missing $ inserted.
\t<inserted text>
\t                $
\tl.15   some math content
`;
    const error = extractLatexErrorTest(block);
    assertEqual(error!.includes("Missing $ inserted"), true);
    assertEqual(error!.includes("l.15"), true);
});

test("LaTeX error extraction - Environment undefined", () => {
    const block = `\t! LaTeX Error: Environment tikzcd undefined.
\t
\tSee the LaTeX manual or LaTeX Companion for explanation.
\tl.12 \\begin{tikzcd}
`;
    const error = extractLatexErrorTest(block);
    assertEqual(error!.includes("Environment tikzcd undefined"), true);
});

test("No diagnostics from clean output", () => {
    const output = `[{"uri":"0001","title":"Test","taxon":null,"tags":[],"route":"0001","metas":{},"sourcePath":"trees/0001.tree"}]`;
    const diags = parseAsaiDiagnosticsTest(output);
    assertEqual(diags.length, 0);
});

test("Block without file path is skipped", () => {
    const output = ` ￫ error[configuration_error]
 Some config error without file marker
 ￮ `;
    const diags = parseAsaiDiagnosticsTest(output);
    assertEqual(diags.length, 0, "No file path → skip");
});

// ── Normalization tests ──

function normalizeForMatch(s: string): string {
    return s
        .replace(/\s+(?=[{[\]})])/g, "")
        .replace(/(?<=[{[\](])\s+/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

test("normalizeForMatch removes forester-inserted spaces", () => {
    // Forester adds spaces before { and [
    const foresterOutput = "\\begin {tikzcd}[cramped, column sep=tiny]";
    const treeSource =     "\\begin{tikzcd}[cramped, column sep=tiny]";
    assertEqual(normalizeForMatch(foresterOutput), normalizeForMatch(treeSource));
});

test("normalizeForMatch handles \\arrow with brackets", () => {
    const foresterOutput = '\\arrow ["5", dashed, from=1-2, to=1-2]';
    const treeSource =     '\\arrow["5", dashed, from=1-2, to=1-2]';
    assertEqual(normalizeForMatch(foresterOutput), normalizeForMatch(treeSource));
});

test("normalizeForMatch collapses multiline to single line", () => {
    const multiline = "\\begin{tikzcd}\n    A \\arrow[r] & B\n  \\end{tikzcd}";
    const result = normalizeForMatch(multiline);
    assertEqual(result.includes("\n"), false, "Should not contain newlines");
    assertEqual(result.includes("\\begin{tikzcd}"), true);
    assertEqual(result.includes("\\end{tikzcd}"), true);
});

// ── Hash extraction tests ──

function extractHashesFromOutput(output: string): string[] {
    const hashes: string[] = [];
    const blocks = output.split(/(?=\s*￫\s)/);
    for (const block of blocks) {
        const hashMatch = block.match(/Building\s+\S*?\/([0-9a-f]{32})\.svg/);
        if (hashMatch) { hashes.push(hashMatch[1]); }
    }
    return hashes;
}

test("Extract hash from Building log line", () => {
    const output = ` ￫ info[log]
 ￮
 ￮ Building ./build/resources/31dbb42201f1cf39c88a29472ff3bc2f.svg

 ￫ error[external_error]
 ￭ /path/to/file.tree
 2 | \\tex{
   ^ error message
 ￮ `;
    const hashes = extractHashesFromOutput(output);
    assertEqual(hashes.length, 1);
    assertEqual(hashes[0], "31dbb42201f1cf39c88a29472ff3bc2f");
});

test("Extract multiple hashes from output", () => {
    const output = ` ￫ info[log]
 ￮
 ￮ Building ./build/resources/aaaa0000aaaa0000aaaa0000aaaa0000.svg

 ￫ info[log]
 ￮
 ￮ Building ./build/resources/bbbb1111bbbb1111bbbb1111bbbb1111.svg
`;
    const hashes = extractHashesFromOutput(output);
    assertEqual(hashes.length, 2);
    assertEqual(hashes[0], "aaaa0000aaaa0000aaaa0000aaaa0000");
    assertEqual(hashes[1], "bbbb1111bbbb1111bbbb1111bbbb1111");
});

// ── Summary ──
console.log(`\n=== Test Results ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
