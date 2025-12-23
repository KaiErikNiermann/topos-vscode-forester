import * as vscode from "vscode";
import { TextDecoder } from "util";

import { Forest, cleanupServer, getForest, onForestChange, initForestMonitoring, getTree, initStatusBar, getForestStatus } from "./get-forest";
import { getRoot, getAvailableTemplates } from "./utils";
import { transcludeNewTree, renameTreeCommand, newTree } from "./edit-forest";
import { ForesterWebviewProvider } from "./forestStructureView";
import { TranscludeDecorationProvider } from "./transclude-decorations";
import { ForesterDocumentFormattingEditProvider, ForesterDocumentRangeFormattingEditProvider, formatAllTreeFiles } from "./formatter";
import { initFormatterConfig, scanMacrosCommand, refreshIgnoredCommandsCache, clearIgnoredCommandsCache } from "./formatter-config";
import { initLanguageToolBridge, checkAllTreeFilesCommand } from "./languageToolIntegration";
import { registerSpeedFixCommand } from "./speedfix";

const textDecoder = new TextDecoder("utf-8");

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

function getMacroNameAtPosition(line: string, position: vscode.Position): string | undefined {
   const match = getMacroMatchAtPosition(line, position);
   return match?.name;
}

interface MacroMatch {
   name: string;
   start: number;
   end: number;
}

function getMacroMatchAtPosition(line: string, position: vscode.Position): MacroMatch | undefined {
   const macroPattern = /\\([A-Za-z][A-Za-z0-9\-]*)/g;
   let match: RegExpExecArray | null;
   while ((match = macroPattern.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
         return { name: match[1], start, end };
      }
   }
   return undefined;
}

interface MacroDefinitionInfo {
   uri: vscode.Uri;
   definitionRange: vscode.Range;  // Full range of the definition (for highlighting in peek)
   targetRange: vscode.Range;      // Where to position cursor
}

async function findMacroDefinitionLocations(macroName: string, originRange?: vscode.Range): Promise<vscode.LocationLink[]> {
   const workspaceFolders = vscode.workspace.workspaceFolders;
   if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
   }

   // Match \def\macroName or \alloc\macroName patterns
   const defRegex = new RegExp(`\\\\(def|alloc)\\\\${macroName}(?![A-Za-z0-9-])`, 'g');
   const treeFiles = await vscode.workspace.findFiles("**/*.tree", "**/node_modules/**");
   const locationLinks: vscode.LocationLink[] = [];

   for (const file of treeFiles) {
      try {
         const raw = await vscode.workspace.fs.readFile(file);
         const content = textDecoder.decode(raw);
         const lines = content.split(/\r?\n/);
         
         for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let match;
            defRegex.lastIndex = 0;
            
            while ((match = defRegex.exec(line)) !== null) {
               const matchStart = match.index;
               const matchEnd = matchStart + match[0].length;
               
               // Find the extent of the full definition (scan for matching braces)
               const definitionEndLine = findDefinitionEnd(lines, i, matchEnd);
               
               const targetRange = new vscode.Range(
                  new vscode.Position(i, matchStart),
                  new vscode.Position(i, matchEnd)
               );
               
               const definitionRange = new vscode.Range(
                  new vscode.Position(i, matchStart),
                  new vscode.Position(definitionEndLine.line, definitionEndLine.char)
               );
               
               locationLinks.push({
                  originSelectionRange: originRange,
                  targetUri: file,
                  targetRange: definitionRange,      // This is what gets shown in peek
                  targetSelectionRange: targetRange  // This is what gets highlighted
               });
            }
         }
      } catch (error) {
         console.error(`Failed to read ${file.fsPath}:`, error);
      }
   }

   return locationLinks;
}

// Find the end of a macro definition by tracking brace depth
function findDefinitionEnd(lines: string[], startLine: number, startChar: number): { line: number; char: number } {
   let depth = 0;
   let inDefinition = false;
   
   for (let lineNum = startLine; lineNum < lines.length && lineNum < startLine + 100; lineNum++) {
      const line = lines[lineNum];
      const startCol = lineNum === startLine ? startChar : 0;
      
      for (let col = startCol; col < line.length; col++) {
         const char = line[col];
         if (char === '{') {
            depth++;
            inDefinition = true;
         } else if (char === '}') {
            depth--;
            if (inDefinition && depth === 0) {
               return { line: lineNum, char: col + 1 };
            }
         }
      }
   }
   
   // Fallback: return end of start line if we can't find matching braces
   return { line: startLine, char: lines[startLine].length };
}

