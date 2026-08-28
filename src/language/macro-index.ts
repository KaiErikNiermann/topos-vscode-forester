/**
 * macro-index.ts — detect handrolled LaTeX where a forester macro already exists.
 * MIRRORS the notes-repo detector at notes/scripts/build/macro-index.ts — the spec is
 * FROZEN and a golden fixture (macro-index.test.ts here + macro-index.test.ts there)
 * asserts both produce identical JSON. Change one, change both.
 *
 * A forest defines `\def\N{\notation{009A}{\mathbb{N}}}`, but nothing stops an author
 * typing `#{\mathbb{N}}`. The glyph is identical, so the mistake is invisible on the
 * page — except that the `\notation` hover popover silently never appears. Inverting
 * the macro table turns "did you mean the macro?" into a lookup.
 *
 * Scope, deliberately narrow:
 *   - ZERO-ARITY macros only. An argument macro's expansion has holes
 *     (`\polyring[ring][var]` → `\ring[\var]`), which needs unification, not substring
 *     matching.
 *   - `#{…}` / `##{…}` math spans only. Inside a raw `!{…}` group forester expands
 *     NOTHING, so the handrolled spelling is the correct one there.
 *
 * A hit is a CANDIDATE, not a verdict. Semantic macros have generic expansions — a
 * `\like` defined as `\mathcal{L}` collides with every first-order language and space
 * of linear maps in the forest. Hence the two severities (see `notation`), and hence
 * the pragma.
 *
 * Dependency-free apart from the two pure modules it reuses, because the Langium
 * validator runs in the language-server bundle where `vscode` does not exist.
 */

import { parseForesterMacroDefinitions, type ForesterMacroDefinition } from '../latex-hover-core.js';
import { findRawGroupSpans, isInSpans } from '../raw-group.js';

/** An expansion worth flagging must be a real command, not `'` or `\,`. */
const MIN_EXPANSION_LENGTH = 6;

/** `% macro-check: allow \mathbb{R}` — file-scoped, one expansion (or macro name) each. */
const PRAGMA_RE = /^\s*%\s*macro-check:\s*allow\s+(\S+)\s*$/;

export interface MacroEntry {
    /** Macro name without the backslash, e.g. `N`. */
    readonly macro: string;
    /** Other macros with the same expansion; non-empty means "do not auto-fix". */
    readonly alternatives: readonly string[];
    /** The expansion as written in the definition, e.g. `\mathbb{N}`. */
    readonly expansion: string;
    /** The `\notation` address when the macro is a documented symbol, else null. */
    readonly notation: string | null;
}

/** Keyed by normalised expansion. */
export type MacroIndex = ReadonlyMap<string, MacroEntry>;

export interface Handroll {
    /** 0-based offset of the match within the source. */
    readonly startOffset: number;
    /** Exclusive end offset — with startOffset, the range a quick-fix replaces. */
    readonly endOffset: number;
    readonly macro: string;
    readonly alternatives: readonly string[];
    readonly expansion: string;
    readonly notation: string | null;
}

/**
 * Whitespace mostly carries no meaning here, so strip it — but a CONTROL SYMBOL whose
 * payload IS whitespace (`\ `, the control space) must survive, or it merges with the
 * command after it: `\def\neq{#{\ \mathrlap{\,/}{=}\ }}` would key on `\\mathrlap…`,
 * a line break followed by a garbage csname.
 */
function norm(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i] ?? '';
        if (ch === '\\' && i + 1 < s.length && !/[A-Za-z]/.test(s[i + 1] ?? '')) {
            out += ch + s[i + 1];
            i += 1;
            continue;
        }
        if (/\s/.test(ch)) { continue; }
        out += ch;
    }
    return out;
}

/** `%`-to-end-of-line, honouring an escaped `\%`. A commented-out `\def` is documentation. */
function stripComments(src: string): string {
    return src
        .split('\n')
        .map((line) => {
            for (let i = 0; i < line.length; i += 1) {
                if (line[i] === '\\') { i += 1; continue; }
                if (line[i] === '%') { return line.slice(0, i); }
            }
            return line;
        })
        .join('\n');
}

/** Peel the forester wrapper: `#{X}` / `##{X}` → `X`, `\notation{addr}{X}` → `X`. */
function unwrap(body: string): string {
    const trimmed = body.trim();
    const math = /^##?\{([\s\S]*)\}$/.exec(trimmed);
    if (math?.[1] !== undefined && balanced(math[1])) { return math[1].trim(); }
    const notation = /^\\notation\{[^{}]*\}\{([\s\S]*)\}$/.exec(trimmed);
    if (notation?.[1] !== undefined && balanced(notation[1])) { return notation[1].trim(); }
    return trimmed;
}

