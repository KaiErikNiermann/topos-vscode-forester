/**
 * sig.ts — parser for `%! sig` macro signatures (the project-local declaration of
 * custom-construct parameter constraints). MIRRORS the notes-repo parser at
 * notes/scripts/build/render/sig.ts — the grammar is FROZEN and a golden fixture
 * (sig.test.ts here + sig.test.ts there) asserts both produce identical JSON.
 * Change one, change both.
 *
 *   %! sig \embed(opts: flags{mode: image|code|raw, width?: number, align?: left|center|right}, target: @artifact-ref, caption?: content)
 *
 * `kind` ∈ a|b|c (enum) · number · content · opaque · @source (dynamic value set,
 * resolved per-environment: @language @figure @taxon @meta-key @tree-id
 * @artifact-ref @bib-ref) · flags{ k: kind, k2?: kind } (first field is the
 * bareword positional).
 */

export type ParamKind =
    | { readonly tag: 'enum'; readonly values: readonly string[] }
    | { readonly tag: 'number' }
    | { readonly tag: 'content' }
    | { readonly tag: 'opaque' }
    | { readonly tag: 'dynamic'; readonly source: string }
    | { readonly tag: 'flags'; readonly fields: readonly FlagField[] };

export interface FlagField {
    readonly name: string;
    readonly optional: boolean;
    readonly kind: ParamKind;
}

export interface Param {
    readonly name: string;
    readonly optional: boolean;
    readonly kind: ParamKind;
}

export interface Sig {
    readonly command: string; // with leading backslash, e.g. "\\embed"
    readonly params: readonly Param[];
}

export interface SigDiagnostic {
    readonly construct: string;
    readonly param: string;
    readonly message: string;
}

// ── parsing ────────────────────────────────────────────────────────────────

// Split on top-level commas, respecting `{…}` nesting (so flags bodies stay intact).
function splitTopLevel(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '{') { depth++; }
        else if (c === '}') { depth--; }
        else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    const tail = s.slice(start).trim();
    if (tail) { out.push(tail); }
    return out.map(x => x.trim()).filter(Boolean);
}

function parseKind(raw: string): ParamKind {
    const s = raw.trim();
    if (s.startsWith('flags{') && s.endsWith('}')) {
        return { tag: 'flags', fields: splitTopLevel(s.slice('flags{'.length, -1)).map(parseField) };
    }
    if (s.startsWith('@')) { return { tag: 'dynamic', source: s.slice(1) }; }
    if (s === 'number') { return { tag: 'number' }; }
    if (s === 'content') { return { tag: 'content' }; }
    if (s === 'opaque') { return { tag: 'opaque' }; }
    return { tag: 'enum', values: s.split('|').map(v => v.trim()).filter(Boolean) };
}

const FIELD_RE = /^(\w+)(\?)?\s*:\s*(.+)$/s;
function parseField(raw: string): FlagField {
    const m = FIELD_RE.exec(raw.trim());
    if (!m) { throw new Error(`bad sig field: ${JSON.stringify(raw)}`); }
    return { name: m[1]!, optional: m[2] === '?', kind: parseKind(m[3]!) };
}

const SIG_RE = /^\s*%!\s*sig\s+\\(\S+?)\s*\((.*)\)\s*$/;

/** Parse a single `%! sig …` line, or null if the line isn't a signature. */
export function parseSigLine(line: string): Sig | null {
    const m = SIG_RE.exec(line);
    if (!m) { return null; }
    const params = splitTopLevel(m[2]!).map((spec): Param => {
        const f = parseField(spec);
        return { name: f.name, optional: f.optional, kind: f.kind };
    });
    return { command: `\\${m[1]}`, params };
}

/** Collect every `%! sig` in a `.tree` source, keyed by command (with backslash). */
export function parseMacroSigs(source: string): Map<string, Sig> {
    const out = new Map<string, Sig>();
    for (const line of source.split('\n')) {
        if (!line.includes('%! sig')) { continue; }
        const sig = parseSigLine(line);
        if (sig) { out.set(sig.command, sig); }
    }
    return out;
}

/** The flag fields of a `flags{…}` param of `sig` named `param`, else undefined. */
export function flagsOf(sig: Sig, param: string): readonly FlagField[] | undefined {
    const p = sig.params.find(x => x.name === param);
    return p && p.kind.tag === 'flags' ? p.kind.fields : undefined;
}

// ── validation (flags) ──────────────────────────────────────────────────────

/** Validate a whitespace-separated flag string against a `flags{…}` schema. */
export function validateFlags(
    fields: readonly FlagField[],
    raw: string,
    construct = '',
): { value: Record<string, string>; diagnostics: SigDiagnostic[] } {
    const value: Record<string, string> = {};
    const diagnostics: SigDiagnostic[] = [];
    const positional = fields[0];
    for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
        const eq = tok.indexOf('=');
        if (eq === -1) {
            if (positional && positional.kind.tag === 'enum') {
                if (positional.kind.values.includes(tok)) { value[positional.name] = tok; }
                else { diagnostics.push({ construct, param: positional.name, message: `unknown ${positional.name} '${tok}' (expected ${positional.kind.values.join('|')})` }); }
            } else {
                diagnostics.push({ construct, param: '', message: `unexpected token '${tok}'` });
            }
            continue;
        }
        const key = tok.slice(0, eq);
        const v = tok.slice(eq + 1);
        const field = fields.find(f => f.name === key);
        if (!field) { diagnostics.push({ construct, param: key, message: `unknown flag '${key}'` }); continue; }
        if (field.kind.tag === 'enum' && !field.kind.values.includes(v)) {
            diagnostics.push({ construct, param: key, message: `'${key}' expects ${field.kind.values.join('|')}, got '${v}'` });
            continue;
        }
        value[key] = v;
    }
    return { value, diagnostics };
}
