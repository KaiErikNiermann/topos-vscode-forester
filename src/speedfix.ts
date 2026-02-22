import * as vscode from "vscode";

interface SpeedFixItem {
   diagnostic: vscode.Diagnostic;
   uri: vscode.Uri;
   actions: vscode.CodeAction[];
   text: string; // The problematic text
   context: string; // Surrounding context
   lineNumber: number;
}

/**
 * Check if the diagnostic text is Forester-specific syntax that should be ignored.
 * This filters out:
 * - Backslash commands: \ul, \li, \subtree, \p, \em, \strong, etc.
 * - Math content: anything starting with # like #{}, ##{}
 * - LaTeX commands within math: \sigma, \to, \mathcal, etc.
 * - Code identifiers that look like programming constructs
 */
function isForesterSyntaxNoise(text: string, context: string): boolean {
   const trimmedText = text.trim();
   
   // Backslash commands (Forester macros and LaTeX commands in math)
   // Matches: \ul, \li, \p, \em, \subtree, \sigma, \to, \mathcal, \texttt, etc.
   if (/^\\[a-zA-Z]+$/.test(trimmedText)) {
      return true;
   }
   
   // Backslash commands with arguments like \em{...} detected as just the command
   if (/^\\[a-zA-Z]+\{/.test(trimmedText)) {
      return true;
   }
   
   // Just a backslash followed by anything (macro-like)
   if (/^\\/.test(trimmedText)) {
      return true;
   }
   
   // Hash expressions (inline/display math markers)
   // Matches: #{, ##{, or just # followed by anything
   if (/^#/.test(trimmedText)) {
      return true;
   }
   
   // Content that looks like it's inside math blocks (LaTeX-style)
   // Common math symbols and commands that aren't English words
   if (/^[a-zA-Z]+_[a-zA-Z0-9]+$/.test(trimmedText)) {
      // Subscript notation like id_comp, hom_inv_id
      return true;
   }
   
   // Check if the problematic text appears to be inside a #{} or ##{} block
   // by looking at the context line
   if (isInsideMathBlock(text, context)) {
      return true;
   }
   
   // Single Greek letter names (often flagged as spelling errors)
   const greekLetters = [
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
      'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho',
      'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
      'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta',
      'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho',
      'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'
   ];
   if (greekLetters.includes(trimmedText)) {
      return true;
   }
   
   // Programming/code identifiers (camelCase, snake_case, etc.)
   // These often appear in codeblocks that LTeX still checks
   if (/^[a-z]+[A-Z][a-zA-Z]*$/.test(trimmedText)) {
      // camelCase like "swapInv", "compId"
      return true;
   }
   
   // All caps abbreviations/acronyms (often code or math)
   if (/^[A-Z]{2,}$/.test(trimmedText)) {
      return true;
   }
   
   // Short tokens (1-3 chars) that are likely variable names or abbreviations
   if (/^[a-zA-Z]{1,3}$/.test(trimmedText)) {
      return true;
   }
   
   // Contains special characters common in code/math
   if (/[\\{}$#_^]/.test(trimmedText)) {
      return true;
   }
   
   // Looks like a Forester tree ID (four hex digits like 002d, 0031)
   if (/^[0-9a-f]{4}$/i.test(trimmedText)) {
      return true;
   }
   
   // Common Forester command names without backslash
   const foresterCommands = [
      'ul', 'li', 'ol', 'p', 'em', 'strong', 'taxon', 'title', 'subtree',
      'transclude', 'codeblock', 'blockquote', 'scope', 'put', 'get',
      'def', 'let', 'tex', 'import', 'export', 'namespace', 'open',
      'alloc', 'object', 'patch', 'call', 'query', 'ref', 'date', 'author',
      'contributor', 'tag', 'meta', 'xml'
   ];
   if (foresterCommands.includes(trimmedText.toLowerCase())) {
      return true;
   }
   
   return false;
}

/**
 * Check if the text appears to be inside a math block #{} or ##{}
 * by examining the surrounding context
 */
function isInsideMathBlock(text: string, context: string): boolean {
   const textPos = context.indexOf(text);
   if (textPos === -1) {
      return false;
   }
   
   const beforeText = context.slice(0, Math.max(0, textPos));
   const afterText = context.slice(Math.max(0, textPos + text.length));
   
   // Count unmatched #{ before the text
   let mathDepth = 0;
   let i = 0;
   while (i < beforeText.length) {
      if (beforeText[i] === '#' && beforeText[i + 1] === '{') {
         mathDepth++;
         i += 2;
      } else if (beforeText[i] === '#' && beforeText[i + 1] === '#' && beforeText[i + 2] === '{') {
         mathDepth++;
         i += 3;
      } else if (beforeText[i] === '}') {
         mathDepth = Math.max(0, mathDepth - 1);
         i++;
      } else {
         i++;
      }
   }
   
   // If we have unclosed math blocks, we're inside one
   if (mathDepth > 0) {
      return true;
   }
   
   // Also check for common math patterns in the immediate vicinity
   // Look for LaTeX-style math indicators
   const mathPatterns = [
      /\\[a-zA-Z]+\s*$/,  // Ends with \command
      /^\s*\\[a-zA-Z]+/,  // Starts with \command
      /[_^{}]/,           // Contains math operators
      /\\(to|circ|times|cdot|land|lor|vdash|vDash|in|notin|subset|supset)/i
   ];
   
   const nearContext = beforeText.slice(-30) + text + afterText.slice(0, 30);
   for (const pattern of mathPatterns) {
      if (pattern.test(nearContext)) {
         // Only filter if the text itself looks math-y
         if (/[\\{}_^#]/.test(text) || /^[a-z]$/.test(text)) {
            return true;
         }
      }
   }
   
   return false;
}

interface SpeedFixState {
   items: SpeedFixItem[];
   currentIndex: number;
   panel: vscode.WebviewPanel | null;
}

// Queue for auto-hiding Forester syntax false positives
interface AutoHideItem {
   action: vscode.CodeAction;
   uri: vscode.Uri;
   diagnostic: vscode.Diagnostic;
   text: string;
}

let autoHideQueue: AutoHideItem[] = [];

// Cache for diagnostics - keyed by file URI
interface DiagnosticCacheEntry {
   items: SpeedFixItem[];
   fileVersion: number; // Document version for cache invalidation
   diagnosticCount: number; // Number of diagnostics when cached
}

interface DiagnosticCache {
   entries: Map<string, DiagnosticCacheEntry>;
   lastFullScanTime: number;
}

let state: SpeedFixState = {
   items: [],
   currentIndex: 0,
   panel: null,
};

let diagnosticCache: DiagnosticCache = {
   entries: new Map(),
   lastFullScanTime: 0,
};

// Cache invalidation on file changes
let cacheInvalidationDisposable: vscode.Disposable | null = null;
// Live update listener for SpeedFix (document changes)
let liveUpdateDisposable: vscode.Disposable | null = null;
// Diagnostic change listener for SpeedFix
let diagnosticChangeDisposable: vscode.Disposable | null = null;
// Debounce timer for live updates
let liveUpdateTimeout: NodeJS.Timeout | null = null;
// Debounce timer for diagnostic updates
let diagnosticUpdateTimeout: NodeJS.Timeout | null = null;

function setupCacheInvalidation(): void {
   if (cacheInvalidationDisposable) {
      return;
   }
   
   // Invalidate cache when documents change
   cacheInvalidationDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === "forester" || e.document.fileName.endsWith(".tree")) {
         diagnosticCache.entries.delete(e.document.uri.toString());
      }
   });
}

