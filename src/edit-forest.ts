/**
 * edit-forest.ts - High-level tree editing operations for the Forester extension
 */

import * as vscode from "vscode";
import * as path from "path";
import { parseTaxonAndTitle, getPrefix, getRootTreeDirectory, getAvailableTemplates } from "./utils";
import { command, getTree } from "./get-forest";

/**
 * Open and focus a newly created tree file based on configuration
 * Places cursor at the end of the document
 */
async function focusNewTree(uri: vscode.Uri): Promise<void> {
   const extensionConfig = vscode.workspace.getConfiguration("forester");
   const openMode = extensionConfig.get<string>("create.openNewTreeMode") || "background";

   // Handle the "off" mode - don't open the file at all
   if (openMode === "off") return

   if (openMode === "background") {
      await vscode.commands.executeCommand("vscode.open", uri, { background: true })
      return
   }

   const document = await vscode.workspace.openTextDocument(uri);

   // Determine view column and focus based on mode
   let viewColumn: vscode.ViewColumn;

   if (openMode === "active") {
      viewColumn = vscode.ViewColumn.Active;
   } else if (openMode === "side") {
      viewColumn = vscode.ViewColumn.Beside;
   } else {
      throw new Error(`Unrecoginsed mode "${openMode}"`)
   }

   const editor = await vscode.window.showTextDocument(document, {
      viewColumn,
      preserveFocus: false,
      preview: false,
   });

   // Move cursor to the end of the document
   const lastLine = document.lineCount - 1;
   const lastCharacter = document.lineAt(lastLine).text.length;
   const endPosition = new vscode.Position(lastLine, lastCharacter);
   editor.selection = new vscode.Selection(endPosition, endPosition);
   editor.revealRange(new vscode.Range(endPosition, endPosition));
}

/**
 * Options for collecting tree title and taxon input from user
 */
interface TitleInputOptions {
   prompt?: string;
   placeholder?: string;
   currentValue?: string;
   selectionRange?: [number, number];
}

/**
 * Result of collecting tree title and taxon input
 */
interface TitleInputResult {
   taxon?: string;
   title: string;
   originalInput: string;
}

/**
 * Collect tree title and taxon input from user with validation
 * Uses QuickInput API for submit-only validation
 */
export async function collectTitleInput(options: TitleInputOptions = {}): Promise<TitleInputResult | undefined> {
   const {
      prompt = "Enter title for tree in form 'taxon: title' (taxon optional and abbreviations like 'thm', 'def', 'prop' are supported)",
      placeholder = "thm: \"My Therom\"",
      currentValue = "",
      selectionRange
   } = options;

   const titleInput = await new Promise<string | undefined>((resolve) => {
      const input = vscode.window.createInputBox();
      input.prompt = prompt;
      input.placeholder = placeholder;

      if (currentValue) {
         input.value = currentValue;
         if (selectionRange) {
            input.valueSelection = selectionRange;
         }
      }

      input.onDidAccept(() => {
         const value = input.value;
         if (!value || !value.trim()) {
            input.validationMessage = "Title cannot be empty";
            return;
         }
         const { title } = parseTaxonAndTitle(value);
         if (!title || !title.trim()) {
            input.validationMessage = "Title cannot be empty after taxon";
            return;
         }
         // Validation passed, resolve with the value
         resolve(value);
         input.dispose();
      });

      input.onDidHide(() => {
         resolve(undefined); // User cancelled
         input.dispose();
      });

      input.show();
   });

   if (!titleInput) {
      return undefined; // User cancelled
   }

   // Parse taxon and title from input
   const { taxon, title } = parseTaxonAndTitle(titleInput);

   return {
      taxon,
      title,
      originalInput: titleInput
   };
}

/**
 * Context information about a tree reference found in the editor
 */
interface TreeReferenceContext {
   treeId: string;
   range: vscode.Range;
   type: 'transclude' | 'import' | 'export' | 'ref' | 'link';
}

/**
 * Find tree reference at the current cursor position
 * Returns information about the tree ID and reference type if cursor is within a reference
 */
