import * as path from "path";
import * as vscode from "vscode";
import { getIgnoredCommandsSync, getSubtreeMacrosSync } from "./formatter-config";
import {
   format,
   tokenize,
   checkContentPreservation,
   FormatOptions,
   Token,
   TOP_LEVEL_COMMANDS,
   BLOCK_COMMANDS,
   TEX_CONTENT_COMMANDS,
   CODE_CONTENT_COMMANDS
} from "./formatter-core";

// ── Langium formatter integration (task 2) ───────────────────────────────────
//
// format-standalone.mjs is a self-contained ESM bundle (built by esbuild from
// src/language/format-standalone.ts).  Because langium is ESM-only we cannot
// statically import it from the CJS extension host; instead we use a dynamic
// import() via `new Function` so esbuild does not try to inline or CJS-ify it.
//
// The module is loaded lazily on first use and then cached for the lifetime of
// the extension host process.

type LangiumFormatFn = (
   text: string,
   config?: Partial<{ ignoredCommands: Set<string>; subtreeMacros: Set<string> }>,
   tabSize?: number,
   insertSpaces?: boolean
) => Promise<string>;

let _langiumFormatFn: LangiumFormatFn | undefined;

async function getLangiumFormat(): Promise<LangiumFormatFn> {
   if (!_langiumFormatFn) {
      // Use `new Function` so esbuild does not convert this import() to require()
      const dynamicImport = new Function('p', 'return import(p)') as
         (p: string) => Promise<{ formatDocument: LangiumFormatFn }>;
      const bundlePath = path.join(__dirname, 'language', 'format-standalone.mjs');
      const mod = await dynamicImport(bundlePath);
      _langiumFormatFn = mod.formatDocument;
   }
   return _langiumFormatFn;
}

// ── Providers ────────────────────────────────────────────────────────────────

export class ForesterDocumentFormattingEditProvider implements vscode.DocumentFormattingEditProvider {
   async provideDocumentFormattingEdits(
      document: vscode.TextDocument,
      options: vscode.FormattingOptions,
      _token: vscode.CancellationToken
   ): Promise<vscode.TextEdit[]> {
      const text = document.getText();
      const ignoredCommands = getIgnoredCommandsSync();
      const subtreeMacros = getSubtreeMacrosSync();

      try {
         const langiumFormat = await getLangiumFormat();
         const formatted = await langiumFormat(text, { ignoredCommands, subtreeMacros }, options.tabSize, options.insertSpaces);

         if (text === formatted) {return [];}

         const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
         );
         return [vscode.TextEdit.replace(fullRange, formatted)];
      } catch (err) {
         console.error('[forester] Langium formatter error:', err);
         return [];
      }
   }
}

export class ForesterDocumentRangeFormattingEditProvider implements vscode.DocumentRangeFormattingEditProvider {
   async provideDocumentRangeFormattingEdits(
      document: vscode.TextDocument,
      _range: vscode.Range,
      options: vscode.FormattingOptions,
      _token: vscode.CancellationToken
   ): Promise<vscode.TextEdit[]> {
      // Range formatting: format the whole document (Langium works on the full
      // parse tree) and replace the entire file — same strategy as before.
      const text = document.getText();
      const ignoredCommands = getIgnoredCommandsSync();
      const subtreeMacros = getSubtreeMacrosSync();

      try {
         const langiumFormat = await getLangiumFormat();
         const formatted = await langiumFormat(text, { ignoredCommands, subtreeMacros }, options.tabSize, options.insertSpaces);

         if (text === formatted) {return [];}

         const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
         );
         return [vscode.TextEdit.replace(fullRange, formatted)];
      } catch (err) {
         console.error('[forester] Langium formatter error:', err);
         return [];
      }
   }
}

/**
 * Log a formatting error to the .forester-logs file
 */
async function logFormatterError(
   filePath: string,
   originalContent: string,
   formattedContent: string,
   details: string
): Promise<void> {
   const workspaceFolders = vscode.workspace.workspaceFolders;
   if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
   }
   
   const logPath = vscode.Uri.joinPath(workspaceFolders[0].uri, ".forester-logs", "formatter-errors.log");
   
   const timestamp = new Date().toISOString();
   const separator = "=".repeat(80);
   const logEntry = `
${separator}
FORMATTER ERROR - ${timestamp}
File: ${filePath}
Issue: ${details}

This isn't supposed to happen: please contact the extension maintainer with this code snippet to fix the formatter.
GitHub: https://github.com/filmerjarred/topos-vscode-forester/issues

--- ORIGINAL CONTENT ---
${originalContent.slice(0, 2000)}${originalContent.length > 2000 ? "\n... (truncated)" : ""}

--- FORMATTED CONTENT (REJECTED) ---
${formattedContent.slice(0, 2000)}${formattedContent.length > 2000 ? "\n... (truncated)" : ""}
${separator}
`;

   try {
      // Ensure directory exists
      const logDir = vscode.Uri.joinPath(workspaceFolders[0].uri, ".forester-logs");
      try {
         await vscode.workspace.fs.stat(logDir);
      } catch {
         await vscode.workspace.fs.createDirectory(logDir);
      }
      
      // Append to log file
      let existingContent = "";
      try {
         const existingData = await vscode.workspace.fs.readFile(logPath);
         existingContent = new TextDecoder().decode(existingData);
      } catch {
         // File doesn't exist yet
      }
      
      const newContent = existingContent + logEntry;
      await vscode.workspace.fs.writeFile(logPath, new TextEncoder().encode(newContent));
   } catch (error) {
      console.error("Failed to write formatter error log:", error);
   }
}

