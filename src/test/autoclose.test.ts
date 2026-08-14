/**
 * Auto-closing behaviour, driven through a real VS Code editor.
 *
 * These assertions are about what the editor does with a keystroke, which is
 * monaco's business and not something the extension can compute — so they run
 * in an extension host and type for real. That matters here more than usual:
 * the pairing of \{ with \} has been added, removed, guarded and re-added four
 * times since March, each time reasoned from a guess about monaco's internals,
 * and each round traded one of these cases for the other.
 *
 * The two that must hold at once:
 *   typing \{ produces \{\}                    — an escape closes as an escape
 *   typing \{ before a } leaves that } alone   — the math block keeps its closer
 *
 * Run with: pnpm run test:vscode
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

const CURSOR = '|';

interface TypeResult {
    text: string;
    /** Text of every content change, to show how the editor grouped its edits. */
    changes: string[];
}

/**
 * Type `keys` into a document whose initial content is `spec` with the cursor
 * written as `|`, and return the resulting text with the cursor marked again.
 */
async function type(spec: string, ...keys: string[]): Promise<TypeResult> {
    const cursorOffset = spec.indexOf(CURSOR);
    assert.ok(cursorOffset >= 0, `Spec must mark the cursor with ${CURSOR}: ${spec}`);
    const content = spec.replace(CURSOR, '');

    const document = await vscode.workspace.openTextDocument({ language: 'forester', content });
    const editor = await vscode.window.showTextDocument(document);

    // Auto-closing consults the tokenizer, and bails out when tokenization of
    // the line is not yet cheap — so give the grammar a moment to land, or the
    // tests measure a race rather than the configuration.
    await new Promise(resolve => setTimeout(resolve, 250));

    const position = document.positionAt(cursorOffset);
    editor.selection = new vscode.Selection(position, position);

    const changes: string[] = [];
    const subscription = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === document) {
            changes.push(...event.contentChanges.map(change => change.text));
        }
    });

    for (const key of keys) {
        await vscode.commands.executeCommand('type', { text: key });
    }

    // Closing \{ with \} is an edit the extension applies in response to the
    // editor's own auto-close, so it lands a turn later. A real keystroke has
    // the same shape; only a test is fast enough to read the buffer in between.
    await new Promise(resolve => setTimeout(resolve, 250));
    subscription.dispose();

    const text = document.getText();
    const caret = document.offsetAt(editor.selection.active);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    return { text: text.slice(0, caret) + CURSOR + text.slice(caret), changes };
}

function assertTyping(actual: TypeResult, expected: string, what: string): void {
    assert.strictEqual(
        actual.text,
        expected,
        `${what}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual.text)}` +
        `\n  edits:    ${JSON.stringify(actual.changes)}`,
    );
}

suite('auto-closing', () => {

    // Closing \{ with \} is the extension's job (see escape-brace-autoclose.ts),
    // so the extension has to be running. Nothing here opens a workspace, and
    // the activation events are all workspaceContains, so ask directly.
    suiteSetup(async function () {
        this.timeout(60_000);
        const extension = vscode.extensions.getExtension('KaiErikNiermann.forest-keeper');
        assert.ok(extension, 'Extension KaiErikNiermann.forest-keeper not found in the test host');
        await extension.activate();
    });

    // ── \{ closes as an escape, not as a bare brace ──────────────────────────

    test('\\{ in inline math closes with \\}', async () => {
        assertTyping(
            await type('#{ | }', '\\', '{'),
            '#{ \\{|\\} }',
            'Typing \\{ inside inline math should close the escape with \\}',
        );
    });

    test('\\{ in prose closes with \\}', async () => {
        assertTyping(
            await type('\\p{ | }', '\\', '{'),
            '\\p{ \\{|\\} }',
            'Typing \\{ in prose should close the escape with \\}',
        );
    });

    // ── …without eating the brace that closes the math block ─────────────────

    test('\\{ against the closer of block math leaves it alone', async () => {
        assertTyping(
            await type('##{|}', '\\', '{'),
            '##{\\{|\\}}',
            'The } of ##{…} must survive: it closes the block, it is not the tail of an escape',
        );
    });

    test('\\{ against the closer of inline math leaves it alone', async () => {
        assertTyping(
            await type('#{|}', '\\', '{'),
            '#{\\{|\\}}',
            'The } of #{…} must survive',
        );
    });

    test('\\{ against a command brace leaves it alone', async () => {
        assertTyping(
            await type('\\p{|}', '\\', '{'),
            '\\p{\\{|\\}}',
            'The } of \\p{…} must survive',
        );
    });

    // ── Brackets close before whitespace, as they do everywhere else ─────────

    test('[ in inline math closes with ]', async () => {
        assertTyping(
            await type('#{ | }', '['),
            '#{ [|] }',
            'Typing [ inside inline math should auto-close',
        );
    });

    test('[ at end of line closes with ]', async () => {
        assertTyping(await type('#{ |', '['), '#{ [|]', 'Typing [ at end of line should auto-close');
    });

    test('( in inline math closes with )', async () => {
        assertTyping(await type('#{ | }', '('), '#{ (|) }', 'Typing ( inside inline math should auto-close');
    });

    // ── The plain brace pair still behaves ───────────────────────────────────

    test('a bare { still closes with }', async () => {
        assertTyping(await type('\\p| ', '{'), '\\p{|} ', 'Typing { after a command should auto-close with }');
    });

    test('{ before the closer of a group closes with }', async () => {
        assertTyping(await type('\\p{|}', '{'), '\\p{{|}}', 'A nested { must not consume the outer }');
    });

    test('a brace after an escaped backslash closes with a plain }', async () => {
        // `\\` is an escaped backslash, so the brace after it opens a group and
        // is not itself escaped. Only an odd run of backslashes makes an escape.
        assertTyping(
            await type('a\\\\| ', '{'),
            'a\\\\{|} ',
            'After \\\\ the brace is structural, so it must not close with \\}',
        );
    });
});