export function findTreeReferenceAtCursor(editor: vscode.TextEditor): TreeReferenceContext | undefined {
   const position = editor.selection.active;
   const line = editor.document.lineAt(position.line).text;

   // Check for different reference patterns
   const patterns = [
      { regex: /\\(transclude|import|export)\{([^}]+)\}/g, captureGroup: 2, typeGroup: 1 },
      { regex: /\\ref\{([^}]*)\}/g, captureGroup: 1, type: 'ref' },
      { regex: /\[[^\]]*\]\(([^)]*)\)/g, captureGroup: 1, type: 'link' },
      { regex: /\[\[([^\]]*)\]\]/g, captureGroup: 1, type: 'link' },
   ];

   for (const pattern of patterns) {
      let match;
      while ((match = pattern.regex.exec(line)) !== null) {
         // Check if cursor is within this match
         const matchStart = match.index;
         const matchEnd = match.index + match[0].length;

         if (position.character >= matchStart && position.character <= matchEnd) {
            const treeId = match[pattern.captureGroup];
            const type = pattern.typeGroup ? match[pattern.typeGroup] : pattern.type;

            return {
               treeId,
               range: new vscode.Range(
                  new vscode.Position(position.line, matchStart),
                  new vscode.Position(position.line, matchEnd)
               ),
               type: type as any
            };
         }
      }
   }

   return undefined;
}

/**
 * Find tree reference at cursor position for transclude commands specifically
 * Used for rename operations that work specifically with transclude/import/export
 */
export function findTranscludeReferenceAtCursor(editor: vscode.TextEditor): string | undefined {
   const position = editor.selection.active;
   const line = editor.document.lineAt(position.line).text;

   const transcludePattern = /\\(transclude|import|export)\{([^}]+)\}/g;
   let match;

   while ((match = transcludePattern.exec(line)) !== null) {
      // Find the position of the opening and closing braces
      const braceOpenIndex = match.index + match[0].indexOf('{');
      const braceCloseIndex = match.index + match[0].lastIndexOf('}') + 1;

      // Check if cursor is inside the braces (not including the braces themselves)
      if (position.character > braceOpenIndex && position.character < braceCloseIndex) {
         return match[2]; // Return the tree ID
      }
   }

   return undefined;
}

/**
 * Options for creating a new tree
 */
interface CreateNewTreeOptions {
   destFolder?: vscode.Uri;
   fromTemplate?: boolean;
}

/**
 * Shared logic for creating a new tree
 * @param options - Options for tree creation
 * @returns The created tree ID and file path, or undefined if cancelled/failed
 */
async function createNewTree(options: CreateNewTreeOptions = {}): Promise<{ treeId: string; filePath: vscode.Uri } | undefined> {
   try {
      const { destFolder: destFolderParam, fromTemplate = false } = options;

      // Collect selected text from all visible editors
      const selections: { editor: vscode.TextEditor; text: string; }[] = [];
      for (const editor of vscode.window.visibleTextEditors) {
         if (!editor.selection.isEmpty) {
            const text = editor.document.getText(editor.selection);
            selections.push({ editor, text });
         }
      }

      // Get the prefix
      const prefix = await getPrefix();
      if (!prefix) return // User cancelled

      // Ask for a title (with optional taxon)
      const titleResult = await collectTitleInput({
         prompt: "Enter title for the new tree (abbreviations like 'thm', 'def', 'prop' are supported)",
         placeholder: "e.g., 'Introduction to Category Theory' or 'thm: Fundamental Theorem'"
      });
      if (!titleResult) return undefined; // User cancelled

      const { taxon, title } = titleResult;

      // Determine destination folder if not provided
      const treesDir = await getRootTreeDirectory();
      const prefixDir = vscode.Uri.joinPath(treesDir, prefix);
      let destFolder = destFolderParam;
      if (!destFolder) {
         // Check if prefix-specific directory exists
         try {
            await vscode.workspace.fs.stat(prefixDir);
            destFolder = prefixDir;
         } catch {
            // Prefix directory doesn't exist, use main trees directory
            destFolder = treesDir;
         }
      }

      // Handle templates
      const extensionConfig = vscode.workspace.getConfiguration("forester");
      const defaultTemplate = extensionConfig.get<string>('defaultTemplate');
      let template: string | undefined = undefined;
      if (defaultTemplate) {
         // Use the default template if set
         template = defaultTemplate !== "(No template)" ? defaultTemplate : undefined;
      }

      if (fromTemplate || !defaultTemplate) {
         const templates = await getAvailableTemplates();

         if (templates.length <= 1) {
            template = undefined;
         }
         else {
            template = await vscode.window.showQuickPick(templates, {
               canPickMany: false,
               placeHolder: fromTemplate ?
                  "Choose a template or Escape to cancel" :
                  "Choose a template or Escape to cancel (run \"set default template\" command if you always use the same template)"
            });

            if (template === undefined) {
               return; // User canceled
            } else if (template === "(No template)") {
               template = undefined;
            }
         }
      }


      // Create the new tree file
      const random: boolean = vscode.workspace.getConfiguration('forester').get('create.random') ?? false;

      let newTreeFilePath = (await command(["new",
         "--dest", destFolder.fsPath,
         "--prefix", prefix,
         ...(template ? [`--template=${template}`] : []),
         ...(random ? ["--random"] : [])
      ]))?.trim();

      if (!newTreeFilePath) {
         vscode.window.showErrorMessage(`Failed to create new tree. This can happen if forest is not in a valid state.`);
         return undefined;
      }

      const uri = vscode.Uri.file(newTreeFilePath);
      const treeId = path.basename(newTreeFilePath, '.tree');
      let newTreeContent = (await vscode.workspace.fs.readFile(uri)).toString()

      // Handle date first, then author, blank line, then taxon and title

      let author = extensionConfig.get<string>("create.author") || undefined;
      const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      if (!newTreeContent.includes('\\date')) newTreeContent += `\\date{${date}}\n`;
      if (!newTreeContent.includes('\\author') && author) newTreeContent += `\\author{${author}}\n\n`;
      if (!newTreeContent.includes('\\taxon') && taxon) newTreeContent += `\\taxon{${taxon}}\n`;
      if (!newTreeContent.includes('\\title') && title) newTreeContent += `\\title{${title}}\n\n`;


      // Handle selections (append to the new tree)
      if (selections.length > 0) {
         // Combine all tree selections
         newTreeContent += selections.map(s => s.text).join('\n\n');
      }

      const edit = new vscode.WorkspaceEdit();
      const encoder = new TextEncoder();
      edit.createFile(uri, { overwrite: true, contents: encoder.encode(newTreeContent) });
      await vscode.workspace.applyEdit(edit);

      // Delete the selected text from each tree editor
      for (const selection of selections) {
         await selection.editor.edit(editBuilder => {
            editBuilder.delete(selection.editor.selection);
         });
      }

      return { treeId, filePath: uri };
   } catch (error) {
      vscode.window.showErrorMessage(`Failed to create new tree: ${error}`);
      return undefined;
   }
}