interface FormatAllResult {
   formatted: number;
   skipped: number;
   errors: number;
   unchanged: number;
}

/**
 * Format all .tree files in the workspace with content preservation checking
 */
export async function formatAllTreeFiles(): Promise<void> {
   const workspaceFolders = vscode.workspace.workspaceFolders;
   if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage("No workspace folder open");
      return;
   }
   
   const treeFiles = await vscode.workspace.findFiles("**/*.tree", "**/node_modules/**");
   
   if (treeFiles.length === 0) {
      vscode.window.showInformationMessage("No .tree files found in workspace");
      return;
   }
   
   const result: FormatAllResult = {
      formatted: 0,
      skipped: 0,
      errors: 0,
      unchanged: 0
   };
   
   const ignoredCommands = getIgnoredCommandsSync();
   const subtreeMacros = getSubtreeMacrosSync();
   
   // Get editor config once (assume same for all tree files)
   const editorConfig = vscode.workspace.getConfiguration("editor");
   const tabSize = editorConfig.get<number>("tabSize", 2);
   const insertSpaces = editorConfig.get<boolean>("insertSpaces", true);
   
   const formatOptions = {
      tabSize,
      insertSpaces,
      ignoredCommands,
      subtreeMacros
   };
   
   // Batch size for parallel processing
   const BATCH_SIZE = 20;
   
   // Collect all edits in a single WorkspaceEdit for efficiency
   const workspaceEdit = new vscode.WorkspaceEdit();
   const filesToSave: vscode.Uri[] = [];
   const skippedFiles: Array<{ uri: vscode.Uri; original: string; formatted: string; details: string }> = [];
   
   await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Formatting .tree files",
      cancellable: true
   }, async (progress, token) => {
      const total = treeFiles.length;
      let processed = 0;
      
      // Process files in batches
      for (let i = 0; i < treeFiles.length; i += BATCH_SIZE) {
         if (token.isCancellationRequested) {
            break;
         }
         
         const batch = treeFiles.slice(i, i + BATCH_SIZE);
         
         progress.report({
            message: `Processing ${i + 1}-${Math.min(i + BATCH_SIZE, total)} of ${total}...`,
            increment: 0
         });
         
         // Process batch in parallel
         const batchResults = await Promise.all(
            batch.map(async (uri) => {
               try {
                  // Read file content directly for speed (avoid full document model)
                  const content = await vscode.workspace.fs.readFile(uri);
                  const originalText = Buffer.from(content).toString('utf8');
                  
                  const formattedText = format(originalText, formatOptions);
                  
                  // Check if anything changed
                  if (originalText === formattedText) {
                     return { type: 'unchanged' as const, uri };
                  }
                  
                  // Check content preservation
                  const preservation = checkContentPreservation(originalText, formattedText);
                  
                  if (!preservation.preserved) {
                     return { 
                        type: 'skipped' as const, 
                        uri, 
                        original: originalText, 
                        formatted: formattedText, 
                        details: preservation.details || "Content mismatch" 
                     };
                  }
                  
                  return { type: 'formatted' as const, uri, originalText, formattedText };
               } catch (error) {
                  console.error(`Error formatting ${uri.fsPath}:`, error);
                  return { type: 'error' as const, uri };
               }
            })
         );
         
         // Collect results
         for (const batchResult of batchResults) {
            switch (batchResult.type) {
               case 'unchanged':
                  result.unchanged++;
                  break;
               case 'skipped':
                  skippedFiles.push(batchResult);
                  result.skipped++;
                  break;
               case 'formatted':
                  // Add to workspace edit
                  const fullRange = new vscode.Range(
                     new vscode.Position(0, 0),
                     new vscode.Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
                  );
                  workspaceEdit.replace(batchResult.uri, fullRange, batchResult.formattedText);
                  filesToSave.push(batchResult.uri);
                  result.formatted++;
                  break;
               case 'error':
                  result.errors++;
                  break;
            }
         }
         
         processed += batch.length;
         progress.report({
            increment: (batch.length / total) * 100
         });
      }
      
      // Apply all edits at once
      if (filesToSave.length > 0 && !token.isCancellationRequested) {
         progress.report({ message: `Applying ${filesToSave.length} edits...` });
         await vscode.workspace.applyEdit(workspaceEdit);
         
         // Save all modified files at once
         progress.report({ message: `Saving ${filesToSave.length} files...` });
         await vscode.workspace.saveAll(false);
      }
      
      // Log skipped files (do this after main work)
      if (skippedFiles.length > 0) {
         progress.report({ message: `Logging ${skippedFiles.length} skipped files...` });
         for (const skipped of skippedFiles) {
            await logFormatterError(
               skipped.uri.fsPath,
               skipped.original,
               skipped.formatted,
               skipped.details
            );
         }
      }
   });
   
   // Show summary
   const messages: string[] = [];
   if (result.formatted > 0) {
      messages.push(`${result.formatted} formatted`);
   }
   if (result.unchanged > 0) {
      messages.push(`${result.unchanged} unchanged`);
   }
   if (result.skipped > 0) {
      messages.push(`${result.skipped} skipped (see .forester-logs)`);
   }
   if (result.errors > 0) {
      messages.push(`${result.errors} errors`);
   }
   
   const summary = messages.join(", ");
   
   if (result.skipped > 0) {
      vscode.window.showWarningMessage(`Format All Trees: ${summary}`);
   } else {
      vscode.window.showInformationMessage(`Format All Trees: ${summary}`);
   }
}

// Export for testing and other modules
export { format, tokenize, FormatOptions, checkContentPreservation };
