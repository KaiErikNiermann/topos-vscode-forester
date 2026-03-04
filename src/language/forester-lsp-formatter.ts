/**
 * Langium LSP Formatter service that delegates to formatter-core.ts.
 *
 * This bridges the hand-rolled Forester formatter (which handles all syntax
 * correctly) into the Langium LSP framework, enabling textDocument/formatting
 * and textDocument/rangeFormatting for any LSP client (Neovim, Helix, etc.).
 */
import type { LangiumDocument, MaybePromise } from 'langium';
import type { CancellationToken } from 'vscode-languageserver';
import type {
    DocumentFormattingParams,
    DocumentOnTypeFormattingParams,
    DocumentOnTypeFormattingOptions,
    DocumentRangeFormattingParams,
    TextEdit,
} from 'vscode-languageserver';
import type { Formatter } from 'langium/lsp';
import { Range, TextEdit as TextEditFactory } from 'vscode-languageserver';
import { format } from '../formatter-core.js';

/**
 * LSP formatter that wraps formatter-core.ts for use with any LSP client.
 */
export class ForesterLspFormatter implements Formatter {

    formatDocument(
        document: LangiumDocument,
        params: DocumentFormattingParams,
        _cancelToken?: CancellationToken,
    ): MaybePromise<TextEdit[]> {
        return this.formatFull(document, params.options.tabSize, params.options.insertSpaces);
    }

    formatDocumentRange(
        document: LangiumDocument,
        params: DocumentRangeFormattingParams,
        _cancelToken?: CancellationToken,
    ): MaybePromise<TextEdit[]> {
        // The hand-rolled formatter operates on full documents for correctness
        // (indentation depends on the full nesting context). Format the whole
        // document and return the edit covering the full range.
        return this.formatFull(document, params.options.tabSize, params.options.insertSpaces);
    }

    formatDocumentOnType(
        _document: LangiumDocument,
        _params: DocumentOnTypeFormattingParams,
        _cancelToken?: CancellationToken,
    ): MaybePromise<TextEdit[]> {
        return [];
    }

    get formatOnTypeOptions(): DocumentOnTypeFormattingOptions | undefined {
        return undefined;
    }

    private formatFull(
        document: LangiumDocument,
        tabSize: number,
        insertSpaces: boolean,
    ): TextEdit[] {
        const text = document.textDocument.getText();
        const formatted = format(text, { tabSize, insertSpaces });

        if (formatted === text) {
            return [];
        }

        // Replace the entire document content
        const lines = text.split('\n');
        const lastLine = lines[lines.length - 1];
        const fullRange = Range.create(
            0, 0,
            lines.length - 1, lastLine.length,
        );

        return [TextEditFactory.replace(fullRange, formatted)];
    }
}
