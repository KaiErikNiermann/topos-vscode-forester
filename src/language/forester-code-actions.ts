/**
 * Code action provider for Forester .tree files.
 *
 * Quick fixes (triggered by Langium validation diagnostics):
 *
 *   • 'missing-import'  (hint)    → "Add \import{treeId}"
 *   • 'unknown-command' (warning) → "Create definition for \foo"
 *   • 'unknown-command' (warning) → "Qualify as \prefix/foo"
 *
 * Refactoring actions (cursor-position, no diagnostic required):
 *
 *   • Cursor on \def\name → "Convert \def to \let (removes from exported API)"
 *   • Cursor on \let\name → "Convert \let to \def (adds to exported API)"
 *   • Cursor on #method that has no object definition → "Create method stub [method]{}"
 */
import type { CodeAction, CodeActionParams } from 'vscode-languageserver';
import type { LangiumDocument, LangiumDocuments, CancellationToken } from 'langium';
import type { CodeActionProvider, LangiumServices } from 'langium/lsp';
import {
    isCommand,
    isBraceArg,
    isBracketGroup,
    isDocument,
    isTextFragment,
} from './generated/ast.js';

// Prefix used in the 'Unknown command …' diagnostic message (from checkUnresolvedCommand)
const UNKNOWN_CMD_PREFIX = 'Unknown command ';

// Commands that introduce a lexical binding (the next sibling command is the name being bound)
const BINDING_COMMANDS: ReadonlySet<string> = new Set(['\\def', '\\let']);

export class ForesterCodeActionProvider implements CodeActionProvider {
    private readonly documents: LangiumDocuments;

    constructor(services: LangiumServices) {
        this.documents = services.shared.workspace.LangiumDocuments;
    }

    getCodeActions(
        document: LangiumDocument,
        params: CodeActionParams,
        _cancelToken?: CancellationToken,
    ): CodeAction[] | undefined {
        const result: CodeAction[] = [];

        for (const diagnostic of params.context.diagnostics) {
            // ── "Add \import{treeId}" ──────────────────────────────────────
            if (diagnostic.code === 'missing-import') {
                const data = diagnostic.data as { treeId?: string } | undefined;
                if (!data?.treeId) continue;

                const { treeId } = data;
                const insertPos = this.findImportInsertPosition(document);

                result.push({
                    title: `Add \\import{${treeId}}`,
                    kind: 'quickfix',
                    diagnostics: [diagnostic],
                    isPreferred: true,
                    edit: {
                        changes: {
                            [document.uri.toString()]: [
                                {
                                    range: { start: insertPos, end: insertPos },
                                    newText: `\\import{${treeId}}\n`,
                                },
                            ],
                        },
                    },
                });
            }

            // ── "Create definition for \foo" / "Qualify as \prefix/foo" ────
            if (diagnostic.message.startsWith(UNKNOWN_CMD_PREFIX)) {
                // Extract \commandName from the message prefix
                const rest = diagnostic.message.slice(UNKNOWN_CMD_PREFIX.length);
                const nameMatch = /^(\\[\w\-\/\?\*]+)/.exec(rest);
                if (!nameMatch) continue;

                const cmdName = nameMatch[1]; // e.g. \foo  (includes backslash)

                // ── "Qualify as \prefix/foo" (only for unqualified names) ──
                const simpleName = cmdName.slice(1); // strip leading backslash
                if (!simpleName.includes('/')) {
                    for (const qualifiedName of this.findNamespaceCandidates(simpleName)) {
                        result.push({
                            title: `Qualify as \\${qualifiedName}`,
                            kind: 'quickfix',
                            diagnostics: [diagnostic],
                            edit: {
                                changes: {
                                    [document.uri.toString()]: [
                                        {
                                            range: diagnostic.range,
                                            newText: `\\${qualifiedName}`,
                                        },
                                    ],
                                },
                            },
                        });
                    }
                }

                // ── "Create definition for \foo" ───────────────────────────
                const insertPos = this.findDefInsertPosition(document);
                result.push({
                    title: `Create definition for ${cmdName}`,
                    kind: 'quickfix',
                    diagnostics: [diagnostic],
                    edit: {
                        changes: {
                            [document.uri.toString()]: [
                                {
                                    range: { start: insertPos, end: insertPos },
                                    newText: `\\def${cmdName}{}\n`,
                                },
                            ],
                        },
                    },
                });
            }
        }

        // ── Refactoring actions (no diagnostic required) ─────────────────────
        // Only add when the client hasn't restricted to quickfix-only.
        const onlyKinds = params.context.only ?? [];
        const wantsRefactor =
            onlyKinds.length === 0 ||
            onlyKinds.some(k => k === '' || k.startsWith('refactor'));

        if (wantsRefactor) {
            this.maybeAddLetDefConversion(document, params, result);
            this.maybeAddMethodStub(document, params, result);
        }

        return result.length > 0 ? result : undefined;
    }

