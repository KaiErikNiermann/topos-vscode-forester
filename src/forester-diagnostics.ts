/**
 * Forester build diagnostics — surfaces LaTeX compilation errors and other
 * forester diagnostics as VS Code problems.
 *
 * Parses the Asai TTY-formatted output that forester emits on stdout when
 * `forester query all` (or `forester build`) encounters errors.
 */

import * as vscode from "vscode";

// ── Public API ─────────────────────────────────────────────────────────────

let diagnosticCollection: vscode.DiagnosticCollection | undefined;

/**
 * Initialize the diagnostic collection.  Call once from `activate()`.
 */
export function initForesterDiagnostics(context: vscode.ExtensionContext): void {
    diagnosticCollection = vscode.languages.createDiagnosticCollection("forester");
    context.subscriptions.push(diagnosticCollection);
}

/**
 * Parse raw forester output for diagnostics and publish them.
 * Call this after every `forester query all` invocation.
 *
 * @param output  The combined stdout (and optionally stderr) captured from the
 *                forester process.  On fatal errors the Asai TTY diagnostics
 *                appear on stdout before the process exits with code 1.
 * @param success Whether the forester process exited successfully.
 */
export function publishForesterDiagnostics(output: string, success: boolean): void {
    if (!diagnosticCollection) { return; }

    // On success clear all diagnostics
    if (success) {
        diagnosticCollection.clear();
        return;
    }

    const parsed = parseAsaiDiagnostics(output);

    // Group diagnostics by file URI
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of parsed) {
        const key = d.uri.toString();
        if (!byFile.has(key)) { byFile.set(key, []); }
        byFile.get(key)!.push(d.diagnostic);
    }

    diagnosticCollection.clear();
    for (const [uriStr, diags] of byFile) {
        diagnosticCollection.set(vscode.Uri.parse(uriStr), diags);
    }
}

// ── Parsing ────────────────────────────────────────────────────────────────

interface ParsedDiagnostic {
    uri: vscode.Uri;
    diagnostic: vscode.Diagnostic;
}

// Asai severity → VS Code severity
function mapSeverity(s: string): vscode.DiagnosticSeverity {
    switch (s) {
        case "error": return vscode.DiagnosticSeverity.Error;
        case "warning": return vscode.DiagnosticSeverity.Warning;
        case "info": return vscode.DiagnosticSeverity.Information;
        default: return vscode.DiagnosticSeverity.Error;
    }
}

/**
 * Parse the Asai TTY output format.
 *
 * Example block:
 * ```
 *  ￫ error[external_error]
 *  ￭ /path/to/file.tree
 *  2 | \tex{
 *    ^ Encountered fatal LaTeX error:
 *      ...latex output...
 *  ￮
 * ```
 */
function parseAsaiDiagnostics(output: string): ParsedDiagnostic[] {
    const results: ParsedDiagnostic[] = [];

    // Split into diagnostic blocks using the ￫ marker (U+FFEB)
    // Each block starts with ` ￫ severity[code]`
    const blocks = output.split(/(?=\s*￫\s)/);

    for (const block of blocks) {
        const parsed = parseAsaiBlock(block);
        if (parsed) {
            results.push(parsed);
        }
    }

    return results;
}

function parseAsaiBlock(block: string): ParsedDiagnostic | null {
    // Extract severity and code from header: ` ￫ error[external_error]`
    const headerMatch = block.match(/￫\s+(error|warning|info|bug)\[([^\]]+)\]/);
    if (!headerMatch) { return null; }

    const severity = headerMatch[1];
    const code = headerMatch[2];

    // Skip log/info messages — they're not actionable diagnostics
    if (severity === "info" && code === "log") { return null; }

    // Extract file path: ` ￭ /path/to/file.tree`
    const fileMatch = block.match(/￭\s+(.+\.tree)\b/);
    if (!fileMatch) { return null; }

    const filePath = fileMatch[1].trim();

    // Extract line number from source context: ` 2 | \tex{`
    const lineMatch = block.match(/^\s*(\d+)\s*\|/m);
    const line = lineMatch ? parseInt(lineMatch[1], 10) - 1 : 0; // 0-indexed

    // Extract the message after the caret: `   ^ message text`
    const caretMatch = block.match(/^\s*\^\s*(.*)$/m);
    let message = caretMatch ? caretMatch[1].trim() : code;

    // For LaTeX errors, extract the specific LaTeX error from the compiler output
    const latexError = extractLatexError(block);
    if (latexError) {
        message = latexError;
    }

    // Build the range — place the diagnostic on the detected line
    const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);

    const diagnostic = new vscode.Diagnostic(range, message, mapSeverity(severity));
    diagnostic.source = "forester";
    diagnostic.code = code;

    return {
        uri: vscode.Uri.file(filePath),
        diagnostic,
    };
}

/**
 * Extract the most useful LaTeX error message from the compiler output
 * embedded in an Asai diagnostic block.
 *
 * LaTeX errors look like:
 *   `! Undefined control sequence.`
 *   `l.18   \undefinedcommand`
 *
 * or:
 *   `! Missing $ inserted.`
 *   `! LaTeX Error: Environment tikzcd undefined.`
 */
function extractLatexError(block: string): string | null {
    // Match LaTeX error lines: `! Error message`
    const errorLines = block.match(/^\t*!\s+(.+)$/gm);
    if (!errorLines || errorLines.length === 0) { return null; }

    // Get the first (most relevant) error
    const firstError = errorLines[0].replace(/^\t*!\s+/, "").trim();

    // Try to find the line context: `l.N text`
    const lineContext = block.match(/^\t*l\.(\d+)\s+(.*)$/m);

    if (lineContext) {
        const texLine = lineContext[1];
        const context = lineContext[2].trim();
        return `LaTeX error: ${firstError} (at l.${texLine}: ${context})`;
    }

    return `LaTeX error: ${firstError}`;
}
