/**
 * Scope tests for the TextMate grammar (resources/language/forester.tmGrammar.json).
 *
 * The grammar decides colour, so the assertions here are about scopes at a
 * position: what the editor paints a given character as. Chiefly they pin down
 * the math boundary — inside #{…} / ##{…} the bracket characters are TeX
 * notation, so none of the constructs they spell elsewhere (links, wiki links,
 * raw groups) may claim them.
 *
 * Run with: pnpm run test:tmgrammar
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type * as OnigurumaModule from 'vscode-oniguruma';
import type * as TextMateModule from 'vscode-textmate';

// Both packages are CommonJS and build their exports in a way Node's ESM
// interop cannot see through, so the namespace import arrives empty. Requiring
// them keeps the real exports, and the type-only imports above keep the types.
const require_ = createRequire(import.meta.url);
const oniguruma = require_('vscode-oniguruma') as typeof OnigurumaModule;
const vsctm = require_('vscode-textmate') as typeof TextMateModule;

// ── Minimal test framework ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        console.log(`✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`✗ ${name}`);
        console.log(`  ${e instanceof Error ? e.message : e}`);
    }
}

function assertIs(condition: boolean, message: string): void {
    if (!condition) {throw new Error(message);}
}

// ── Grammar setup ────────────────────────────────────────────────────────────

const GRAMMAR_PATH = resolve('resources/language/forester.tmGrammar.json');

await oniguruma.loadWASM(readFileSync(require_.resolve('vscode-oniguruma/release/onig.wasm')).buffer as ArrayBuffer);

const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
        createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
        createOnigString: (s: string) => new oniguruma.OnigString(s),
    }),
    // text.tex.latex lives in VS Code's bundled LaTeX grammar and is not
    // resolvable here; vscode-textmate skips includes it cannot load, which
    // costs these tests nothing — no assertion below is about LaTeX colouring.
    loadGrammar: async (scopeName: string) =>
        scopeName === 'source.forester'
            ? vsctm.parseRawGrammar(readFileSync(GRAMMAR_PATH, 'utf8'), GRAMMAR_PATH)
            : null,
});

const grammar = await registry.loadGrammar('source.forester');
if (!grammar) {throw new Error('Failed to load source.forester grammar');}

/**
 * Scopes covering the first character of `needle` in `source`.
 *
 * Tokenizing runs from the first line every time: a rule stack is what makes a
 * position mean anything here, and starting mid-document would throw away the
 * very context under test.
 */
function scopesAt(source: string, needle: string, occurrence = 1): string[] {
    const lines = source.split('\n');
    let seen = 0;
    let target: { line: number; column: number } | undefined;

    for (const [lineIdx, lineText] of lines.entries()) {
        let from = 0;
        for (;;) {
            const at = lineText.indexOf(needle, from);
            if (at < 0) {break;}
            seen++;
            if (seen === occurrence) {
                target = { line: lineIdx, column: at };
                break;
            }
            from = at + 1;
        }
        if (target) {break;}
    }

    if (!target) {throw new Error(`Needle not found in source: ${JSON.stringify(needle)}`);}

    let ruleStack = vsctm.INITIAL;
    for (const [lineIdx, lineText] of lines.entries()) {
        const result = grammar!.tokenizeLine(lineText, ruleStack);
        ruleStack = result.ruleStack;
        if (lineIdx !== target.line) {continue;}

        const token = result.tokens.find(t => t.startIndex <= target!.column && target!.column < t.endIndex);
        if (!token) {throw new Error(`No token at line ${lineIdx + 1}, column ${target.column}`);}
        return token.scopes;
    }

    throw new Error('Unreachable: target line not tokenized');
}

function assertScope(source: string, needle: string, scope: string, occurrence = 1): void {
    const scopes = scopesAt(source, needle, occurrence);
    assertIs(
        scopes.includes(scope),
        `Expected scope ${scope} at ${JSON.stringify(needle)}, got:\n    ${scopes.join('\n    ')}`,
    );
}

function assertNotScope(source: string, needle: string, scope: string, occurrence = 1): void {
    const scopes = scopesAt(source, needle, occurrence);
    assertIs(
        !scopes.includes(scope),
        `Expected no ${scope} at ${JSON.stringify(needle)}, got:\n    ${scopes.join('\n    ')}`,
    );
}

const LINK = 'markup.underline.link.forester';
const MATH = 'meta.math.forester';
const RAW = 'embedded.latex';

// ── Prose: the constructs keep working ───────────────────────────────────────

test('[[id]] in prose is a link', () => {
    assertScope('see [[00DJ]] here', '00DJ', LINK);
});

test('[text](url) in prose links the target', () => {
    assertScope('see [free vector](00DJ) here', '00DJ', LINK);
});

test('!{ … } in prose is a raw group', () => {
    assertScope('\\texfig!{\\draw (0,0);}', '\\draw', RAW);
});

// ── Math: brackets are TeX notation, and nothing else ────────────────────────

