/**
 * Go-to-definition tests, driven through the language server over stdio.
 *
 * At the LSP level on purpose: the Langium provider is now the *only* path for
 * macro navigation (the regex scan in extension.ts that used to shadow it is
 * gone), and what matters is what VS Code receives on a ctrl+click — including
 * that the workspace scan finds a binding in a file nobody opened.
 *
 * Run with: pnpm run test:langium-definition   (compiles first)
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER = path.resolve(
   path.dirname(fileURLToPath(import.meta.url)),
   '..',
   'out',
   'language',
   'main.js',
);

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

function assertEqual(actual: unknown, expected: unknown, msg?: string): void {
   if (actual !== expected) {
      throw new Error(
         `${msg ? msg + '\n' : ''}Expected: ${JSON.stringify(expected)}\nActual  : ${JSON.stringify(actual)}`,
      );
   }
}

// ── LSP client ───────────────────────────────────────────────────────────────

interface DefinitionLink { targetUri: string; targetSelectionRange: { start: { line: number } } }

class Server {
   #child: ChildProcessByStdio<Writable, Readable, null>;
   #id = 0;
   #pending = new Map<number, (body: { result?: unknown }) => void>();
   #buf = Buffer.alloc(0);

   constructor() {
      this.#child = spawn(process.execPath, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
      this.#child.stdout.on('data', (chunk: Buffer) => this.#onData(chunk));
   }

   #onData(chunk: Buffer): void {
      this.#buf = Buffer.concat([this.#buf, chunk]);
      for (;;) {
         const sep = this.#buf.indexOf('\r\n\r\n');
         if (sep === -1) { return; }
         const header = this.#buf.subarray(0, sep).toString();
         const match = /Content-Length: (\d+)/i.exec(header);
         if (!match) { return; }
         const len = Number(match[1]);
         if (this.#buf.length < sep + 4 + len) { return; }
         const body = JSON.parse(this.#buf.subarray(sep + 4, sep + 4 + len).toString()) as {
            id?: number;
            result?: unknown;
         };
         this.#buf = this.#buf.subarray(sep + 4 + len);
         const resolve = body.id === undefined ? undefined : this.#pending.get(body.id);
         if (resolve && body.id !== undefined) {
            this.#pending.delete(body.id);
            resolve(body);
         }
      }
   }

   #send(msg: Record<string, unknown>): void {
      const s = JSON.stringify({ jsonrpc: '2.0', ...msg });
      this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
   }

   request(method: string, params: unknown): Promise<{ result?: unknown }> {
      const id = ++this.#id;
      return new Promise((resolve) => {
         this.#pending.set(id, resolve);
         this.#send({ id, method, params });
      });
   }

   notify(method: string, params: unknown): void {
      this.#send({ method, params });
   }

   stop(): void {
      this.#child.kill();
   }
}

/** Boot a server over a throwaway workspace of `files`, and open `entry` in it. */
async function withWorkspace(
   files: Record<string, string>,
   entry: string,
): Promise<{ server: Server; entryUri: string; uriOf: (name: string) => string }> {
   const root = await mkdtemp(path.join(tmpdir(), 'forester-def-'));
   await Promise.all(
      Object.entries(files).map(async ([name, text]) => writeFile(path.join(root, name), text, 'utf8')),
   );
   const uriOf = (name: string): string => pathToFileURL(path.join(root, name)).toString();

   const server = new Server();
   await server.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(root).toString(),
      workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: 'forest' }],
      capabilities: {},
   });
   server.notify('initialized', {});
   server.notify('textDocument/didOpen', {
      textDocument: { uri: uriOf(entry), languageId: 'forester', version: 1, text: files[entry] },
   });
   // Let the workspace scan and the initial build settle.
   await new Promise((r) => setTimeout(r, 1500));
   return { server, entryUri: uriOf(entry), uriOf };
}

/** Definitions offered at the first occurrence of `needle` in `text`. */
async function definitionsAt(
   server: Server,
   uri: string,
   text: string,
   needle: string,
): Promise<DefinitionLink[]> {
   const offset = text.indexOf(needle);
   if (offset === -1) { throw new Error(`needle not present: ${needle}`); }
   const before = text.slice(0, offset);
   const line = before.split('\n').length - 1;
   const character = offset - (before.lastIndexOf('\n') + 1) + 1; // inside the name
   const { result } = await server.request('textDocument/definition', {
      textDocument: { uri },
      position: { line, character },
   });
   return (result ?? []) as DefinitionLink[];
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== Langium Go-to-Definition Tests ===\n');

{
   // The reported bug: a TikZ `\def\st` inside `\texfig!{…}` used to be offered
   // alongside — and ahead of — the forest's own binding.
   const macros = '\\def\\st{#{\\ \\textrm{such that}\\ }}\n';
   const figure = [
      '\\subtree[00I5]{',
      '  \\texfig!{',
      '    \\ifnum\\i=3\\relax\\def\\st{pick}\\else\\def\\st{skip}\\fi',
      '  }',
      '}',
      '',
   ].join('\n');
   const use = '\\p{X \\st Y}\n';

   const { server, entryUri, uriOf } = await withWorkspace(
      { 'base-macros.tree': macros, '00I4.tree': figure, '006O.tree': use },
      '006O.tree',
   );

   await test('a macro call resolves to its \\def, in a file that was never opened', async () => {
      const links = await definitionsAt(server, entryUri, use, '\\st Y');
      assertEqual(links.length, 1, 'expected exactly one definition');
      assertEqual(links[0]?.targetUri, uriOf('base-macros.tree'));
   });

   await test('a \\def inside \\texfig!{…} is not a binding site', async () => {
      const links = await definitionsAt(server, entryUri, use, '\\st Y');
      const fromFigure = links.filter((l) => l.targetUri === uriOf('00I4.tree'));
      assertEqual(fromFigure.length, 0, 'the figure-internal \\def\\st leaked into the results');
   });

   server.stop();
}

{
   // \alloc binds a name the same way \def does; the regex scanner that used to
   // cover it is gone, so the AST path has to.
   const macros = ['\\alloc\\base/tex-preamble', '\\put?\\base/tex-preamble{\\usepackage{amsmath}}', ''].join('\n');
   const use = '\\p{\\figure{\\tex{\\get\\base/tex-preamble}{x}}}\n';

   const { server, entryUri, uriOf } = await withWorkspace(
      { 'base-macros.tree': macros, '006O.tree': use },
      '006O.tree',
   );

   await test('an \\alloc-bound name resolves to its \\alloc', async () => {
      const links = await definitionsAt(server, entryUri, use, '\\base/tex-preamble}{x}');
      assertEqual(links.length > 0, true, 'no definition offered for an \\alloc-bound name');
      assertEqual(links[0]?.targetUri, uriOf('base-macros.tree'));
      assertEqual(links[0]?.targetSelectionRange.start.line, 0, 'should point at the \\alloc line');
   });

   server.stop();
}

{
   const source = '\\texfig!{\\def\\onlyHere{x} \\onlyHere}\n';
   const { server, entryUri } = await withWorkspace({ '006O.tree': source }, '006O.tree');

   await test('nothing resolves from inside a raw group — its body is not forester', async () => {
      const links = await definitionsAt(server, entryUri, source, '\\onlyHere}');
      assertEqual(links.length, 0, 'a raw-group body should offer no navigation');
   });

   server.stop();
}

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
   process.exitCode = 1;
}
