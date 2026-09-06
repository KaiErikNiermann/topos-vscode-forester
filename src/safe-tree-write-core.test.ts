/**
 * Tests for the whole-file `.tree` write guards.
 * Run: pnpm dlx tsx src/safe-tree-write-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    treeIdOfPath,
    checkPathClaimsTree,
    checkOnlyEditableLinesChanged,
    checkCreateTarget,
} from './safe-tree-write-core.js';

const denied = (v: { ok: boolean; reason?: string }): string => {
    assert.equal(v.ok, false, 'expected the write to be refused');
    return (v as { reason: string }).reason;
};

test('treeIdOfPath reads the address off the filename', () => {
    assert.equal(treeIdOfPath('/f/trees/006C.tree'), '006C');
    assert.equal(treeIdOfPath('006C.tree'), '006C');
    assert.equal(treeIdOfPath('/f/trees/notes.md'), null);
});

test('a path claiming a different address is refused', () => {
    assert.ok(checkPathClaimsTree('/f/trees/006C.tree', '006C').ok);
    const reason = denied(checkPathClaimsTree('/f/trees/005b.tree', '006C'));
    assert.match(reason, /005b\.tree/);
    assert.match(reason, /006C/);
});

test('case is significant — 005b must never resolve to 005B.tree', () => {
    // Forester's base36 alphabet is uppercase, so these are distinct addresses
    // that a case-folding filesystem (or a glob) can conflate.
    denied(checkPathClaimsTree('/f/trees/005B.tree', '005b'));
    denied(checkPathClaimsTree('/f/trees/005b.tree', '005B'));
});

test('a non-tree path is never a legal whole-file target', () => {
    denied(checkPathClaimsTree('/f/trees/006C.txt', '006C'));
});

const TREE = [
    '\\date{2026-03-21}',
    '',
    '\\import{base-macros}',
    '',
    '\\taxon{VU-EC-2026}',
    '',
    '\\title{Evolutionary Computing}',
    '',
    '\\p{body that must survive}',
].join('\n');

test('retitling and re-taxoning is allowed', () => {
    const updated = TREE
        .replace('\\title{Evolutionary Computing}', '\\title{Evolutionary Computation}')
        .replace('\\taxon{VU-EC-2026}', '\\taxon{Note}');
    assert.ok(checkOnlyEditableLinesChanged(TREE, updated).ok);
});

test('adding a title, or dropping a taxon, is allowed', () => {
    // renameTreeById splices out exactly the \taxon line, never an adjacent blank.
    assert.ok(checkOnlyEditableLinesChanged(TREE, TREE.replace('\\taxon{VU-EC-2026}\n', '')).ok);
    assert.ok(checkOnlyEditableLinesChanged(TREE, `\\title{New}\n${TREE}`).ok);
});

test('dropping a blank line alongside the taxon is refused — only \\title/\\taxon may move', () => {
    denied(checkOnlyEditableLinesChanged(TREE, TREE.replace('\\taxon{VU-EC-2026}\n\n', '')));
});

test('touching a body line is refused', () => {
    const updated = TREE.replace('\\p{body that must survive}', '\\p{clobbered}');
    assert.match(denied(checkOnlyEditableLinesChanged(TREE, updated)), /outside \\title\/\\taxon/);
});

test('the regression: one tree\'s content written over another is refused', () => {
    // trees/005b.tree (17,774 bytes of logic notes) was replaced by a stub of
    // the Evolutionary Computing tree on 2026-09-06. Same title/taxon shape,
    // completely different body — the structural check is what catches it.
    const victim = [
        '\\date{2025-12-19}',
        '',
        '\\import{base-macros}',
        '',
        '\\title{Predicate logic}',
        '',
        '\\p{So we have a universe #{U} ...}',
    ].join('\n');
    denied(checkOnlyEditableLinesChanged(victim, TREE));
});

test('truncating a tree to a stub is refused', () => {
    denied(checkOnlyEditableLinesChanged(TREE, '\\title{Evolutionary Computing}'));
});

test('an identical rewrite is fine', () => {
    assert.ok(checkOnlyEditableLinesChanged(TREE, TREE).ok);
});

test('CRLF input is compared line-wise, not byte-wise', () => {
    assert.ok(checkOnlyEditableLinesChanged(TREE, TREE.replaceAll('\n', '\r\n')).ok);
});

test('a freshly allocated address must not already exist', () => {
    const existing = new Set(['/f/trees/005b.tree']);
    assert.ok(checkCreateTarget('/f/trees/00L7.tree', existing).ok);
    assert.match(denied(checkCreateTarget('/f/trees/005b.tree', existing)), /already existed/);
});
