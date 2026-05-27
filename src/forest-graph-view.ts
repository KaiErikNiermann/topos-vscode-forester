/**
 * Forest graph view — VS Code host adapter.
 *
 * The actual D3 renderer and graph-data extractor live in two sibling
 * packages (graph-view/ and forester-graph/) that together form the
 * publishable artifact also consumed by the notes-site at
 * /home/appulsauce/Projects/notes.
 *
 * This adapter is intentionally thin: it
 *   1) Owns the WebviewPanel lifecycle.
 *   2) Calls into the extractor (with the extension's cached getForest).
 *   3) Bridges --vscode-* theme variables into the renderer's Theme object.
 *   4) Wires node clicks to `vscode.commands.executeCommand('vscode.open', …)`.
 *   5) Forwards active-editor changes as renderer focus updates.
 */
import * as path from "path";
import * as vscode from "vscode";

import { buildGraph } from "@forester/graph-data";
import type { GraphData, Theme } from "@forester/graph-view/types";
import { defaultTheme } from "@forester/graph-view/default-theme";

import { getForest, onForestChange } from "./get-forest";

// Inlined at build time (esbuild text loader). The source file lives under
// `src/**` which is excluded from the .vsix, so loading it from disk at
// runtime would fail in marketplace installs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RENDERER_CSS: string = require("../graph-view/src/renderer.css");

const RENDERER_DIST = "graph-view/dist/graph.js";

export class ForestGraphView {
    public static readonly viewType = "forester.forestGraph";
    private static currentPanel: ForestGraphView | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _disposables: vscode.Disposable[] = [];
    private _initialized = false;
    private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

    public static createOrShow(extensionUri: vscode.Uri): void {
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;

        if (ForestGraphView.currentPanel) {
            ForestGraphView.currentPanel._panel.reveal(column);
            void ForestGraphView.currentPanel._update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ForestGraphView.viewType,
            "Forest Graph",
            column,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            },
        );

        ForestGraphView.currentPanel = new ForestGraphView(panel, extensionUri);
    }

    public dispose(): void {
        ForestGraphView.currentPanel = undefined;
        if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
        this._panel.dispose();
        for (const d of this._disposables) { d.dispose(); }
        this._disposables.length = 0;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        void this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            (msg: { type: string; sourcePath?: string }) => {
                if (msg.type === "openFile" && msg.sourcePath) {
                    void vscode.commands.executeCommand(
                        "vscode.open",
                        vscode.Uri.file(msg.sourcePath),
                    );
                }
            },
            null,
            this._disposables,
        );

        this._disposables.push(
            onForestChange(() => {
                if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
                this._debounceTimer = setTimeout(() => void this._update(), 300);
            }),
            vscode.window.onDidChangeActiveTextEditor(() => this._sendFocus()),
        );
    }

    private _sendFocus(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor?.document.fileName.endsWith(".tree")) { return; }
        const treeId = path.basename(editor.document.fileName, ".tree");
        this._panel.webview.postMessage({ type: "focus", treeId });
    }

    private async _buildGraphData(): Promise<GraphData> {
        const forest = await getForest({ fastReturnStale: true });
        const excluded = vscode.workspace
            .getConfiguration("forester")
            .get<string[]>("graphView.excludedNodes", ["basic-macros"]);
        return buildGraph(forest, { excludedNodes: excluded });
    }

    private async _update(): Promise<void> {
        const data = await this._buildGraphData();
        if (!this._initialized) {
            this._panel.webview.html = this._getHtml(data);
            this._initialized = true;
            setTimeout(() => this._sendFocus(), 300);
        } else {
            this._panel.webview.postMessage({ type: "updateData", data });
            setTimeout(() => this._sendFocus(), 100);
        }
    }

    private _getHtml(data: GraphData): string {
        const nonce = getNonce();
        const webview = this._panel.webview;

        const rendererJsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, ...RENDERER_DIST.split("/")),
        );

        // Replace '</' to prevent early </script> tag termination.
        const graphJson = JSON.stringify(data).replace(/<\//g, "<\\/");
        const themeJson = JSON.stringify(buildVscodeTheme()).replace(/<\//g, "<\\/");
        const cspSource = webview.cspSource;

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src 'nonce-${nonce}' ${cspSource};
                 style-src 'nonce-${nonce}' ${cspSource} 'unsafe-inline';">
  <title>Forest Graph</title>
  <style nonce="${nonce}">
    html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; }
    #graph-root { width: 100%; height: 100%; }
${RENDERER_CSS}
  </style>
</head>
<body>
  <div id="graph-root"></div>
  <script nonce="${nonce}" src="${rendererJsUri}"></script>
  <script nonce="${nonce}">
    (function () {
      'use strict';
      const vscode = acquireVsCodeApi();
      const root = document.getElementById('graph-root');
      const initialData = ${graphJson};
      const theme = ${themeJson};

      const handle = ForesterGraphView.mountGraph({
        container: root,
        data: initialData,
        theme: theme,
        onNodeClick: (n) => {
          vscode.postMessage({ type: 'openFile', sourcePath: n.sourcePath });
        },
      });

      window.addEventListener('message', (ev) => {
        const msg = ev.data;
        if (msg.type === 'focus') {
          handle.setFocus(msg.treeId);
        } else if (msg.type === 'updateData') {
          handle.update(msg.data);
        } else if (msg.type === 'theme') {
          handle.setTheme(msg.theme);
        }
      });
    }());
  </script>
</body>
</html>`;
    }
}

// ── Theme bridge ──────────────────────────────────────────────────────────────

/**
 * Build a renderer `Theme` from VS Code's color scheme. We can't read
 * `--vscode-*` CSS variables from the extension host (they only exist inside
 * the webview), so we pull from the active `vscode.ColorTheme` and
 * `vscode.window.activeColorTheme` and use sensible fallbacks for things
 * that aren't exposed via the public API.
 */
function buildVscodeTheme(): Theme {
    const kind = vscode.window.activeColorTheme.kind;
    const isDark =
        kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;

    // Only minimal substitutions here; the renderer's CSS variables also
    // cascade from a theme.palette so node colors stay correct.
    return {
        ...defaultTheme,
        palette: {
            ...defaultTheme.palette,
            background: isDark ? "#1e1e1e" : "#ffffff",
            foreground: isDark ? "#cccccc" : "#1b1b21",
            muted: isDark ? "#888888" : "#666666",
            highlight: isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.06)",
            hover: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
        },
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from(
        { length: 32 },
        () => chars[Math.floor(Math.random() * chars.length)],
    ).join("");
}