    /**
     * Search all workspace documents for \namespace{prefix}{…} blocks that
     * define \simpleName inside them (via \def or \let).
     *
     * Returns an array of qualified names like "prefix/simpleName".
     * Results are deduplicated; order is not guaranteed.
     */
    private findNamespaceCandidates(simpleName: string): string[] {
        const candidates = new Set<string>();
        const targetCmd = `\\${simpleName}`;

        for (const doc of this.documents.all) {
            const root = doc.parseResult.value;
            if (!isDocument(root)) continue;

            for (const node of root.nodes) {
                if (!isCommand(node) || node.name !== '\\namespace') continue;

                const braceArgs = node.args.filter(isBraceArg);
                const prefixArg = braceArgs[0];
                const bodyArg = braceArgs[1];
                if (!prefixArg || !bodyArg) continue;

                // Extract the namespace prefix string from the first brace arg
                const prefixFrag = prefixArg.nodes.find(isTextFragment);
                if (!prefixFrag) continue;
                const prefix = prefixFrag.value.trim();
                if (!prefix) continue;

                // Scan body nodes for \def\simpleName or \let\simpleName patterns
                const bodyNodes = bodyArg.nodes;
                for (let i = 0; i + 1 < bodyNodes.length; i++) {
                    const curr = bodyNodes[i];
                    const next = bodyNodes[i + 1];
                    if (
                        isCommand(curr) &&
                        BINDING_COMMANDS.has(curr.name) &&
                        isCommand(next) &&
                        next.name === targetCmd
                    ) {
                        candidates.add(`${prefix}/${simpleName}`);
                    }
                }
            }
        }

        return [...candidates];
    }

