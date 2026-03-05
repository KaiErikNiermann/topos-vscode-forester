/**
 * Forester build diagnostics — surfaces LaTeX compilation errors and other
 * forester diagnostics as VS Code problems.
 *
 * Parses the Asai TTY-formatted output that forester emits on stdout when
 * `forester query all` (or `forester build`) encounters errors.
 *
 * When a LaTeX error points to a macro definition file (e.g. base-macros.tree),
 * attempts to relocate the diagnostic to the actual call site by matching
 * the compiled LaTeX body back to .tree source files.
 */

import * as vscode from "vscode";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { getRoot } from "./utils";

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

    // Try to relocate diagnostics that point to macro definitions
    const relocated = parsed.map(d => tryRelocateToCallSite(d, output));

    // Group diagnostics by file URI
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of relocated) {
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
    /** The hash of the LaTeX source, if this is a LaTeX compilation error */
    hash?: string;
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
 *  ￫ info[log]
 *  ￮  Building ./build/resources/abc123.svg
 *
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

    // Track the most recently seen hash from "Building" log lines
    let lastHash: string | undefined;

    for (const block of blocks) {
        // Check for hash in "Building ./build/resources/{hash}.svg" lines
        const hashMatch = block.match(/Building\s+\S*?\/([0-9a-f]{32})\.svg/);
        if (hashMatch) {
            lastHash = hashMatch[1];
        }

        const parsed = parseAsaiBlock(block, lastHash);
        if (parsed) {
            results.push(parsed);
        }
    }

    return results;
}

function parseAsaiBlock(block: string, hash?: string): ParsedDiagnostic | null {
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
        hash: code === "external_error" ? hash : undefined,
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

// ── Call-site relocation ───────────────────────────────────────────────────

/**
 * Normalize content for matching between forester-generated .tex and .tree
 * source. Forester inserts spaces before { and [ when converting to TeX.
 */
function normalizeForMatch(s: string): string {
    return s
        .replace(/\s+(?=[{[\]})])/g, "")   // Remove space before brackets/braces
        .replace(/(?<=[{[\](])\s+/g, "")    // Remove space after opening delimiters
        .replace(/\s+/g, " ")               // Collapse all whitespace to single space
        .trim();
}

/**
 * Try to relocate a diagnostic from a macro definition to the actual call site.
 *
 * When \texfig or \ltexfig calls \tex internally, the Asai location points to
 * the macro definition. We use the persisted .tex file (if available) to match
 * the LaTeX body back to the .tree source where the macro was actually called.
 */
function tryRelocateToCallSite(diag: ParsedDiagnostic, _output: string): ParsedDiagnostic {
    // Only attempt relocation for external_error with a hash
    if (!diag.hash || diag.diagnostic.code !== "external_error") {
        return diag;
    }

    let workspaceRoot: string;
    try {
        workspaceRoot = getRoot().fsPath;
    } catch {
        return diag;
    }

    // Try hash-based relocation via persisted .tex file
    const callSite = findCallSiteByHash(diag.hash, workspaceRoot);
    if (callSite) {
        const range = new vscode.Range(callSite.line, 0, callSite.line, Number.MAX_SAFE_INTEGER);
        const relocated = new vscode.Diagnostic(range, diag.diagnostic.message, diag.diagnostic.severity);
        relocated.source = diag.diagnostic.source;
        relocated.code = diag.diagnostic.code;
        return { uri: vscode.Uri.file(callSite.filePath), diagnostic: relocated };
    }

    return diag;
}

/**
 * Find the actual call site by reading the persisted .tex file for a given
 * hash, extracting the LaTeX body, and searching .tree files for matching
 * content.
 */
function findCallSiteByHash(
    hash: string,
    workspaceRoot: string
): { filePath: string; line: number } | null {
    const texPath = join(workspaceRoot, "build", "resources", `${hash}.tex`);
    if (!existsSync(texPath)) { return null; }

    let texContent: string;
    try {
        texContent = readFileSync(texPath, "utf-8");
    } catch {
        return null;
    }

    // Extract the body between \begin{document} and \end{document}
    const bodyMatch = texContent.match(
        /\\begin\{document\}\s*([\s\S]*?)\s*\\end\{document\}/
    );
    if (!bodyMatch) { return null; }

    const body = bodyMatch[1].trim();
    if (!body) { return null; }

    // Normalize for matching
    const normalizedBody = normalizeForMatch(body);

    // We need a sufficiently distinctive fragment to search for.
    // Use the full normalized body for matching.
    if (normalizedBody.length < 5) { return null; }

    // Collect all .tree files from configured tree directories
    const treeFiles = collectTreeFiles(workspaceRoot);

    for (const filePath of treeFiles) {
        let content: string;
        try {
            content = readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }

        const normalizedContent = normalizeForMatch(content);

        if (normalizedContent.includes(normalizedBody)) {
            // Found the file — now find the exact line
            const line = findEnclosingTexCommand(content, normalizedBody);
            if (line !== null) {
                return { filePath, line };
            }
        }
    }

    return null;
}

/**
 * Find the line of the \texfig / \ltexfig / \tex command that contains the
 * matching body content.
 *
 * Slides a window forward to find the LAST start line from which the body
 * is still visible — that pinpoints where the body actually begins.
 */
function findEnclosingTexCommand(fileContent: string, normalizedBody: string): number | null {
    const lines = fileContent.split("\n");

    // Find the last line from which a 50-line window still contains the body.
    // This narrows down to the actual start of the body content.
    let bodyStartLine: number | null = null;
    for (let i = 0; i < lines.length; i++) {
        const windowNorm = normalizeForMatch(
            lines.slice(i, Math.min(i + 50, lines.length)).join("\n")
        );
        if (windowNorm.includes(normalizedBody)) {
            bodyStartLine = i;
        } else if (bodyStartLine !== null) {
            break; // Past the body
        }
    }

    if (bodyStartLine === null) { return null; }

    // Scan backward from bodyStartLine to find enclosing \texfig / \ltexfig / \tex
    for (let j = bodyStartLine; j >= Math.max(0, bodyStartLine - 10); j--) {
        if (/\\(texfig|ltexfig|tex)\s*[\[{]/.test(lines[j])) {
            return j;
        }
    }
    return bodyStartLine;
}

/**
 * Collect all .tree files under the workspace, checking common tree
 * directories (trees/, tree/).
 */
function collectTreeFiles(workspaceRoot: string): string[] {
    const files: string[] = [];

    // Read forest.toml to find configured tree directories
    const tomlPath = join(workspaceRoot, "forest.toml");
    let treeDirs = ["trees"];
    if (existsSync(tomlPath)) {
        try {
            const toml = readFileSync(tomlPath, "utf-8");
            const match = toml.match(/trees\s*=\s*\[([^\]]*)\]/);
            if (match) {
                treeDirs = match[1]
                    .split(",")
                    .map(s => s.trim().replace(/^["']|["']$/g, ""))
                    .filter(Boolean);
            }
        } catch { /* use default */ }
    }

    for (const dir of treeDirs) {
        const dirPath = resolve(workspaceRoot, dir);
        if (!existsSync(dirPath)) { continue; }
        try {
            collectTreeFilesRecursive(dirPath, files);
        } catch { /* skip unreadable dirs */ }
    }

    return files;
}

function collectTreeFilesRecursive(dirPath: string, files: string[]): void {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        const full = join(dirPath, entry.name);
        if (entry.isDirectory()) {
            collectTreeFilesRecursive(full, files);
        } else if (entry.name.endsWith(".tree")) {
            files.push(full);
        }
    }
}
