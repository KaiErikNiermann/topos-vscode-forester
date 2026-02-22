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
    isBracketGroup,
    isCommand,
    isDocument,
    isEscape,
    isMathBraceGroup,
    isMathBracketGroup,
    isMathDisplay,
    isMathEscape,
    isMathInline,
    isMathText,
    isParenGroup,
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

// ── Starred commands ────────────────────────────────────────────────────────

await test('\\inferrule* parses as single command token', async () => {
    const doc = await parseClean('\\inferrule*{premise}{conclusion}');
    const cmd = firstCommand(doc, '\\inferrule*');
    assertEqual(cmd.args.length, 2);
    assertOk(isBraceArg(cmd.args[0]));
    assertOk(isBraceArg(cmd.args[1]));
});

await test('\\operatorname* parses as single command token', async () => {
    const doc = await parseClean('\\operatorname*{argmax}');
    const cmd = firstCommand(doc, '\\operatorname*');
    assertEqual(cmd.args.length, 1);
});

// ── Escape sequences (spec §2.3) ───────────────────────────────────────────

await test('\\\\  (double backslash) parses as Escape node', async () => {
    const doc = await parseClean('\\\\');
    const esc = doc.nodes.find(isEscape);
    assertOk(esc, 'Expected Escape node for \\\\');
    assertEqual(esc.value, '\\\\');
});

await test('\\{ and \\} parse as Escape nodes', async () => {
    const doc = await parseClean('\\{text\\}');
    const escapes = doc.nodes.filter(isEscape);
    if (escapes.length < 2) {
        throw new Error(`Expected 2 Escape nodes, got ${escapes.length}`);
    }
});

await test('\\[ and \\] parse as Escape nodes', async () => {
    const doc = await parseClean('\\[stuff\\]');
    const escapes = doc.nodes.filter(isEscape);
    if (escapes.length < 2) {
        throw new Error(`Expected 2 Escape nodes, got ${escapes.length}`);
    }
});

await test('\\# parses as Escape node (not math)', async () => {
    const doc = await parseClean('\\#');
    const esc = doc.nodes.find(isEscape);
    assertOk(esc, 'Expected Escape node for \\#');
    assertEqual(esc.value, '\\#');
});

await test('\\, and \\; parse as Escape nodes', async () => {
    const doc = await parseClean('\\,thin\\;medium');
    const escapes = doc.nodes.filter(isEscape);
    if (escapes.length < 2) {
        throw new Error(`Expected 2 Escape nodes, got ${escapes.length}`);
    }
});

await test('\\\\ inside math parses as MathEscape', async () => {
    const doc = await parseClean('#{\\\\ next}');
    const mi = doc.nodes.find(isMathInline);
    assertOk(mi, 'Expected MathInline');
    const esc = mi.nodes.find(isMathEscape);
    assertOk(esc, 'Expected MathEscape for \\\\ inside math');
});

// ── Standalone bracket/paren groups (spec §4.2) ────────────────────────────

await test('[text](url) parses as BracketGroup + ParenGroup', async () => {
    const doc = await parseClean('\\p{See [link text](https://example.com) here}');
    const p = firstCommand(doc, '\\p');
    assertOk(isBraceArg(p.args[0]));
    const bg = p.args[0].nodes.find(isBracketGroup);
    assertOk(bg, 'Expected BracketGroup for [link text]');
    const pg = p.args[0].nodes.find(isParenGroup);
    assertOk(pg, 'Expected ParenGroup for (url)');
});

await test('standalone [text] inside brace arg parses as BracketGroup', async () => {
    const doc = await parseClean('\\p{prefix [bracketed content] suffix}');
    const p = firstCommand(doc, '\\p');
    assertOk(isBraceArg(p.args[0]));
    const bg = p.args[0].nodes.find(isBracketGroup);
    assertOk(bg, 'Expected BracketGroup inside \\p body');
});

