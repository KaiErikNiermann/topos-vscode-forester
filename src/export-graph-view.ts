/**
 * `forester.exportGraphView` — produce a standalone, self-contained graph-view
 * artifact from the current workspace.
 *
 * What it does:
 *   1. Prompts the user for an output folder.
 *   2. Runs `buildGraph()` against the active forest (same call the webview
 *      makes) → `data.json`.
 *   3. Copies the bundled renderer + extractor + manifest out of the .vsix
 *      install path (`<extensionUri>/dist/graph-view/`).
 *   4. Writes a tiny shell `index.html` that mounts the renderer with a
 *      neutral default theme and reads `?focus=` from the URL.
 *
 * Output shape mirrors the artifact format that `dist/graph-view/` ships in,
 * with an extra `index.html` + `data.json`. Consumers who already have a
 * site wrapper (e.g. the notes-site `graph-vendor` stage with
 * `GRAPH_VIEW_SOURCE`) can ignore the `index.html` and use the rest verbatim.
 *
 * No terminal, no pnpm — this is the marketplace user's path to a static
 * graph view of their forest.
 */
import { promises as fsp } from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { buildGraph } from "@forester/graph-data";

import { getForest } from "./get-forest";

const BUNDLED_ARTIFACT_REL = "dist/graph-view";

const ARTIFACT_FILES: ReadonlyArray<string> = [
    "graph.js",
    "graph.css",
    "extract",
    "default-theme.js",
    "manifest.json",
    "README.md",
];

const SHELL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Forest Graph</title>
  <link rel="stylesheet" href="graph.css">
  <style>
    html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: #0f1117; color: #f4f6ff; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    #graph-root { width: 100%; height: 100vh; position: relative; }
  </style>
</head>
<body>
  <main id="graph-root"></main>
  <script src="graph.js"></script>
  <script type="module">
    import { defaultTheme } from './default-theme.js';
    const url = new URL(window.location.href);
    const focus = url.searchParams.get('focus') || undefined;
    const data = await fetch('data.json').then(r => r.json());
    window.ForesterGraphView.mountGraph({
      container: document.getElementById('graph-root'),
      data,
      theme: defaultTheme,
      focus,
      onNodeClick: (node) => {
        // Default behavior: copy the node's id. Override by editing this file.
        if (navigator.clipboard) navigator.clipboard.writeText(node.id);
      },
    });
  </script>
</body>
</html>
`;

export async function exportGraphView(context: vscode.ExtensionContext): Promise<void> {
    // 1. Pick output folder.
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Export graph view here",
        title: "Choose a folder for the graph view artifact",
    });
    if (!picked || picked.length === 0) { return; }
    const outDir = picked[0].fsPath;

    // 2. Confirm overwrite if the folder is non-empty.
    let existing: string[] = [];
    try {
        existing = await fsp.readdir(outDir);
    } catch {
        // dir doesn't exist yet — fine
    }
    const conflict = existing.filter((n) =>
        n === "index.html" || n === "data.json" || ARTIFACT_FILES.includes(n)
    );
    if (conflict.length > 0) {
        const choice = await vscode.window.showWarningMessage(
            `${outDir} already contains graph view files (${conflict.join(", ")}). Overwrite?`,
            { modal: true },
            "Overwrite",
        );
        if (choice !== "Overwrite") { return; }
    }

    // 3. Run the extraction + copy under a progress indicator.
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Exporting Forest Graph",
            cancellable: false,
        },
        async (progress) => {
            progress.report({ message: "Reading forest…" });
            const forest = await getForest({ fastReturnStale: false });
            const excluded = vscode.workspace
                .getConfiguration("forester")
                .get<string[]>("graphView.excludedNodes", ["basic-macros"]);

            progress.report({ message: "Building graph…" });
            const graph = await buildGraph(forest, { excludedNodes: excluded });

            progress.report({ message: "Writing artifact…" });
            await fsp.mkdir(outDir, { recursive: true });

            // Copy each bundled file from <extensionPath>/dist/graph-view/ into outDir.
            const artifactSrc = path.join(context.extensionPath, BUNDLED_ARTIFACT_REL);
            for (const name of ARTIFACT_FILES) {
                const src = path.join(artifactSrc, name);
                const dst = path.join(outDir, name);
                try {
                    await fsp.copyFile(src, dst);
                    if (name === "extract") {
                        // Preserve executable bit (lost on some filesystems / Windows).
                        try { await fsp.chmod(dst, 0o755); } catch { /* ignore */ }
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    throw new Error(
                        `Failed to copy ${name} from ${src}: ${msg}.\n` +
                        `The extension's bundled artifact may be missing. ` +
                        `If you built this extension from source, run \`pnpm run build:graph-view\` ` +
                        `to produce dist/graph-view/.`
                    );
                }
            }

            // Write data.json + index.html (the things bespoke to this user's forest).
            await fsp.writeFile(
                path.join(outDir, "data.json"),
                JSON.stringify(graph, null, 2),
                "utf-8",
            );
            await fsp.writeFile(path.join(outDir, "index.html"), SHELL_HTML, "utf-8");
        },
    );

    // 4. Success — surface a notification with reveal actions.
    const openInBrowser = "Open index.html";
    const reveal = "Reveal in OS";
    const choice = await vscode.window.showInformationMessage(
        `Graph view exported to ${outDir}`,
        openInBrowser,
        reveal,
    );
    if (choice === reveal) {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outDir));
    } else if (choice === openInBrowser) {
        await vscode.env.openExternal(vscode.Uri.file(path.join(outDir, "index.html")));
    }
}