/**
 * Setup live update listener for SpeedFix panel
 * Watches for document changes and diagnostic updates
 */
function setupLiveUpdate(): void {
   // Setup document change listener
   if (!liveUpdateDisposable) {
      liveUpdateDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
         if (!state.panel || state.items.length === 0) {
            return;
         }
         
         // Check if the changed document is relevant to SpeedFix
         const changedUri = e.document.uri.toString();
         const hasRelevantItems = state.items.some(item => item.uri.toString() === changedUri);
         
         if (!hasRelevantItems) {
            return;
         }
         
         // Debounce updates to avoid excessive refreshes while typing
         if (liveUpdateTimeout) {
            clearTimeout(liveUpdateTimeout);
         }
         
         liveUpdateTimeout = setTimeout(async () => {
            await handleDocumentUpdate(e.document);
         }, 300); // 300ms debounce
      });
   }
   
   // Setup diagnostic change listener - this fires when LTeX updates its diagnostics
   if (!diagnosticChangeDisposable) {
      diagnosticChangeDisposable = vscode.languages.onDidChangeDiagnostics((e) => {
         if (!state.panel || state.items.length === 0) {
            return;
         }
         
         // Check if any of the changed URIs are relevant to SpeedFix
         const relevantUris = e.uris.filter(uri => 
            state.items.some(item => item.uri.toString() === uri.toString())
         );
         
         if (relevantUris.length === 0) {
            return;
         }
         
         // Debounce diagnostic updates
         if (diagnosticUpdateTimeout) {
            clearTimeout(diagnosticUpdateTimeout);
         }
         
         diagnosticUpdateTimeout = setTimeout(async () => {
            await handleDiagnosticUpdate(relevantUris);
         }, 100); // Shorter debounce for diagnostics since they're already debounced by LTeX
      });
   }
}

/**
 * Handle document content update - refresh context preview
 */
async function handleDocumentUpdate(document: vscode.TextDocument): Promise<void> {
   if (!state.panel || state.items.length === 0) {
      return;
   }
   
   const docUri = document.uri.toString();
   
   // Refresh context for all items in this file
   for (const item of state.items) {
      if (item.uri.toString() === docUri) {
         const lineNum = item.diagnostic.range.start.line;
         if (lineNum < document.lineCount) {
            item.context = document.lineAt(lineNum).text.trim();
         }
      }
   }
   
   // Update the webview
   updateWebview();
}

/**
 * Handle diagnostic changes - check if issues are resolved
 */
async function handleDiagnosticUpdate(uris: readonly vscode.Uri[]): Promise<void> {
   if (!state.panel || state.items.length === 0) {
      return;
   }
   
   // Sync against all actual LTeX diagnostics
   await syncWithLtexDiagnostics();
}

/**
 * Sync SpeedFix items with actual LTeX diagnostics across all relevant files.
 * Removes items that no longer have corresponding diagnostics.
 * This ensures the counter precisely matches what LTeX reports.
 */
async function syncWithLtexDiagnostics(): Promise<void> {
   if (!state.panel || state.items.length === 0) {
      return;
   }
   
   // Get all unique URIs from our items
   const uriSet = new Set<string>();
   for (const item of state.items) {
      uriSet.add(item.uri.toString());
   }
   
   // Build a map of all current LTeX diagnostics by URI
   const ltexDiagnosticsByUri = new Map<string, vscode.Diagnostic[]>();
   for (const uriStr of uriSet) {
      const uri = vscode.Uri.parse(uriStr);
      const allDiagnostics = vscode.languages.getDiagnostics(uri);
      const ltexDiagnostics = allDiagnostics.filter(d => 
         d.source?.toLowerCase().includes("ltex") ||
         d.source?.toLowerCase().includes("spell") ||
         d.source?.toLowerCase().includes("grammar")
      );
      ltexDiagnosticsByUri.set(uriStr, ltexDiagnostics);
   }
   
   // Check each item and remove if its diagnostic no longer exists
   let itemsRemoved = false;
   const currentItemText = state.items[state.currentIndex]?.text;
   
   for (let i = state.items.length - 1; i >= 0; i--) {
      const item = state.items[i];
      const uriStr = item.uri.toString();
      const ltexDiagnostics = ltexDiagnosticsByUri.get(uriStr) || [];
      
      // Check if this item's diagnostic still exists in LTeX
      const stillExists = ltexDiagnostics.some(d => diagnosticsMatch(item.diagnostic, d));
      
      if (!stillExists) {
         // This issue was resolved or no longer reported by LTeX
         state.items.splice(i, 1);
         itemsRemoved = true;
         
         // Adjust currentIndex if needed
         if (i < state.currentIndex) {
            state.currentIndex--;
         } else if (i === state.currentIndex && state.currentIndex >= state.items.length) {
            state.currentIndex = Math.max(0, state.items.length - 1);
         }
      }
   }
   
   // Invalidate caches for affected files
   for (const uriStr of uriSet) {
      const uri = vscode.Uri.parse(uriStr);
      invalidateCacheForUri(uri);
   }
   
   // Update the webview if anything changed
   if (itemsRemoved) {
      updateWebview();
   }
}

/**
 * Check if two diagnostics match (same issue)
 */
function diagnosticsMatch(a: vscode.Diagnostic, b: vscode.Diagnostic): boolean {
   // Must have same message
   if (a.message !== b.message) {
      return false;
   }
   
   // Must be on the same line
   if (a.range.start.line !== b.range.start.line) {
      return false;
   }
   
   // Character position can shift slightly due to edits, allow some tolerance
   // but not too much - within 3 characters should be the same issue
   if (Math.abs(a.range.start.character - b.range.start.character) > 3) {
      return false;
   }
   
   return true;
}

/**
 * Cleanup live update listeners
 */
function cleanupLiveUpdate(): void {
   if (liveUpdateTimeout) {
      clearTimeout(liveUpdateTimeout);
      liveUpdateTimeout = null;
   }
   if (diagnosticUpdateTimeout) {
      clearTimeout(diagnosticUpdateTimeout);
      diagnosticUpdateTimeout = null;
   }
   if (liveUpdateDisposable) {
      liveUpdateDisposable.dispose();
      liveUpdateDisposable = null;
   }
   if (diagnosticChangeDisposable) {
      diagnosticChangeDisposable.dispose();
      diagnosticChangeDisposable = null;
   }
}

