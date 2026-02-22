/**
 * Code action provider for Forester .tree files.
 *
 * Provides quick fixes triggered by Langium validation diagnostics:
 *
 *   • 'missing-import'  (hint)    → "Add \import{treeId}"
 *     Inserts \import{…} after the last existing \import or at the top.
 *
 *   • 'unknown-command' (warning) → "Create definition for \foo"
 *     Inserts \def\foo{} at the end of the file.
 */
import type { CodeAction, CodeActionParams } from 'vscode-languageserver';
import type { LangiumDocument, CancellationToken } from 'langium';
import type { CodeActionProvider } from 'langium/lsp';

// Prefix used in the 'Unknown command …' diagnostic message (from checkUnresolvedCommand)
const UNKNOWN_CMD_PREFIX = 'Unknown command ';

export class ForesterCodeActionProvider implements CodeActionProvider {
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

            // ── "Create definition for \foo" ───────────────────────────────
            if (diagnostic.message.startsWith(UNKNOWN_CMD_PREFIX)) {
                // Extract \commandName from the message prefix
                const rest = diagnostic.message.slice(UNKNOWN_CMD_PREFIX.length);
                const nameMatch = /^(\\[\w\-\/\?\*]+)/.exec(rest);
                if (!nameMatch) continue;

                const cmdName = nameMatch[1]; // e.g. \foo
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

        return result.length > 0 ? result : undefined;
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
}
