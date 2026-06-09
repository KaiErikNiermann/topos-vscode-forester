/**
 * sig-inlay.ts — clangd-style parameter-name inlay hints for sig-typed commands.
 *
 * Renders the parameter name inside each positional brace of a command that has a
 * `%! sig` (or builtin) parameter list — `\embed{opts: …}{target: …}{caption: …}` —
 * so the role of each brace is apparent without hovering the command. Runs on the
 * CLIENT (not the LSP server) because the parameter list comes from getProjectSigs,
 * which discovers project `%! sig`s via the workspace API. Coexists with the LSP
 * tag-closure inlay hints (VS Code merges providers).
 */
import * as vscode from 'vscode';
import { getProjectSigs } from './sig-registry.js';
import { BUILTIN_PARAMS } from './language/command-metadata.js';
import { collectParamNameHints, type NamedParam } from './sig-inlay-core.js';
import { onForestChange } from './get-forest.js';

const ENABLED_SETTING = 'inlayHints.paramNames.enabled';

class SigInlayHintsProvider implements vscode.InlayHintsProvider {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeInlayHints = this.changeEmitter.event;

    public refresh(): void { this.changeEmitter.fire(); }
    public dispose(): void { this.changeEmitter.dispose(); }

    public async provideInlayHints(
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken,
    ): Promise<vscode.InlayHint[]> {
        const config = vscode.workspace.getConfiguration('forester', document.uri);
        if (!config.get<boolean>(ENABLED_SETTING, true)) { return []; }

        const sigs = await getProjectSigs();
        if (token.isCancellationRequested) { return []; }

        // Project sigs win over builtins of the same name (project may override).
        const params = new Map<string, readonly NamedParam[]>();
        for (const [command, params_] of BUILTIN_PARAMS) { params.set(command, params_); }
        for (const [command, sig] of sigs) { params.set(command, sig.params); }

        const startOffset = document.offsetAt(range.start);
        const endOffset = document.offsetAt(range.end);

        return collectParamNameHints(document.getText(), params)
            .filter(h => h.offset >= startOffset && h.offset <= endOffset)
            .map(h => {
                const hint = new vscode.InlayHint(document.positionAt(h.offset), h.label, vscode.InlayHintKind.Parameter);
                hint.paddingRight = true; // `{opts: image}` rather than `{opts:image}`
                return hint;
            });
    }
}

export function registerSigInlayHints(context: vscode.ExtensionContext): void {
    const provider = new SigInlayHintsProvider();
    context.subscriptions.push(
        vscode.languages.registerInlayHintsProvider({ scheme: 'file', language: 'forester' }, provider),
        // New/edited `%! sig`s change what gets hinted — refresh when the forest does.
        onForestChange(() => provider.refresh()),
        provider,
    );
}
