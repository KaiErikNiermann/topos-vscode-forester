/**
 * Custom document validator for Forester that:
 * 1. Suppresses parse errors inside \startverb…\stopverb ranges.
 * 2. Provides precise bracket-mismatch diagnostics with relatedInformation
 *    pointing at the cause (e.g. unclosed '{' on line 7) rather than the
 *    symptom (EOF or wherever Chevrotain gave up).
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
import {
    type CancellationToken,
    type Diagnostic,
    DiagnosticRelatedInformation,
    DiagnosticSeverity,
    Location,
    Range,
    Position,
} from 'vscode-languageserver';

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
        if (!stopMatch) {continue;}
        const svEnd = stopMatch.index + stopMatch[0].length;

        // Expand outward to the enclosing brace block:
        // Scan backwards for the nearest unmatched '{'
        let braceStart = svStart;
        let depth = 0;
        for (let i = svStart - 1; i >= 0; i--) {
            if (text[i] === '}') {depth++;}
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
            if (text[i] === '{') {depth++;}
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

// ── Bracket-mismatch diagnostics ─────────────────────────────────────────────

const OPENERS: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
const CLOSERS: Record<string, string> = { '}': '{', ']': '[', ')': '(' };

interface BracketEntry {
    opener: string;
    offset: number;
    line: number;
    character: number;
}

function offsetToPosition(text: string, offset: number): Position {
    let line = 0;
    let character = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') {
            line++;
            character = 0;
        } else {
            character++;
        }
    }
    return Position.create(line, character);
}

/**
 * Stack-based bracket matching over raw document text.
 * Skips: escaped delimiters (\{ \} \[ \]), \startverb…\stopverb,
 * % line comments, and ```…``` verbatim fences.
 */
export function findBracketMismatches(text: string, uri: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const stack: BracketEntry[] = [];
    let i = 0;
    let line = 0;
    let character = 0;

    function advance(): void {
        if (text[i] === '\n') {
            line++;
            character = 0;
        } else {
            character++;
        }
        i++;
    }

    function lookingAt(s: string): boolean {
        return text.startsWith(s, i);
    }

    while (i < text.length) {
        // Skip % line comments
        if (text[i] === '%') {
            while (i < text.length && text[i] !== '\n') {
                advance();
            }
            continue;
        }

        // Skip escaped delimiters: \{ \} \[ \]
        if (text[i] === '\\' && i + 1 < text.length && (text[i + 1] === '{' || text[i + 1] === '}' || text[i + 1] === '[' || text[i + 1] === ']')) {
            advance(); advance();
            continue;
        }

        // Skip \startverb…\stopverb
        if (lookingAt('\\startverb')) {
            const end = text.indexOf('\\stopverb', i + 10);
            if (end !== -1) {
                const target = end + 9; // length of \stopverb
                while (i < target) {advance();}
            } else {
                // No matching \stopverb — skip to end
                while (i < text.length) {advance();}
            }
            continue;
        }

        // Skip ```…``` verbatim fences
        if (lookingAt('```')) {
            advance(); advance(); advance(); // skip opening ```
            while (i < text.length && !lookingAt('```')) {
                advance();
            }
            if (lookingAt('```')) {
                advance(); advance(); advance(); // skip closing ```
            }
            continue;
        }

        // Handle #{ and ##{ (math openers — push as {)
        if (text[i] === '#' && i + 1 < text.length && text[i + 1] === '#' && i + 2 < text.length && text[i + 2] === '{') {
            stack.push({ opener: '{', offset: i, line, character });
            advance(); advance(); advance();
            continue;
        }
        if (text[i] === '#' && i + 1 < text.length && text[i + 1] === '{') {
            stack.push({ opener: '{', offset: i, line, character });
            advance(); advance();
            continue;
        }

        // Opening delimiters
        if (text[i] in OPENERS) {
            stack.push({ opener: text[i], offset: i, line, character });
            advance();
            continue;
        }

        // Closing delimiters
        if (text[i] in CLOSERS) {
            const closer = text[i];
            const expectedOpener = CLOSERS[closer];
            const closerLine = line;
            const closerChar = character;

            if (stack.length === 0) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: Range.create(closerLine, closerChar, closerLine, closerChar + 1),
                    message: `Unexpected '${closer}' — no matching '${expectedOpener}'`,
                    source: 'forester',
                    data: { code: 'bracket-mismatch' },
                });
            } else {
                const top = stack[stack.length - 1];
                if (top.opener !== expectedOpener) {
                    const expectedCloser = OPENERS[top.opener];
                    diagnostics.push({
                        severity: DiagnosticSeverity.Error,
                        range: Range.create(closerLine, closerChar, closerLine, closerChar + 1),
                        message: `Mismatched delimiter: found '${closer}' but '${top.opener}' at line ${top.line + 1} expects '${expectedCloser}'`,
                        source: 'forester',
                        data: { code: 'bracket-mismatch' },
                        relatedInformation: [
                            DiagnosticRelatedInformation.create(
                                Location.create(uri, Range.create(top.line, top.character, top.line, top.character + 1)),
                                `Opening '${top.opener}' is here`,
                            ),
                        ],
                    });
                    stack.pop();
                } else {
                    stack.pop();
                }
            }
            advance();
            continue;
        }

        advance();
    }

    // Remaining unclosed openers
    const eofPos = offsetToPosition(text, text.length);
    for (const entry of stack) {
        const expectedCloser = OPENERS[entry.opener];
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: Range.create(entry.line, entry.character, entry.line, entry.character + 1),
            message: `Unclosed '${entry.opener}' — no matching '${expectedCloser}' found`,
            source: 'forester',
            data: { code: 'bracket-mismatch' },
            relatedInformation: [
                DiagnosticRelatedInformation.create(
                    Location.create(uri, Range.create(eofPos, eofPos)),
                    `Matching '${expectedCloser}' expected before end of file`,
                ),
            ],
        });
    }

    return diagnostics;
}

/**
 * Check whether a Chevrotain parsing error message is about bracket/delimiter
 * mismatches, so we can suppress it in favour of our more precise diagnostics.
 */
function isBracketRelatedError(message: string): boolean {
    return /[{}()\[\]]/.test(message);
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
        const uri = document.textDocument.uri;

        // Run bracket matching
        const bracketDiags = findBracketMismatches(text, uri);

        // Filter diagnostics: suppress Chevrotain bracket errors if we have our own,
        // and suppress errors inside \startverb…\stopverb ranges.
        let filtered = diagnostics;

        if (bracketDiags.length > 0) {
            filtered = filtered.filter(d => {
                const code = (d.data as { code?: string })?.code;
                if (code !== 'parsing-error') {return true;}
                return !isBracketRelatedError(d.message);
            });
        }

        if (text.includes('\\startverb')) {
            const suppressedRanges = findSuppressedRanges(text);
            if (suppressedRanges.length > 0) {
                filtered = filtered.filter(d => {
                    const code = (d.data as { code?: string })?.code;
                    if (code !== 'lexing-error' && code !== 'parsing-error') {
                        return true;
                    }
                    const offset = positionToOffset(text, d.range.start.line, d.range.start.character);
                    return !suppressedRanges.some(r => offset >= r.startOffset && offset < r.endOffset);
                });
            }
        }

        return [...filtered, ...bracketDiags];
    }
}