/**
 * Check if cache entry is still valid
 */
function isCacheValid(uri: vscode.Uri, currentDiagnosticCount: number): boolean {
   const entry = diagnosticCache.entries.get(uri.toString());
   if (!entry) {
      return false;
   }
   
   // Invalid if diagnostic count changed (LTeX updated its analysis)
   if (entry.diagnosticCount !== currentDiagnosticCount) {
      return false;
   }
   
   // Cache is valid for 30 seconds max (in case LTeX re-analyzes)
   const cacheAge = Date.now() - diagnosticCache.lastFullScanTime;
   if (cacheAge > 30000) {
      return false;
   }
   
   return true;
}

/**
 * Collect diagnostics for a single file with caching
 */
async function collectFileItems(
   uri: vscode.Uri,
   diagnostics: vscode.Diagnostic[],
   progress: vscode.Progress<{ message?: string; increment?: number }>,
   fileIndex: number,
   totalFiles: number
): Promise<SpeedFixItem[]> {
   // Filter for LTeX diagnostics
   const ltexDiagnostics = diagnostics.filter(d => 
      d.source === "LTeX" || 
      d.source === "ltex" ||
      d.source?.toLowerCase().includes("spell") ||
      d.source?.toLowerCase().includes("grammar")
   );
   
   if (ltexDiagnostics.length === 0) {
      return [];
   }
   
   // Check cache
   const cacheKey = uri.toString();
   if (isCacheValid(uri, ltexDiagnostics.length)) {
      const cached = diagnosticCache.entries.get(cacheKey);
      if (cached) {
         return cached.items;
      }
   }
   
   // Load document
   const doc = await vscode.workspace.openTextDocument(uri);
   const fileName = uri.path.split("/").pop() || "";
   
   progress.report({
      message: `${fileName} (${fileIndex}/${totalFiles}) - ${ltexDiagnostics.length} issues`,
   });
   
   const items: SpeedFixItem[] = [];
   
   // Batch fetch code actions - process in chunks for better performance
   const BATCH_SIZE = 10;
   for (let i = 0; i < ltexDiagnostics.length; i += BATCH_SIZE) {
      const batch = ltexDiagnostics.slice(i, i + BATCH_SIZE);
      
      // Fetch code actions in parallel for this batch
      const actionPromises = batch.map(async (diagnostic) => {
         const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            "vscode.executeCodeActionProvider",
            uri,
            diagnostic.range,
            vscode.CodeActionKind.QuickFix.value
         ) || [];
         
         return {
            diagnostic,
            actions,
            text: doc.getText(diagnostic.range),
            context: doc.lineAt(diagnostic.range.start.line).text.trim(),
            lineNumber: diagnostic.range.start.line + 1,
         };
      });
      
      const batchResults = await Promise.all(actionPromises);
      
      for (const result of batchResults) {
         // Filter out Forester-specific syntax noise (backslash commands, math content, etc.)
         // and auto-hide these false positives
         if (isForesterSyntaxNoise(result.text, result.context)) {
            // Find and apply the "hide false positive" action automatically
            const hideAction = result.actions.find(a => isHideFalsePositiveAction(a));
            if (hideAction) {
               // Queue this for auto-hiding (we'll process these after collecting)
               autoHideQueue.push({
                  action: hideAction,
                  uri,
                  diagnostic: result.diagnostic,
                  text: result.text,
               });
            }
            continue;
         }
         
         items.push({
            diagnostic: result.diagnostic,
            uri,
            actions: result.actions,
            text: result.text,
            context: result.context,
            lineNumber: result.lineNumber,
         });
      }
   }
   
   // Update cache
   diagnosticCache.entries.set(cacheKey, {
      items,
      fileVersion: doc.version,
      diagnosticCount: ltexDiagnostics.length,
   });
   
   return items;
}

/**
 * Collect all spelling/grammar diagnostics from LTeX in the workspace
 * Optimized with batching, parallel processing, and caching
 */
async function collectDiagnostics(
   progress: vscode.Progress<{ message?: string; increment?: number }>,
   token: vscode.CancellationToken
): Promise<SpeedFixItem[]> {
   setupCacheInvalidation();
   
   // Get all .tree files
   const treeFiles = await vscode.workspace.findFiles("**/*.tree", "**/node_modules/**");
   
   if (treeFiles.length === 0) {
      return [];
   }
   
   // First pass: quickly count total diagnostics for progress
   progress.report({ message: "Scanning for issues..." });
   
   const filesWithDiagnostics: { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }[] = [];
   let totalDiagnostics = 0;
   
   for (const uri of treeFiles) {
      if (token.isCancellationRequested) {
         return [];
      }
      
      const diagnostics = vscode.languages.getDiagnostics(uri);
      const ltexDiagnostics = diagnostics.filter(d => 
         d.source === "LTeX" || 
         d.source === "ltex" ||
         d.source?.toLowerCase().includes("spell") ||
         d.source?.toLowerCase().includes("grammar")
      );
      
      if (ltexDiagnostics.length > 0) {
         filesWithDiagnostics.push({ uri, diagnostics: ltexDiagnostics });
         totalDiagnostics += ltexDiagnostics.length;
      }
   }
   
   progress.report({ 
      message: `Found ${totalDiagnostics} issues in ${filesWithDiagnostics.length} files. Loading...` 
   });
   
   if (filesWithDiagnostics.length === 0) {
      return [];
   }
   
   // Update cache timestamp
   diagnosticCache.lastFullScanTime = Date.now();
   
   // Second pass: collect items with progress
   const allItems: SpeedFixItem[] = [];
   const incrementPerFile = 100 / filesWithDiagnostics.length;
   
   // Process files in parallel batches for speed
   const FILE_BATCH_SIZE = 5;
   for (let i = 0; i < filesWithDiagnostics.length; i += FILE_BATCH_SIZE) {
      if (token.isCancellationRequested) {
         return allItems;
      }
      
      const batch = filesWithDiagnostics.slice(i, i + FILE_BATCH_SIZE);
      
      const batchPromises = batch.map((file, batchIndex) => 
         collectFileItems(
            file.uri, 
            file.diagnostics, 
            progress, 
            i + batchIndex + 1, 
            filesWithDiagnostics.length
         )
      );
      
      const batchResults = await Promise.all(batchPromises);
      
      for (const items of batchResults) {
         allItems.push(...items);
      }
      
      progress.report({ 
         increment: incrementPerFile * batch.length,
         message: `Loaded ${allItems.length}/${totalDiagnostics} issues...`
      });
   }
   
   return allItems;
}

/**
 * Re-fetch fresh code actions for a diagnostic to avoid stale edits
 * Handles cases where multiple identical diagnostics exist on the same line
 */