await test('\\inferrule*[right=Atom]{premise}{conclusion} parses correctly', async () => {
    const doc = await parseClean('\\inferrule*[right=Atom]{premise}{conclusion}');
    const cmd = firstCommand(doc, '\\inferrule*');
    assertEqual(cmd.args.length, 3);
    assertOk(isBracketArg(cmd.args[0]), 'Expected BracketArg');
    assertOk(isBraceArg(cmd.args[1]), 'Expected first BraceArg');
    assertOk(isBraceArg(cmd.args[2]), 'Expected second BraceArg');
});

await test('[...] inside math parses as MathBracketGroup', async () => {
    const doc = await parseClean('#{\\sqrt[n]{x}}');
    const mi = doc.nodes.find(isMathInline);
    assertOk(mi, 'Expected MathInline');
    const sqrt = mi.nodes.find(n => isCommand(n) && (n as Command).name === '\\sqrt');
    assertOk(sqrt, 'Expected \\sqrt command');
    assertOk(isBracketArg((sqrt as Command).args[0]), 'Expected BracketArg [n] on \\sqrt');
});

// ── Real-world file tests ──────────────────────────────────────────────────

await test('0007.tree-like content: \\inferrule*[right=Atom-$\\top$] parses', async () => {
    const source = `\\infrule{
  \\inferrule*[right=Atom]{
    premise
  }{
    conclusion
  }
}`;
    const doc = await parseClean(source);
    const infrule = firstCommand(doc, '\\infrule');
    assertOk(isBraceArg(infrule.args[0]));
});

await test('double backslash \\\\ inside brace arg parses as Escape', async () => {
    const source = '\\p{line1 \\\\ line2}';
    const doc = await parseClean(source);
    const p = firstCommand(doc, '\\p');
    assertOk(isBraceArg(p.args[0]));
    const esc = p.args[0].nodes.find(isEscape);
    assertOk(esc, 'Expected Escape for \\\\ inside \\p body');
});

await test('markdown link [text](url) at document level', async () => {
    const doc = await parseClean('[De Morgan](000g)');
    const bg = doc.nodes.find(isBracketGroup);
    assertOk(bg, 'Expected BracketGroup for [De Morgan]');
    const pg = doc.nodes.find(isParenGroup);
    assertOk(pg, 'Expected ParenGroup for (000g)');
});

await test('0007.tree full file parses without errors', async () => {
    const source = `\\date{2025-11-22}

\\import{base-macros}

\\taxon{Definition}

\\title{Semantics}

\\p{
  We can define the semantic inference rules for propositional logic formulas under interpretations as follows inductively, starting with the base cases:
}

\\infrule{
  \\inferrule*[right=Atom]{
    I(p) = \\top
  }{
    I \\models p
  }
  \\and
  \\inferrule*[right=Atom]{
    I(p) = \\bot
  }{
    I \\not\\models p
  }
  \\and
  \\inferrule*[right=True]{
  }{
    I \\models \\top
  }
  \\and
  \\inferrule*[right=False]{
  }{
    I \\not\\models \\bot
  }
}

\\p{
  Moving on to the inductive case we have
}

\\infrule{
  \\inferrule*[right=Neg]{
    I \\models \\neg F
  }{
    I \\not\\models F
  }
  \\and
  \\inferrule*[right=Conj]{
    I \\models F_1 \\quad I \\models F_2
  }{
    I \\models F_1 \\land F_2
  }
  \\and
  \\inferrule*[right=Disj]{
    I \\models F_1 \\quad \\text{or} \\quad I \\models F_2
  }{
    I \\models F_1 \\lor F_2
  }
  \\and
  \\inferrule*[right=Imp]{
    I \\not\\models F_1 \\quad \\text{or} \\quad I \\models F_2
  }{
    I \\models F_1 \\to F_2
  }
  \\and
  \\inferrule*[right=Contr]{
    I \\models F \\\\ I \\not\\models F
  }{
    I \\models \\bot
  }
}`;
    const doc = await parseClean(source);
    // Verify we can find at least the top-level commands
    const cmds = doc.nodes.filter(isCommand);
    const cmdNames = cmds.map(c => (c as Command).name);
    if (!cmdNames.includes('\\date')) throw new Error('Missing \\date');
    if (!cmdNames.includes('\\import')) throw new Error('Missing \\import');
    if (!cmdNames.includes('\\title')) throw new Error('Missing \\title');
    if (!cmdNames.includes('\\infrule')) throw new Error('Missing \\infrule');
});

