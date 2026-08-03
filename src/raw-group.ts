/**
 * Scanning for `!{ … }` raw groups.
 *
 * Forester lexes the body of a raw group verbatim: '%' is not a comment,
 * brackets and parens do not group, '#{' does not open math. Braces are the one
 * exception, since one of them ends the group — so the body's must balance, and
 * a backslash and the character after it are consumed together, which is what
 * keeps LaTeX's `\{`, `\}` and `\\` from counting. This mirrors the compiler's
 * lexer (Lexer.mll, the `raw` rule); the two must agree on where a group ends.
 *
 * Deliberately dependency-free: the Langium token builder, the document
 * validator and the LanguageTool integration all need this, and they do not
 * otherwise share a runtime (the last one loads under a stubbed `vscode`).
 */

export interface RawGroupSpan {
    startOffset: number;
    /** Exclusive — the offset just past the closing brace. */
    endOffset: number;
}

/**
 * Offset just past the `}` closing the raw group that opens at `offset`, or
 * null when `offset` does not start one or it is never closed.
 */
export function rawGroupEnd(text: string, offset: number): number | null {
    if (text.charCodeAt(offset) !== 0x21 /* ! */ || text.charCodeAt(offset + 1) !== 0x7b /* { */) {
        return null;
    }
    let depth = 0;
    for (let i = offset + 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\') {
            i++; // the escaped character belongs to the body, whatever it is
            continue;
        }
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return i + 1;
            }
        }
    }
    return null;
}

/** Every raw group in `text`, outermost only (they cannot nest — a `!{` inside
 *  a raw group is already part of its opaque body). */
export function findRawGroupSpans(text: string): RawGroupSpan[] {
    const spans: RawGroupSpan[] = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '!') { continue; }
        const end = rawGroupEnd(text, i);
        if (end !== null) {
            spans.push({ startOffset: i, endOffset: end });
            i = end - 1;
        }
    }
    return spans;
}

/** True when `offset` falls inside one of `spans`. */
export function isInSpans(spans: readonly RawGroupSpan[], offset: number): boolean {
    return spans.some((s) => offset >= s.startOffset && offset < s.endOffset);
}