async function getFreshCodeActions(
   uri: vscode.Uri, 
   diagnostic: vscode.Diagnostic,
   originalText: string
): Promise<{ actions: vscode.CodeAction[], diagnostic: vscode.Diagnostic | null }> {
   // Get fresh diagnostics from LTeX for this file
   const currentDiagnostics = vscode.languages.getDiagnostics(uri);
   const doc = await vscode.workspace.openTextDocument(uri);
   
   // Find all matching diagnostics (same message, source, line)
   const matchingDiagnostics = currentDiagnostics.filter(d => 
      d.message === diagnostic.message &&
      d.source === diagnostic.source &&
      d.range.start.line === diagnostic.range.start.line
   );
   
   if (matchingDiagnostics.length === 0) {
      // Diagnostic no longer exists (maybe already fixed)
      return { actions: [], diagnostic: null };
   }
   
   // If only one match, use it
   if (matchingDiagnostics.length === 1) {
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
         "vscode.executeCodeActionProvider",
         uri,
         matchingDiagnostics[0].range,
         vscode.CodeActionKind.QuickFix.value
      ) || [];
      return { actions, diagnostic: matchingDiagnostics[0] };
   }
   
   // Multiple matches on same line - try to match by the actual text at that position
   // This handles cases like multiple "its" on the same line
   for (const matchDiag of matchingDiagnostics) {
      const textAtRange = doc.getText(matchDiag.range);
      if (textAtRange === originalText) {
         // Found a match with the same text - this is likely the right one
         const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            "vscode.executeCodeActionProvider",
            uri,
            matchDiag.range,
            vscode.CodeActionKind.QuickFix.value
         ) || [];
         return { actions, diagnostic: matchDiag };
      }
   }
   
   // Fallback: just use the first matching diagnostic
   const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      uri,
      matchingDiagnostics[0].range,
      vscode.CodeActionKind.QuickFix.value
   ) || [];
   return { actions, diagnostic: matchingDiagnostics[0] };
}

/**
 * Ensure the document is open and the editor is ready and ACTIVE
 */
async function ensureEditorReady(uri: vscode.Uri): Promise<vscode.TextEditor> {
   const doc = await vscode.workspace.openTextDocument(uri);
   
   // Always show the document to make it the active editor
   // LTeX commands require the editor to be active, not just visible
   const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false, // Must give focus for LTeX commands to work
      preview: true
   });
   
   // Longer delay to ensure editor is fully ready and LTeX has updated
   await new Promise(resolve => setTimeout(resolve, 100));
   
   return editor;
}

/**
 * Apply a code action, ensuring the document is open first
 * Re-fetches fresh code actions to avoid stale edit ranges
 */
async function applyAction(
   cachedAction: vscode.CodeAction, 
   uri: vscode.Uri,
   diagnostic: vscode.Diagnostic,
   originalText: string
): Promise<boolean> {
   // Ensure the document is open and editor is ready
   await ensureEditorReady(uri);
   
   // Re-fetch fresh code actions to get current ranges
   const { actions: freshActions, diagnostic: freshDiagnostic } = await getFreshCodeActions(uri, diagnostic, originalText);
   
   if (freshActions.length === 0 || !freshDiagnostic) {
      vscode.window.showWarningMessage("SpeedFix: Issue may have already been resolved.");
      return false;
   }
   
   // Find the matching action by title
   const freshAction = freshActions.find(a => a.title === cachedAction.title);
   
   if (!freshAction) {
      // Fallback: try to find a similar action
      const similarAction = freshActions.find(a => 
         a.title.toLowerCase().includes(cachedAction.title.toLowerCase().split(' ')[0])
      );
      if (similarAction) {
         return applyFreshAction(similarAction);
      }
      vscode.window.showWarningMessage("SpeedFix: Could not find matching fix. Try refreshing.");
      return false;
   }
   
   return applyFreshAction(freshAction);
}

/**
 * Apply a fresh code action
 */
async function applyFreshAction(action: vscode.CodeAction): Promise<boolean> {
   try {
      if (action.edit) {
         await vscode.workspace.applyEdit(action.edit);
      }
      if (action.command) {
         await vscode.commands.executeCommand(
            action.command.command,
            ...(action.command.arguments || [])
         );
      }
      return true;
   } catch (error) {
      console.error("SpeedFix: Error applying action:", error);
      return false;
   }
}

/**
 * Refresh the context (line text) for items in the same file after an edit
 * This ensures the preview shows the updated text after fixes
 */
async function refreshContextForFile(uri: vscode.Uri): Promise<void> {
   try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const uriString = uri.toString();
      
      for (const item of state.items) {
         if (item.uri.toString() === uriString) {
            // Update the context with the current line text
            const lineNum = item.diagnostic.range.start.line;
            if (lineNum < doc.lineCount) {
               item.context = doc.lineAt(lineNum).text.trim();
            }
         }
      }
   } catch (error) {
      console.error("SpeedFix: Error refreshing context:", error);
   }
}

/**
 * Check if an action is an "add to dictionary" action
 */
function isDictionaryAction(action: vscode.CodeAction): boolean {
   const title = action.title.toLowerCase();
   return title.includes("add") && (
      title.includes("dictionary") ||
      title.includes("ltex") ||
      title.includes("ignore")
   );
}

/**
 * Check if an action is a "hide false positive" action
 */
function isHideFalsePositiveAction(action: vscode.CodeAction): boolean {
   const title = action.title.toLowerCase();
   return title.includes("hide") && title.includes("false");
}

/**
 * Remove all items with the same problematic word (case-insensitive)
 * Returns the count of removed items (excluding the current one)
 */
function removeItemsWithSameWord(word: string, currentIndex: number): number {
   const wordLower = word.toLowerCase().trim();
   let removedCount = 0;
   
   // Iterate backwards to safely remove items
   for (let i = state.items.length - 1; i >= 0; i--) {
      if (i === currentIndex) {
         continue; // Skip current item, it will be handled separately
      }
      
      const itemWord = state.items[i].text.toLowerCase().trim();
      if (itemWord === wordLower) {
         state.items.splice(i, 1);
         removedCount++;
         
         // Adjust currentIndex if we removed an item before it
         if (i < currentIndex) {
            state.currentIndex--;
         }
      }
   }
   
   return removedCount;
}

/**
 * Get the webview HTML content
 */
