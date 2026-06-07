/**
 * sig-registry.ts — project-local `%! sig` macro signatures, discovered from the
 * workspace `.tree` files and cached. Invalidated whenever the forest changes
 * (onForestChange already watches `.tree`/`forest.toml`). Discovery uses
 * findFiles (not the forest tree-list) so macro-only files like base-macros.tree
 * — which have no uri and may be absent from the forest — are still scanned.
 */
import * as vscode from 'vscode';
import { parseMacroSigs, type Sig } from './language/sig.js';
import { onForestChange } from './get-forest.js';

let cache: Map<string, Sig> | null = null;
let invalidator: vscode.Disposable | null = null;

/** All custom-construct signatures declared in the workspace, keyed by command. */
export async function getProjectSigs(): Promise<Map<string, Sig>> {
    if (!invalidator) { invalidator = onForestChange(() => { cache = null; }); }
    if (cache) { return cache; }
    const merged = new Map<string, Sig>();
    let files: vscode.Uri[] = [];
    try {
        files = await vscode.workspace.findFiles('**/*.tree', '**/node_modules/**');
    } catch { /* no workspace */ }
    await Promise.all(files.map(async (uri) => {
        try {
            const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
            if (!text.includes('%! sig')) { return; } // substring pre-filter: skip the vast majority
            for (const [cmd, sig] of parseMacroSigs(text)) { merged.set(cmd, sig); }
        } catch { /* unreadable — skip */ }
    }));
    cache = merged;
    return cache;
}
