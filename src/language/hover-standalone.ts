/**
 * Langium-backed hover snippet finder (tasks 4–7).
 *
 * Replaces findHoverTexSnippetAtOffset from latex-hover-core.ts with queries
 * over the parsed Langium AST.  Exported as an ESM bundle (esbuild) and
 * consumed by latex-hover.ts via dynamic import().
 *
 * Task 4 – Infrastructure: standalone parse + CST offset navigation
 * Task 5 – #{...} MathInline snippet
 * Task 6 – ##{...} MathDisplay snippet
 * Task 7 – \tex{preamble}{body} Command snippet
 */

import type { AstNode } from 'langium';
import { CstUtils, EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { isBraceArg, isCommand, isMathDisplay, isMathInline } from './generated/ast.js';
import { createForesterServices } from './forester-module.js';

// ── Snippet types ─────────────────────────────────────────────────────────────

/** Mirrors HoverTexSnippet from latex-hover-core.ts for drop-in compatibility. */
export type HoverSnippetKind = 'math-inline' | 'math-display' | 'tex';

export interface LangiumHoverSnippet {
    kind: HoverSnippetKind;
    /** Start offset in the source text (inclusive, matches HoverTexSnippet.range.start). */
    start: number;
    /** End offset in the source text (exclusive, matches HoverTexSnippet.range.end). */
    end: number;
    /** LaTeX math body for math-inline and math-display; body arg for tex. */
    body: string;
    /** Preamble content (first brace arg) — only populated for tex kind. */
    preamble?: string;
}

// ── Service singleton ─────────────────────────────────────────────────────────

let _parse: ReturnType<typeof parseHelper> | undefined;

function getParse(): ReturnType<typeof parseHelper> {
    if (!_parse) {
        const { Forester } = createForesterServices(EmptyFileSystem);
        _parse = parseHelper(Forester);
    }
    return _parse;
}

// ── Content extraction helpers ────────────────────────────────────────────────

/** Returns the raw source text between the opening delimiter and the trailing }. */
function innerText(text: string, openLen: number, cstStart: number, cstEnd: number): string {
    return text.slice(cstStart + openLen, cstEnd - 1);
}

// ── Task 5: #{...} inline math ────────────────────────────────────────────────

function asMathInline(text: string, node: AstNode): LangiumHoverSnippet | undefined {
    if (!isMathInline(node) || !node.$cstNode) return undefined;
    const { offset, end } = node.$cstNode;
    return {
        kind: 'math-inline',
        start: offset,
        end,
        body: innerText(text, 2, offset, end),   // strip leading #{
    };
}

// ── Task 6: ##{...} display math ─────────────────────────────────────────────

function asMathDisplay(text: string, node: AstNode): LangiumHoverSnippet | undefined {
    if (!isMathDisplay(node) || !node.$cstNode) return undefined;
    const { offset, end } = node.$cstNode;
    return {
        kind: 'math-display',
        start: offset,
        end,
        body: innerText(text, 3, offset, end),   // strip leading ##{
    };
}

// ── Task 7: \tex{preamble}{body} ─────────────────────────────────────────────

function asTexCommand(text: string, node: AstNode): LangiumHoverSnippet | undefined {
    if (!isCommand(node) || node.name !== '\\tex' || !node.$cstNode) return undefined;
    const braceArgs = node.args.filter(isBraceArg);
    if (braceArgs.length < 2) return undefined;
    const [preambleArg, bodyArg] = braceArgs;
    if (!preambleArg.$cstNode || !bodyArg.$cstNode) return undefined;
    return {
        kind: 'tex',
        start: node.$cstNode.offset,
        end: node.$cstNode.end,
        preamble: innerText(text, 1, preambleArg.$cstNode.offset, preambleArg.$cstNode.end),
        body: innerText(text, 1, bodyArg.$cstNode.offset, bodyArg.$cstNode.end),
    };
}

// ── Task 4: Walk ancestors from the leaf AST node to find a snippet ───────────

function snippetFromAncestors(text: string, start: AstNode | undefined): LangiumHoverSnippet | undefined {
    let node: AstNode | undefined = start;
    while (node) {
        const result =
            asMathInline(text, node) ??
            asMathDisplay(text, node) ??
            asTexCommand(text, node);
        if (result) return result;
        node = node.$container;
    }
    return undefined;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse `text` with the Langium Forester parser and return the math or \\tex
 * snippet that covers the cursor `offset`, or `undefined` if none.
 *
 * Replaces `findHoverTexSnippetAtOffset` from latex-hover-core.ts.
 */
export async function findHoverSnippetAtOffset(
    text: string,
    offset: number,
): Promise<LangiumHoverSnippet | undefined> {
    const parse = getParse();
    const document = await parse(text);
    const rootCstNode = document.parseResult.value.$cstNode;
    if (!rootCstNode) return undefined;

    const leafNode = CstUtils.findLeafNodeAtOffset(rootCstNode, offset);
    if (!leafNode) return undefined;

    return snippetFromAncestors(text, leafNode.astNode);
}