function getWebviewContent(item: SpeedFixItem | null, index: number, total: number): string {
   function escapeHtml(text: string): string {
      return text
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;");
   }

   function highlightInContext(context: string, text: string): string {
      const escaped = escapeHtml(context);
      const escapedText = escapeHtml(text);
      return escaped.replace(escapedText, `<span class="highlight">${escapedText}</span>`);
   }

   if (!item) {
      return `<!DOCTYPE html>
      <html>
      <head>
         <style>
            body {
               font-family: var(--vscode-font-family);
               background: var(--vscode-editor-background);
               color: var(--vscode-editor-foreground);
               padding: 20px;
               display: flex;
               flex-direction: column;
               align-items: center;
               justify-content: center;
               height: 80vh;
            }
            .done {
               font-size: 48px;
               margin-bottom: 20px;
            }
            .message {
               font-size: 18px;
               color: var(--vscode-descriptionForeground);
            }
            .shortcut {
               margin-top: 20px;
               padding: 10px 20px;
               background: var(--vscode-button-background);
               color: var(--vscode-button-foreground);
               border: none;
               border-radius: 4px;
               cursor: pointer;
            }
         </style>
      </head>
      <body>
         <div class="done">✨</div>
         <div class="message">All done! No more issues to fix.</div>
         <button class="shortcut" onclick="close()">Close (Esc)</button>
         <script>
            const vscode = acquireVsCodeApi();
            document.addEventListener('keydown', (e) => {
               if (e.key === 'Escape') {
                  vscode.postMessage({ type: 'close' });
               }
            });
            function close() {
               vscode.postMessage({ type: 'close' });
            }
         </script>
      </body>
      </html>`;
   }

   const fileName = item.uri.path.split("/").pop() || "";
   
   // Helper to check if action is a dictionary action
   const isDictAction = (title: string) => {
      const t = title.toLowerCase();
      return t.includes("add") && (t.includes("dictionary") || t.includes("ltex") || t.includes("ignore"));
   };
   
   // Helper to check if action is a hide false positive action
   const isHideAction = (title: string) => {
      const t = title.toLowerCase();
      return t.includes("hide") && t.includes("false");
   };
   
   const actionsHtml = item.actions.map((action, i) => {
      const key = i < 9 ? (i + 1).toString() : i === 9 ? "0" : "";
      const keyHint = key ? `<span class="key">${key}</span>` : "";
      const isDict = isDictAction(action.title);
      const isHide = isHideAction(action.title);
      return `<button class="action" data-index="${i}" data-is-dictionary="${isDict}" data-is-hide="${isHide}" onclick="selectAction(${i})">
         ${keyHint}
         ${isDict ? '<span class="key">A</span>' : ''}
         ${isHide ? '<span class="key">H</span>' : ''}
         <span class="action-title">${escapeHtml(action.title)}</span>
      </button>`;
   }).join("");

   return `<!DOCTYPE html>
   <html>
   <head>
      <style>
         * { box-sizing: border-box; }
         body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 0;
            margin: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
         }
         .header {
            padding: 12px 20px;
            background: var(--vscode-titleBar-activeBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
         }
         .progress {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
         }
         .progress-bar {
            width: 100px;
            height: 4px;
            background: var(--vscode-progressBar-background);
            border-radius: 2px;
            overflow: hidden;
         }
         .progress-fill {
            height: 100%;
            background: var(--vscode-progressBar-background);
            background: var(--vscode-textLink-foreground);
            transition: width 0.2s;
         }
         .shortcuts {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
         }
         .shortcuts kbd {
            background: var(--vscode-keybindingLabel-background);
            border: 1px solid var(--vscode-keybindingLabel-border);
            border-radius: 3px;
            padding: 1px 5px;
            font-size: 11px;
         }
         .main {
            flex: 1;
            padding: 20px;
            overflow: auto;
         }
         .location {
            font-size: 12px;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 8px;
            cursor: pointer;
         }
         .location:hover {
            text-decoration: underline;
         }
         .error-text {
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 8px;
            color: var(--vscode-errorForeground);
         }
         .context {
            font-family: var(--vscode-editor-font-family);
            font-size: 14px;
            background: var(--vscode-textCodeBlock-background);
            padding: 12px 16px;
            border-radius: 6px;
            margin-bottom: 16px;
            white-space: pre-wrap;
            word-break: break-word;
         }
         .highlight {
            background: var(--vscode-editor-findMatchHighlightBackground);
            border-bottom: 2px solid var(--vscode-errorForeground);
         }
         .message {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 20px;
         }
         .actions {
            display: flex;
            flex-direction: column;
            gap: 8px;
         }
         .action {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 6px;
            cursor: pointer;
            text-align: left;
            font-size: 14px;
            transition: all 0.1s;
         }
         .action:hover, .action:focus {
            background: var(--vscode-button-secondaryHoverBackground);
            outline: none;
         }
         .action.selected {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            outline: 2px solid var(--vscode-focusBorder);
            outline-offset: -2px;
         }
         .action.selected:hover {
            background: var(--vscode-button-hoverBackground);
         }
         .key {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            background: var(--vscode-keybindingLabel-background);
            border: 1px solid var(--vscode-keybindingLabel-border);
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
            flex-shrink: 0;
         }
         .action-title {
            flex: 1;
         }
         .nav-buttons {
            display: flex;
            gap: 8px;
            margin-top: 16px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-panel-border);
         }
         .nav-btn {
            padding: 8px 16px;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
         }
         .nav-btn:hover {
            background: var(--vscode-list-hoverBackground);
         }
         .nav-btn kbd {
            background: var(--vscode-keybindingLabel-background);
            border: 1px solid var(--vscode-keybindingLabel-border);
            border-radius: 3px;
            padding: 1px 5px;
            font-size: 11px;
            margin-right: 6px;
         }
         .loading-bar {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 3px;
            background: transparent;
            overflow: hidden;
            opacity: 0;
            transition: opacity 0.2s;
            z-index: 1000;
         }
         .loading-bar.active {
            opacity: 1;
         }
         .loading-bar::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 30%;
            height: 100%;
            background: linear-gradient(90deg, transparent, var(--vscode-textLink-foreground), transparent);
            animation: loading-slide 1s ease-in-out infinite;
         }
         @keyframes loading-slide {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(400%); }
         }
         .main.loading {
            opacity: 0.6;
            pointer-events: none;
         }
      </style>
   </head>
   <body>
      <div class="loading-bar" id="loadingBar"></div>
      <div class="header">
         <div>
            <div class="progress">${index + 1} / ${total}</div>
            <div class="progress-bar">
               <div class="progress-fill" style="width: ${((index + 1) / total) * 100}%"></div>
            </div>
         </div>
         <div class="shortcuts">
            <kbd>↑↓</kbd> select · <kbd>Enter</kbd> apply · <kbd>A</kbd> add to dict · <kbd>S</kbd> skip · <kbd>←→</kbd> nav · <kbd>Esc</kbd> close
         </div>
      </div>
      <div class="main" id="mainContent">
         <div class="location" onclick="goToLocation()">${escapeHtml(fileName)}:${item.lineNumber}</div>
         <div class="error-text">${escapeHtml(item.text)}</div>
         <div class="context">${highlightInContext(item.context, item.text)}</div>
         <div class="message">${escapeHtml(item.diagnostic.message)}</div>
         <div class="actions">
            ${actionsHtml}
         </div>
         <div class="nav-buttons">
            <button class="nav-btn" onclick="skip()"><kbd>S</kbd>Skip</button>
            <button class="nav-btn" onclick="prev()"><kbd>←</kbd>Previous</button>
            <button class="nav-btn" onclick="next()"><kbd>→</kbd>Next</button>
            <button class="nav-btn refresh-btn" onclick="refresh()"><kbd>R</kbd>Refresh</button>
         </div>
      </div>
      <script>
         const vscode = acquireVsCodeApi();
         let selectedIndex = 0;
         const actions = document.querySelectorAll('.action');
         
         function updateSelection() {
            actions.forEach((el, i) => {
               el.classList.toggle('selected', i === selectedIndex);
            });
            // Scroll selected into view
            if (actions[selectedIndex]) {
               actions[selectedIndex].scrollIntoView({ block: 'nearest' });
            }
         }
         
         // Initialize selection
         updateSelection();
         
         document.addEventListener('keydown', (e) => {
            // Up/Down for action selection
            if (e.key === 'ArrowUp' || e.key === 'k') {
               e.preventDefault();
               if (selectedIndex > 0) {
                  selectedIndex--;
                  updateSelection();
               }
               return;
            }
            if (e.key === 'ArrowDown' || e.key === 'j') {
               e.preventDefault();
               if (selectedIndex < actions.length - 1) {
                  selectedIndex++;
                  updateSelection();
               }
               return;
            }
            
            // Number keys 1-9, 0 for selecting actions
            if (e.key >= '1' && e.key <= '9') {
               const index = parseInt(e.key) - 1;
               selectAction(index);
               return;
            }
            if (e.key === '0') {
               selectAction(9);
               return;
            }
            
            // 'A' for add to dictionary
            if (e.key === 'a' || e.key === 'A') {
               const dictAction = document.querySelector('.action[data-is-dictionary="true"]');
               if (dictAction) {
                  const index = parseInt(dictAction.getAttribute('data-index') || '0');
                  selectAction(index);
               }
               return;
            }
            
            // 'H' for hide false positive
            if (e.key === 'h' || e.key === 'H') {
               const hideAction = document.querySelector('.action[data-is-hide="true"]');
               if (hideAction) {
                  const index = parseInt(hideAction.getAttribute('data-index') || '0');
                  selectAction(index);
               }
               return;
            }
            
            // Navigation
            if (e.key === 's' || e.key === 'S') {
               skip();
               return;
            }
            if (e.key === 'ArrowLeft') {
               prev();
               return;
            }
            if (e.key === 'ArrowRight' || e.key === 'l') {
               next();
               return;
            }
            if (e.key === 'r' || e.key === 'R') {
               refresh();
               return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
               e.preventDefault();
               selectAction(selectedIndex);
               return;
            }
            if (e.key === 'Escape') {
               vscode.postMessage({ type: 'close' });
               return;
            }
         });
         
         function selectAction(index) {
            showLoading();
            vscode.postMessage({ type: 'action', index });
         }
         
         function skip() {
            vscode.postMessage({ type: 'skip' });
         }
         
         function prev() {
            vscode.postMessage({ type: 'prev' });
         }
         
         function next() {
            vscode.postMessage({ type: 'next' });
         }
         
         function refresh() {
            showLoading();
            vscode.postMessage({ type: 'refresh' });
         }
         
         function goToLocation() {
            vscode.postMessage({ type: 'goto' });
         }
         
         function showLoading() {
            document.getElementById('loadingBar').classList.add('active');
            document.getElementById('mainContent').classList.add('loading');
         }
         
         function hideLoading() {
            document.getElementById('loadingBar').classList.remove('active');
            document.getElementById('mainContent').classList.remove('loading');
         }
         
         // Listen for messages from the extension
         window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'loading') {
               if (message.show) {
                  showLoading();
               } else {
                  hideLoading();
               }
            }
         });
      </script>
   </body>
   </html>`;
}

