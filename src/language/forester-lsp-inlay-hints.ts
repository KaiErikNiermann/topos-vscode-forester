/**
 * Langium LSP InlayHintProvider for tag closure hints.
 *
 * Shows the opening command name after closing braces (e.g., `} ul`)
 * using the pure logic from tag-closure-inlay-core.ts.
 */
import type { MaybePromise } from 'langium';
import type { InlayHint, InlayHintParams } from 'vscode-languageserver';
import { InlayHintKind } from 'vscode-languageserver';
import type { CancellationToken } from 'vscode-languageserver';
import type { LangiumDocument } from 'langium';
import type { InlayHintProvider } from 'langium/lsp';
import { collectTagClosureHints, DEFAULT_TAG_CLOSURE_HINT_TAGS, formatSubtreeTooltip } from '../tag-closure-inlay-core.js';

export class ForesterLspInlayHintProvider implements InlayHintProvider {

    getInlayHints(
        document: LangiumDocument,
        params: InlayHintParams,
        _cancelToken?: CancellationToken,
    ): MaybePromise<InlayHint[] | undefined> {
        const text = document.textDocument.getText();

        const hints = collectTagClosureHints(text, {
            enabledTags: [...DEFAULT_TAG_CLOSURE_HINT_TAGS],
        });

        // Filter to requested range
        const startOffset = document.textDocument.offsetAt(params.range.start);
        const endOffset = document.textDocument.offsetAt(params.range.end);

        const result: InlayHint[] = [];
        for (const hint of hints) {
            if (hint.offset < startOffset || hint.offset > endOffset) {
                continue;
            }
            const position = document.textDocument.positionAt(hint.offset + 1);
            result.push({
                position,
                label: ` ${hint.label}`,
                kind: InlayHintKind.Parameter,
                paddingLeft: true,
                tooltip: hint.subtreeMetadata
                    ? formatSubtreeTooltip(hint.subtreeMetadata)
                    : undefined,
            });
        }

        return result;
    }
}
