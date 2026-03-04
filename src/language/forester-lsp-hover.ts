/**
 * Langium LSP HoverProvider that shows LaTeX math previews.
 *
 * Detects #{...}, ##{...}, and \tex{preamble}{body} at the hover position
 * and returns markdown with LaTeX math blocks. Falls back to Langium's
 * default hover (doc-comments on declarations) for non-math content.
 */
import type { AstNode, MaybePromise } from 'langium';
import { CstUtils } from 'langium';
import type { LangiumServices } from 'langium/lsp';
import type { Hover, HoverParams } from 'vscode-languageserver';
import type { CancellationToken } from 'vscode-languageserver';
import type { LangiumDocument } from 'langium';
import { isBraceArg, isCommand, isMathDisplay, isMathInline } from './generated/ast.js';

/**
 * Extract the inner text of a CST node, stripping opening/closing delimiters.
 */
function innerText(text: string, openLen: number, cstStart: number, cstEnd: number): string {
    return text.slice(cstStart + openLen, cstEnd - 1);
}

/**
 * Walk up ancestors from a leaf node to find a math/tex snippet.
 */
function findMathSnippet(text: string, node: AstNode | undefined): { kind: string; body: string; preamble?: string; start: number; end: number } | undefined {
    let current = node;
    while (current) {
        if (isMathInline(current) && current.$cstNode) {
            const { offset, end } = current.$cstNode;
            return { kind: 'math-inline', body: innerText(text, 2, offset, end), start: offset, end };
        }
        if (isMathDisplay(current) && current.$cstNode) {
            const { offset, end } = current.$cstNode;
            return { kind: 'math-display', body: innerText(text, 3, offset, end), start: offset, end };
        }
        if (isCommand(current) && current.name === '\\tex' && current.$cstNode) {
            const braceArgs = current.args.filter(isBraceArg);
            if (braceArgs.length >= 2 && braceArgs[0].$cstNode && braceArgs[1].$cstNode) {
                return {
                    kind: 'tex',
                    preamble: innerText(text, 1, braceArgs[0].$cstNode.offset, braceArgs[0].$cstNode.end),
                    body: innerText(text, 1, braceArgs[1].$cstNode.offset, braceArgs[1].$cstNode.end),
                    start: current.$cstNode.offset,
                    end: current.$cstNode.end,
                };
            }
        }
        current = current.$container;
    }
    return undefined;
}

export class ForesterLspHoverProvider {
    protected readonly services: LangiumServices;

    constructor(services: LangiumServices) {
        this.services = services;
    }

    getHoverContent(document: LangiumDocument, params: HoverParams, _cancelToken?: CancellationToken): MaybePromise<Hover | undefined> {
        const rootCstNode = document.parseResult?.value?.$cstNode;
        if (!rootCstNode) { return undefined; }

        const text = document.textDocument.getText();
        const offset = document.textDocument.offsetAt(params.position);

        const leafNode = CstUtils.findLeafNodeAtOffset(rootCstNode, offset);
        if (!leafNode) { return undefined; }

        const snippet = findMathSnippet(text, leafNode.astNode);
        if (!snippet) { return undefined; }

        let markdown: string;
        if (snippet.kind === 'math-inline') {
            markdown = `$${snippet.body}$`;
        } else if (snippet.kind === 'math-display') {
            markdown = `$$\n${snippet.body}\n$$`;
        } else {
            // tex: show preamble + body
            const preambleSection = snippet.preamble?.trim()
                ? `**Preamble:**\n\`\`\`latex\n${snippet.preamble.trim()}\n\`\`\`\n\n`
                : '';
            markdown = `${preambleSection}$$\n${snippet.body}\n$$`;
        }

        const startPos = document.textDocument.positionAt(snippet.start);
        const endPos = document.textDocument.positionAt(snippet.end);

        return {
            contents: { kind: 'markdown', value: markdown },
            range: { start: startPos, end: endPos },
        };
    }
}
