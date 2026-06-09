/**
 * sig-inlay-core.ts — pure logic for "parameter name" inlay hints.
 *
 * For a command that has a known parameter list (a project `%! sig` or a builtin),
 * surface each brace argument's parameter name just inside its opening brace, e.g.
 *
 *     \embed{opts: image}{target: #artifact:x}{caption: …}
 *            ^^^^^         ^^^^^^^              ^^^^^^^^
 *
 * — the clangd-style "name:" parameter hint, so the role of each positional brace
 * is visible without hovering the command. The Nth brace argument maps to the Nth
 * parameter (matching how completion maps them; bracket/paren args don't count).
 *
 * Reuses the tokenizer primitives from tag-closure-inlay-core (comment/escape aware,
 * balanced scanning, math `#{…}`/`##{…}` skipping) so hints never land inside
 * comments, verbatim heralds, or math.
 */
import {
    isEscaped,
    skipComment,
    skipWhitespaceAndComments,
    scanBalanced,
    readCommandHeader,
} from './tag-closure-inlay-core.js';

export interface ParamNameHint {
    /** Offset just inside the opening brace where the `name:` label is placed. */
    readonly offset: number;
    /** The label to render (e.g. `opts:`). */
    readonly label: string;
}

/** Minimal parameter shape this needs — the `name` to surface. */
export interface NamedParam {
    readonly name: string;
}

// A command whose name is being *bound* (`\def\foo…`, `\let\foo…`) is a definition,
// not a call site — its brackets are binders and its brace is the template body, so
// it must not receive call-argument hints. `\def`/`\let` sit immediately to the left.
const BINDER_BEFORE = /\\(?:def|let)\s*$/;

/**
 * Collect parameter-name inlay hints for every call site of a command that has a
 * known parameter list. `paramsByCommand` is keyed by command WITH the leading
 * backslash (e.g. `\embed`), matching sig.ts / command-metadata.ts.
 */
export function collectParamNameHints(
    source: string,
    paramsByCommand: ReadonlyMap<string, readonly NamedParam[]>,
): ParamNameHint[] {
    const hints: ParamNameHint[] = [];

    const parseRegion = (startIndex: number, endIndex: number): void => {
        let index = startIndex;
        while (index < endIndex) {
            const char = source[index]!;

            if (char === '%' && !isEscaped(source, index)) {
                index = skipComment(source, index);
                continue;
            }

            // Skip math `#{…}` / `##{…}` wholesale — no command hints inside.
            if (char === '#' && !isEscaped(source, index)) {
                const braceAt = source[index + 1] === '#' ? index + 2 : index + 1;
                if (source[braceAt] === '{') {
                    const close = scanBalanced(source, braceAt, endIndex, '{', '}');
                    index = close === null ? endIndex : close + 1;
                    continue;
                }
            }

            if (char !== '\\' || isEscaped(source, index)) {
                index += 1;
                continue;
            }

            const header = readCommandHeader(source, index, endIndex);
            if (!header) {
                index += 1;
                continue;
            }

            const isBinderName = BINDER_BEFORE.test(source.slice(Math.max(0, index - 8), index));

            let cursor = skipWhitespaceAndComments(source, header.endIndex + 1, endIndex);
            // Bracket/paren args don't carry positional params — skip over them.
            while (cursor < endIndex && (source[cursor] === '[' || source[cursor] === '(')) {
                const close = scanBalanced(source, cursor, endIndex, source[cursor]!, source[cursor] === '[' ? ']' : ')');
                if (close === null) { break; }
                cursor = skipWhitespaceAndComments(source, close + 1, endIndex);
            }
            // Collect the consecutive brace args (the positional ones).
            const argRanges: Array<{ open: number; close: number }> = [];
            while (cursor < endIndex && source[cursor] === '{') {
                const close = scanBalanced(source, cursor, endIndex, '{', '}');
                if (close === null) { break; }
                argRanges.push({ open: cursor, close });
                cursor = skipWhitespaceAndComments(source, close + 1, endIndex);
            }

            if (argRanges.length === 0) {
                index = header.endIndex + 1;
                continue;
            }

            // A definition (`\def\foo…`): don't hint, and don't descend into the
            // template body — its braces aren't call arguments.
            if (isBinderName) {
                index = cursor;
                continue;
            }

            // Recurse into each arg first so nested calls (e.g. a `\cite` inside an
            // `\embed` caption) get their own hints.
            for (const a of argRanges) {
                if (a.close > a.open + 1) { parseRegion(a.open + 1, a.close); }
            }

            const params = paramsByCommand.get(`\\${header.name}`);
            if (params) {
                for (let i = 0; i < argRanges.length && i < params.length; i += 1) {
                    hints.push({ offset: argRanges[i]!.open + 1, label: `${params[i]!.name}:` });
                }
            }

            index = cursor;
        }
    };

    parseRegion(0, source.length);
    return hints;
}
