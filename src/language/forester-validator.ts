/**
 * Custom document validator for Forester that suppresses parse errors
 * inside \startverb…\stopverb ranges.
 *
 * Forester treats \startverb…\stopverb as verbatim content (no parsing),
 * but the Langium parser doesn't know about this convention and produces
 * false-positive errors for unbalanced delimiters (e.g. LaTeX half-open
 * intervals like [a, +∞) ).
 *
 * Strategy: after the default validator produces diagnostics, find each
 * \startverb…\stopverb pair and expand the suppression zone to the
 * enclosing brace block (scanning outward for balanced { }),
 * then drop any lexing/parsing diagnostics whose position falls inside.
 * This is necessary because parser errors from verbatim content cascade
 * to the closing delimiters of the enclosing block.
 */
import type { LangiumDocument, LangiumCoreServices, ValidationOptions } from 'langium';
import { DefaultDocumentValidator } from 'langium';
import type { CancellationToken, Diagnostic } from 'vscode-languageserver';

interface SuppressedRange {
    startOffset: number;
    endOffset: number;
}

/**
 * Find the enclosing brace block for each \startverb…\stopverb pair.
 * We scan backwards from \startverb for the nearest unmatched '{' and
 * forwards from \stopverb for the nearest unmatched '}'.
 */
function findSuppressedRanges(text: string): SuppressedRange[] {
    const ranges: SuppressedRange[] = [];
    const startPattern = /\\startverb\b/g;
    const stopPattern = /\\stopverb\b/g;

    let match: RegExpExecArray | null;
    while ((match = startPattern.exec(text)) !== null) {
        const svStart = match.index;
        // Find the next \stopverb after this \startverb
        stopPattern.lastIndex = svStart + match[0].length;
        const stopMatch = stopPattern.exec(text);
        if (!stopMatch) continue;
        const svEnd = stopMatch.index + stopMatch[0].length;

        // Expand outward to the enclosing brace block:
        // Scan backwards for the nearest unmatched '{'
        let braceStart = svStart;
        let depth = 0;
        for (let i = svStart - 1; i >= 0; i--) {
            if (text[i] === '}') depth++;
            else if (text[i] === '{') {
                if (depth === 0) {
                    braceStart = i;
                    break;
                }
                depth--;
            }
        }

        // Scan forwards from \stopverb for the nearest unmatched '}'
        let braceEnd = svEnd;
        depth = 0;
        for (let i = svEnd; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') {
                if (depth === 0) {
                    braceEnd = i + 1;
                    break;
                }
                depth--;
            }
        }

        ranges.push({ startOffset: braceStart, endOffset: braceEnd });
    }
    return ranges;
}

/**
 * Convert a line/character position to a character offset in the text.
 */
function positionToOffset(text: string, line: number, character: number): number {
    let currentLine = 0;
    for (let i = 0; i < text.length; i++) {
        if (currentLine === line) {
            return i + character;
        }
        if (text[i] === '\n') {
            currentLine++;
        }
    }
    return text.length;
}

export class ForesterDocumentValidator extends DefaultDocumentValidator {

    constructor(services: LangiumCoreServices) {
        super(services);
    }

    override async validateDocument(
        document: LangiumDocument,
        options?: ValidationOptions,
        cancelToken?: CancellationToken,
    ): Promise<Diagnostic[]> {
        const diagnostics = await super.validateDocument(document, options, cancelToken);

        const text = document.textDocument.getText();
        // Quick check: if no \startverb in the text, nothing to filter
        if (!text.includes('\\startverb')) {
            return diagnostics;
        }

        const suppressedRanges = findSuppressedRanges(text);
        if (suppressedRanges.length === 0) {
            return diagnostics;
        }

        return diagnostics.filter(d => {
            const code = (d.data as { code?: string })?.code;
            // Only suppress lexing and parsing errors (not custom validations)
            if (code !== 'lexing-error' && code !== 'parsing-error') {
                return true;
            }
            const offset = positionToOffset(text, d.range.start.line, d.range.start.character);
            return !suppressedRanges.some(r => offset >= r.startOffset && offset < r.endOffset);
        });
    }
}