/**
 * Create a new tree and transclude it at the current cursor position
 * This is the main implementation for the "transclude new tree" command
 */
export async function transcludeNewTree(): Promise<void> {
   // Check if the current editor is a forester file
   const editor = vscode.window.activeTextEditor;
   if (!editor || editor.document.languageId !== "forester") {
      vscode.window.showInformationMessage(
         "Please open a Forester (.tree) file to use this command"
      );
      return;
   }

   // Store the current document URI and check if we're in preview mode
   const currentDocUri = editor.document.uri;
   const currentViewColumn = editor.viewColumn;

   // Check if the tab is in preview mode (italicized tab label)
   // We'll need to keep focus on the editor after creating the new tree
   const tabGroups = vscode.window.tabGroups;
   let isPreview = false;

   for (const group of tabGroups.all) {
      for (const tab of group.tabs) {
         if (tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === currentDocUri.toString()) {
            isPreview = tab.isPreview ?? false;
            break;
         }
      }
      if (isPreview) break;
   }

   // If in preview mode, first make it permanent by executing keepEditor command
   if (isPreview) {
      await vscode.commands.executeCommand('workbench.action.keepEditor');
   }

   // Create the new tree (without opening it in editor since we'll insert transclude)
   const result = await createNewTree();
   if (!result) {
      return; // User cancelled or error
   }

   // Insert the transclude command in the original document first
   const originalEditor = vscode.window.activeTextEditor;
   if (originalEditor && originalEditor.document.uri.toString() === currentDocUri.toString()) {
      const position = originalEditor.selection.active;
      await originalEditor.edit(editBuilder => {
         editBuilder.insert(position, `\\transclude{${result.treeId}}\n`);
      });
   }

   // Open and focus the new tree based on configuration
   await focusNewTree(result.filePath);

   // Get configuration to check if we need to return focus to original document
   const extensionConfig = vscode.workspace.getConfiguration("forester");
   const openNewTreeToSide = extensionConfig.get<boolean>("create.openNewTreeToSide");
   const openNewTree = extensionConfig.get<boolean>("create.openNewTree");

   // If in background mode (default), return focus to the original document
   if (!openNewTree && !openNewTreeToSide) {
      await vscode.window.showTextDocument(currentDocUri, { viewColumn: currentViewColumn, preview: false });
   }
}

/**
 * Create a new tree file
 * This is the main implementation for the "new tree" and "new tree from template" commands
 */
export async function newTree(folder?: vscode.Uri, fromTemplate?: boolean): Promise<void> {
   const result = await createNewTree({ destFolder: folder, fromTemplate });
   if (result) await focusNewTree(result.filePath);
}

/**
 * Rename a tree with intelligent context detection
 * This is the main implementation for the "rename tree" command
 */
