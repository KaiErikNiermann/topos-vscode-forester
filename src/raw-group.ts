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

const VERBATIM_HERALD = '\\startverb';
const VERBATIM_TERMINATOR = '\\stopverb';
const VERBATIM_FENCE = '```';

/**
 * Every span forester lexes verbatim: `!{ … }` raw groups, `\startverb … \stopverb`
 * heralds, and ``` fences.
 *
 * Nothing inside one is forester syntax. `\texfig!{ … }` takes a TeX body, so a
 * `\def\st{pick}` in there is TeX's `\def`, bound in TeX's namespace and passed
 * through by the compiler untouched — it defines no forester macro. Any scanner
 * that registers macros by walking raw text has to exclude these spans or it
 * indexes the wrong language: go-to-definition on a forest's own `\st` was
 * offering six TikZ-internal bindings from a figure alongside the real one.
 *
 * Highlighting is unaffected — this is about what the spans *mean*, not how they
 * look. The Langium side already gets this right for free, since RAW_GROUP and
 * VERBATIM_SPAN are single opaque terminals; this is for the regex scanners that
 * do not go through the parser.
 *
 * Spans are returned in source order and never overlap: an unterminated herald
 * or fence runs to end-of-input, which is what forester's own lexer does with it.
 */
export function findVerbatimSpans(text: string): RawGroupSpan[] {
    const spans: RawGroupSpan[] = [];
    for (let i = 0; i < text.length; i++) {
        const end = verbatimSpanEnd(text, i);
        if (end === null) { continue; }
        spans.push({ startOffset: i, endOffset: end });
        i = end - 1;
    }
    return spans;
}

/** Offset just past the verbatim span opening at `offset`, or null for none. */
function verbatimSpanEnd(text: string, offset: number): number | null {
    switch (text[offset]) {
        case '!': {
            return rawGroupEnd(text, offset);
        }
        case '\\': {
            if (!text.startsWith(VERBATIM_HERALD, offset)) { return null; }
            const stop = text.indexOf(VERBATIM_TERMINATOR, offset + VERBATIM_HERALD.length);
            return stop === -1 ? text.length : stop + VERBATIM_TERMINATOR.length;
        }
        case '`': {
            if (!text.startsWith(VERBATIM_FENCE, offset)) { return null; }
            const close = text.indexOf(VERBATIM_FENCE, offset + VERBATIM_FENCE.length);
            return close === -1 ? text.length : close + VERBATIM_FENCE.length;
        }
        default: {
            return null;
        }
    }
}