function balanced(s: string): boolean {
    let depth = 0;
    for (let i = 0; i < s.length; i += 1) {
        if (s[i] === '\\') { i += 1; continue; }
        if (s[i] === '{') { depth += 1; }
        else if (s[i] === '}') { depth -= 1; if (depth < 0) { return false; } }
    }
    return depth === 0;
}

/** The `\notation` address a definition is annotated with, if any. */
function notationAddr(body: string): string | null {
    return /^\\notation\{([^{}]+)\}/.exec(body.trim())?.[1] ?? null;
}

/**
 * Invert macro definitions: expansion → the macro that stands for it. Accepts the
 * definitions the caller already has, so the import-transitive workspace registry can
 * feed it directly rather than this module re-reading files.
 */
export function buildInverseIndex(defs: readonly ForesterMacroDefinition[]): MacroIndex {
    const index = new Map<string, MacroEntry & { alternatives: string[] }>();
    for (const def of defs) {
        if (def.args.length > 0) { continue; }
        const expansion = unwrap(def.body);
        if (!expansion.includes('\\')) { continue; }
        const key = norm(expansion);
        if (key.length < MIN_EXPANSION_LENGTH) { continue; }
        const seen = index.get(key);
        if (seen) {
            if (seen.macro !== def.name) { seen.alternatives.push(def.name); }
            continue;
        }
        index.set(key, { macro: def.name, alternatives: [], expansion, notation: notationAddr(def.body) });
    }
    return index;
}

/** Convenience for a single source, e.g. base-macros.tree read straight off disk. */
export function buildInverseIndexFromSource(src: string): MacroIndex {
    return buildInverseIndex(parseForesterMacroDefinitions(stripComments(src)));
}

/** Expansions (or macro names) this file has explicitly excused. */
export function allowedByPragma(src: string): ReadonlySet<string> {
    const allowed = new Set<string>();
    for (const line of src.split('\n')) {
        const m = PRAGMA_RE.exec(line);
        if (m?.[1]) { allowed.add(norm(m[1])); }
    }
    return allowed;
}

/** True when `%` opens a comment before `offset` on the same line. */
function onCommentLine(src: string, offset: number): boolean {
    const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
    for (let i = lineStart; i < offset; i += 1) {
        if (src[i] === '\\') { i += 1; continue; }
        if (src[i] === '%') { return true; }
    }
    return false;
}

/** Index just past the `}` closing the `{` at `open`, or -1. */
function matchBrace(src: string, open: number): number {
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
        if (src[i] === '\\') { i += 1; continue; }
        if (src[i] === '{') { depth += 1; }
        else if (src[i] === '}' && (depth -= 1) === 0) { return i; }
    }
    return -1;
}

/**
 * Every handrolled expansion in `src`, with the exact source range of the match so a
 * quick-fix can replace it. One hit per occurrence (not per span), because the editor
 * squiggles each one individually.
 */
export function findHandrolls(src: string, index: MacroIndex): readonly Handroll[] {
    const allowed = allowedByPragma(src);
    const raw = findRawGroupSpans(src);
    const hits: Handroll[] = [];

    const spanRe = /##?\{/g;
    for (let m = spanRe.exec(src); m !== null; m = spanRe.exec(src)) {
        if (isInSpans(raw, m.index)) { continue; }
        if (onCommentLine(src, m.index)) { continue; }
        const open = m.index + m[0].length - 1;
        const close = matchBrace(src, open);
        if (close === -1) { continue; }
        const body = src.slice(open + 1, close);

        for (const [key, entry] of index) {
            if (allowed.has(key) || allowed.has(norm(`\\${entry.macro}`))) { continue; }
            // Locate each occurrence in the ORIGINAL text: normalisation drops the
            // whitespace the offsets are measured in, so scan the raw body directly.
            let at = body.indexOf(entry.expansion);
            while (at !== -1) {
                hits.push({
                    startOffset: open + 1 + at,
                    endOffset: open + 1 + at + entry.expansion.length,
                    macro: entry.macro,
                    alternatives: entry.alternatives,
                    expansion: entry.expansion,
                    notation: entry.notation,
                });
                at = body.indexOf(entry.expansion, at + entry.expansion.length);
            }
        }
        spanRe.lastIndex = close;
    }
    return hits.sort((a, b) => a.startOffset - b.startOffset);
}
