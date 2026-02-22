/**
 * Code action provider for Forester .tree files.
 *
 * Provides quick fixes triggered by Langium validation diagnostics:
 *
 *   • 'missing-import' (hint, code = 'missing-import', data = { treeId })
 *     → "Add \import{treeId}" — inserts \import{…} after the last existing
 *       \import or at the top of the file if none exist.
 */
import type { CodeAction, CodeActionParams } from 'vscode-languageserver';
import type { LangiumDocument, CancellationToken } from 'langium';
import type { CodeActionProvider } from 'langium/lsp';

export class ForesterCodeActionProvider implements CodeActionProvider {
    getCodeActions(
        document: LangiumDocument,
        params: CodeActionParams,
        _cancelToken?: CancellationToken,
    ): CodeAction[] | undefined {
        const result: CodeAction[] = [];

        for (const diagnostic of params.context.diagnostics) {
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
}
