/**
 * Cross-repo contract test for the `%! sig` parser. The GOLDEN_INPUT / GOLDEN_OUTPUT
 * below MUST be byte-identical to notes/scripts/build/render/__tests__/sig.test.ts.
 * If both parsers produce this JSON for this input, they can't have drifted.
 * Run: pnpm dlx tsx src/sig.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSigLine, parseMacroSigs, flagsOf, validateFlags, type Sig } from './language/sig.js';

const GOLDEN_INPUT = String.raw`%! sig \embed(opts: flags{mode: image|code|raw, width?: number, align?: left|center|right}, target: @artifact-ref, caption?: content)`;

const GOLDEN_OUTPUT: Sig = {
    command: '\\embed',
    params: [
        {
            name: 'opts', optional: false,
            kind: {
                tag: 'flags',
                fields: [
                    { name: 'mode', optional: false, kind: { tag: 'enum', values: ['image', 'code', 'raw'] } },
                    { name: 'width', optional: true, kind: { tag: 'number' } },
                    { name: 'align', optional: true, kind: { tag: 'enum', values: ['left', 'center', 'right'] } },
                ],
            },
        },
        { name: 'target', optional: false, kind: { tag: 'dynamic', source: 'artifact-ref' } },
        { name: 'caption', optional: true, kind: { tag: 'content' } },
    ],
};

test('golden fixture: the \\embed sig parses to the frozen JSON (cross-repo contract)', () => {
    assert.deepEqual(parseSigLine(GOLDEN_INPUT), GOLDEN_OUTPUT);
});

test('parseMacroSigs + validateFlags behave as in the notes parser', () => {
    const m = parseMacroSigs([
        String.raw`%! sig \codeblock(lang: @language, body: content)`,
        String.raw`\def\codeblock[lang][body]{…}`,
        String.raw`%! sig \d3(name: @figure)`,
    ].join('\n'));
    assert.deepEqual([...m.keys()].sort(), ['\\codeblock', '\\d3']);

    const flags = flagsOf(GOLDEN_OUTPUT, 'opts')!;
    assert.deepEqual(validateFlags(flags, 'image width=70 align=center').value, { mode: 'image', width: '70', align: 'center' });
    assert.equal(validateFlags(flags, 'align=bogus').diagnostics.length, 1);
});
