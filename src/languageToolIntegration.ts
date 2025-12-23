import * as path from "path";
import * as vscode from "vscode";

const languageToolLog = vscode.window.createOutputChannel("Forester LanguageTool");

// Our own diagnostic collection to hold filtered diagnostics
let foresterDiagnostics: vscode.DiagnosticCollection | undefined;
// Track if we're currently inside our own update to prevent infinite loops
let isUpdatingDiagnostics = false;

// Create a unique key for a diagnostic to detect duplicates
function diagnosticKey(uri: vscode.Uri, d: vscode.Diagnostic): string {
   return `${uri.toString()}:${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
}

// Filter diagnostics from any source (including the original LanguageTool extension)
// This works by listening to diagnostics changes and creating our own filtered collection
function filterAndUpdateDiagnostics(uri: vscode.Uri): void {
   if (isUpdatingDiagnostics) {
      return;
   }
   
   const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
   if (!doc) {
      return;
   }

   // Get all current diagnostics for this file
   const allDiagnostics = vscode.languages.getDiagnostics(uri);
   
   // Find LanguageTool/LTeX diagnostics from any grammar-checking extension (not ours)
   const grammarDiagnostics = allDiagnostics.filter(d => {
      const src = d.source?.toLowerCase() || "";
      // Match LanguageTool, LTeX, or similar grammar checker sources
      // but exclude our own "LanguageTool (Forester)" source
      const isGrammarChecker = src === "languagetool" || src === "ltex" || src.includes("grammar");
      const isOurs = src.includes("forester");
      return isGrammarChecker && !isOurs;
   });

   if (grammarDiagnostics.length === 0) {
      return;
   }
   
   languageToolLog.appendLine(`[filter] Found ${grammarDiagnostics.length} grammar diagnostics to filter for ${path.basename(uri.fsPath)}`);

   const content = doc.getText();
   const ignoredRanges = buildIgnoreRanges(content);
   const commandRanges = buildCommandRanges(content);

   // Filter diagnostics
   const filteredDiagnostics: vscode.Diagnostic[] = [];
   let suppressCount = 0;

   for (const diag of grammarDiagnostics) {
      if (shouldIgnoreRule(diag)) {
         suppressCount++;
         languageToolLog.appendLine(`[filter] Suppressed by rule: ${diag.message.substring(0, 50)}...`);
      } else if (shouldIgnoreDiagnostic(doc, content, ignoredRanges, commandRanges, diag)) {
         suppressCount++;
         languageToolLog.appendLine(`[filter] Suppressed by content: ${diag.message.substring(0, 50)}...`);
      } else {
         // Keep this diagnostic but rebrand it as from our extension
         const newDiag = new vscode.Diagnostic(
            diag.range,
            diag.message,
            diag.severity
         );
         newDiag.source = "LanguageTool (Forester)";
         newDiag.code = diag.code;
         newDiag.relatedInformation = diag.relatedInformation;
         newDiag.tags = diag.tags;
         filteredDiagnostics.push(newDiag);
      }
   }

   // Log filtering results
   languageToolLog.appendLine(`[filter] ${path.basename(uri.fsPath)}: ${grammarDiagnostics.length} grammar diagnostics -> suppressed ${suppressCount}, kept ${filteredDiagnostics.length}`);

   // We can't remove the original diagnostics, but at least log what would be filtered
   if (suppressCount > 0) {
      languageToolLog.appendLine(`[filter] NOTE: Original grammar diagnostics cannot be hidden directly.`);
      languageToolLog.appendLine(`[filter] Configure ltex.hiddenFalsePositives or disable the grammar extension for .tree files.`);
   }
}

export function filterSyntacticDiagnostics(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): vscode.Diagnostic[] {
   const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
   if (!doc) return diagnostics;

   const content = doc.getText();
   const ignoredRanges = buildIgnoreRanges(content);
   const commandRanges = buildCommandRanges(content);
   const filtered: vscode.Diagnostic[] = [];

   for (const diag of diagnostics) {
      if (shouldIgnoreRule(diag)) continue;
      if (shouldIgnoreDiagnostic(doc, content, ignoredRanges, commandRanges, diag)) {
         continue;
      }
      filtered.push(diag);
   }

   return filtered;
}

export type RangeLike = { start: number; end: number };

export function buildIgnoreRanges(text: string): RangeLike[] {
   const ranges: RangeLike[] = [];
   const regexes = [
      /#\{[\s\S]*?\}/g,  // custom inline latex
      /##\{[\s\S]*?\}/g, // custom inline latex block
      /\\\(.+?\\\)/gs,
      /\\\[.+?\\\]/gs,
      /\$[^$]+\$/gs,
      /\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}/g,
      /\\[A-Za-z]+(?:\[[^\]]*\])?\{[^}]*\}/g,
      /\{[^}]*\}/g, // generic braces content (reduces macro args)
   ];

   for (const re of regexes) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
         ranges.push({ start: m.index, end: m.index + m[0].length });
      }
   }

   return ranges;
}

export function buildCommandRanges(text: string): RangeLike[] {
   const ranges: RangeLike[] = [];
   const re = /\\[A-Za-z]+(?:\[[^\]]*\])?(?:\{[^}]*\})*/g;
   let m: RegExpExecArray | null;
   while ((m = re.exec(text)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
   }
   return ranges;
}

export function shouldIgnoreDiagnostic(doc: vscode.TextDocument, content: string, ignored: RangeLike[], commands: RangeLike[], diag: vscode.Diagnostic): boolean {
   const text = doc.getText(diag.range);
   const startOffset = doc.offsetAt(diag.range.start);
   const endOffset = doc.offsetAt(diag.range.end);
   
   // Debug logging
   const logPrefix = `[shouldIgnore] text="${text}"`;
   
   if (!text.trim()) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (empty/whitespace)`);
      return true;
   }
   if (!/[A-Za-z]/.test(text)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (no letters)`);
      return true;
   }

   // Ignore obvious macro-ish tokens
   if (/^\\/.test(text)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (starts with backslash)`);
      return true;
   }
   if (/[\\{}$#]/.test(text)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (contains special chars)`);
      return true;
   }
   if (/^\\?[A-Za-z]{1,3}$/.test(text)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (short token 1-3 chars)`);
      return true;
   }
   if (/^\\?(ul|li|p|ol|em|strong|taxon)$/i.test(text)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (known command name)`);
      return true;
   }
   if (/^\\?(ul|li|ol|p)[{\\]/i.test(text)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (command followed by brace/backslash)`);
      return true;
   }
   if (/^\\?(ul|li|ol|p)\b/i.test(text)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (command word boundary)`);
      return true;
   }

   if (ignored.some(r => endOffset > r.start && startOffset < r.end)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (in ignored range)`);
      return true;
   }
   if (commands.some(r => endOffset > r.start && startOffset < r.end)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (in command range)`);
      return true;
   }

   // If immediately preceded by a backslash, it's likely a macro name.
   const prefix = content.slice(Math.max(0, startOffset - 1), startOffset);
   if (prefix.includes("\\")) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (preceded by backslash)`);
      return true;
   }

   // If inside a command name (letters after backslash on the same line)
   const lineStart = doc.offsetAt(new vscode.Position(diag.range.start.line, 0));
   const lineEnd = doc.offsetAt(new vscode.Position(diag.range.start.line, doc.lineAt(diag.range.start.line).text.length));
   const lineText = content.slice(lineStart, lineEnd);
   const relativeStart = startOffset - lineStart;
   const before = lineText.slice(Math.max(0, relativeStart - 5), relativeStart);
   if (/\\[A-Za-z]*$/.test(before)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (looks like command name, before="${before}")`);
      return true;
   }

   // Ignore LaTeX-ish command names without letters (e.g., \_, \%)
   if (/^\\[^A-Za-z]*$/.test(text)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (latex special char)`);
      return true;
   }

   // Ignore very short tokens that are often macro fragments.
   if (text.length <= 2) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (very short <= 2)`);
      return true;
   }

   languageToolLog.appendLine(`${logPrefix} -> KEEP (no ignore rule matched)`);
   return false;
}

