/**
 * Simple datalog query evaluator for the extension host.
 *
 * Evaluates a subset of Forester datalog queries against the in-memory
 * Forest index (from `forester query all`).  Supports single-variable
 * queries over the built-in relations that map directly to forest metadata:
 *
 *   ?X -: {has-taxon{?X}{'<taxon>'}}       → filter by taxon
 *   ?X -: {has-tag{?X}{'<tag>'}}            → filter by tag
 *   ?X -: {is-reference{?X}}                → taxon === "Reference"
 *   ?X -: {is-person{?X}}                   → taxon === "Person"
 *   ?X -: {is-article{?X}}                  → taxon present, not ref/person
 *
 * Blocks without `-:` are treated as rule/fact definitions and are
 * reported as such without evaluation.
 */
import type { Forest } from './get-forest.js';

export interface DatalogResult {
    /** Column headers, one per variable / display field. */
    columns: string[];
    /** Each row corresponds to one matching tree. */
    rows: string[][];
    /** Human-readable status message (always present). */
    message: string;
}

/**
 * Evaluate `queryText` (the inner content of a `\datalog{…}` block,
 * braces already stripped) against `forest`.
 */
export function evalDatalogQuery(queryText: string, forest: Forest): DatalogResult {
    const trimmed = queryText.trim();

    // Rule/fact block — no query variable
    if (!trimmed.includes('-:')) {
        return {
            columns: [],
            rows: [],
            message: 'This block defines datalog rules or facts. Build the forest to evaluate.',
        };
    }

    // Extract the query variable: ?VarName -: ...
    const varMatch = /^\?(\w+)\s*-:/.exec(trimmed);
    if (!varMatch) {
        return {
            columns: [],
            rows: [],
            message: 'Could not parse query variable. Expected pattern: ?X -: {constraints}',
        };
    }
    const varLabel = `?${varMatch[1]}`;
    const afterHead = trimmed.slice(varMatch[0].length).trim();

    // If no body braces, no constraints — return all trees
    let results = forest;
    if (afterHead.startsWith('{')) {
        const constraints = extractBraceContent(afterHead);
        results = applyConstraints(constraints, forest);
    }

    if (results.length === 0) {
        return {
            columns: [varLabel, 'title', 'taxon'],
            rows: [],
            message: `Query returned 0 results.`,
        };
    }

    return {
        columns: [varLabel, 'title', 'taxon'],
        rows: results.map(t => [t.route, t.title ?? '(no title)', t.taxon ?? '(none)']),
        message: `Query returned ${results.length} result${results.length === 1 ? '' : 's'}.`,
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the content of the first top-level `{…}` block. */
function extractBraceContent(text: string): string {
    if (!text.startsWith('{')) return text;
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            if (depth === 0) start = i + 1;
            depth++;
        } else if (text[i] === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i);
        }
    }
    return text.slice(1); // unmatched — return rest
}

/**
 * Apply the recognised built-in-relation constraints from `constraintText`
 * to `forest` and return the filtered subset.
 */
function applyConstraints(constraintText: string, forest: Forest): Forest {
    let results = forest;

    // has-taxon — e.g. \rel/has-taxon{?X}{'Reference'} or has-taxon(?X,'Reference')
    const taxonVal = extractRelationArg(constraintText, 'has-taxon');
    if (taxonVal !== undefined) {
        const lower = taxonVal.toLowerCase();
        results = results.filter(t => t.taxon?.toLowerCase() === lower);
    }

    // has-tag — e.g. \rel/has-tag{?X}{'algebra'}
    const tagVal = extractRelationArg(constraintText, 'has-tag');
    if (tagVal !== undefined) {
        const lower = tagVal.toLowerCase();
        results = results.filter(t => t.tags?.some(tg => tg.toLowerCase() === lower));
    }

    // is-reference — taxon === "Reference"
    if (/\\rel\/is-reference\{|is-reference\(/.test(constraintText)) {
        results = results.filter(t => t.taxon?.toLowerCase() === 'reference');
    }

    // is-person — taxon === "Person"
    if (/\\rel\/is-person\{|is-person\(/.test(constraintText)) {
        results = results.filter(t => t.taxon?.toLowerCase() === 'person');
    }

    // is-article — has a taxon that is not "Reference" or "Person"
    if (/\\rel\/is-article\{|is-article\(/.test(constraintText)) {
        const SKIP = new Set(['reference', 'person']);
        results = results.filter(t => t.taxon && !SKIP.has(t.taxon.toLowerCase()));
    }

    return results;
}

/**
 * Extract the constant string argument to a named relation in two common forms:
 *   1. `\rel/relName{?Var}{'value'}` → returns "value"
 *   2. `relName(?Var, 'value')`       → returns "value"
 */
function extractRelationArg(text: string, relName: string): string | undefined {
    // Form 1: \rel/relName{...}{'value'}
    const re1 = new RegExp(`\\\\rel\\/${relName}\\{[^}]*\\}\\{'([^']*)'\\}`);
    const m1 = re1.exec(text);
    if (m1) return m1[1];

    // Form 2: relName(?var, 'value')
    const re2 = new RegExp(`${relName}\\([^,)]*,\\s*'([^']*)'\\)`);
    const m2 = re2.exec(text);
    if (m2) return m2[1];

    return undefined;
}