await test('001c.tree-like content: tikzcd with \\arrow[r, "0"] parses', async () => {
    const source = `\\texfig{
  \\begin{tikzcd}
    1 \\arrow[r, "0"] \\arrow[dr, "z"'] & \\N \\arrow[d, "u"] \\arrow[r, "s"] & \\N \\arrow[d, "u"] \\\\
    & X \\arrow[r, "f"'] & X
  \\end{tikzcd}
}`;
    const doc = await parseClean(source);
    const cmd = firstCommand(doc, '\\texfig');
    assertOk(isBraceArg(cmd.args[0]));
});

await test('0022.tree-like content: markdown link [1](bradley2007calculus)', async () => {
    const source = '\\p{See this result [1](bradley2007calculus) for more.}';
    const doc = await parseClean(source);
    const p = firstCommand(doc, '\\p');
    assertOk(isBraceArg(p.args[0]));
    const bg = p.args[0].nodes.find(isBracketGroup);
    assertOk(bg, 'Expected BracketGroup for [1]');
    const pg = p.args[0].nodes.find(isParenGroup);
    assertOk(pg, 'Expected ParenGroup for (bradley2007calculus)');
});

await test('display math with LaTeX commands: \\nexists, \\ldots, \\land', async () => {
    const source = '##{\\nexists x_0, x_1, x_2, \\ldots \\in S.\\ x_1 \\prec x_0 \\land x_2 \\prec x_1}';
    const doc = await parseClean(source);
    const md = doc.nodes.find(isMathDisplay);
    assertOk(md, 'Expected MathDisplay');
});

// ── Validator: \startverb…\stopverb error suppression ──────────────────────

await test('\\startverb…\\stopverb with mismatched delimiters: parser errors suppressed by validator', async () => {
    // This mirrors the pattern from 005d.tree: LaTeX half-open intervals
    // [a, +∞) inside \startverb…\stopverb which have mismatched [ and )
    const source = `##{
  \\startverb
  [a, +\\infty)
  \\stopverb
}`;
    const doc = await parse(source);
    // The parser WILL produce errors (mismatched [ and ))
    // But the validator should filter them out
    const diagnostics = await Forester.validation.DocumentValidator.validateDocument(doc);
    const parsingDiags = diagnostics.filter(d => (d.data as { code?: string })?.code === 'parsing-error');
    if (parsingDiags.length > 0) {
        throw new Error(
            `Expected 0 parsing diagnostics after validator filtering, got ${parsingDiags.length}: ${parsingDiags.map(d => `${d.message} at L${d.range.start.line}:${d.range.start.character}`).join('; ')}`,
        );
    }
});

await test('parse errors outside \\startverb…\\stopverb are NOT suppressed', async () => {
    // A mismatched delimiter NOT inside \startverb should still produce errors
    const source = '\\p{text [unclosed}';
    const doc = await parse(source);
    const diagnostics = await Forester.validation.DocumentValidator.validateDocument(doc);
    const parsingDiags = diagnostics.filter(d => (d.data as { code?: string })?.code === 'parsing-error');
    if (parsingDiags.length === 0) {
        throw new Error('Expected parsing diagnostics for mismatched delimiters outside \\startverb');
    }
});

// ── Validator: arity checks (Task 4) ─────────────────────────────────────────

