/**
 * meta-keys-core.ts — the value set for `\meta{key}` completion.
 *
 * Nothing declares meta keys. The forester compiler pops the key as plain text and
 * appends it to the frontmatter unvalidated (Eval.ml, the `Meta` case), and each
 * renderer picks out the keys it cares about by string literal. So a forest's real
 * key vocabulary only exists in the forest itself — which makes *usage* the
 * declaration: every key already written anywhere in the workspace is offered back.
 *
 * Two sources feed that, both free of file I/O: the forest query (which reports
 * every tree's metas, and which the extension already caches) and the buffer being
 * edited (so a key typed a moment ago is offered before the next forest rebuild).
 *
 * Pure — no vscode dependency, so it can be exercised by a standalone test.
 */
import { DEFAULT_META_KEYS } from './language/command-metadata.js';

export interface MetaKeySuggestion {
    /** What to insert: a whole key, or a `prefix:` for the namespaced ones. */
    readonly key: string;
    /** True for a `prefix:` standing in for keys that carry a payload after the colon. */
    readonly namespaced: boolean;
}

/**
 * `\meta{…}` keys written in a source text. Deliberately naive (as with the
 * `artifact-file:` scraper it generalises): a `\meta` inside a comment or a raw
 * group is picked up too, which costs at most one stray suggestion.
 */
const META_KEY_RE = /\\meta\s*\{\s*([^{}]+?)\s*\}/g;

/**
 * Namespaced keys — `style:tbl-jn0h1f`, `artifact-file:figures/board.svg` — carry
 * their subject in the key, so there is one per table or artifact and the literal
 * key is never wanted again. Collapse them to the prefix, which IS the reusable
 * part; the payload after it is completed by typing.
 */
function collapse(key: string): MetaKeySuggestion {
    const colon = key.indexOf(':');
    return colon === -1
        ? { key, namespaced: false }
        : { key: key.slice(0, colon + 1), namespaced: true };
}

/**
 * Meta keys to offer, most useful first: the builtins in their declared order,
 * then everything the workspace itself uses, ranked by how often it is used —
 * a key written 70 times is a convention, one written once may be a typo.
 */
export function collectMetaKeys(
    forestMetas: readonly Readonly<Record<string, string>>[],
    docText: string,
    builtins: readonly string[] = DEFAULT_META_KEYS,
): readonly MetaKeySuggestion[] {
    const uses = new Map<string, { suggestion: MetaKeySuggestion; count: number }>();
    const record = (raw: string): void => {
        const suggestion = collapse(raw.trim());
        if (!suggestion.key) { return; }
        const seen = uses.get(suggestion.key);
        if (seen) { seen.count++; } else { uses.set(suggestion.key, { suggestion, count: 1 }); }
    };

    // The legacy query format (get-forest.ts) predates metas, hence the guard.
    for (const metas of forestMetas) {
        for (const key of Object.keys(metas ?? {})) { record(key); }
    }
    for (const [, key] of docText.matchAll(META_KEY_RE)) { record(key!); }

    const builtinKeys = new Set(builtins);
    const discovered = [...uses.values()]
        .filter(u => !builtinKeys.has(u.suggestion.key))
        .sort((a, b) => b.count - a.count || a.suggestion.key.localeCompare(b.suggestion.key))
        .map(u => u.suggestion);

    return [...builtins.map(key => ({ key, namespaced: false })), ...discovered];
}