/**
 * Update the webview with current item
 */
function updateWebview(): void {
   if (!state.panel) {
      return;
   }
   
   const item = state.items[state.currentIndex] || null;
   state.panel.webview.html = getWebviewContent(item, state.currentIndex, state.items.length);
}

/**
 * Send loading state to the webview
 */
function setWebviewLoading(show: boolean): void {
   if (!state.panel) {
      return;
   }
   state.panel.webview.postMessage({ type: 'loading', show });
}

/**
 * Go to the location of the current item in the editor
 */
async function goToLocation(): Promise<void> {
   const item = state.items[state.currentIndex];
   if (!item) {
      return;
   }
   
   const editor = await ensureEditorReady(item.uri);
   editor.selection = new vscode.Selection(item.diagnostic.range.start, item.diagnostic.range.end);
   editor.revealRange(item.diagnostic.range, vscode.TextEditorRevealType.InCenter);
}

/**
 * Open the SpeedFix panel
 */
export async function openSpeedFix(): Promise<void> {
   // Show progress while collecting diagnostics
   const cancelled = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "⚡ SpeedFix",
      cancellable: true
   }, async (progress, token) => {
      state.items = await collectDiagnostics(progress, token);
      state.currentIndex = 0;
      return token.isCancellationRequested;
   });

   if (cancelled) {
      return;
   }

   if (state.items.length === 0) {
      vscode.window.showInformationMessage("SpeedFix: No spelling or grammar issues found!");
      return;
   }

   // Create or reveal the panel
   if (state.panel) {
      state.panel.reveal(vscode.ViewColumn.Two);
   } else {
      state.panel = vscode.window.createWebviewPanel(
         "foresterSpeedFix",
         "⚡ SpeedFix",
         vscode.ViewColumn.Two,
         {
            enableScripts: true,
            retainContextWhenHidden: true,
         }
      );

      // Setup live update listener for this session
      setupLiveUpdate();

      state.panel.onDidDispose(() => {
         state.panel = null;
         // Cleanup live update listener when panel closes
         cleanupLiveUpdate();
      });

      state.panel.webview.onDidReceiveMessage(async (message) => {
         switch (message.type) {
            case "action":
               const item = state.items[state.currentIndex];
               if (item && item.actions[message.index]) {
                  const action = item.actions[message.index];
                  const wasDictionaryAction = isDictionaryAction(action);
                  const word = item.text;
                  
                  const success = await applyAction(action, item.uri, item.diagnostic, item.text);
                  
                  if (!success) {
                     // Action failed, remove this item anyway to avoid getting stuck
                     state.items.splice(state.currentIndex, 1);
                     if (state.currentIndex >= state.items.length) {
                        state.currentIndex = Math.max(0, state.items.length - 1);
                     }
                     updateWebview();
                     // Re-focus the SpeedFix panel (preserveFocus: false to take focus)
                     state.panel?.reveal(vscode.ViewColumn.Two, false);
                     break;
                  }
                  
                  // Refresh context for other items in the same file to show updated text
                  await refreshContextForFile(item.uri);
                  
                  // Invalidate cache for this file since we made changes
                  invalidateCacheForUri(item.uri);
                  
                  // If this was a dictionary action, remove all items with the same word immediately
                  // (these won't be removed by LTeX diagnostic sync since dictionary additions
                  // affect future analysis, but current diagnostics may not update immediately)
                  let extraRemoved = 0;
                  if (wasDictionaryAction) {
                     extraRemoved = removeItemsWithSameWord(word, state.currentIndex);
                     if (extraRemoved > 0) {
                        vscode.window.showInformationMessage(
                           `⚡ Added "${word}" to dictionary - auto-resolved ${extraRemoved} more occurrence${extraRemoved === 1 ? '' : 's'}!`
                        );
                     }
                     // Also remove current item for dictionary actions
                     state.items.splice(state.currentIndex, 1);
                     if (state.currentIndex >= state.items.length) {
                        state.currentIndex = Math.max(0, state.items.length - 1);
                     }
                  } else {
                     // For non-dictionary actions, wait for LTeX to update and sync with actual diagnostics
                     // This ensures our counter precisely matches what LTeX reports
                     await new Promise(resolve => setTimeout(resolve, 500)); // Wait for LTeX to process
                     await syncWithLtexDiagnostics();
                  }
               }
               updateWebview();
               // Re-focus the SpeedFix panel after applying action (preserveFocus: false to take focus)
               state.panel?.reveal(vscode.ViewColumn.Two, false);
               break;
            
            case "skip":
            case "next":
               if (state.currentIndex < state.items.length - 1) {
                  state.currentIndex++;
                  updateWebview();
               }
               break;
            
            case "prev":
               if (state.currentIndex > 0) {
                  state.currentIndex--;
                  updateWebview();
               }
               break;
            
            case "goto":
               await goToLocation();
               break;
            
            case "refresh":
               // Manually sync with LTeX diagnostics
               await syncWithLtexDiagnostics();
               updateWebview();
               break;
            
            case "close":
               state.panel?.dispose();
               break;
         }
      });
   }

   updateWebview();
   
   // Show the first item's location, then refocus the SpeedFix panel
   await goToLocation();
   
   // Small delay then refocus the panel so keyboard works immediately
   await new Promise(resolve => setTimeout(resolve, 50));
   state.panel?.reveal(vscode.ViewColumn.Two, false);
}

