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

const treeId = (name: string): readonly Param[] =>
    [{ name, optional: false, kind: { tag: 'dynamic', source: 'tree-id' } }];

/** Builtin command → its parameters (first brace arg first), keyed with backslash. */
export const BUILTIN_PARAMS: ReadonlyMap<string, readonly Param[]> = new Map<string, readonly Param[]>([
    ['\\taxon', [{ name: 'taxon', optional: false, kind: { tag: 'dynamic', source: 'taxon' } }]],
    ['\\transclude', treeId('tree-id')],
    ['\\ref', treeId('tree-id')],
    ['\\import', treeId('tree-id')],
    ['\\export', treeId('tree-id')],
]);