export async function renameTreeCommand(treeIdParam?: string): Promise<void> {
   // Handle parameter cleanup (VSCode sometimes passes objects)
   if (typeof treeIdParam === 'object') {
      treeIdParam = undefined;
   }

   // If a tree ID was passed as parameter, rename that tree directly
   if (treeIdParam) {
      await renameTreeById(treeIdParam);
      return;
   }

   // Otherwise, check context
   const editor = vscode.window.activeTextEditor;
   if (!editor || editor.document.languageId !== "forester") {
      vscode.window.showInformationMessage(
         "Please open a Forester (.tree) file to rename it"
      );
      return;
   }

   // Check if cursor is inside a transclude command
   const targetTreeId = findTranscludeReferenceAtCursor(editor);

   if (targetTreeId) {
      // Rename the transcluded tree
      await renameTreeById(targetTreeId);
   } else {
      // Rename the current file
      const fileName = editor.document.fileName;
      const treeId = fileName.substring(fileName.lastIndexOf('/') + 1, fileName.lastIndexOf('.tree'));
      await renameTreeById(treeId);
   }
}

/**
 * Rename a tree by its ID with user input
 * This is the low-level rename implementation
 */
export async function renameTreeById(treeId: string): Promise<void> {
   // Get the tree object
   const tree = await getTree(treeId);
   if (!tree) {
      vscode.window.showErrorMessage(`Tree ${treeId} not found`);
      return;
   }

   // Prepare current value for input
   const currentTaxon = tree.taxon || '';
   const currentTitle = tree.title || tree.uri;
   const currentValue = currentTaxon ? `${currentTaxon}: ${currentTitle}` : currentTitle;

   // Calculate selection range to highlight only the title
   let selectionStart = 0;
   let selectionEnd = currentValue.length;

   if (currentTaxon) {
      // Find where the title starts (after "taxon: ")
      const colonIndex = currentValue.indexOf(':');
      if (colonIndex >= 0) {
         selectionStart = colonIndex + 2; // Skip past ": "
      }
   }

   // Get new title and taxon from user
   const titleResult = await collectTitleInput({
      prompt: 'Edit taxon and/or title (format: "taxon: title" or just "title"). You can use abbreviations like "thm", "def", "prop".',
      currentValue,
      selectionRange: [selectionStart, selectionEnd]
   });

   if (!titleResult) {
      return; // User cancelled
   }

   const { taxon: newTaxon, title: newTitle } = titleResult;

   // Read the current file
   const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(tree.sourcePath));
   const text = Buffer.from(fileContent).toString('utf-8');
   const lines = text.split('\n');

   // Find and update/add title and taxon lines
   let titleLineIndex = -1;
   let taxonLineIndex = -1;
   let lastMetadataLine = -1;

   for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('\\title{')) {
         titleLineIndex = i;
         lastMetadataLine = i;
      } else if (line.startsWith('\\taxon{')) {
         taxonLineIndex = i;
         lastMetadataLine = i;
      } else if (line.startsWith('\\date{') || line.startsWith('\\author{') || line.startsWith('\\import{') || line.startsWith('\\export{')) {
         lastMetadataLine = i;
      }
   }

   // Update or add title
   if (titleLineIndex >= 0) {
      lines[titleLineIndex] = `\\title{${newTitle}}`;
   } else {
      // Add title at the beginning
      lines.unshift(`\\title{${newTitle}}`);
      if (taxonLineIndex >= 0) taxonLineIndex++;
      if (lastMetadataLine >= 0) lastMetadataLine++;
   }

   // Update, add, or remove taxon
   if (newTaxon !== undefined) {
      if (taxonLineIndex >= 0) {
         lines[taxonLineIndex] = `\\taxon{${newTaxon}}`;
      } else {
         // Add taxon after title
         const insertIndex = titleLineIndex >= 0 ? titleLineIndex + 1 : 0;
         lines.splice(insertIndex, 0, `\\taxon{${newTaxon}}`);
      }
   } else {
      // Remove taxon if it exists and user didn't specify one
      if (taxonLineIndex >= 0) {
         lines.splice(taxonLineIndex, 1);
      }
   }

   // Write the updated content back using WorkspaceEdit to trigger file events
   const updatedContent = lines.join('\n');
   const edit = new vscode.WorkspaceEdit();
   edit.createFile(vscode.Uri.file(tree.sourcePath), { overwrite: true, contents: new Uint8Array(Buffer.from(updatedContent, 'utf-8')) });
   await vscode.workspace.applyEdit(edit);

   // Show success message
   const message = newTaxon
      ? `Tree renamed to "${newTaxon}: ${newTitle}"`
      : `Tree renamed to "${newTitle}"`;
   vscode.window.showInformationMessage(message);
}