/**
 * Clear the diagnostic cache (call after applying fixes)
 */
function invalidateCacheForUri(uri: vscode.Uri): void {
   diagnosticCache.entries.delete(uri.toString());
}

/**
 * Generate dictionary entries for common Forester/LaTeX terms.
 * These are words that appear in plain text after LTEX strips markup.
 * 
 * Note: LTEX's hiddenFalsePositives regex matches against PLAIN TEXT,
 * not the original source. LTEX first converts documents to plain text
 * (stripping commands like \ul, \mathcal, etc.), then applies rules.
 * So we cannot match \commands in hiddenFalsePositives - instead we
 * add common terms to the dictionary.
 */
function generateForesterDictionaryEntries(): string[] {
   return [
      // Forester command names (appear as plain text after LTeX strips backslash)
      // e.g., \ol{...} becomes "ol" in plain text
      'ul', 'li', 'ol', 'em', 'kbd',
      'subtree', 'transclude', 'codeblock', 'blockquote',
      'taxon', 'xmlns', 'alloc', 'def',
      'tex', 'xml', 'namespace',
      
      // Greek letters (common in math)
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
      'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho',
      'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
      'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta',
      'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho',
      'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega',
      'varepsilon', 'varphi', 'varpi', 'varrho', 'varsigma', 'vartheta',
      
      // Common math/category theory terms
      'functor', 'functors', 'morphism', 'morphisms', 'homomorphism', 'homomorphisms',
      'isomorphism', 'isomorphisms', 'endomorphism', 'endomorphisms', 'automorphism', 'automorphisms',
      'bijection', 'bijections', 'surjection', 'surjections', 'injection', 'injections',
      'colimit', 'colimits', 'pullback', 'pullbacks', 'pushout', 'pushouts',
      'cokernel', 'cokernels', 'codomain', 'codomains', 'coproduct', 'coproducts',
      'monoid', 'monoids', 'groupoid', 'groupoids', 'topos', 'topoi', 'toposes',
      'presheaf', 'presheaves', 'sheaf', 'sheaves', 'fibration', 'fibrations',
      'hom', 'Hom', 'dom', 'cod', 'ker', 'coker', 'im', 'coim',
      'op', 'id', 'ob', 'Ob', 'arr', 'Arr', 'mor', 'Mor',
      'colim', 'lim', 'proj', 'inj',
      
      // LaTeX math command names (appear as plain text after backslash stripped)
      'mathcal', 'mathbb', 'mathbf', 'mathrm', 'mathsf', 'mathfrak', 'mathit', 'mathtt',
      'textbf', 'textit', 'textrm', 'texttt', 'textsf', 'textsc',
      'frac', 'dfrac', 'tfrac', 'cfrac',
      'sqrt', 'root', 'binom', 'tbinom', 'dbinom',
      'sum', 'prod', 'coprod', 'bigcup', 'bigcap', 'bigoplus', 'bigotimes', 'bigsqcup',
      'int', 'oint', 'iint', 'iiint',
      'lim', 'liminf', 'limsup', 'inf', 'sup', 'max', 'min',
      'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
      'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
      'log', 'ln', 'lg', 'exp', 'det', 'dim', 'deg', 'gcd', 'lcm',
      'infty', 'cdot', 'cdots', 'ldots', 'ddots', 'vdots',
      'circ', 'oplus', 'otimes', 'ominus', 'odot', 'oslash',
      'times', 'div', 'pm', 'mp', 'ast', 'star', 'dagger', 'ddagger',
      'wedge', 'vee', 'cap', 'cup', 'sqcap', 'sqcup', 'uplus',
      'vdash', 'vDash', 'dashv', 'Vdash', 'Vvdash', 'nvdash', 'nvDash',
      'models', 'perp', 'mid', 'nmid', 'parallel', 'nparallel',
      'leq', 'geq', 'neq', 'approx', 'equiv', 'cong', 'sim', 'simeq', 'propto',
      'prec', 'succ', 'preceq', 'succeq', 'll', 'gg',
      'subset', 'supset', 'subseteq', 'supseteq', 'subsetneq', 'supsetneq',
      'in', 'ni', 'notin', 'owns',
      'forall', 'exists', 'nexists', 'emptyset', 'varnothing',
      'land', 'lor', 'lnot', 'neg', 'implies', 'iff',
      'to', 'gets', 'mapsto', 'longmapsto',
      'leftarrow', 'rightarrow', 'leftrightarrow',
      'Leftarrow', 'Rightarrow', 'Leftrightarrow',
      'longleftarrow', 'longrightarrow', 'longleftrightarrow',
      'Longleftarrow', 'Longrightarrow', 'Longleftrightarrow',
      'hookrightarrow', 'hookleftarrow', 'twoheadrightarrow', 'twoheadleftarrow',
      'uparrow', 'downarrow', 'updownarrow',
      'Uparrow', 'Downarrow', 'Updownarrow',
      'nearrow', 'searrow', 'swarrow', 'nwarrow',
      'langle', 'rangle', 'lfloor', 'rfloor', 'lceil', 'rceil',
      'lvert', 'rvert', 'lVert', 'rVert',
      'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr',
      'overline', 'underline', 'overbrace', 'underbrace',
      'widehat', 'widetilde', 'bar', 'hat', 'tilde', 'vec', 'dot', 'ddot', 'check', 'acute', 'grave', 'breve',
      'partial', 'nabla', 'prime', 'backprime',
      'hbar', 'ell', 'wp', 'Re', 'Im', 'aleph', 'beth', 'gimel',
      'imath', 'jmath',
      'quad', 'qquad', 'thinspace', 'enspace', 'negspace',
      'hspace', 'vspace', 'hfill', 'vfill',
      'begin', 'end',
      'operatorname', 'DeclareMathOperator',
      'text', 'mbox', 'hbox', 'vbox',
      'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle',
      'color', 'textcolor', 'colorbox', 'fcolorbox',
      'boxed', 'fbox', 'framebox',
      'stackrel', 'overset', 'underset', 'atop',
      'substack', 'smallmatrix',
      'phantom', 'vphantom', 'hphantom', 'smash',
      'strut', 'mathstrut', 'rule',
      
      // Programming/code terms common in Forester
      'init', 'impl', 'struct', 'enum', 'fn', 'mut', 'const', 'async', 'await',
      'Nat', 'Bool', 'Int', 'Vec', 'Prop', 'Type', 'Set',
      'src', 'dst', 'idx', 'len', 'ptr', 'buf', 'ctx', 'cfg', 'arg', 'args',
      
      // Common abbreviations
      'iff', 'resp', 'wrt', 'eg', 'ie', 'etc', 'cf', 'vs',
      'lhs', 'rhs', 'LHS', 'RHS',
   ];
}

