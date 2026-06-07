/**
 * Simple datalog query evaluator for the extension host.
 *
 * Evaluates a subset of Forester datalog queries against the in-memory
 * Forest index (from `forester query all`).  Supports single-variable
 * queries over the built-in relations that map directly to forest metadata:
 *
 *   ?X -: {\rel/has-taxon ?X '{<taxon>}}    → filter by taxon
 *   ?X -: {\rel/has-tag ?X '{<tag>}}        → filter by tag
 *   ?X -: {\rel/is-reference ?X}            → taxon === "Reference"
 *   ?X -: {\rel/is-person ?X}               → taxon === "Person"
 *   ?X -: {\rel/is-article ?X}              → taxon present, not ref/person
 *
 * Terms are space-separated (a variable `?X`, a content constant `'{value}`,
 * or a URI constant `@{uri}`) — matching Forester's actual grammar. The older
 * braced-argument forms (`\rel/has-taxon{?X}{'value'}`) are tolerated so stale
 * queries still evaluate, but the language-server validator flags them.
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

    // Apply the positive premises (everything before a `#` negation block).
    // The relation matchers scan the whole text, so multiple `{…}` premises and
    // both the modern and legacy term syntaxes are handled.
    let results = forest;
    const positives = afterHead.split('#')[0].trim();
    if (positives.length > 0) {
        results = applyConstraints(positives, forest);
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

    // is-reference — taxon === "Reference" (modern `\rel/is-reference ?X`,
    // legacy `\rel/is-reference{?X}`, or `is-reference(?X)`)
    if (/\\rel\/is-reference\b|is-reference\(/.test(constraintText)) {
        results = results.filter(t => t.taxon?.toLowerCase() === 'reference');
    }

    // is-person — taxon === "Person"
    if (/\\rel\/is-person\b|is-person\(/.test(constraintText)) {
        results = results.filter(t => t.taxon?.toLowerCase() === 'person');
    }

    // is-article — has a taxon that is not "Reference" or "Person"
    if (/\\rel\/is-article\b|is-article\(/.test(constraintText)) {
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
    // Modern Forester form: \rel/relName ?Var '{value}  (space-separated terms,
    // content constant = tick + braces).
    const re0 = new RegExp(`\\\\rel\\/${relName}\\s+\\?\\w+\\s+'\\{([^}]*)\\}`);
    const m0 = re0.exec(text);
    if (m0) {return m0[1];}

    // Legacy form: \rel/relName{...}{'value'}
    const re1 = new RegExp(`\\\\rel\\/${relName}\\{[^}]*\\}\\{'([^']*)'\\}`);
    const m1 = re1.exec(text);
    if (m1) {return m1[1];}

    // Datalog-tuple form: relName(?var, 'value')
    const re2 = new RegExp(`${relName}\\([^,)]*,\\s*'([^']*)'\\)`);
    const m2 = re2.exec(text);
    if (m2) {return m2[1];}

    return undefined;
}