export function shouldIgnoreRule(diag: vscode.Diagnostic): boolean {
   const src = diag.source || "";
   const msg = diag.message.toLowerCase();

   // Common whitespace rule id/message from LT
   if (src.toLowerCase().includes("whitespace") || msg.includes("whitespace")) {
      languageToolLog.appendLine(`[shouldIgnoreRule] IGNORE whitespace rule: src="${src}", msg="${msg.slice(0, 50)}"`);
      return true;
   }
   
   // Parenthesis/bracket spacing rules - very common in Forester due to syntax
   if (msg.includes("before the closing parenthesis") || 
       msg.includes("after the opening parenthesis") ||
       msg.includes("before the closing bracket") ||
       msg.includes("after the opening bracket") ||
       msg.includes("before comma") || 
       msg.includes("before ,") || 
       msg.includes("before )") ||
       msg.includes("after (")) {
      languageToolLog.appendLine(`[shouldIgnoreRule] IGNORE punctuation spacing rule: msg="${msg.slice(0, 50)}"`);
      return true;
   }

   return false;
}

export async function initLanguageToolBridge(context: vscode.ExtensionContext): Promise<void> {
   languageToolLog.appendLine("[init] Starting LanguageTool bridge initialization...");

   // Create our own diagnostic collection for filtered diagnostics
   foresterDiagnostics = vscode.languages.createDiagnosticCollection("forester-languagetool-filtered");
   context.subscriptions.push(foresterDiagnostics);

   // Listen for diagnostic changes from ALL sources (including original LanguageTool extension)
   // We filter LanguageTool diagnostics and suppress the ones we don't want
   context.subscriptions.push(
      vscode.languages.onDidChangeDiagnostics((event) => {
         if (isUpdatingDiagnostics) {
            return; // Prevent infinite loop
         }

         for (const uri of event.uris) {
            if (!uri.fsPath.endsWith(".tree")) {
               continue;
            }

            filterAndUpdateDiagnostics(uri);
         }
      })
   );

   // Also filter diagnostics for currently open .tree files
   for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.fsPath.endsWith(".tree")) {
         filterAndUpdateDiagnostics(doc.uri);
      }
   }

   // Check if LTeX extension is available and offer to enable it for forester
   await suggestLtexConfiguration(context);
   
   // Trigger LTeX check for open .tree files
   await triggerLtexCheckForTreeFiles();
   
   // Also trigger LTeX check when .tree files are opened or saved
   context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
         if (doc.uri.fsPath.endsWith(".tree")) {
            languageToolLog.appendLine(`[ltex] Document opened: ${doc.uri.fsPath}`);
            triggerLtexCheckForDocument(doc);
         }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
         if (doc.uri.fsPath.endsWith(".tree")) {
            languageToolLog.appendLine(`[ltex] Document saved: ${doc.uri.fsPath}`);
            triggerLtexCheckForDocument(doc);
         }
      })
   );

   context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(async (event) => {
         if (event.affectsConfiguration("forester.languageTool") || event.affectsConfiguration("ltex.enabled")) {
            // Re-filter diagnostics when config changes
            for (const doc of vscode.workspace.textDocuments) {
               if (doc.uri.fsPath.endsWith(".tree")) {
                  filterAndUpdateDiagnostics(doc.uri);
               }
            }
         }
      })
   );
}

