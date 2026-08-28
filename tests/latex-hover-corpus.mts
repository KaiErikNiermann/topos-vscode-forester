/**
 * latex-hover-corpus.mts — does the LaTeX hover actually render a real forest?
 *
 * Unit tests pin the pieces; only a whole forest tells you whether the pieces add up.
 * This walks every `.tree` in a forest, finds every span the hover would preview,
 * assembles the same standalone document the extension does, compiles it, and
 * classifies whatever fails.
 *
 * It found the two bugs the pieces could not: `\def\span` clobbering TeX's alignment
 * primitive (69 of 121 failures, none of them near a table), and math spans compiling
 * with no project preamble at all (43 more).
 *
 * NOT part of `pnpm test` — it needs a forest to point at, a TeX installation, and a
 * couple of minutes. Run it against a real forest when changing anything that reaches
 * the assembled document:
 *
 *   FOREST=~/notes pnpm run test:hover-corpus
 *
 * Environment: FOREST (required), MATH_CAP (math spans to compile, longest first; 0 =
 * all), CONCURRENCY, LIMIT, OUT (JSON report), HOVER_TEXINPUTS, DUMP + DUMP_LINE +
 * DUMP_OUT (write one span's .tex to disk to compile by hand).
 */
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
   buildLatexDocument,
   buildLatexMacroPreamble,
   buildRenderableLatexBody,
   collectDefinedStructuralPrimitives,
   extractLatexDefinedCommandNames,
   filterTopLevelPutAssignments,
   findFirstTexCommand,
   findForesterMacroCallAtOffset,
   parseForesterImports,
   parseForesterMacroDefinitions,
   parseForesterPutAssignments,
   resolveForesterPreamble,
   resolveProjectPreamble,
   substituteForesterMacroArgs,
   type ForesterMacroDefinition,
   type HoverTexSnippet,
} from '../src/latex-hover-core.js';

const FOREST = process.env.FOREST;
if (!FOREST) {
   console.error('Set FOREST to the root of a forest to check, e.g. FOREST=~/notes');
   process.exit(2);
}
const TREES = join(FOREST, 'trees');
const CONCURRENCY = Number(process.env.CONCURRENCY ?? '12');
const LIMIT = Number(process.env.LIMIT ?? '0');
const TEXINPUTS = process.env.HOVER_TEXINPUTS ?? '';

// ── Forest-wide macro/put context (the extension's buildMacroContext) ─────────

interface Parsed {
   imports: string[];
   macroDefinitions: ForesterMacroDefinition[];
   putAssignments: ReturnType<typeof parseForesterPutAssignments>;
}

const parsedCache = new Map<string, Parsed>();
const fileCache = new Map<string, string | null>();

async function readTree(id: string): Promise<string | null> {
   if (fileCache.has(id)) { return fileCache.get(id)!; }
   let out: string | null = null;
   for (const candidate of [join(TREES, `${id}.tree`), join(FOREST, `${id}.tree`)]) {
      try { out = await fs.readFile(candidate, 'utf8'); break; } catch { /* next */ }
   }
   fileCache.set(id, out);
   return out;
}

function parseContent(content: string): Parsed {
   const macroDefinitions = parseForesterMacroDefinitions(content);
   return {
      imports: parseForesterImports(content),
      macroDefinitions,
      putAssignments: filterTopLevelPutAssignments(parseForesterPutAssignments(content), macroDefinitions),
   };
}

function apply(parsed: Parsed, macros: Map<string, ForesterMacroDefinition>, puts: Map<string, string>): void {
   for (const m of parsed.macroDefinitions) { macros.set(m.name, m); }
   for (const a of parsed.putAssignments) {
      if (a.isDefault && puts.has(a.path)) { continue; }
      puts.set(a.path, a.value);
   }
}

