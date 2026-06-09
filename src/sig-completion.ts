/**
 * sig-completion.ts — parameter-value completion driven by `%! sig` signatures.
 * Generalizes the old hard-coded `\taxon{…}` provider to ANY command: inside a
 * command's first brace arg (the high-value position — codeblock language, d3
 * figure, embed opts) it offers the param's enum / dynamic value set; inside an
 * `opts: flags{…}` arg it offers the mode bareword, flag keys, and flag values.
 *
 * Dynamic value sources (`@language @figure @taxon @tree-id @artifact-ref
 * @bib-ref`) are all resolved from the workspace / current tree.
 */
import * as vscode from 'vscode';
import type { ParamKind, Param } from './language/sig.js';
import { getProjectSigs } from './sig-registry.js';
import { BUILTIN_PARAMS, DEFAULT_TAXONS } from './language/command-metadata.js';
import { getForest } from './get-forest.js';

// A reasonable code-language set for `@language` (highlight.js common aliases).
const LANGUAGES = [
    'lean', 'typescript', 'ts', 'javascript', 'js', 'python', 'py', 'bash', 'sh',
    'json', 'yaml', 'toml', 'xml', 'html', 'css', 'scss', 'rust', 'go', 'c', 'cpp',
    'java', 'haskell', 'ocaml', 'sql', 'markdown', 'latex', 'plaintext',
];

/** Parameters for a command: project `%! sig` first, then builtin metadata. */
async function paramsFor(command: string): Promise<readonly Param[] | undefined> {
    return (await getProjectSigs()).get(command)?.params ?? BUILTIN_PARAMS.get(command);
}

/**
 * Artifact keys an `\embed` target can reference, declared in THIS tree as
 * `\meta{artifact-file:KEY}{…}` (the per-tree artifact index — artifacts don't
 * cross trees, so we scan the current document only). Returns the `#artifact:KEY`
 * forms an embed target actually takes.
 */
function artifactRefs(doc: vscode.TextDocument): string[] {
    const re = /\\meta\s*\{\s*artifact-file:([^{}]+?)\s*\}/g;
    const keys = new Set<string>();
    for (const m of doc.getText().matchAll(re)) { keys.add(`#artifact:${m[1]!.trim()}`); }
    return [...keys];
}

/** Resolve a dynamic `@source` to its value set (workspace-derived where applicable). */
async function resolveDynamic(source: string, doc?: vscode.TextDocument): Promise<readonly string[]> {
    switch (source) {
        case 'language': return LANGUAGES;
        case 'figure': {
            const files = await vscode.workspace.findFiles('**/figures/*.ts', '**/node_modules/**');
            return files
                .map(u => u.path.split('/').pop() ?? '')
                .filter(n => n.endsWith('.ts') && !n.endsWith('.d.ts'))
                .map(n => n.slice(0, -3));
        }
        case 'taxon': {
            const forest = await getForest({ fastReturnStale: true });
            return [...new Set([...DEFAULT_TAXONS, ...forest.map(t => t.taxon).filter((t): t is string => !!t)])];
        }
        case 'tree-id': {
            const forest = await getForest({ fastReturnStale: true });
            return forest.map(t => t.uri).filter(Boolean);
        }
        case 'artifact-ref': return doc ? artifactRefs(doc) : [];
        case 'bib-ref': {
            // Citations target reference trees (`\cite{tree-id}`), which the forest
            // marks with the `Reference` taxon — offer those ids.
            const forest = await getForest({ fastReturnStale: true });
            return forest.filter(t => t.taxon?.toLowerCase() === 'reference').map(t => t.uri).filter(Boolean);
        }
        default: return [];
    }
}

/** Values to suggest for a param kind (enum literals or a resolved dynamic set). */
async function valuesFor(kind: ParamKind, doc?: vscode.TextDocument): Promise<readonly string[]> {
    if (kind.tag === 'enum') { return kind.values; }
    if (kind.tag === 'dynamic') { return resolveDynamic(kind.source, doc); }
    return [];
}

function items(values: readonly string[], range: vscode.Range, kindLabel: string): vscode.CompletionItem[] {
    return values.map((v, i) => {
        const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember);
        item.range = range;
        item.detail = kindLabel;
        item.sortText = String(i).padStart(4, '0');
        return item;
    });
}

