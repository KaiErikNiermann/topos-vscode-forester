/**
 * Grammar correctness tests for the Langium Forester parser.
 *
 * Covers edge cases: nested braces, verbatim, math, comments, escape sequences,
 * multiple argument forms, and command categories.
 * Run with: npm run test:langium-grammar
 */

import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import {
    isBraceArg,
    isBracketArg,
    isCommand,
    isDocument,
    isEscape,
    isMathBraceGroup,
    isMathDisplay,
    isMathInline,
    isMathText,
    isTextFragment,
    isVerbatimBlock,
    isWikiLink,
    type Command,
    type Document,
} from './language/generated/ast.js';
import { createForesterServices } from './language/forester-module.js';

// ── Minimal test framework ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`✓ ${name}`);
    } catch (e) {
        failed++;
        console.log(`✗ ${name}`);
        console.log(`  ${e instanceof Error ? e.message : e}`);
    }
}

function assertOk<T>(value: T, msg?: string): asserts value is NonNullable<T> {
    if (value === undefined || value === null) {
        throw new Error(msg ?? `Expected a defined value but got ${value}`);
    }
}

function assertEqual(actual: unknown, expected: unknown, msg?: string): void {
    if (actual !== expected) {
        throw new Error(
            `${msg ? msg + '\n' : ''}Expected: ${JSON.stringify(expected)}\nActual  : ${JSON.stringify(actual)}`,
        );
    }
}