export async function activate(context: vscode.ExtensionContext) {
   // Set context for conditional visibility - extension only activates when Forester files exist
   vscode.commands.executeCommand('setContext', 'workspaceHasForesterFiles', true);

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

   // Track pinned state for context
   vscode.commands.executeCommand('setContext', 'foresterTreeViewPinned', false);

   // Initialize formatter config and scan for macros
   await initFormatterConfig();
   await refreshIgnoredCommandsCache();
   await initLanguageToolBridge(context);

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
         getForest({ forceReload: true })
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
      })
   );

   // Initialize forest monitoring (handles file watching internally)
   initForestMonitoring(context);

   // Initialize status bar
   initStatusBar(context);

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
            // Get the line text
            const line = document.lineAt(position.line).text;

            // Macro definition lookup
            const macroMatch = getMacroMatchAtPosition(line, position);
            if (macroMatch) {
               const originRange = new vscode.Range(
                  new vscode.Position(position.line, macroMatch.start),
                  new vscode.Position(position.line, macroMatch.end)
               );
               const macroDefs = await findMacroDefinitionLocations(macroMatch.name, originRange);
               if (macroDefs.length > 0) {
                  return macroDefs;
               }
            }

            // Check for link patterns that contain the cursor position
            // We need to check for patterns that might span around the cursor
            // Pattern matches: \ref{id}, \transclude{id}, \import{id}, \export{id}, [text](id), [[id]]
            const patterns = [
               /\\ref\{([^}]*)\}/g,
               /\\transclude\{([^}]*)\}/g,
               /\\import\{([^}]*)\}/g,
               /\\export\{([^}]*)\}/g,
               /\[[^\]]*\]\(([^)]*)\)/g, // [text](id)
               /\[\[([^\]]*)\]\]/g, // [[id]]
            ];

            let treeId: string | undefined;

            // Check each pattern to see if cursor is within a match
            for (const pattern of patterns) {
               let match;
               while ((match = pattern.exec(line)) !== null) {
                  // Check if cursor is within this match
                  const matchStart = match.index;
                  const matchEnd = match.index + match[0].length;

                  if (
                     position.character >= matchStart &&
                     position.character <= matchEnd
                  ) {
                     // Extract the tree ID from capture group 1
                     treeId = match[1];
                     break;
                  }
               }
               if (treeId) break;
            }

            if (!treeId) {
               // Not inside a link
               return undefined;
            }

            // Get the forest
            let tree = await getTree(treeId);
            if (!tree) {
               // Tree not found
               vscode.window.showInformationMessage(`Tree '${treeId}' not found`);
               return undefined;
            }

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
                  vscode.window.showInformationMessage(
                     `File for tree '${treeId}' not found`,
                  );
                  return undefined;
               }

               treePath = files[0];
            }

            // Return the location
            return new vscode.Location(treePath, new vscode.Position(0, 0));
         },
      },
   );

   context.subscriptions.push(definitionProvider);

   // Register hover provider for transcludes with rename action
   const hoverProvider = vscode.languages.registerHoverProvider(
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
               return undefined;
            }

            // Get the forest
            let tree = await getTree(targetTreeId);
            if (!tree) {
               // Tree not found
               vscode.window.showInformationMessage(`Tree '${targetTreeId}' not found`);
               return undefined;
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

   context.subscriptions.push(hoverProvider);

   context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
         { scheme: "file", language: "forester" },
         {
            async provideCompletionItems(doc, pos) {
               // see if we should complete
               // \transclude{, \import{, \export{, \ref, [link](, [[link
               // There are three matching groups for the replacing content
               const tagPattern =
                  /(?:\\transclude{|\\import{|\\export{|\\ref{)([^}]*)$|\[[^\[]*\]\(([^\)]*)$|\[\[([^\]]*)$/d;
               const text = doc.getText(
                  new vscode.Range(new vscode.Position(pos.line, 0), pos),
               );
               let match = tagPattern.exec(text);
               if (match === null || match.indices === undefined) {
                  return [];
               }

               // Get the needed range
               let ix =
                  match.indices[1]?.[0] ??
                  match.indices[2]?.[0] ??
                  match.indices[3]?.[0] ??
                  pos.character;
               let range = new vscode.Range(
                  new vscode.Position(pos.line, ix),
                  pos,
               );

               const forest = await getForest({ fastReturnStale: true });

               return suggest(forest, range);
            },
            // resolveCompletionItem, we can extend the CompletionItem class to inject more information
         },
         "{",
         "(",
         "[",
      ),
   );
}

// This method is called when your extension is deactivated
export function deactivate() {
   // Clean up server resources
   cleanupServer();
}
