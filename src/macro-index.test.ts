/**
 * Cross-repo contract test for the handrolled-macro detector. The GOLDEN_MACROS /
 * GOLDEN_INDEX / GOLDEN_TREE / GOLDEN_HITS below MUST be byte-identical to
 * notes/scripts/build/__tests__/macro-index.test.ts. If both detectors produce this
 * JSON for this input, they can't have drifted.
 *
 * What is frozen: `buildInverseIndex`'s entries and `findHandrolls`' findings, offsets
 * included. What is NOT frozen is host-side discovery — the notes repo reads only its
 * trees/base-macros.tree, this extension walks the `\import` closure of the open
 * workspace, and those legitimately yield different macro sets.
 *
 * Run: pnpm dlx tsx src/macro-index.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    allowedByPragma,
    buildInverseIndexFromSource,
    findHandrolls,
    type Handroll,
    type MacroEntry,
} from './language/macro-index.js';

// ── golden fixture (frozen — mirrored in the notes repo) ─────────────────────
const GOLDEN_MACROS = String.raw`
\def\N{\notation{009A}{\mathbb{N}}}
\def\defeq{\notation{sym-defeq}{\triangleq}}
\def\Hom{#{\operatorname{\textrm{Hom}}}}
\def\Lim[arg1]{\operatorname{\textrm{lim}}_{\arg1}}
\def\tick{#{'}}
\def\brc[x]{#{{\mathopen{}\left\{\x\right\}\mathclose{}}}}
\def\EX{\notation{sym-ex}{\mathbb{E}}}
\def\E{#{\mathbb{E}}}
% Usage: \def\phantom{\notation{009z}{\mathcal{B}\textrm{aire}}}
`;

const GOLDEN_INDEX: readonly (readonly [string, MacroEntry])[] = [
    [
        String.raw`\mathbb{N}`,
        { macro: 'N', alternatives: [], expansion: String.raw`\mathbb{N}`, notation: '009A' },
    ],
    [
        String.raw`\triangleq`,
        { macro: 'defeq', alternatives: [], expansion: String.raw`\triangleq`, notation: 'sym-defeq' },
    ],
    [
        String.raw`\operatorname{\textrm{Hom}}`,
        {
            macro: 'Hom',
            alternatives: [],
            expansion: String.raw`\operatorname{\textrm{Hom}}`,
            notation: null,
        },
    ],
    [
        String.raw`\mathbb{E}`,
        { macro: 'EX', alternatives: ['E'], expansion: String.raw`\mathbb{E}`, notation: 'sym-ex' },
    ],
];

// Offsets are part of the contract, so this string must stay byte-identical too.
const GOLDEN_TREE = '\\p{a #{\\mathbb{N}} b}\n\\p{##{ x \\triangleq \\mathbb{N} }}\n';

const GOLDEN_HITS: readonly Handroll[] = [
    {
        startOffset: 7,
        endOffset: 17,
        macro: 'N',
        alternatives: [],
        expansion: String.raw`\mathbb{N}`,
        notation: '009A',
    },
    {
        startOffset: 31,
        endOffset: 41,
        macro: 'defeq',
        alternatives: [],
        expansion: String.raw`\triangleq`,
        notation: 'sym-defeq',
    },
    {
        startOffset: 42,
        endOffset: 52,
        macro: 'N',
        alternatives: [],
        expansion: String.raw`\mathbb{N}`,
        notation: '009A',
    },
];

test('golden fixture: definitions invert to the frozen index (cross-repo contract)', () => {
    assert.deepEqual([...buildInverseIndexFromSource(GOLDEN_MACROS)], GOLDEN_INDEX);
});

test('golden fixture: the tree yields the frozen findings (cross-repo contract)', () => {
    assert.deepEqual(findHandrolls(GOLDEN_TREE, buildInverseIndexFromSource(GOLDEN_MACROS)), GOLDEN_HITS);
});

test('argument macros are excluded — their expansions have holes', () => {
    const index = buildInverseIndexFromSource(GOLDEN_MACROS);
    assert.equal([...index.values()].some((e) => e.macro === 'Lim'), false);
    assert.equal([...index.values()].some((e) => e.macro === 'brc'), false);
});

test('indistinctive expansions are excluded', () => {
    assert.equal(
        [...buildInverseIndexFromSource(GOLDEN_MACROS).values()].some((e) => e.macro === 'tick'),
        false,
    );
});

test('a commented-out \\def is documentation, not a definition', () => {
    const index = buildInverseIndexFromSource(GOLDEN_MACROS);
    assert.equal([...index.values()].some((e) => e.macro === 'phantom'), false);
});

test('colliding expansions record alternatives instead of guessing', () => {
    const entry = [...buildInverseIndexFromSource(GOLDEN_MACROS).values()].find((e) => e.macro === 'EX');
    assert.deepEqual(entry?.alternatives, ['E']);
});

test('a control space is not merged into the command after it', () => {
    const index = buildInverseIndexFromSource(String.raw`\def\neq{#{\ \mathrlap{\,/}{=}\ }}`);
    const key = [...index.keys()][0] ?? '';
    assert.equal(key.includes(String.raw`\\mathrlap`), false, `control space merged: ${key}`);
    assert.equal(key.startsWith('\\ '), true, `control space lost: ${key}`);
});

test('raw !{…} groups are never scanned', () => {
    assert.deepEqual(
        findHandrolls(String.raw`\texfig!{ #{\mathbb{N}} }`, buildInverseIndexFromSource(GOLDEN_MACROS)),
        [],
    );
});

test('comment lines are never scanned', () => {
    assert.deepEqual(
        findHandrolls(String.raw`% see #{\mathbb{N}}`, buildInverseIndexFromSource(GOLDEN_MACROS)),
        [],
    );
});

test('a file-scoped pragma silences one expansion', () => {
    const src = String.raw`
% macro-check: allow \mathbb{N}
\p{#{\mathbb{N}} and #{\triangleq}}
`;
    assert.deepEqual(
        findHandrolls(src, buildInverseIndexFromSource(GOLDEN_MACROS)).map((h) => h.macro),
        ['defeq'],
    );
});

test('a pragma may name the macro instead of the expansion', () => {
    const src = String.raw`
% macro-check: allow \N
\p{#{\mathbb{N}}}
`;
    assert.deepEqual(findHandrolls(src, buildInverseIndexFromSource(GOLDEN_MACROS)), []);
});

test('allowedByPragma collects every allow line, whitespace-normalised', () => {
    const src = '% macro-check: allow \\mathbb{N}\n%macro-check:allow  \\triangleq\n';
    assert.deepEqual(
        [...allowedByPragma(src)].sort(),
        [String.raw`\mathbb{N}`, String.raw`\triangleq`].sort(),
    );
});

test('repeated occurrences in one span are reported individually', () => {
    const hits = findHandrolls(
        String.raw`#{\mathbb{N} \times \mathbb{N}}`,
        buildInverseIndexFromSource(GOLDEN_MACROS),
    );
    assert.equal(hits.length, 2);
    assert.notEqual(hits[0]?.startOffset, hits[1]?.startOffset);
});