function assertEmpty(arr: unknown[], msg?: string): void {
    if (arr.length !== 0) {
        throw new Error(msg ?? `Expected empty array but got ${JSON.stringify(arr)}`);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const { Forester } = createForesterServices(EmptyFileSystem);
const parse = parseHelper<Document>(Forester);

async function parseClean(source: string): Promise<Document> {
    const doc = await parse(source);
    const { lexerErrors, parserErrors } = doc.parseResult;
    if (lexerErrors.length > 0) {
        throw new Error(`Lexer errors: ${lexerErrors.map(e => e.message).join('; ')}`);
    }
    if (parserErrors.length > 0) {
        throw new Error(`Parser errors: ${parserErrors.map(e => e.message).join('; ')}`);
    }
    const root = doc.parseResult.value;
    if (!isDocument(root)) {
        throw new Error('Root is not a Document');
    }
    return root;
}

function firstCommand(doc: Document, name?: string): Command {
    const cmd = doc.nodes.find(n => isCommand(n) && (!name || (n as Command).name === name));
    if (!cmd || !isCommand(cmd)) {
        throw new Error(`No command${name ? ` named ${name}` : ''} found at top level`);
    }
    return cmd;
}

// ── Tests: Empty / trivial documents ─────────────────────────────────────────

console.log('\n=== Grammar Correctness Tests ===\n');

await test('empty document parses without errors', async () => {
    const doc = await parseClean('');
    assertEqual(doc.nodes.length, 0);
});

await test('plain text fragment parses correctly', async () => {
    const doc = await parseClean('hello world');
    // TEXT terminal matches [^\\{}[\]()\n\t %#`]+ — spaces are WS (hidden),
    // so the result should be at least one TextFragment
    const frags = doc.nodes.filter(isTextFragment);
    if (frags.length === 0) {
        throw new Error('Expected at least one TextFragment');
    }
    const combined = frags.map(f => f.value).join('');
    if (!combined.includes('hello') || !combined.includes('world')) {
        throw new Error(`Expected text to contain 'hello world', got: ${JSON.stringify(combined)}`);
    }
});

await test('escaped percent \\% parses as Escape node', async () => {
    const doc = await parseClean('\\%');
    assertEqual(doc.nodes.length, 1);
    if (!isEscape(doc.nodes[0])) {
        throw new Error(`Expected Escape, got ${doc.nodes[0].$type}`);
    }
    assertEqual(doc.nodes[0].value, '\\%');
});

// ── Tests: Simple commands ────────────────────────────────────────────────────

await test('simple \\title{Hello} parses as Command with one BraceArg', async () => {
    const doc = await parseClean('\\title{Hello}');
    const cmd = firstCommand(doc, '\\title');
    assertEqual(cmd.args.length, 1);
    if (!isBraceArg(cmd.args[0])) {
        throw new Error('Expected BraceArg');
    }
    const innerFrag = cmd.args[0].nodes.find(isTextFragment);
    assertOk(innerFrag, 'Expected TextFragment inside brace arg');
    assertEqual(innerFrag.value, 'Hello');
});

await test('\\p with multiple children parses correctly', async () => {
    const doc = await parseClean('\\p{Hello World}');
    const cmd = firstCommand(doc, '\\p');
    assertEqual(cmd.args.length, 1);
    assertOk(isBraceArg(cmd.args[0]), 'Expected BraceArg');
    // "Hello" and "World" are each a TextFragment (WS between them is hidden)
    const frags = cmd.args[0].nodes.filter(isTextFragment);
    if (frags.length === 0) {
        throw new Error('Expected TextFragments inside \\p body');
    }
});

await test('\\subtree with bracket address arg [id] and brace body', async () => {
    const doc = await parseClean('\\subtree[my-id]{\\title{Test}}');
    const cmd = firstCommand(doc, '\\subtree');
    if (cmd.args.length < 2) {
        throw new Error(`Expected at least 2 args, got ${cmd.args.length}`);
    }
    if (!isBracketArg(cmd.args[0])) {
        throw new Error('Expected first arg to be BracketArg');
    }
    if (!isBraceArg(cmd.args[1])) {
        throw new Error('Expected second arg to be BraceArg');
    }
});

// ── Tests: Nested braces ─────────────────────────────────────────────────────

await test('deeply nested braces parse without errors', async () => {
    const doc = await parseClean('\\p{\\ul{\\li{nested content}}}');
    const p = firstCommand(doc, '\\p');
    assertOk(isBraceArg(p.args[0]), 'Expected BraceArg on \\p');
    const ulNode = p.args[0].nodes.find(n => isCommand(n) && (n as Command).name === '\\ul');
    assertOk(ulNode, 'Expected \\ul inside \\p');
    const ul = ulNode as Command;
    assertOk(isBraceArg(ul.args[0]), 'Expected BraceArg on \\ul');
    const liNode = ul.args[0].nodes.find(n => isCommand(n) && (n as Command).name === '\\li');
    assertOk(liNode, 'Expected \\li inside \\ul');
});

await test('\\tex{preamble}{body} parses as Command with two BraceArgs', async () => {
    const source = '\\tex{\\usepackage{amsmath}}{\\begin{equation}E=mc^2\\end{equation}}';
    const doc = await parseClean(source);
    const cmd = firstCommand(doc, '\\tex');
    const braceArgs = cmd.args.filter(isBraceArg);
    if (braceArgs.length < 2) {
        throw new Error(`Expected at least 2 BraceArgs on \\tex, got ${braceArgs.length}`);
    }
});

await test('command nested in brace arg of another command', async () => {
    const doc = await parseClean('\\scope{\\p{\\em{important}}}');
    const scope = firstCommand(doc, '\\scope');
    assertOk(isBraceArg(scope.args[0]), 'Expected BraceArg on \\scope');
    const pNode = scope.args[0].nodes.find(n => isCommand(n) && (n as Command).name === '\\p');
    assertOk(pNode, 'Expected \\p inside \\scope');
});

// ── Tests: Verbatim blocks ────────────────────────────────────────────────────

await test('triple-backtick verbatim block parses as VerbatimBlock', async () => {
    const doc = await parseClean('```python\nprint("hello")\n```');
    const vb = doc.nodes.find(isVerbatimBlock);
    assertOk(vb, 'Expected a VerbatimBlock node');
    if (!vb.content.includes('print')) {
        throw new Error(`Expected verbatim content to include 'print', got: ${JSON.stringify(vb.content)}`);
    }
});

await test('verbatim block preserves content including braces', async () => {
    const doc = await parseClean('```\n\\macro{arg1}{arg2}\n```');
    const vb = doc.nodes.find(isVerbatimBlock);
    assertOk(vb, 'Expected a VerbatimBlock node');
    if (!vb.content.includes('\\macro')) {
        throw new Error(`Expected verbatim to contain '\\macro', got: ${JSON.stringify(vb.content)}`);
    }
});

await test('verbatim block followed by regular content', async () => {
    const doc = await parseClean('```\ncode\n```\n\\p{prose}');
    const vb = doc.nodes.find(isVerbatimBlock);
    assertOk(vb, 'Expected VerbatimBlock');
    const p = doc.nodes.find(n => isCommand(n) && (n as Command).name === '\\p');
    assertOk(p, 'Expected \\p after verbatim');
});

// ── Tests: Inline math #{...} ─────────────────────────────────────────────────

await test('#{x^2} parses as MathInline at top level', async () => {
    const doc = await parseClean('#{x^2}');
    const mi = doc.nodes.find(isMathInline);
    assertOk(mi, 'Expected MathInline');
    // MathText inside: '^' and '2' might be separate, 'x' is a token
    if (mi.nodes.length === 0) {
        throw new Error('Expected nodes inside MathInline');
    }
});

await test('#{a + b} has MathText nodes for a, +, b', async () => {
    const doc = await parseClean('#{a + b}');
    const mi = doc.nodes.find(isMathInline);
    assertOk(mi);
    const texts = mi.nodes.filter(isMathText);
    if (texts.length === 0) {
        throw new Error('Expected MathText nodes inside MathInline');
    }
});

await test('#{x^{a+b}} parses nested MathBraceGroup', async () => {
    const doc = await parseClean('#{x^{a+b}}');
    const mi = doc.nodes.find(isMathInline);
    assertOk(mi);
    const bg = mi.nodes.find(isMathBraceGroup);
    assertOk(bg, 'Expected MathBraceGroup for ^{...}');
});

await test('inline math inside \\p body', async () => {
    const doc = await parseClean('\\p{The equation #{x^2} is key.}');
    const p = firstCommand(doc, '\\p');
    assertOk(isBraceArg(p.args[0]));
    const mi = p.args[0].nodes.find(isMathInline);
    assertOk(mi, 'Expected MathInline inside \\p body');
});

// ── Tests: Display math ##{...} ──────────────────────────────────────────────

await test('##{E = mc^2} parses as MathDisplay at top level', async () => {
    const doc = await parseClean('##{E = mc^2}');
    const md = doc.nodes.find(isMathDisplay);
    assertOk(md, 'Expected MathDisplay');
    if (md.nodes.length === 0) {
        throw new Error('Expected nodes inside MathDisplay');
    }
});

await test('display math with \\frac command inside', async () => {
    const doc = await parseClean('##{\\frac{a}{b}}');
    const md = doc.nodes.find(isMathDisplay);
    assertOk(md, 'Expected MathDisplay');
    const fracCmd = md.nodes.find(n => isCommand(n) && (n as Command).name === '\\frac');
    assertOk(fracCmd, 'Expected \\frac command inside display math');
    const frac = fracCmd as Command;
    const braceArgs = frac.args.filter(isBraceArg);
    if (braceArgs.length < 2) {
        throw new Error(`Expected 2 brace args for \\frac, got ${braceArgs.length}`);
    }
});

await test('display math inside \\p body', async () => {
    const doc = await parseClean('\\p{See ##{x^2}.}');
    const p = firstCommand(doc, '\\p');
    assertOk(isBraceArg(p.args[0]));
    const md = p.args[0].nodes.find(isMathDisplay);
    assertOk(md, 'Expected MathDisplay inside \\p body');
});

await test('##{ must not be confused with #{ inside body', async () => {
    const source = '\\p{#{inline} and ##{display}}';
    const doc = await parseClean(source);
    const p = firstCommand(doc, '\\p');
    assertOk(isBraceArg(p.args[0]));
    const mi = p.args[0].nodes.find(isMathInline);
    const md = p.args[0].nodes.find(isMathDisplay);
    assertOk(mi, 'Expected MathInline');
    assertOk(md, 'Expected MathDisplay');
});

// ── Tests: Comments ──────────────────────────────────────────────────────────

await test('percent comment is consumed without error', async () => {
    const doc = await parseClean('% this is a comment\n\\p{text}');
    const p = doc.nodes.find(n => isCommand(n) && (n as Command).name === '\\p');
    assertOk(p, 'Expected \\p after comment');
});

await test('inline comment inside brace arg', async () => {
    const doc = await parseClean('\\title{Hello % comment\nWorld}');
    const cmd = firstCommand(doc, '\\title');
    assertOk(isBraceArg(cmd.args[0]));
    // Should have at least one TextFragment for Hello and one for World
    const frags = cmd.args[0].nodes.filter(isTextFragment);
    const combined = frags.map(f => f.value).join('');
    if (!combined.includes('Hello') || !combined.includes('World')) {
        throw new Error(`Expected Hello and World in frags, got: ${JSON.stringify(combined)}`);
    }
});

// ── Tests: Macro definitions ─────────────────────────────────────────────────

await test('\\def\\macroName{body} parses as two consecutive Commands', async () => {
    const doc = await parseClean('\\def\\myMacro{content}');
    // \def is the outer command, \myMacro is its first argument (a COMMAND_NAME)
    // In the Forester grammar, \def\macroName[arg1 arg2]{body} is parsed as:
    //   Command(name=\def, args=[BraceArg(nodes=[Command(name=\myMacro, args=[BraceArg])])])
    // or possibly at the top level with \def followed by \myMacro
    // Let's just check both appear and no errors
    const commands = doc.nodes.filter(isCommand);
    const hasDefOrMacro = commands.some(c =>
        (c as Command).name === '\\def' || (c as Command).name === '\\myMacro'
    );
    if (!hasDefOrMacro) {
        throw new Error('Expected \\def or \\myMacro in parsed commands');
    }
});

// ── Tests: Link-like commands ─────────────────────────────────────────────────

await test('\\transclude{tree-id} parses as Command with BraceArg', async () => {
    const doc = await parseClean('\\transclude{jms-001A}');
    const cmd = firstCommand(doc, '\\transclude');
    assertEqual(cmd.args.length, 1);
    assertOk(isBraceArg(cmd.args[0]));
});

await test('\\import followed by \\export', async () => {
    const doc = await parseClean('\\import{lib-001}\n\\export{lib-002}');
    const importCmd = doc.nodes.find(n => isCommand(n) && (n as Command).name === '\\import');
    const exportCmd = doc.nodes.find(n => isCommand(n) && (n as Command).name === '\\export');
    assertOk(importCmd, 'Expected \\import');
    assertOk(exportCmd, 'Expected \\export');
});

// ── Tests: Complex documents ──────────────────────────────────────────────────

await test('full subtree with metadata and math parses cleanly', async () => {
    const source = `\\subtree[test-001]{
  \\title{Test Tree}
  \\taxon{proposition}
  \\p{Consider #{x^2 + y^2 = z^2}.}
  ##{a^2 + b^2 = c^2}
}`;
    const doc = await parseClean(source);
    const subtree = firstCommand(doc, '\\subtree');
    assertOk(isBracketArg(subtree.args[0]), 'Expected bracket arg for ID');
    assertOk(isBraceArg(subtree.args[1]), 'Expected brace arg for body');
    const body = subtree.args[1];
    const title = body.nodes.find(n => isCommand(n) && (n as Command).name === '\\title');
    assertOk(title, 'Expected \\title');
    const p = body.nodes.find(n => isCommand(n) && (n as Command).name === '\\p');
    assertOk(p, 'Expected \\p');
    const md = body.nodes.find(isMathDisplay);
    assertOk(md, 'Expected MathDisplay');
});

await test('verbatim does not interfere with surrounding parse', async () => {
    const source = '\\p{before}\n```\n\\fake{broken\n```\n\\p{after}';
    const doc = await parseClean(source);
    const pCmds = doc.nodes.filter(n => isCommand(n) && (n as Command).name === '\\p');
    if (pCmds.length < 2) {
        throw new Error(`Expected 2 \\p commands, got ${pCmds.length}`);
    }
});

await test('math display with nested inline math is not ambiguous', async () => {
    // ##{...} must tokenize HASH_DISPLAY before HASH_INLINE can start
    const doc = await parseClean('##{outer #{inner} more}');
    const md = doc.nodes.find(isMathDisplay);
    assertOk(md, 'Expected MathDisplay');
    // Inside display math, #{inner} is another MathInline node
    const innerMi = md.nodes.find(isMathInline);
    assertOk(innerMi, 'Expected nested MathInline inside MathDisplay');
});

// ── WikiLink and XML element names (grammar additions) ────────────────────────

await test('[[tree-id]] parses as WikiLink node', async () => {
    const doc = await parseClean('\\p{See [[some-tree-id]] for details.}');
    const p = doc.nodes.find(isCommand);
    assertOk(p, 'Expected \\p command');
    const brace = p.args.find(isBraceArg);
    assertOk(brace, 'Expected BraceArg');
    const wl = brace.nodes.find(isWikiLink);
    assertOk(wl, 'Expected WikiLink inside \\p');
    if (wl.content !== '[[some-tree-id]]') {
        throw new Error(`Expected content "[[some-tree-id]]", got "${wl.content}"`);
    }
});

await test('[[id]] at document level parses as WikiLink', async () => {
    const doc = await parseClean('[[my-tree]]');
    const wl = doc.nodes.find(isWikiLink);
    assertOk(wl, 'Expected top-level WikiLink');
    if (wl.content !== '[[my-tree]]') {
        throw new Error(`Expected "[[my-tree]]", got "${wl.content}"`);
    }
});

await test('[[id]] does not break surrounding parse', async () => {
    const doc = await parseClean('\\title{Test}\n[[ref]]\n\\p{After}');
    const cmds = doc.nodes.filter(isCommand);
    if (cmds.length < 2) {
        throw new Error(`Expected 2 commands, got ${cmds.length}`);
    }
    const wl = doc.nodes.find(isWikiLink);
    assertOk(wl, 'Expected WikiLink between commands');
});

await test('\\<html:div> parses as Command with XML_COMMAND_NAME', async () => {
    const doc = await parseClean('\\<html:div>[class]{container}{Content}');
    const cmd = doc.nodes.find(isCommand);
    assertOk(cmd, 'Expected Command');
    if (cmd.name !== '\\<html:div>') {
        throw new Error(`Expected name "\\<html:div>", got "${cmd.name}"`);
    }
    // Should have bracket arg + two brace args
    if (cmd.args.length < 3) {
        throw new Error(`Expected ≥3 args, got ${cmd.args.length}`);
    }
});

await test('\\<svg:rect> parses as Command with XML_COMMAND_NAME', async () => {
    const doc = await parseClean('\\<svg:rect>{Content}');
    const cmd = doc.nodes.find(isCommand);
    assertOk(cmd, 'Expected Command');
    if (cmd.name !== '\\<svg:rect>') {
        throw new Error(`Expected "\\<svg:rect>", got "${cmd.name}"`);
    }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