    /**
     * Find the line at which to insert a new \import{…}.
     *
     * Strategy: insert immediately after the last existing \import{…} line.
     * If the document has no \import commands yet, insert at line 0.
     */
    private findImportInsertPosition(
        document: LangiumDocument,
    ): { line: number; character: number } {
        const text = document.textDocument.getText();
        let lastImportOffset = -1;

        // Find the end offset of the last \import{...} token in the raw text
        const importRe = /\\import\{[^}]+\}/g;
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(text)) !== null) {
            const end = m.index + m[0].length;
            if (end > lastImportOffset) lastImportOffset = end;
        }

        if (lastImportOffset >= 0) {
            // Advance to the end of the line containing that import
            const newlineIdx = text.indexOf('\n', lastImportOffset);
            const lineEndOffset = newlineIdx >= 0 ? newlineIdx + 1 : text.length;
            const pos = document.textDocument.positionAt(lineEndOffset);
            return { line: pos.line, character: 0 };
        }

        // No existing imports: prepend at the very first character
        return { line: 0, character: 0 };
    }

    /**
     * Find the position to insert a new \\def\\name{…} block.
     *
     * Strategy: insert after the last existing \\def or \\let line in the file,
     * or at the very end of the document if none exist.
     */
    private findDefInsertPosition(
        document: LangiumDocument,
    ): { line: number; character: number } {
        const text = document.textDocument.getText();
        let lastDefOffset = -1;

        const defRe = /\\(?:def|let)\\[\w\-\/\?\*]+/g;
        let m: RegExpExecArray | null;
        while ((m = defRe.exec(text)) !== null) {
            const end = m.index + m[0].length;
            if (end > lastDefOffset) lastDefOffset = end;
        }

        if (lastDefOffset >= 0) {
            const newlineIdx = text.indexOf('\n', lastDefOffset);
            const lineEndOffset = newlineIdx >= 0 ? newlineIdx + 1 : text.length;
            const pos = document.textDocument.positionAt(lineEndOffset);
            return { line: pos.line, character: 0 };
        }

        // No existing defs: append at the end of the document
        const pos = document.textDocument.positionAt(text.length);
        return { line: pos.line, character: pos.character };
    }

    /**
     * If the cursor is inside a \def\name or \let\name token, add a refactoring
     * action to convert between the two binding forms.
     *
     * \def exports the binding; \let keeps it local.  The action title includes
     * a parenthetical explaining the API surface impact.
     */
    private maybeAddLetDefConversion(
        document: LangiumDocument,
        params: CodeActionParams,
        result: CodeAction[],
    ): void {
        const text = document.textDocument.getText();
        const cursorOffset = document.textDocument.offsetAt(params.range.start);

        // Find all \def\name and \let\name occurrences; check if cursor is inside
        const LET_DEF_RE = /\\(def|let)(\\[\w\-\/\?\*]+)/g;
        let m: RegExpExecArray | null;
        while ((m = LET_DEF_RE.exec(text)) !== null) {
            const start = m.index;
            const end = m.index + m[0].length;
            if (cursorOffset < start || cursorOffset > end) continue;

            const keyword = m[1] as 'def' | 'let';
            const other = keyword === 'def' ? 'let' : 'def';
            const impact = keyword === 'def'
                ? '(removes from exported API)'
                : '(adds to exported API)';

            // Replace only the \def or \let keyword (m[0] starts with \keyword)
            const kwEnd = start + 1 + keyword.length; // backslash + keyword letters
            const kwStart = document.textDocument.positionAt(start);
            const kwEndPos = document.textDocument.positionAt(kwEnd);

            result.push({
                title: `Convert \\${keyword} to \\${other} ${impact}`,
                kind: 'refactor.rewrite',
                edit: {
                    changes: {
                        [document.uri.toString()]: [
                            {
                                range: { start: kwStart, end: kwEndPos },
                                newText: `\\${other}`,
                            },
                        ],
                    },
                },
            });
            break; // only one match at a cursor position
        }
    }

    /**
     * If the cursor is on a method-name TextFragment that follows '#' (i.e., the
     * `#methodName` suffix in `\get\obj#methodName`), and the method is not found
     * in any workspace \object or \patch block, add an action to insert a method
     * stub `[methodName]{}` into the nearest \object block in the current file.
     */
    private maybeAddMethodStub(
        document: LangiumDocument,
        params: CodeActionParams,
        result: CodeAction[],
    ): void {
        const text = document.textDocument.getText();
        const cursorOffset = document.textDocument.offsetAt(params.range.start);

        // Find a `#name` pattern where the cursor lands on `name`
        // BARE_HASH (#) followed immediately by TEXT (no space)
        const HASH_NAME_RE = /#([A-Za-z][\w\-]*)/g;
        let m: RegExpExecArray | null;
        while ((m = HASH_NAME_RE.exec(text)) !== null) {
            const nameStart = m.index + 1; // after the '#'
            const nameEnd = nameStart + m[1].length;
            if (cursorOffset < nameStart || cursorOffset > nameEnd) continue;

            const methodName = m[1];

            // Check if this method is already defined in any workspace object
            if (this.methodExistsInWorkspace(methodName)) break;

            // Find insertion point: end of last method in first \object in this file
            const insertPos = this.findMethodInsertPosition(text, document);
            if (!insertPos) break;

            result.push({
                title: `Create method stub [${methodName}]{}`,
                kind: 'quickfix',
                edit: {
                    changes: {
                        [document.uri.toString()]: [
                            {
                                range: { start: insertPos, end: insertPos },
                                newText: `[${methodName}]{}\n`,
                            },
                        ],
                    },
                },
            });
            break;
        }
    }

    /**
     * Return true if any workspace \object or \patch defines a method with the
     * given name.
     */
    private methodExistsInWorkspace(methodName: string): boolean {
        for (const doc of this.documents.all) {
            const root = doc.parseResult.value;
            if (!isDocument(root)) continue;

            for (const node of [...root.nodes]) {
                // Stream contents manually to avoid a full AstUtils import here
                const stack = [node];
                while (stack.length > 0) {
                    const current = stack.pop()!;
                    if (isCommand(current) && (current.name === '\\object' || current.name === '\\patch')) {
                        const bodyArg = [...current.args].reverse().find(isBraceArg);
                        if (bodyArg) {
                            for (const bodyNode of bodyArg.nodes) {
                                if (isBracketGroup(bodyNode)) {
                                    const frag = bodyNode.nodes.find(isTextFragment);
                                    if (frag?.value.trim() === methodName) return true;
                                }
                                stack.push(bodyNode);
                            }
                        }
                    }
                }
            }
        }
        return false;
    }

    /**
     * Find the insertion position for a new method stub inside the first
     * \object block in the document text.
     *
     * Strategy: find the closing brace of the first \object{...} body, then
     * insert just before it on a new line.
     *
     * Falls back to undefined if no \object block is found.
     */
    private findMethodInsertPosition(
        text: string,
        document: LangiumDocument,
    ): { line: number; character: number } | undefined {
        // Find `\object` followed by optional bracket arg and then `{`
        const objectRe = /\\(?:object|patch)[^\{]*\{/g;
        const m = objectRe.exec(text);
        if (!m) return undefined;

        // Walk forward from the opening brace to find the matching closing brace
        const openIdx = m.index + m[0].length - 1;
        let depth = 1;
        let i = openIdx + 1;
        while (i < text.length && depth > 0) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') depth--;
            i++;
        }
        // i is now just past the closing brace; insert before it
        const insertOffset = i - 1; // position of the closing '}'
        const pos = document.textDocument.positionAt(insertOffset);
        return { line: pos.line, character: 0 };
    }
}
