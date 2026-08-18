/**
 * command-metadata.ts — per-parameter constraints for BUILT-IN forester commands,
 * expressed in the same `Param` shape as project `%! sig` signatures (sig.ts). The
 * completion/hover providers (client) and the validator (server) both consume this,
 * so a builtin's parameter value set lives in exactly one place.
 *
 * These are SOFT constraints (dynamic value sources for completion/hover). Hard
 * checks stay where they already work: `\date` ISO format (checkDateFormat) and
 * tree-id existence for `\transclude`/`\ref`/… (checkCrossRefTarget). Arity stays
 * in BUILTIN_ARITY (forester-validator-checks.ts).
 */
import type { Param } from './sig.js';

/** Common taxon names; the workspace's own taxons are merged in at resolve time. */
export const DEFAULT_TAXONS: readonly string[] = [
    'Definition', 'Theorem', 'Lemma', 'Proposition', 'Corollary', 'Example',
    'Remark', 'Note', 'Proof', 'Construction', 'Conjecture', 'Exercise',
    'Problem', 'Solution', 'Reference', 'Person', 'Institution',
];

/**
 * Meta keys the forester compiler's own renderers treat specially (frontmatter
 * lines, links, and the three `false`/`lang` switches) — everything else a forest
 * uses is discovered from the forest itself, since nothing declares meta keys.
 * Source: lib/frontend/Htmx_frontmatter.ml and bin/forester/theme/{metadata,tree}.xsl.
 * Ordered by how often they are hand-written rather than machine-generated.
 */
export const DEFAULT_META_KEYS: readonly string[] = [
    'external', 'position', 'institution', 'venue', 'source', 'doi', 'orcid',
    'slides', 'video', 'bibtex', 'author', 'toc', 'lang',
];

/**
 * Commands whose builtin parameter list drives completion and hover but NOT the
 * parameter-name inlay hints. `\meta{key}{value}` names its own slots, so labelling
 * them would only add noise to every frontmatter line in a forest. A project
 * `%! sig` for the same command overrides this and restores the hints.
 */
export const INLAY_SUPPRESSED_COMMANDS: ReadonlySet<string> = new Set(['\\meta']);

const treeId = (name: string): readonly Param[] =>
    [{ name, optional: false, kind: { tag: 'dynamic', source: 'tree-id' } }];

/** Builtin command → its parameters (first brace arg first), keyed with backslash. */
export const BUILTIN_PARAMS: ReadonlyMap<string, readonly Param[]> = new Map<string, readonly Param[]>([
    ['\\taxon', [{ name: 'taxon', optional: false, kind: { tag: 'dynamic', source: 'taxon' } }]],
    ['\\meta', [
        { name: 'key', optional: false, kind: { tag: 'dynamic', source: 'meta-key' } },
        { name: 'value', optional: false, kind: { tag: 'content' } },
    ]],
    ['\\transclude', treeId('tree-id')],
    ['\\ref', treeId('tree-id')],
    ['\\import', treeId('tree-id')],
    ['\\export', treeId('tree-id')],
]);