async function visit(id: string, seen: Set<string>, macros: Map<string, ForesterMacroDefinition>, puts: Map<string, string>, depth: number): Promise<void> {
   if (depth >= 16 || seen.has(id)) { return; }
   seen.add(id);
   const text = await readTree(id);
   if (text === null) { return; }
   let parsed = parsedCache.get(id);
   if (!parsed) { parsed = parseContent(text); parsedCache.set(id, parsed); }
   for (const nested of parsed.imports) { await visit(nested, seen, macros, puts, depth + 1); }
   apply(parsed, macros, puts);
}

async function buildContext(sourceText: string): Promise<{ macros: Map<string, ForesterMacroDefinition>; puts: Map<string, string> }> {
   const macros = new Map<string, ForesterMacroDefinition>();
   const puts = new Map<string, string>();
   const current = parseContent(sourceText);
   const seen = new Set<string>();
   for (const imp of current.imports) { await visit(imp, seen, macros, puts, 0); }
   apply(current, macros, puts);
   return { macros, puts };
}

// ── Snippet extraction ───────────────────────────────────────────────────────

// Built by `pnpm run compile`; resolved from the repo root rather than from this
// bundle, whose location depends on how the script was invoked.
const hoverMod = await import(join(process.cwd(), 'out/language/hover-standalone.mjs'));
interface RawSnippet { kind: 'math-inline' | 'math-display' | 'tex'; start: number; end: number; body: string; preamble?: string }
const collectHoverSnippets = hoverMod.collectHoverSnippets as (text: string) => RawSnippet[];

interface Sample {
   file: string;
   line: number;
   kind: string;
   source: string;
   snippet: HoverTexSnippet;
   puts: ReadonlyMap<string, string>;
   macros: ReadonlyMap<string, ForesterMacroDefinition>;
}

/** Offsets at which a hover could plausibly be requested: every `#{`, `##{`, `\tex{`, and macro call with a raw group. */
function candidateOffsets(text: string): number[] {
   const offsets: number[] = [];
   const re = /\\[A-Za-z][A-Za-z0-9\-\/]*(?=\s*[{!])/g;
   let m: RegExpExecArray | null;
   while ((m = re.exec(text)) !== null) { offsets.push(m.index + 1); }
   return offsets;
}

function lineOf(text: string, offset: number): number {
   return text.slice(0, offset).split('\n').length;
}

async function samplesFor(file: string, text: string): Promise<Sample[]> {
   const { macros, puts } = await buildContext(text);
   const out: Sample[] = [];
   const covered: Array<[number, number]> = [];

   // One parse for every \tex-backed and math span in the file.
   for (const raw of collectHoverSnippets(text)) {
      const snippet: HoverTexSnippet = raw.kind === 'tex'
         ? { kind: 'tex', range: { start: raw.start, end: raw.end }, preamble: raw.preamble ?? '', body: raw.body }
         : { kind: raw.kind, range: { start: raw.start, end: raw.end }, body: raw.body };
      // A #{…} nested inside a \tex body is reached by the outer span's hover first.
      if (covered.some(([a, b]) => raw.start >= a && raw.end <= b)) { continue; }
      covered.push([raw.start, raw.end]);
      out.push({ file, line: lineOf(text, raw.start), kind: raw.kind, source: text.slice(raw.start, raw.end), snippet, puts, macros });
   }

   // The macro-call fallback: \texfig!{…}, \algo!{…}, \infrule{…} and friends are
   // ordinary user macros, invisible to the Langium collector.
   for (const offset of candidateOffsets(text)) {
      if (covered.some(([a, b]) => offset >= a && offset < b)) { continue; }
      const call = findForesterMacroCallAtOffset(text, offset, macros);
      if (!call) { continue; }
      const tpl = findFirstTexCommand(call.definition.body);
      if (!tpl) { continue; }
      if (covered.some(([a, b]) => call.range.start >= a && call.range.end <= b)) { continue; }

      const lp = new Map(puts);
      for (const a of parseForesterPutAssignments(call.definition.body)) {
         const value = substituteForesterMacroArgs(a.value, call.args);
         if (a.isDefault && lp.has(a.path)) { continue; }
         lp.set(a.path, value);
      }
      covered.push([call.range.start, call.range.end]);
      out.push({
         file, line: lineOf(text, call.range.start), kind: `macro:${call.name}`,
         source: text.slice(call.range.start, call.range.end),
         snippet: {
            kind: 'tex', range: call.range,
            preamble: substituteForesterMacroArgs(tpl.preamble, call.args),
            body: substituteForesterMacroArgs(tpl.body, call.args),
         },
         puts: lp, macros,
      });
   }

   return out.sort((a, b) => a.line - b.line);
}


// ── Compile ──────────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], cwd: string, input?: Buffer): Promise<{ code: number; stdout: string; stderr: string }> {
   return new Promise((resolve) => {
      const env = { ...process.env, ...(TEXINPUTS ? { TEXINPUTS } : {}) };
      const child = spawn(cmd, args, { cwd, stdio: 'pipe', env });
      const so: Buffer[] = []; const se: Buffer[] = [];
      child.stdout.on('data', (c) => so.push(c));
      child.stderr.on('data', (c) => se.push(c));
      child.on('error', () => resolve({ code: -1, stdout: '', stderr: 'spawn failed' }));
      const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: Buffer.concat(so).toString(), stderr: Buffer.concat(se).toString() }); });
      if (input) { child.stdin.write(input); }
      child.stdin.end();
   });
}