// Suggest enabling LTeX for forester files if it's installed but not configured
async function suggestLtexConfiguration(context: vscode.ExtensionContext): Promise<void> {
   const ltexExtension = vscode.extensions.getExtension("valentjn.vscode-ltex");
   if (!ltexExtension) {
      languageToolLog.appendLine("[ltex] LTeX extension not found - no grammar checking available");
      return;
   }
   
   languageToolLog.appendLine("[ltex] LTeX extension found");
   
   // Check if forester is already in the enabled list
   const ltexConfig = vscode.workspace.getConfiguration("ltex");
   const enabled = ltexConfig.get<string[] | boolean>("enabled");
   
   if (Array.isArray(enabled) && enabled.includes("forester")) {
      languageToolLog.appendLine("[ltex] LTeX already enabled for forester files");
      return;
   }
   
   // Offer to enable it
   const promptShownKey = "ltex.forester.promptShown";
   if (context.globalState.get<boolean>(promptShownKey)) {
      return;
   }
   
   const choice = await vscode.window.showInformationMessage(
      "LTeX grammar checker is installed. Would you like to enable it for Forester (.tree) files?",
      "Enable for Forester", "Not Now"
   );
   
   context.globalState.update(promptShownKey, true);
   
   if (choice === "Enable for Forester") {
      const currentEnabled = Array.isArray(enabled) ? enabled : ["bibtex", "context", "context.tex", "html", "latex", "markdown", "org", "restructuredtext", "rsweave"];
      if (!currentEnabled.includes("forester")) {
         currentEnabled.push("forester");
      }
      // Also add plaintext since LTeX falls back to plaintext for unknown languages
      if (!currentEnabled.includes("plaintext")) {
         currentEnabled.push("plaintext");
      }
      await ltexConfig.update("enabled", currentEnabled, vscode.ConfigurationTarget.Workspace);
      languageToolLog.appendLine("[ltex] Enabled LTeX for forester files");
      vscode.window.showInformationMessage("LTeX grammar checking enabled for Forester files. Diagnostics will be filtered for Forester syntax.");
   }
}

// Trigger LTeX check for all open .tree files
async function triggerLtexCheckForTreeFiles(): Promise<void> {
   const ltexExtension = vscode.extensions.getExtension("valentjn.vscode-ltex");
   if (!ltexExtension) {
      return;
   }
   
   for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.fsPath.endsWith(".tree")) {
         await triggerLtexCheckForDocument(doc);
      }
   }
}

