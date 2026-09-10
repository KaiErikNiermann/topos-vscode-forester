import * as vscode from "vscode";
import * as path from "path";
import { TextDecoder } from "util";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient/node";

import { Forest, cleanupServer, getForest, onForestChange, initForestMonitoring, getTree, initStatusBar, getForestStatus } from "./get-forest";
import { getRoot, getAvailableTemplates } from "./utils";
import { transcludeNewTree, renameTreeCommand, newTree } from "./edit-forest";
import { ForesterWebviewProvider } from "./forestStructureView";
import { TranscludeDecorationProvider } from "./transclude-decorations";
import { ForesterDocumentFormattingEditProvider, ForesterDocumentRangeFormattingEditProvider, formatAllTreeFiles } from "./formatter";
import { initFormatterConfig, scanMacrosCommand, refreshIgnoredCommandsCache, clearIgnoredCommandsCache } from "./formatter-config";
import { initLanguageToolBridge, checkAllTreeFilesCommand } from "./languageToolIntegration";
import { registerSpeedFixCommand } from "./speedfix";
import { registerSigCompletion, registerSigHover } from "./sig-completion";
import { registerSigInlayHints } from "./sig-inlay";
import { EscapeBraceAutoCloseFeature } from "./escape-brace-autoclose";
import { SubtreeAutoIdFeature } from "./subtree-auto-id";
import { ForesterLatexHoverService } from "./latex-hover";
import { findVerbatimSpans, isInSpans } from "./raw-group";
import {
   initLinkAliasConfig,
   buildAutocompleteRegex,
   buildDefinitionRegex,
   getTriggerCharacters,
   createDefaultConfigFile,
   openConfigFile,
   addLinkPatternCommand,
   removeLinkPatternCommand,
} from "./link-aliases-config";
import { ForestGraphView } from "./forest-graph-view";
import { exportGraphView } from "./export-graph-view";
import { TransclusionTreeProvider } from "./transclusion-tree-view";
import { BacklinksTreeProvider } from "./backlinks-view";
import { ContributorsTreeProvider } from "./contributors-view";
import { evalDatalogQuery } from "./datalog-query-runner";
import { initForesterDiagnostics } from "./forester-diagnostics";
import { findSubtreeDeclaration, mayContainSubtree } from "./subtree-location-core";

const textDecoder = new TextDecoder("utf-8");

let langiumClient: LanguageClient | undefined;

function suggest(trees: Forest, range: vscode.Range) {
   var results: vscode.CompletionItem[] = [];
   const config = vscode.workspace.getConfiguration("forester");
   const showID = config.get("completion.showID") ?? false;
   for (const entry of trees) {
      let { uri: id, title, taxon } = entry;
      let item = new vscode.CompletionItem(
         {
            label: title === null ? `[${id}]` : showID ? `[${id}] ${title}` : title,
            description: taxon ?? "",
         },
         vscode.CompletionItemKind.Value,
      );
      item.range = range;
      item.insertText = id;
      item.filterText = `${id} ${title ?? ""} ${taxon ?? ""}`;
      item.detail = `${taxon ?? "Tree"} [${id}]`;
      item.documentation = title ?? undefined;
      results.push(item);
   }
   return results;
}

async function findInlineSubtreeLocation(
   treeId: string,
   sourcePath?: string,
): Promise<vscode.Location | undefined> {
   const locate = async (file: vscode.Uri): Promise<vscode.Location | undefined> => {
      let content: string;
      try {
         content = textDecoder.decode(await vscode.workspace.fs.readFile(file));
      } catch {
         return undefined;
      }
      if (!mayContainSubtree(content, treeId)) {
         return undefined;
      }
      const declaration = findSubtreeDeclaration(content, treeId);
      if (!declaration) {
         return undefined;
      }
      return new vscode.Location(
         file,
         new vscode.Range(
            new vscode.Position(declaration.start.line, declaration.start.character),
            new vscode.Position(declaration.end.line, declaration.end.character),
         ),
      );
   };

   if (sourcePath) {
      const absolute = path.isAbsolute(sourcePath)
         ? sourcePath
         : path.join(getRoot().fsPath, sourcePath);
      const hit = await locate(vscode.Uri.file(absolute));
      if (hit) {
         return hit;
      }
   }

   const treeFiles = await vscode.workspace.findFiles("**/*.tree", "**/node_modules/**");
   const BATCH = 32;
   for (let start = 0; start < treeFiles.length; start += BATCH) {
      const batch = treeFiles.slice(start, start + BATCH);
      const hits = await Promise.all(batch.map(locate));
      const hit = hits.find((location) => location !== undefined);
      if (hit) {
         return hit;
      }
   }

   return undefined;
}