test('math content is scoped as math', () => {
    assertScope('#{x^2}', 'x^2', MATH);
});

test('[[…]] in display math is not a link', () => {
    const source = '##{ [[a b]] }';
    assertScope(source, 'a b', MATH);
    assertNotScope(source, 'a b', LINK);
});

test('[[…]] in inline math is not a link', () => {
    const source = '#{ [[a b]] }';
    assertNotScope(source, 'a b', LINK);
});

test('[f](x) in math is an evaluation, not a link', () => {
    // Needle the target text itself: the link rule scopes its capture groups,
    // so probing the surrounding punctuation would pass whatever the rule did.
    assertNotScope('#{ [f](zz) = f(zz) }', 'zz', LINK);
});

test('!{ … } in math is not a raw group', () => {
    // Likewise, '{' belongs to the raw group's begin capture. The body is what
    // carries embedded.latex, so the body is what has to be clean.
    assertNotScope('#{ n!{zz} }', 'zz', RAW);
});

test('math survives a braced command before the brackets', () => {
    // The bracket row of the align* body from 00DH.tree: the earlier
    // \begin{align*} and \mathcal{C} must not have closed the math, or the
    // brackets would be back in body scope and a link again.
    const source = String.raw`##{
  \begin{align*}
    [\bvec{x}]_\mathcal{C} & = \underset{\mathcal{C} \leftarrow \mathcal{B}}{P} [\bvec{x}]_\mathcal{B} \\
    & = [[\bvec{b}_1 \quad \bvec{b}_2 \quad \ldots \quad \bvec{b}_3]]
  \end{align*}
}`;
    assertScope(source, '\\bvec{b}_1', MATH);
    assertNotScope(source, '\\bvec{b}_1', LINK);
});

test('prose after math is prose again', () => {
    const source = 'text #{[[a]]} and then [[00DJ]] here';
    assertNotScope(source, 'a]]', LINK);
    assertScope(source, '00DJ', LINK);
});

test('a group nested in a formula is still a formula', () => {
    assertNotScope(String.raw`#{ \mathcal{[[zz]]} }`, 'zz', LINK);
});

test('math nested in a body group is still math', () => {
    assertNotScope('\\p{ text #{[[zz]]} }', 'zz', LINK);
});

// ── The body rules the math split had to leave alone ─────────────────────────

test('[[id]] inside a body group is still a link', () => {
    assertScope('\\p{see [[00DJ]] here}', '00DJ', LINK);
});

test('\\em{…} is still italic', () => {
    assertScope('\\p{\\em{stressed} word}', 'stressed', 'markup.italic.forester');
});

test('\\title{…} is still a heading', () => {
    assertScope('\\title{A primer}', 'A primer', 'markup.heading.forester');
});

test('\\transclude{…} still underlines its target', () => {
    assertScope('\\transclude{00DJ}', '00DJ', LINK);
});

test('\\startverb…\\stopverb is still raw', () => {
    assertScope('\\code{\\startverb\\taxon{x}\\stopverb}', '\\taxon', 'markup.raw.forester');
});

test('% comments are still comments', () => {
    assertScope('% a remark', 'a remark', 'comment.line.percentage.forester');
});

test('a command is still a command', () => {
    assertScope('\\p{x}', '\\p', 'constant.language.forester');
});

// ── Brace-less single arguments ──────────────────────────────────────────────
//
// \em word == \em{word}. The argument must carry the SAME scope as the braced
// form, so the two look identical to a theme and the author can see that the
// bare form did something.

test('\\em word is italic without braces', () => {
    assertScope('\\em hello world', 'hello', 'markup.italic.forester');
});

test('\\strong word is bold without braces', () => {
    assertScope('\\strong hello, world', 'hello,', 'markup.bold.forester');
});

test('\\code word is raw without braces', () => {
    assertScope('\\code foo bar', 'foo', 'markup.inline.raw.forester');
});

test('a brace-less argument is styled inside a group too', () => {
    assertScope('\\p{\\em hello there}', 'hello', 'markup.italic.forester');
});

test('the brace-less rule stops at the first word', () => {
    assertNotScope('\\em hello world', 'world', 'markup.italic.forester');
});

// Whitespace before a braced argument now binds in the compiler, so it has to
// keep its scope here as well.
test('\\em {x} still italicises through the space', () => {
    assertScope('\\em {x}', 'x', 'markup.italic.forester');
});

// \emph is a different command; the [ \t]+ guard keeps the rule off it.
test('the brace-less rule does not fire on a longer command name', () => {
    assertNotScope('\\emph foo', 'foo', 'markup.italic.forester');
});

// Builtins outside the brace-less tier must NOT be styled bare -- writing them
// that way is still a compile error, and highlighting it would suggest it works.
test('\\title takes no brace-less argument', () => {
    assertNotScope('\\title A primer', 'A', 'markup.heading.forester');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {process.exit(1);}