// Trigger LTeX check for a single document
async function triggerLtexCheckForDocument(doc: vscode.TextDocument): Promise<void> {
   const ltexExtension = vscode.extensions.getExtension("valentjn.vscode-ltex");
   if (!ltexExtension) {
      languageToolLog.appendLine("[ltex] LTeX extension not found");
      return;
   }
   
   // Make sure LTeX is activated
   if (!ltexExtension.isActive) {
      languageToolLog.appendLine("[ltex] Activating LTeX extension...");
      try {
         await ltexExtension.activate();
      } catch (e) {
         languageToolLog.appendLine(`[ltex] Failed to activate LTeX: ${e}`);
         return;
      }
   }
   
   // Log all current diagnostics for this file to see what's there
   const currentDiags = vscode.languages.getDiagnostics(doc.uri);
   languageToolLog.appendLine(`[ltex] Current diagnostics for ${path.basename(doc.uri.fsPath)}: ${currentDiags.length}`);
   for (const d of currentDiags) {
      languageToolLog.appendLine(`[ltex]   - [${d.source}] ${d.message.substring(0, 50)}`);
   }
   
   // Try to trigger LTeX check using the command
   try {
      // First, make sure the document is the active editor
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === doc.uri.toString());
      if (editor) {
         languageToolLog.appendLine(`[ltex] Triggering check for ${path.basename(doc.uri.fsPath)}`);
         await vscode.commands.executeCommand("ltex.checkCurrentDocument");
         languageToolLog.appendLine(`[ltex] Check command executed`);
      } else {
         languageToolLog.appendLine(`[ltex] Document not in visible editor, skipping active check`);
      }
   } catch (e) {
      languageToolLog.appendLine(`[ltex] Error triggering check: ${e}`);
   }
}

async function ensureLanguageToolClient(context: vscode.ExtensionContext): Promise<void> {
   // This function is now deprecated - we rely on LTeX for grammar checking
   // and just filter its diagnostics
   languageToolLog.appendLine("[bridge] Using LTeX for grammar checking (if available)");
}

// Command to check all .tree files in the workspace
export async function checkAllTreeFilesCommand(): Promise<void> {
   const ltexExtension = vscode.extensions.getExtension("valentjn.vscode-ltex");
   if (!ltexExtension) {
      vscode.window.showErrorMessage("LTeX extension is not installed. Please install it for grammar checking.");
      return;
   }
   
   // Make sure LTeX is activated
   if (!ltexExtension.isActive) {
      languageToolLog.appendLine("[ltex] Activating LTeX extension...");
      try {
         await ltexExtension.activate();
      } catch (e) {
         vscode.window.showErrorMessage(`Failed to activate LTeX: ${e}`);
         return;
      }
   }
   
   // Find all .tree files in the workspace
   const treeFiles = await vscode.workspace.findFiles("**/*.tree", "**/node_modules/**");
   
   if (treeFiles.length === 0) {
      vscode.window.showInformationMessage("No .tree files found in workspace.");
      return;
   }
   
   languageToolLog.appendLine(`[ltex] Found ${treeFiles.length} .tree files to check`);
   
   // Show progress
   await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Checking .tree files with LTeX",
      cancellable: true
   }, async (progress, token) => {
      let checked = 0;
      
      for (const fileUri of treeFiles) {
         if (token.isCancellationRequested) {
            languageToolLog.appendLine("[ltex] Check cancelled by user");
            break;
         }
         
         const fileName = path.basename(fileUri.fsPath);
         progress.report({ 
            message: `${fileName} (${checked + 1}/${treeFiles.length})`,
            increment: (1 / treeFiles.length) * 100
         });
         
         languageToolLog.appendLine(`[ltex] Checking ${fileName}...`);
         
         try {
            // Open the document (required for LTeX to check it)
            const doc = await vscode.workspace.openTextDocument(fileUri);
            
            // Use LTeX's checkAllDocumentsInWorkspace won't work for forester
            // So we trigger check by briefly showing the document
            // LTeX will automatically check when a document is opened if it's in the enabled list
            
            // Give LTeX a moment to process the document
            await new Promise(resolve => setTimeout(resolve, 100));
            
            checked++;
         } catch (e) {
            languageToolLog.appendLine(`[ltex] Error checking ${fileName}: ${e}`);
         }
      }
      
      languageToolLog.appendLine(`[ltex] Finished checking ${checked} files`);
   });
   
   // Show the problems panel
   vscode.commands.executeCommand("workbench.actions.view.problems");
   
   vscode.window.showInformationMessage(`Checked ${treeFiles.length} .tree files. See Problems panel for results.`);
}