/**
 * Generate hidden false positive rules for sentence-level patterns.
 * These match PLAIN TEXT (after LTEX strips markup), not source code.
 * 
 * For matching backslash commands, we need 8 backslashes in settings.json:
 * - JSON parse 1: \\\\\\\\ → \\\\
 * - JSON parse 2 (by LTEX): \\\\ → \\
 * - Regex engine: \\ → matches literal \
 * 
 * But since LTEX strips \commands before matching, this is only useful
 * for content that actually appears in the plain text output.
 */
function generateForesterHiddenFalsePositiveRules(): string[] {
   const rules: string[] = [];
   
   // Hide sentences with tree ID references (these survive as plain text)
   // e.g., "See trees-001A for details" → trees-001A appears in plain text
   const treeIdPattern = `.*[a-z]+-[0-9A-Fa-f]{4}.*`;
   rules.push(JSON.stringify({ rule: "MORFOLOGIK_RULE_EN_US", sentence: treeIdPattern }));
   rules.push(JSON.stringify({ rule: "MORFOLOGIK_RULE_EN_GB", sentence: treeIdPattern }));
   
   // Hide sentences with subscript-like patterns (may survive in some contexts)
   const subscriptPattern = `.*[a-zA-Z]+_[a-zA-Z0-9]+.*`;
   rules.push(JSON.stringify({ rule: "MORFOLOGIK_RULE_EN_US", sentence: subscriptPattern }));
   rules.push(JSON.stringify({ rule: "MORFOLOGIK_RULE_EN_GB", sentence: subscriptPattern }));
   
   return rules;
}

/**
 * Add Forester-specific dictionary entries and hiding rules to LTeX settings.
 * 
 * This uses two approaches:
 * 1. Dictionary entries for common terms (words flagged as spelling errors)
 * 2. Hidden false positives for sentence patterns (like tree IDs)
 * 
 * Note: LTEX's hiddenFalsePositives regex matches PLAIN TEXT after markup
 * is stripped, so we cannot hide \commands there - we use dictionary instead.
 */
export async function autoHideForesterSyntaxNoise(): Promise<void> {
   const dictionaryEntries = generateForesterDictionaryEntries();
   const hiddenRules = generateForesterHiddenFalsePositiveRules();
   
   // Get current workspace configuration
   const config = vscode.workspace.getConfiguration("ltex");
   const language = config.get<string>("language") || "en-US";
   
   // Update dictionary
   const currentDict = config.get<Record<string, string[]>>("dictionary") || {};
   const existingDictWords = new Set(currentDict[language] || []);
   let dictAddedCount = 0;
   
   for (const word of dictionaryEntries) {
      if (!existingDictWords.has(word)) {
         existingDictWords.add(word);
         dictAddedCount++;
      }
   }
   
   const updatedDict = {
      ...currentDict,
      [language]: Array.from(existingDictWords)
   };
   
   // Update hidden false positives
   const currentHidden = config.get<Record<string, string[]>>("hiddenFalsePositives") || {};
   const existingRules = new Set(currentHidden[language] || []);
   let rulesAddedCount = 0;
   
   for (const rule of hiddenRules) {
      if (!existingRules.has(rule)) {
         existingRules.add(rule);
         rulesAddedCount++;
      }
   }
   
   const updatedHidden = {
      ...currentHidden,
      [language]: Array.from(existingRules)
   };
   
   try {
      // Update both settings
      await config.update(
         "dictionary",
         updatedDict,
         vscode.ConfigurationTarget.Workspace
      );
      
      await config.update(
         "hiddenFalsePositives",
         updatedHidden,
         vscode.ConfigurationTarget.Workspace
      );
      
      const totalAdded = dictAddedCount + rulesAddedCount;
      if (totalAdded > 0) {
         vscode.window.showInformationMessage(
            `🧹 Added ${dictAddedCount} dictionary entries and ${rulesAddedCount} hiding rules for Forester!`
         );
      } else {
         vscode.window.showInformationMessage(
            `✨ Forester LTeX configuration already up to date.`
         );
      }
   } catch (error) {
      console.error("Failed to update LTeX settings:", error);
      vscode.window.showErrorMessage(
         `Failed to update settings: ${error}`
      );
   }
}

/**
 * Register the SpeedFix command
 */
export function registerSpeedFixCommand(context: vscode.ExtensionContext): vscode.Disposable[] {
   // Setup cache invalidation listener
   setupCacheInvalidation();
   
   // Dispose cache listener when extension deactivates
   if (cacheInvalidationDisposable) {
      context.subscriptions.push(cacheInvalidationDisposable);
   }
   
   return [
      vscode.commands.registerCommand("forester.speedFix", openSpeedFix),
      vscode.commands.registerCommand("forester.autoHideSyntaxNoise", autoHideForesterSyntaxNoise)
   ];
}
