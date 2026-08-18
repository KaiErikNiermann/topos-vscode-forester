/**
 * Tests for the `\meta{key}` completion value set.
 * Run: pnpm dlx tsx src/meta-keys-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMetaKeys, type MetaKeySuggestion } from './meta-keys-core.js';
import { DEFAULT_META_KEYS } from './language/command-metadata.js';

const keys = (suggestions: readonly MetaKeySuggestion[]): string[] => suggestions.map(s => s.key);
/** Just the discovered tail — the builtins always occupy the head. */
const discovered = (suggestions: readonly MetaKeySuggestion[]): MetaKeySuggestion[] =>
    suggestions.slice(DEFAULT_META_KEYS.length);

test('builtins come first, in their declared order, even when the forest is empty', () => {
    const result = collectMetaKeys([], '');
    assert.deepEqual(keys(result), [...DEFAULT_META_KEYS]);
    assert.ok(result.every(s => !s.namespaced));
});

test('trees with no metas at all contribute nothing', () => {
    // The legacy query format predates metas, so the field can be missing entirely.
    const trees = [{}, undefined as unknown as Record<string, string>];
    assert.deepEqual(keys(collectMetaKeys(trees, '')), [...DEFAULT_META_KEYS]);
});

test('discovered keys are ranked by how often the forest uses them', () => {
    const trees: Record<string, string>[] = [
        { note: 'a', publisher: 'x' },
        { note: 'b', publisher: 'y' },
        { note: 'c' },
        { isbn: '1' },
    ];
    assert.deepEqual(keys(discovered(collectMetaKeys(trees, ''))), ['note', 'publisher', 'isbn']);
});

test('keys used equally often are ordered alphabetically', () => {
    const trees = [{ zeta: '1', alpha: '1', mu: '1' }];
    assert.deepEqual(keys(discovered(collectMetaKeys(trees, ''))), ['alpha', 'mu', 'zeta']);
});

test('namespaced keys collapse to a single prefix and never appear verbatim', () => {
    const trees: Record<string, string>[] = [
        { 'style:tbl-k4en0e': 'cols=64,97', 'style:tbl-jn0h1f': 'width=85' },
        { 'style:tbl-sl2zcz': 'cols=1', 'artifact-file:code/fib.py': 'url' },
    ];
    const result = discovered(collectMetaKeys(trees, ''));
    assert.deepEqual(keys(result), ['style:', 'artifact-file:']);
    assert.ok(result.every(s => s.namespaced), 'both are prefixes');
    assert.ok(!keys(result).some(k => k.includes('tbl-')), 'no instance key survives');
});

test('a prefix is ranked by the total uses of its instances', () => {
    const trees: Record<string, string>[] = [
        { 'style:a': '1', 'style:b': '1', 'style:c': '1' },
        { venue: 'x' }, // a builtin — excluded from the discovered tail
        { gloss: 'g' },
    ];
    assert.deepEqual(keys(discovered(collectMetaKeys(trees, ''))), ['style:', 'gloss']);
});

test('a key present only in the buffer is offered (unsaved-edit case)', () => {
    const doc = '\\meta{brandnew}{x}\n\\p{body}\n';
    assert.deepEqual(keys(discovered(collectMetaKeys([], doc))), ['brandnew']);
});

test('the buffer scan tolerates whitespace and collapses namespaced keys too', () => {
    const doc = '\\meta { spaced } {v}\n\\meta{artifact-source:figures/board.svg}{\\cite{x}}\n';
    assert.deepEqual(keys(discovered(collectMetaKeys([], doc))), ['artifact-source:', 'spaced']);
});

test('forest and buffer counts add up rather than duplicating', () => {
    const trees = [{ gloss: 'a' }, { gloss: 'b' }];
    const result = discovered(collectMetaKeys(trees, '\\meta{gloss}{c}\n\\meta{once}{d}'));
    assert.deepEqual(keys(result), ['gloss', 'once'], 'gloss appears once, ranked by 3 uses');
});

test('a builtin used by the forest is not repeated in the tail', () => {
    const result = collectMetaKeys([{ position: 'Student', external: 'https://x' }], '');
    assert.deepEqual(keys(result), [...DEFAULT_META_KEYS]);
});

test('the builtin list is overridable (the sig-override path)', () => {
    const result = collectMetaKeys([{ gloss: 'g' }], '', ['only-this']);
    assert.deepEqual(keys(result), ['only-this', 'gloss']);
});

test('an empty or brace-only key is dropped rather than offered', () => {
    assert.deepEqual(keys(discovered(collectMetaKeys([{ '': 'x' }], '\\meta{   }{y}'))), []);
});