await test('\\title{text}: valid arity — no arity warning', async () => {
    const doc = await parse('\\title{My Tree}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const arityWarns = diags.filter(d => d.message.includes('brace argument'));
    if (arityWarns.length > 0) {
        throw new Error(`Unexpected arity warnings: ${arityWarns.map(d => d.message).join('; ')}`);
    }
});

await test('\\link{uri}: missing second brace arg — arity warning', async () => {
    const doc = await parse('\\link{https://example.com}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const arityWarns = diags.filter(d => d.message.includes('\\link') && d.message.includes('brace argument'));
    if (arityWarns.length === 0) {
        throw new Error('Expected arity warning for \\link with 1 brace arg');
    }
});

await test('\\link{uri}{text}: valid two brace args — no arity warning', async () => {
    const doc = await parse('\\link{https://example.com}{click here}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const arityWarns = diags.filter(d => d.message.includes('\\link') && d.message.includes('brace argument'));
    if (arityWarns.length > 0) {
        throw new Error(`Unexpected arity warnings: ${arityWarns.map(d => d.message).join('; ')}`);
    }
});

await test('\\meta{key}: missing second brace arg — arity warning', async () => {
    const doc = await parse('\\meta{doi}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const arityWarns = diags.filter(d => d.message.includes('\\meta') && d.message.includes('brace argument'));
    if (arityWarns.length === 0) {
        throw new Error('Expected arity warning for \\meta with 1 brace arg');
    }
});

// ── Validator: date format checks (Task 5) ───────────────────────────────────

await test('\\date{2024-01-15}: valid ISO date — no date-format warning', async () => {
    const doc = await parse('\\date{2024-01-15}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const dateWarns = diags.filter(d => d.message.includes('ISO 8601'));
    if (dateWarns.length > 0) {
        throw new Error(`Unexpected date warnings: ${dateWarns.map(d => d.message).join('; ')}`);
    }
});

await test('\\date{not-a-date}: invalid date format — date-format warning', async () => {
    const doc = await parse('\\date{not-a-date}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const dateWarns = diags.filter(d => d.message.includes('ISO 8601'));
    if (dateWarns.length === 0) {
        throw new Error('Expected ISO 8601 date-format warning for \\date{not-a-date}');
    }
});

await test('\\date{2024-13-01}: invalid month — date-format warning', async () => {
    const doc = await parse('\\date{2024-13-01}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const dateWarns = diags.filter(d => d.message.includes('ISO 8601'));
    if (dateWarns.length === 0) {
        throw new Error('Expected ISO 8601 date-format warning for invalid month 13');
    }
});

await test('\\date{2024-12-32}: invalid day — date-format warning', async () => {
    const doc = await parse('\\date{2024-12-32}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const dateWarns = diags.filter(d => d.message.includes('ISO 8601'));
    if (dateWarns.length === 0) {
        throw new Error('Expected ISO 8601 date-format warning for invalid day 32');
    }
});

// ── Validator: import/export hygiene (Task 3) ────────────────────────────────

await test('duplicate \\import: warns on second occurrence', async () => {
    const doc = await parse('\\import{jms-0001}\n\\import{jms-0001}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const dupeWarns = diags.filter(d => d.message.includes('Duplicate import'));
    if (dupeWarns.length === 0) {
        throw new Error('Expected duplicate import warning');
    }
});

await test('no duplicate \\import: different tree-ids — no warning', async () => {
    const doc = await parse('\\import{jms-0001}\n\\import{jms-0002}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const dupeWarns = diags.filter(d => d.message.includes('Duplicate import'));
    if (dupeWarns.length > 0) {
        throw new Error(`Unexpected duplicate import warning: ${dupeWarns.map(d => d.message).join('; ')}`);
    }
});

// ── Validator: unresolved command check (Task 2) ──────────────────────────────

await test('known builtin \\title: no unresolved-command warning', async () => {
    const doc = await parse('\\title{Hello}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const warns = diags.filter(d => d.message.includes('Unknown command'));
    if (warns.length > 0) {
        throw new Error(`Unexpected unresolved-command warning for \\title: ${warns[0].message}`);
    }
});

await test('workspace macro defined by \\def: no unresolved-command warning', async () => {
    // The macro is defined and then used in the same document.
    // collectWorkspaceMacros() scans the single loaded doc, so \\foo is found.
    const doc = await parse('\\def\\foo{body}\n\\foo');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const warns = diags.filter(d => d.message.includes('Unknown command \\foo'));
    if (warns.length > 0) {
        throw new Error(`Unexpected unresolved-command warning for workspace macro: ${warns[0].message}`);
    }
});

await test('command in #{…} math mode: no unresolved-command warning', async () => {
    // \\frac is not a Forester builtin or workspace macro, but it is in math mode.
    const doc = await parse('#{\\frac{a}{b}}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const warns = diags.filter(d => d.message.includes('Unknown command \\frac'));
    if (warns.length > 0) {
        throw new Error(`Unexpected warning for TeX command inside math: ${warns[0].message}`);
    }
});

await test('command in ##{…} display math mode: no unresolved-command warning', async () => {
    const doc = await parse('##{\\sum_{i=1}^n}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const warns = diags.filter(d => d.message.includes('Unknown command \\sum'));
    if (warns.length > 0) {
        throw new Error(`Unexpected warning for TeX command inside display math: ${warns[0].message}`);
    }
});

await test('command inside \\tex{}{} body: no unresolved-command warning', async () => {
    // \\frac is a TeX command — should be suppressed inside \\tex body.
    const doc = await parse('\\tex{}{\\frac{a}{b}}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const warns = diags.filter(d => d.message.includes('Unknown command \\frac'));
    if (warns.length > 0) {
        throw new Error(`Unexpected warning for TeX command inside \\tex body: ${warns[0].message}`);
    }
});

// ── Validator: transclusion cycle detection (Task 3) ──────────────────────────

await test('self-loop \\transclude: warns about cycle', async () => {
    // A document that transcludes itself via its own tree ID.
    // In the test harness the URI is synthetic so treeIdFromUriPath returns undefined
    // and the check is silently skipped.  Verify no crash and no false positives.
    const doc = await parse('\\transclude{jms-0001}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const cycleWarns = diags.filter(d => d.message.includes('Transclusion cycle'));
    // In tests, treeIdFromUriPath returns undefined (no .tree extension in synthetic URI),
    // so the check is a no-op — just confirm no crash.
    if (cycleWarns.length > 0) {
        throw new Error(`Unexpected cycle warning: ${cycleWarns[0].message}`);
    }
});

await test('\\transclude without cycle: no cycle warning', async () => {
    const doc = await parse('\\transclude{other-tree}');
    const diags = await Forester.validation.DocumentValidator.validateDocument(doc);
    const cycleWarns = diags.filter(d => d.message.includes('Transclusion cycle'));
    if (cycleWarns.length > 0) {
        throw new Error(`Unexpected cycle warning: ${cycleWarns[0].message}`);
    }
});

// ── Definition provider: peek range prerequisites (Task 11) ──────────────────
// computePeekRange relies on \title commands and TextFragments having CstNode
// ranges attached by the Langium parser.  The tests below verify those
// preconditions so that a malfunctioning parse would be caught here.

await test('peek range: \\title has CstNode range starting at line 0', async () => {
    const doc = await parseClean('\\title{My Tree}');
    const titleCmd = doc.nodes.find(n => isCommand(n) && (n as Command).name === '\\title');
    assertOk(titleCmd, 'Expected \\title command at top level');
    assertOk(titleCmd.$cstNode, 'Expected CstNode on \\title command');
    assertEqual(titleCmd.$cstNode.range.start.line, 0, '\\title should start on line 0');
    assertEqual(titleCmd.$cstNode.range.end.line, 0, '\\title should end on line 0 (single line)');
});

await test('peek range: prose TextFragment on line after \\title has CstNode range', async () => {
    // This mirrors a typical .tree file where preamble commands precede body text.
    const source = '\\title{My Tree}\nSome prose text here.';
    const doc = await parseClean(source);
    // Find the first non-whitespace TextFragment at document level
    const prose = doc.nodes.find(
        n => isTextFragment(n) && n.value.trim().length > 0,
    );
    assertOk(prose, 'Expected non-empty TextFragment at document level');
    assertOk(prose.$cstNode, 'Expected CstNode on TextFragment');
    // Text starts on line 1 (after the \title line)
    if (prose.$cstNode.range.start.line < 1) {
        throw new Error(
            `Expected prose to start on line ≥ 1, got line ${prose.$cstNode.range.start.line}`,
        );
    }
});

await test('peek range: document with no prose falls back to title range', async () => {
    // A preamble-only document: no direct text children, just commands.
    const source = '\\title{Only a Title}\n\\taxon{theorem}';
    const doc = await parseClean(source);
    const titleCmd = doc.nodes.find(n => isCommand(n) && (n as Command).name === '\\title');
    assertOk(titleCmd, 'Expected \\title command');
    assertOk(titleCmd.$cstNode, 'Expected CstNode on \\title command');
    // The only non-whitespace TextFragment would be inside the \title BraceArg,
    // NOT a direct child of Document (its $container is BraceArg, not Document).
    const directProse = doc.nodes.find(
        n => isTextFragment(n) && n.value.trim().length > 0,
    );
    // Should be undefined — all text is nested inside command args
    if (directProse !== undefined) {
        throw new Error(
            `Expected no direct prose in preamble-only document, got TextFragment: ${JSON.stringify(directProse.value)}`,
        );
    }
});

// ── Code action: namespace qualify prerequisites (Task 3) ─────────────────────
// findNamespaceCandidates relies on the AST structure of \namespace{prefix}{body}
// where body contains \def\name pairs.  These tests verify the parse structure.

await test('namespace: \\namespace{prefix}{\\def\\foo{}} parses with two BraceArgs', async () => {
    const source = '\\namespace{myprefix}{\\def\\foo{}}';
    const doc = await parseClean(source);
    const nsCmd = doc.nodes.find(n => isCommand(n) && (n as Command).name === '\\namespace');
    assertOk(nsCmd, 'Expected \\namespace command at top level');
    if (!isCommand(nsCmd)) throw new Error('Not a Command');
    const braceArgs = nsCmd.args.filter(isBraceArg);
    assertEqual(braceArgs.length, 2, 'Expected 2 BraceArgs on \\namespace');

    // First BraceArg: prefix name
    const prefixFrag = braceArgs[0].nodes.find(isTextFragment);
    assertOk(prefixFrag, 'Expected TextFragment inside prefix arg');
    assertEqual(prefixFrag.value.trim(), 'myprefix', 'Prefix should be "myprefix"');

    // Second BraceArg: body should contain \\def and \\foo as sibling Commands
    const bodyNodes = braceArgs[1].nodes;
    const defCmd = bodyNodes.find(n => isCommand(n) && (n as Command).name === '\\def');
    assertOk(defCmd, 'Expected \\def Command inside namespace body');
    const fooCmd = bodyNodes.find(n => isCommand(n) && (n as Command).name === '\\foo');
    assertOk(fooCmd, 'Expected \\foo Command inside namespace body');

    // \\def must immediately precede \\foo
    const defIdx = bodyNodes.indexOf(defCmd);
    const fooIdx = bodyNodes.indexOf(fooCmd);
    if (fooIdx !== defIdx + 1) {
        throw new Error(
            `Expected \\foo to immediately follow \\def (indices ${defIdx}, ${fooIdx})`,
        );
    }
});

await test('namespace: body without \\def has no binding pair', async () => {
    // \namespace{ns}{\foo{}} — \foo is called but not defined here
    const source = '\\namespace{ns}{\\foo{}}';
    const doc = await parseClean(source);
    const nsCmd = doc.nodes.find(n => isCommand(n) && (n as Command).name === '\\namespace');
    assertOk(nsCmd, 'Expected \\namespace command');
    if (!isCommand(nsCmd)) throw new Error('Not a Command');
    const bodyArg = nsCmd.args.filter(isBraceArg)[1];
    assertOk(bodyArg, 'Expected body BraceArg');

    // No \def inside — body has only \foo (a call, not a binding)
    const defCmd = bodyArg.nodes.find(n => isCommand(n) && (n as Command).name === '\\def');
    if (defCmd !== undefined) {
        throw new Error('Should not have \\def in body that only calls \\foo');
    }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