// Completion inside an `opts: flags{…}` arg: mode bareword, flag keys, values.
async function flagCompletions(
    fields: readonly import('./language/sig.js').FlagField[],
    typed: string,
    pos: vscode.Position,
    doc: vscode.TextDocument,
): Promise<vscode.CompletionItem[]> {
    const valueMatch = /(\w+)=(\S*)$/.exec(typed);
    if (valueMatch) {
        const field = fields.find(f => f.name === valueMatch[1]);
        if (!field) { return []; }
        const vals = await valuesFor(field.kind, doc);
        const start = pos.translate(0, -(valueMatch[2]?.length ?? 0));
        return items(vals, new vscode.Range(start, pos), `${valueMatch[1]} value`);
    }
    // bareword → the positional (mode) enum + the other flags' keys as `key=`
    const word = /(\S*)$/.exec(typed)?.[1] ?? '';
    const range = new vscode.Range(pos.translate(0, -word.length), pos);
    const out: vscode.CompletionItem[] = [];
    const positional = fields[0];
    if (positional && positional.kind.tag === 'enum') { out.push(...items(positional.kind.values, range, positional.name)); }
    for (const f of fields.slice(1)) {
        const item = new vscode.CompletionItem(`${f.name}=`, vscode.CompletionItemKind.Field);
        item.range = range;
        item.detail = f.optional ? 'optional flag' : 'flag';
        out.push(item);
    }
    return out;
}

function formatKind(kind: ParamKind): string {
    switch (kind.tag) {
        case 'enum': return kind.values.join('|');
        case 'dynamic': return `@${kind.source}`;
        case 'flags': return `flags{${kind.fields.map(f => `${f.name}${f.optional ? '?' : ''}: ${formatKind(f.kind)}`).join(', ')}}`;
        default: return kind.tag;
    }
}

/** Hover over a `\command` with a `%! sig` → show its signature + allowed values. */
export function registerSigHover(context: vscode.ExtensionContext): void {
    const provider = vscode.languages.registerHoverProvider(
        { scheme: 'file', language: 'forester' },
        {
            async provideHover(doc, pos) {
                const range = doc.getWordRangeAtPosition(pos, /\\[A-Za-z]\w*/);
                if (!range) { return undefined; }
                const cmd = doc.getText(range);
                const params = await paramsFor(cmd);
                if (!params) { return undefined; }
                const md = new vscode.MarkdownString();
                md.appendCodeblock(`${cmd}(${params.map(p => `${p.name}${p.optional ? '?' : ''}: ${formatKind(p.kind)}`).join(', ')})`, 'forester');
                return new vscode.Hover(md, range);
            },
        },
    );
    context.subscriptions.push(provider);
}

/**
 * Locate the `\command` and 0-based brace-arg index the cursor sits in, plus the
 * text typed so far in that arg. Walks left from the cursor: the cursor must be
 * inside an unmatched `{`; preceding balanced `{…}`/`[…]`/`(…)` groups are earlier
 * args. Only BRACE groups advance the param index, matching how `%! sig` params map
 * positionally onto a macro's brace binders (so e.g. `\embed{opts}{target}` →
 * target is arg index 1).
 */
function argContext(line: string): { command: string; argIndex: number; typed: string } | null {
    // The brace we're typing in = the last unmatched '{' to the cursor's left.
    let depth = 0;
    let open = -1;
    for (let i = line.length - 1; i >= 0; i--) {
        const ch = line[i];
        if (ch === '}') { depth++; }
        else if (ch === '{') { if (depth === 0) { open = i; break; } depth--; }
    }
    if (open === -1) { return null; }
    const typed = line.slice(open + 1);

    // Walk left over earlier args to find the owning command and count brace args.
    let i = open - 1;
    let argIndex = 0;
    for (;;) {
        while (i >= 0 && /\s/.test(line[i]!)) { i--; }
        if (i < 0) { return null; }
        const ch = line[i]!;
        if (ch === '}' || ch === ']' || ch === ')') {
            const openCh = ch === '}' ? '{' : ch === ']' ? '[' : '(';
            let d = 0;
            while (i >= 0) {
                if (line[i] === ch) { d++; }
                else if (line[i] === openCh) { d--; if (d === 0) { i--; break; } }
                i--;
            }
            if (ch === '}') { argIndex++; } // only brace args carry positional params
            continue;
        }
        break;
    }
    const cm = /\\(\w+)$/.exec(line.slice(0, i + 1));
    return cm ? { command: `\\${cm[1]}`, argIndex, typed } : null;
}

export function registerSigCompletion(context: vscode.ExtensionContext): void {
    const provider = vscode.languages.registerCompletionItemProvider(
        { scheme: 'file', language: 'forester' },
        {
            async provideCompletionItems(doc, pos) {
                const line = doc.getText(new vscode.Range(new vscode.Position(pos.line, 0), pos));
                const ctx = argContext(line);
                if (!ctx) { return []; }
                const param = (await paramsFor(ctx.command))?.[ctx.argIndex];
                if (!param) { return []; }
                if (param.kind.tag === 'flags') { return flagCompletions(param.kind.fields, ctx.typed, pos, doc); }
                const vals = await valuesFor(param.kind, doc);
                if (vals.length === 0) { return []; }
                const word = /(\S*)$/.exec(ctx.typed)?.[1] ?? '';
                return items(vals, new vscode.Range(pos.translate(0, -word.length), pos), param.name);
            },
        },
        '{', '=', ' ', '#', ':',
    );
    context.subscriptions.push(provider);
}
