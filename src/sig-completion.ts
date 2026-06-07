/**
 * sig-completion.ts — parameter-value completion driven by `%! sig` signatures.
 * Generalizes the old hard-coded `\taxon{…}` provider to ANY command: inside a
 * command's first brace arg (the high-value position — codeblock language, d3
 * figure, embed opts) it offers the param's enum / dynamic value set; inside an
 * `opts: flags{…}` arg it offers the mode bareword, flag keys, and flag values.
 *
 * Dynamic value sources (`@language @figure @taxon @tree-id`) are resolved from
 * the workspace; `@artifact-ref`/`@bib-ref` are left to a later pass.
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

/** Resolve a dynamic `@source` to its value set (workspace-derived where applicable). */
async function resolveDynamic(source: string): Promise<readonly string[]> {
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
        default: return []; // @artifact-ref / @bib-ref — later
    }
}

/** Values to suggest for a param kind (enum literals or a resolved dynamic set). */
async function valuesFor(kind: ParamKind): Promise<readonly string[]> {
    if (kind.tag === 'enum') { return kind.values; }
    if (kind.tag === 'dynamic') { return resolveDynamic(kind.source); }
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

// Completion inside an `opts: flags{…}` first arg: mode bareword, flag keys, values.
async function flagCompletions(
    fields: readonly import('./language/sig.js').FlagField[],
    typed: string,
    pos: vscode.Position,
): Promise<vscode.CompletionItem[]> {
    const valueMatch = /(\w+)=(\S*)$/.exec(typed);
    if (valueMatch) {
        const field = fields.find(f => f.name === valueMatch[1]);
        if (!field) { return []; }
        const vals = await valuesFor(field.kind);
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

export function registerSigCompletion(context: vscode.ExtensionContext): void {
    const provider = vscode.languages.registerCompletionItemProvider(
        { scheme: 'file', language: 'forester' },
        {
            async provideCompletionItems(doc, pos) {
                const line = doc.getText(new vscode.Range(new vscode.Position(pos.line, 0), pos));
                // \command{<typed-so-far>  — the first brace arg (no nested braces yet)
                const m = /\\(\w+)\{([^{}]*)$/.exec(line);
                if (!m) { return []; }
                const param = (await paramsFor(`\\${m[1]}`))?.[0];
                if (!param) { return []; }
                const typed = m[2] ?? '';
                if (param.kind.tag === 'flags') { return flagCompletions(param.kind.fields, typed, pos); }
                const vals = await valuesFor(param.kind);
                if (vals.length === 0) { return []; }
                const word = /(\S*)$/.exec(typed)?.[1] ?? '';
                return items(vals, new vscode.Range(pos.translate(0, -word.length), pos), param.name);
            },
        },
        '{', '=', ' ',
    );
    context.subscriptions.push(provider);
}