/**
 * Macro go-to-definition lives in the Langium server (forester-definition-provider),
 * not here. It resolves `\def` / `\let` / `\alloc` binding sites from the parsed
 * AST over every indexed workspace document, which means it gets for free what a
 * regex scan over raw text has to be told: `RAW_GROUP` and `VERBATIM_SPAN` are
 * opaque terminals, so a `\def\st{pick}` inside a `\texfig!{…}` is TeX and never
 * becomes a binding. It also reads a slash-bearing name like `\base/tex-preamble`
 * as one command rather than stopping at the slash. The scan that used to live
 * here duplicated every real hit it found.
 */

export async function activate(context: vscode.ExtensionContext) {
   // Set context for conditional visibility - extension only activates when Forester files exist
   vscode.commands.executeCommand('setContext', 'workspaceHasForesterFiles', true);

   // ── Langium language server (LSP client) ──────────────────────────────────
   const serverModule = context.asAbsolutePath(path.join('out', 'language', 'main.js'));
   const serverOptions: ServerOptions = {
      run:   { module: serverModule, transport: TransportKind.ipc },
      debug: { module: serverModule, transport: TransportKind.ipc,
               options: { execArgv: ['--nolazy', '--inspect=6009'] } },
   };
   const clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: 'file', language: 'forester' }],
   };
   langiumClient = new LanguageClient('foresterLangServer', 'Forester Language Server', serverOptions, clientOptions);
   langiumClient.start();
   context.subscriptions.push(langiumClient);

   // Register the WebView tree provider
   const webviewProvider = new ForesterWebviewProvider(context.extensionUri, context);

   context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
         ForesterWebviewProvider.viewType,
         webviewProvider,
         { webviewOptions: { retainContextWhenHidden: true } }
      )
   );

   // Register for forest changes to refresh tree view
   context.subscriptions.push(
      onForestChange(() => {
         webviewProvider.refresh();
      })
   );

   // ── Transclusion Tree View (native VS Code TreeView) ──────────────────────
   const transclusionProvider = new TransclusionTreeProvider();
   context.subscriptions.push(
      vscode.window.createTreeView('foresterTransclusionView', {
         treeDataProvider: transclusionProvider,
         showCollapseAll: true,
      }),
      // Refresh whenever the active editor changes
      vscode.window.onDidChangeActiveTextEditor(editor => {
         void transclusionProvider.update(editor?.document);
      }),
   );
   // Populate immediately for the current editor
   void transclusionProvider.update(vscode.window.activeTextEditor?.document);

   // ── Backlinks View (native VS Code TreeView) ──────────────────────────────
   const backlinksProvider = new BacklinksTreeProvider();
   context.subscriptions.push(
      vscode.window.createTreeView('foresterBacklinksView', {
         treeDataProvider: backlinksProvider,
         showCollapseAll: true,
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
         void backlinksProvider.update(editor?.document);
      }),
   );
   void backlinksProvider.update(vscode.window.activeTextEditor?.document);

   // ── Contributors View (native VS Code TreeView) ───────────────────────────
   const contributorsProvider = new ContributorsTreeProvider();
   context.subscriptions.push(
      vscode.window.createTreeView('foresterContributorsView', {
         treeDataProvider: contributorsProvider,
         showCollapseAll: true,
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
         void contributorsProvider.update(editor?.document);
      }),
   );
   void contributorsProvider.update(vscode.window.activeTextEditor?.document);

   // Track pinned state for context
   vscode.commands.executeCommand('setContext', 'foresterTreeViewPinned', false);

   // Initialize formatter config and scan for macros
   await initFormatterConfig();
   await refreshIgnoredCommandsCache();
   await initLanguageToolBridge(context);

   new SubtreeAutoIdFeature().activate(context);
   new EscapeBraceAutoCloseFeature().activate(context);

   // Watch for configuration changes to refresh the ignored commands cache
   context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
         if (e.affectsConfiguration("forester.formatter")) {
            clearIgnoredCommandsCache();
            refreshIgnoredCommandsCache();
         }
      })
   );

   // Register tree commands
   context.subscriptions.push(
      vscode.commands.registerCommand(
         "forester.scanMacros",
         async () => {
            await scanMacrosCommand();
            await refreshIgnoredCommandsCache();
         }
      ),
      vscode.commands.registerCommand(
         "forester.checkAllTreeFiles",
         checkAllTreeFilesCommand
      ),
      ...registerSpeedFixCommand(context),
      vscode.commands.registerCommand(
         "forester.formatAllTrees",
         formatAllTreeFiles
      ),
      vscode.commands.registerCommand(
         "forester.newTree",
         (folder?: vscode.Uri) => newTree(folder, false)
      ),
      vscode.commands.registerCommand(
         "forester.newFromTemplate",
         (folder?: vscode.Uri) => newTree(folder, true)
      ),
      vscode.commands.registerCommand(
         "forester.transcludeNewTree",
         transcludeNewTree
      ),
      vscode.commands.registerCommand(
         "forester.renameTree",
         renameTreeCommand
      ),
      vscode.commands.registerCommand(
         "forester.setDefaultPrefix",
         async () => {
            const config = vscode.workspace.getConfiguration("forester");
            const currentPrefix = config.get<string>("defaultPrefix") || "";

            const newPrefix = await vscode.window.showInputBox({
               prompt: "Enter the default prefix for new trees",
               placeHolder: "e.g., jms, ssl, djm",
               value: currentPrefix,
               validateInput: (value) => {
                  if (!value) {
                     return "Prefix cannot be empty";
                  }
                  if (!/^[a-zA-Z0-9-]+$/.test(value)) {
                     return "Prefix should only contain letters, numbers, and hyphens";
                  }
                  return null;
               }
            });

            if (newPrefix) {
               await config.update("defaultPrefix", newPrefix, vscode.ConfigurationTarget.Workspace);
               vscode.window.showInformationMessage(`Default prefix set to: ${newPrefix}`);
            }
         }
      ),
      vscode.commands.registerCommand(
         "forester.setDefaultTemplate",
         async () => {
            const config = vscode.workspace.getConfiguration("forester");
            const templates = await getAvailableTemplates();

            const newTemplate = await vscode.window.showQuickPick(templates, {
               placeHolder: "Choose default template for new trees",
               canPickMany: false
            });

            if (newTemplate !== undefined) {
               await config.update("defaultTemplate", newTemplate, vscode.ConfigurationTarget.Workspace);
               vscode.window.showInformationMessage(`Default template set to: ${newTemplate}`);
            }
         }
      ),
      vscode.commands.registerCommand(
         "forester.changeOpenBehaviour",
         async () => {
            const config = vscode.workspace.getConfiguration("forester");
            const currentMode = config.get<string>("create.openNewTreeMode") || "background";

            const options = [
               {
                  label: "Off",
                  description: "Do not open the new tree",
                  value: "off"
               },
               {
                  label: "Background",
                  description: "Open the new tree in the background (default)",
                  value: "background"
               },
               {
                  label: "Side",
                  description: "Open the new tree to the side",
                  value: "side"
               },
               {
                  label: "Active",
                  description: "Open the new tree as the active editor",
                  value: "active"
               }
            ];

            const selected = await vscode.window.showQuickPick(options, {
               placeHolder: `Choose how newly created trees are opened (current: ${currentMode})`,
               canPickMany: false
            });

            if (selected) {
               await config.update("create.openNewTreeMode", selected.value, vscode.ConfigurationTarget.Workspace);
               vscode.window.showInformationMessage(`Open behaviour set to: ${selected.label}`);
            }
         }
      ),
      vscode.commands.registerCommand('forester.showForestStructureView', async () => {
         await vscode.commands.executeCommand('foresterTreeView.focus');
      }),
      vscode.commands.registerCommand('forester.refreshTreeView', () => {
         getForest({ forceReload: true });
         webviewProvider.refresh();
      }),
      vscode.commands.registerCommand('forester.collapseAllTreeView', () => {
         webviewProvider.collapseAll();
      }),
      vscode.commands.registerCommand('forester.showForestStatus', async () => {
         // Refresh the forest when status bar is clicked
         await getForest({ forceReload: true });

         const status = getForestStatus();
         if (status.valid) {
            vscode.window.showInformationMessage('Forester forest is valid');
         } else {
            vscode.window.showErrorMessage(`Forester forest error: ${status.error || 'Unknown error'}`);
         }
      }),
      // Test helper command: Get active editor info
      vscode.commands.registerCommand('forester.test.getActiveEditorInfo', () => {
         const editor = vscode.window.activeTextEditor;
         if (!editor) {
            return null;
         }
         return {
            fileName: editor.document.fileName,
            uri: editor.document.uri.toString(),
            languageId: editor.document.languageId,
            lineCount: editor.document.lineCount,
            // Get just the base name (e.g., "test-0001.tree" instead of full path)
            baseName: editor.document.fileName.split('/').pop() || '',
         };
      }),
      // Link alias configuration commands
      vscode.commands.registerCommand(
         "forester.configureLinkAliases",
         openConfigFile
      ),
      vscode.commands.registerCommand(
         "forester.createLinkAliasConfig",
         createDefaultConfigFile
      ),
      vscode.commands.registerCommand(
         "forester.addLinkPattern",
         addLinkPatternCommand
      ),
      vscode.commands.registerCommand(
         "forester.removeLinkPattern",
         removeLinkPatternCommand
      ),
      vscode.commands.registerCommand(
         "forester.showGraphView",
         () => ForestGraphView.createOrShow(context.extensionUri)
      ),
      vscode.commands.registerCommand(
         "forester.exportGraphView",
         async () => {
            try {
               await exportGraphView(context);
            } catch (err) {
               const msg = err instanceof Error ? err.message : String(err);
               void vscode.window.showErrorMessage(`Export failed: ${msg}`);
            }
         }
      ),
      vscode.commands.registerCommand(
         "forester.restartLanguageServer",
         async () => {
            if (!langiumClient) {return;}
            await vscode.window.withProgress(
               { location: vscode.ProgressLocation.Notification, title: 'Restarting Forester language server…', cancellable: false },
               async () => {
                  await langiumClient!.stop();
                  await langiumClient!.start();
               },
            );
         }
      ),
      // ── Datalog query runner (invoked from CodeLens in the language server) ──
      vscode.commands.registerCommand(
         "forester.runDatalogQuery",
         async (queryText: string) => {
            const channel = vscode.window.createOutputChannel('Forester Datalog');
            channel.show(true);
            channel.appendLine('─'.repeat(60));
            channel.appendLine('Forester Datalog Query');
            channel.appendLine('─'.repeat(60));
            channel.appendLine(queryText);
            channel.appendLine('─'.repeat(60));

            try {
               const forest = await getForest({ fastReturnStale: true });
               const result = evalDatalogQuery(queryText, forest);

               channel.appendLine(result.message);
               if (result.rows.length > 0) {
                  channel.appendLine('');
                  // Column widths
                  const widths = result.columns.map((col, i) =>
                     Math.max(col.length, ...result.rows.map(r => (r[i] ?? '').length))
                  );
                  const header = result.columns.map((col, i) => col.padEnd(widths[i])).join('  ');
                  const divider = widths.map(w => '-'.repeat(w)).join('  ');
                  channel.appendLine(header);
                  channel.appendLine(divider);
                  for (const row of result.rows) {
                     channel.appendLine(row.map((cell, i) => cell.padEnd(widths[i])).join('  '));
                  }
               }
            } catch (err) {
               // Never let the datalog feature fail silently — surface it.
               const msg = err instanceof Error ? err.message : String(err);
               channel.appendLine(`Error evaluating query: ${msg}`);
               vscode.window.showErrorMessage(`Forester datalog query failed: ${msg}`);
            }
         }
      )
   );

   // Initialize forest monitoring (handles file watching internally)
   initForestMonitoring(context);

   // Initialize status bar
   initStatusBar(context);

   // Initialize forester build diagnostics (LaTeX errors, etc.)
   initForesterDiagnostics(context);

   // Initialize link alias configuration (file watching for .forester-links.json)
   initLinkAliasConfig(context);

   // Initialize transclude decorations
   const transcludeDecorations = new TranscludeDecorationProvider();
   transcludeDecorations.activate(context);

   // Register document formatter
   context.subscriptions.push(
      vscode.languages.registerDocumentFormattingEditProvider(
         { scheme: "file", language: "forester" },
         new ForesterDocumentFormattingEditProvider()
      )
   );

   // Register range formatter
   context.subscriptions.push(
      vscode.languages.registerDocumentRangeFormattingEditProvider(
         { scheme: "file", language: "forester" },
         new ForesterDocumentRangeFormattingEditProvider()
      )
   );

   // Register definition provider for navigation
   const definitionProvider = vscode.languages.registerDefinitionProvider(
      { scheme: "file", language: "forester" },
      {
         async provideDefinition(document, position) {
            // Inside a raw group or a verbatim block nothing is forester — the
            // body is TeX (or code) the compiler passes through — so neither a
            // macro call nor a `\ref{…}` in there is a reference to resolve.
            if (isInSpans(findVerbatimSpans(document.getText()), document.offsetAt(position))) {
               return;
            }

            // Get the line text
            const line = document.lineAt(position.line).text;

            // Check for link patterns that contain the cursor position
            // Use configurable patterns from link-aliases-config
            const patterns = await buildDefinitionRegex();

            let treeId: string | undefined;

            // Check each pattern to see if cursor is within a match
            for (const pattern of patterns) {
               let matchResult;
               while ((matchResult = pattern.exec(line)) !== null) {
                  // Check if cursor is within this match
                  const matchStart = matchResult.index;
                  const matchEnd = matchResult.index + matchResult[0].length;

                  if (
                     position.character >= matchStart &&
                     position.character <= matchEnd
                  ) {
                     // Extract the tree ID from capture group 1
                     treeId = matchResult[1];
                     break;
                  }
               }
               if (treeId) {
                  break;
               }
            }

            if (!treeId) {
               // Not inside a link
               return;
            }

            // Get the forest. A missing entry is not fatal: an inline subtree
            // added since the last successful build is still navigable from its
            // \subtree[id]{…} declaration, so fall through to that scan.
            const tree = await getTree(treeId);

            // Find the actual file path
            // Trees can be in subdirectories, so we need to search for them
            const root = getRoot();
            let treePath = vscode.Uri.joinPath(root, `${treeId}.tree`);
            try {
               // Check if file exists at direct path
               await vscode.workspace.fs.stat(treePath);
            } catch {
               // File doesn't exist at direct path, search for it
               const pattern = new vscode.RelativePattern(root, `**/${treeId}.tree`);
               const files = await vscode.workspace.findFiles(pattern, null, 1);

               if (files.length === 0) {
                  // No file of its own — an inline \subtree[id]{…} inside some
                  // parent file is a tree just as much as a .tree file is, and
                  // forester's own sourcePath points at that parent.
                  const subtree = await findInlineSubtreeLocation(treeId, tree?.sourcePath);
                  if (subtree) {
                     return subtree;
                  }

                  vscode.window.showInformationMessage(
                     tree
                        ? `Tree '${treeId}' has no .tree file and no \\subtree[${treeId}] declaration`
                        : `Tree '${treeId}' not found`,
                  );
                  return;
               }

               treePath = files[0];
            }

            // Return the location
            return new vscode.Location(treePath, new vscode.Position(0, 0));
         },
      },
   );

   context.subscriptions.push(definitionProvider);

   const latexHoverService = new ForesterLatexHoverService(context);
   context.subscriptions.push(latexHoverService);

   const latexHoverProvider = vscode.languages.registerHoverProvider(
      { scheme: "file", language: "forester" },
      {
         provideHover(document, position, token) {
            return latexHoverService.provideHover(document, position, token);
         },
      },
   );
   context.subscriptions.push(latexHoverProvider);

   // Tag closure inlay hints are provided by the Langium LSP server
   // (see forester-lsp-inlay-hints.ts / forester-module.ts)

   // Register hover provider for transcludes with rename action
   const transcludeHoverProvider = vscode.languages.registerHoverProvider(
      { scheme: "file", language: "forester" },
      {
         async provideHover(document, position) {
            const line = document.lineAt(position.line).text;

            const transcludePattern = /\\(transclude|import|export)\{([^}]+)\}/g;
            let match;
            let targetTreeId: string | null = null;

            while ((match = transcludePattern.exec(line)) !== null) {
               // Find the position of the opening and closing braces
               const braceOpenIndex = match.index + match[0].indexOf('{');
               const braceCloseIndex = match.index + match[0].lastIndexOf('}') + 1;

               // Check if cursor is inside the braces (not including the braces themselves)
               if (position.character > braceOpenIndex && position.character < braceCloseIndex) {
                  targetTreeId = match[2];
                  break;
               }
            }

            if (!targetTreeId) {
               // Not inside a link
               return;
            }

            // Get the forest
            let tree = await getTree(targetTreeId);
            if (!tree) {
               // Tree not found
               vscode.window.showInformationMessage(`Tree '${targetTreeId}' not found`);
               return;
            }

            // Create hover content with title and rename action
            const contents = new vscode.MarkdownString();
            contents.isTrusted = true; // Allow command links

            // Show tree info
            if (tree.taxon) {
               contents.appendMarkdown(`**${tree.taxon}**: ${tree.title || targetTreeId}\n\n`);
            } else {
               contents.appendMarkdown(`**${tree.title || targetTreeId}**\n\n`);
            }

            // contents.appendMarkdown(`ID: \`${targetTreeId}\`\n\n`);

            // Add action links
            const renameCommand = `command:forester.renameTree?${encodeURIComponent(JSON.stringify([targetTreeId]))}`;
            contents.appendMarkdown(`[Rename](${renameCommand} "Rename this tree")`);

            return new vscode.Hover(contents);
         }
      }
   );

   context.subscriptions.push(transcludeHoverProvider);

   // Register completion provider with dynamic trigger characters from link aliases
   const registerCompletionProvider = async () => {
      const triggerChars = await getTriggerCharacters();

      return vscode.languages.registerCompletionItemProvider(
         { scheme: "file", language: "forester" },
         {
            async provideCompletionItems(doc, pos) {
               // Build dynamic regex from configurable link patterns
               const { regex: tagPattern, patternCount } = await buildAutocompleteRegex();

               const text = doc.getText(
                  new vscode.Range(new vscode.Position(pos.line, 0), pos),
               );

               let matchResult = tagPattern.exec(text);
               if (matchResult === null || matchResult.indices === undefined) {
                  return [];
               }

               // Get the needed range - find the first matching capture group
               let ix = pos.character;
               for (let i = 1; i <= patternCount; i++) {
                  const indices = matchResult.indices[i];
                  if (indices) {
                     ix = indices[0];
                     break;
                  }
               }

               let range = new vscode.Range(
                  new vscode.Position(pos.line, ix),
                  pos,
               );

               const forest = await getForest({ fastReturnStale: true });

               return suggest(forest, range);
            },
         },
         ...triggerChars,
      );
   };

   const completionProvider = await registerCompletionProvider();
   context.subscriptions.push(completionProvider);

   // Signature-driven parameter completion + hover, for both project `%! sig`
   // constructs (embed/codeblock/d3) AND builtins (\taxon, \transclude/\ref/… via
   // command-metadata) — supersedes the old hard-coded \taxon-only provider.
   registerSigCompletion(context);
   registerSigHover(context);

   // clangd-style `{name: …}` parameter-name inlay hints for the same sig-typed
   // commands, so each positional brace's role is visible without hovering.
   registerSigInlayHints(context);
}

// This method is called when your extension is deactivated
export function deactivate(): Thenable<void> | undefined {
   // Clean up server resources
   cleanupServer();
   return langiumClient?.stop();
}