interface Result { sample: Sample; ok: boolean; cause: string; detail: string; }

function classify(log: string): { cause: string; detail: string } {
   const missingFile = /! LaTeX Error: File `([^']+)' not found/.exec(log);
   if (missingFile) { return { cause: 'missing-sty', detail: missingFile[1] }; }
   const undef = /! Undefined control sequence\.[\s\S]{0,400}?(\\[A-Za-z@]+)\s*$/m.exec(log);
   if (undef) { return { cause: 'undefined-command', detail: undef[1] }; }
   if (/! Undefined control sequence/.test(log)) {
      const m = /^l\.\d+[\s\S]{0,200}?(\\[A-Za-z@]+)\s*$/m.exec(log);
      return { cause: 'undefined-command', detail: m ? m[1] : '?' };
   }
   const env = /! LaTeX Error: Environment ([^ ]+) undefined/.exec(log);
   if (env) { return { cause: 'undefined-environment', detail: env[1] }; }
   const missingDollar = /! Missing \$ inserted/.exec(log);
   if (missingDollar) { return { cause: 'missing-dollar', detail: '' }; }
   const generic = /^! (.+)$/m.exec(log);
   return { cause: 'other', detail: generic ? generic[1].slice(0, 90) : 'unknown' };
}

async function compile(sample: Sample): Promise<Result> {
   const snippetPreamble = sample.snippet.kind === 'tex'
      ? resolveForesterPreamble(sample.snippet.preamble, sample.puts, sample.macros)
      : resolveProjectPreamble(sample.macros, sample.puts);
   const excluded = extractLatexDefinedCommandNames(snippetPreamble);
   const macroPreamble = buildLatexMacroPreamble(sample.macros.values(), excluded);
   const body = buildRenderableLatexBody(sample.snippet, collectDefinedStructuralPrimitives(sample.macros.values()));
   const source = buildLatexDocument({
      documentClass: 'standalone',
      documentClassOptions: ['preview', 'border=2pt'],
      macroPreamble, snippetPreamble, body,
      foregroundColor: 'black',
   });

   if (process.env.DUMP && sample.file.includes(process.env.DUMP) && String(sample.line) === (process.env.DUMP_LINE ?? String(sample.line))) {
      await fs.writeFile(process.env.DUMP_OUT ?? '/tmp/dump.tex', source, 'utf8');
      console.error(`dumped ${sample.file}:${sample.line}`);
   }
   const key = createHash('sha256').update(source).digest('hex').slice(0, 16);
   const dir = join(tmpdir(), 'forester-corpus', key);
   await fs.mkdir(dir, { recursive: true });
   try {
      await fs.writeFile(join(dir, 'job.tex'), source, 'utf8');
      const latex = await run('latex', ['-halt-on-error', '-interaction=nonstopmode', 'job.tex'], dir);
      if (latex.code !== 0) {
         let log = '';
         try { log = await fs.readFile(join(dir, 'job.log'), 'utf8'); } catch { log = latex.stdout; }
         const { cause, detail } = classify(log || latex.stdout);
         return { sample, ok: false, cause, detail };
      }
      const dvi = await fs.readFile(join(dir, 'job.dvi'));
      const svg = await run('dvisvgm', ['--exact', '--clipjoin', '--font-format=woff', '--zoom=1.3', '--stdin', '--stdout'], dir, dvi);
      if (svg.code !== 0 || svg.stdout.trim().length === 0) {
         return { sample, ok: false, cause: 'dvisvgm', detail: svg.stderr.split('\n').slice(0, 2).join(' ').slice(0, 120) };
      }
      return { sample, ok: true, cause: '', detail: '' };
   } finally {
      await fs.rm(dir, { recursive: true, force: true });
   }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function* walk(dir: string): AsyncGenerator<string> {
   for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { yield* walk(p); } else if (e.name.endsWith('.tree')) { yield p; }
   }
}

const files: string[] = [];
for await (const f of walk(TREES)) { files.push(f); }
files.sort();

const allSamples: Sample[] = [];
for (const f of files) {
   const text = await fs.readFile(f, 'utf8');
   try { allSamples.push(...await samplesFor(relative(FOREST, f), text)); }
   catch (e) { console.error(`extract failed ${f}: ${e}`); }
}

// Dedupe by exact source: a forest repeats `#{\\N}` hundreds of times and each
// repeat compiles to the same document, so one representative is the whole signal.
const bySource = new Map<string, Sample>();
for (const s of allSamples) { if (!bySource.has(s.source)) { bySource.set(s.source, s); } }
const unique = [...bySource.values()];

const MATH_CAP = Number(process.env.MATH_CAP ?? '0');
const texBacked = unique.filter(s => s.kind === 'tex' || s.kind.startsWith('macro:'));
const math = unique.filter(s => s.kind === 'math-inline' || s.kind === 'math-display');
// Longest math spans first: a one-symbol span exercises nothing the next does not.
math.sort((a, b) => b.source.length - a.source.length);
const picked = [...texBacked, ...(MATH_CAP > 0 ? math.slice(0, MATH_CAP) : math)];
const samples = LIMIT > 0 ? picked.slice(0, LIMIT) : picked;
console.error(`${allSamples.length} spans -> ${unique.length} unique (${texBacked.length} tex-backed, ${math.length} math)`);
console.error(`${files.length} trees, ${allSamples.length} spans, compiling ${samples.length} with TEXINPUTS=${TEXINPUTS || '(unset)'}`);

const results: Result[] = [];
let cursor = 0;
let done = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
   while (cursor < samples.length) {
      const i = cursor++;
      results.push(await compile(samples[i]!));
      done++;
      if (done % 50 === 0) { console.error(`  ${done}/${samples.length}`); }
   }
}));

await fs.writeFile(
   process.env.OUT ?? 'latex-hover-corpus.json',
   JSON.stringify(results.map(r => ({
      file: r.sample.file, line: r.sample.line, kind: r.sample.kind,
      ok: r.ok, cause: r.cause, detail: r.detail,
      source: r.sample.source.slice(0, 400),
   })), null, 2),
);

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} rendered (${((results.length - failed.length) / results.length * 100).toFixed(1)}%) ===\n`);
const byCause = new Map<string, Result[]>();
for (const r of failed) { (byCause.get(r.cause) ?? byCause.set(r.cause, []).get(r.cause)!).push(r); }
for (const [cause, rs] of [...byCause].sort((a, b) => b[1].length - a[1].length)) {
   const details = new Map<string, number>();
   for (const r of rs) { details.set(r.detail, (details.get(r.detail) ?? 0) + 1); }
   const top = [...details].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, n]) => `${d}×${n}`).join('  ');
   console.log(`${String(rs.length).padStart(4)}  ${cause.padEnd(22)} ${top}`);
}

