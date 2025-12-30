import * as path from "path";
import * as vscode from "vscode";

const languageToolLog = vscode.window.createOutputChannel("Forester LanguageTool");

// Our own diagnostic collection to hold filtered diagnostics
let foresterDiagnostics: vscode.DiagnosticCollection | undefined;
// Track if we're currently inside our own update to prevent infinite loops
let isUpdatingDiagnostics = false;

// Track items we've already added to LTeX config to avoid duplicates
const addedDictionaryWords = new Set<string>();
const addedDisabledRules = new Set<string>();
const addedHiddenFalsePositives = new Set<string>();

// Debounce timer for batch updates to LTeX config
let ltexConfigUpdateTimer: ReturnType<typeof setTimeout> | undefined;
const pendingDictionaryWords: string[] = [];
const pendingDisabledRules: string[] = [];

/**
 * Get the current LTeX language setting (defaults to "en-US")
 */
function getLtexLanguage(): string {
   const config = vscode.workspace.getConfiguration("ltex");
   return config.get<string>("language") || "en-US";
}

/**
 * Add words to ltex.dictionary in workspace settings
 */
async function addToDictionary(words: string[]): Promise<void> {
   if (words.length === 0) return;
   
   const language = getLtexLanguage();
   const config = vscode.workspace.getConfiguration("ltex");
   const currentDict = config.get<Record<string, string[]>>("dictionary") || {};
   
   // Get existing words for this language
   const existingWords = new Set(currentDict[language] || []);
   const newWords: string[] = [];
   
   for (const word of words) {
      const normalized = word.trim();
      if (normalized && !existingWords.has(normalized) && !addedDictionaryWords.has(normalized)) {
         newWords.push(normalized);
         addedDictionaryWords.add(normalized);
      }
   }
   
   if (newWords.length === 0) return;
   
   // Update the dictionary
   const updatedDict = { ...currentDict };
   updatedDict[language] = [...(currentDict[language] || []), ...newWords];
   
   try {
      await config.update("dictionary", updatedDict, vscode.ConfigurationTarget.Workspace);
      languageToolLog.appendLine(`[ltex-config] Added ${newWords.length} words to dictionary: ${newWords.join(", ")}`);
   } catch (e) {
      languageToolLog.appendLine(`[ltex-config] Failed to update dictionary: ${e}`);
   }
}

/**
 * Add rules to ltex.disabledRules in workspace settings
 */
async function addToDisabledRules(rules: string[]): Promise<void> {
   if (rules.length === 0) return;
   
   const language = getLtexLanguage();
   const config = vscode.workspace.getConfiguration("ltex");
   const currentRules = config.get<Record<string, string[]>>("disabledRules") || {};
   
   // Get existing rules for this language
   const existingRules = new Set(currentRules[language] || []);
   const newRules: string[] = [];
   
   for (const rule of rules) {
      const normalized = rule.trim();
      if (normalized && !existingRules.has(normalized) && !addedDisabledRules.has(normalized)) {
         newRules.push(normalized);
         addedDisabledRules.add(normalized);
      }
   }
   
   if (newRules.length === 0) return;
   
   // Update the disabled rules
   const updatedRules = { ...currentRules };
   updatedRules[language] = [...(currentRules[language] || []), ...newRules];
   
   try {
      await config.update("disabledRules", updatedRules, vscode.ConfigurationTarget.Workspace);
      languageToolLog.appendLine(`[ltex-config] Disabled ${newRules.length} rules: ${newRules.join(", ")}`);
   } catch (e) {
      languageToolLog.appendLine(`[ltex-config] Failed to update disabledRules: ${e}`);
   }
}

/**
 * Extract the rule ID from a diagnostic (from the code property)
 */
function extractRuleId(diag: vscode.Diagnostic): string | undefined {
   if (typeof diag.code === "string") {
      return diag.code;
   }
   if (typeof diag.code === "object" && diag.code !== null && "value" in diag.code) {
      return String(diag.code.value);
   }
   return undefined;
}

/**
 * Queue words/rules to be added to LTeX config (batched with debounce)
 */
function queueLtexConfigUpdate(type: "dictionary" | "disabledRules", items: string[]): void {
   if (items.length === 0) return;
   
   if (type === "dictionary") {
      pendingDictionaryWords.push(...items);
   } else {
      pendingDisabledRules.push(...items);
   }
   
   // Debounce: wait 500ms before actually updating to batch multiple changes
   if (ltexConfigUpdateTimer) {
      clearTimeout(ltexConfigUpdateTimer);
   }
   
   ltexConfigUpdateTimer = setTimeout(async () => {
      ltexConfigUpdateTimer = undefined;
      
      // Process pending updates
      if (pendingDictionaryWords.length > 0) {
         const words = [...pendingDictionaryWords];
         pendingDictionaryWords.length = 0;
         await addToDictionary(words);
      }
      
      if (pendingDisabledRules.length > 0) {
         const rules = [...pendingDisabledRules];
         pendingDisabledRules.length = 0;
         await addToDisabledRules(rules);
      }
   }, 500);
}

/**
 * Initialize the tracking sets from current LTeX config to avoid re-adding existing items
 */
function initializeFromExistingConfig(): void {
   // Clear existing tracking sets first (in case this is a reload)
   addedDictionaryWords.clear();
   addedDisabledRules.clear();
   addedHiddenFalsePositives.clear();
   
   const config = vscode.workspace.getConfiguration("ltex");
   const language = getLtexLanguage();
   
   // Load existing dictionary
   const currentDict = config.get<Record<string, string[]>>("dictionary") || {};
   for (const word of currentDict[language] || []) {
      addedDictionaryWords.add(word);
   }
   
   // Load existing disabled rules
   const currentRules = config.get<Record<string, string[]>>("disabledRules") || {};
   for (const rule of currentRules[language] || []) {
      addedDisabledRules.add(rule);
   }
   
   // Load existing hidden false positives (just track them to avoid re-adding)
   const currentHidden = config.get<Record<string, string[]>>("hiddenFalsePositives") || {};
   for (const fp of currentHidden[language] || []) {
      addedHiddenFalsePositives.add(fp);
   }
   
   languageToolLog.appendLine(`[ltex-config] Loaded existing config: ${addedDictionaryWords.size} dictionary words, ${addedDisabledRules.size} disabled rules, ${addedHiddenFalsePositives.size} hidden false positives`);
}

// Create a unique key for a diagnostic to detect duplicates
function diagnosticKey(uri: vscode.Uri, d: vscode.Diagnostic): string {
   return `${uri.toString()}:${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
}

/**
 * Check if auto-population of LTeX config is enabled
 */
function isAutoPopulateEnabled(): boolean {
   const config = vscode.workspace.getConfiguration("forester.languageTool");
   return config.get<boolean>("autoPopulateLtexConfig", true);
}

// Filter diagnostics from any source (including the original LanguageTool extension)
// This works by listening to diagnostics changes and automatically populating LTeX's
// dictionary and disabledRules to suppress false positives for Forester syntax
function filterAndUpdateDiagnostics(uri: vscode.Uri): void {
   if (isUpdatingDiagnostics) {
      return;
   }
   
   // Check if auto-population is enabled
   if (!isAutoPopulateEnabled()) {
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

   // Collect words and rules to add to LTeX config
   const wordsToAdd: string[] = [];
   const rulesToDisable: string[] = [];
   let suppressCount = 0;

   for (const diag of grammarDiagnostics) {
      const text = doc.getText(diag.range).trim();
      const ruleId = extractRuleId(diag);
      
      if (shouldIgnoreRule(diag)) {
         suppressCount++;
         // For rule-based suppression, disable the entire rule in LTeX
         const ruleToDisable = getRuleIdToDisable(diag);
         if (ruleToDisable) {
            rulesToDisable.push(ruleToDisable);
            languageToolLog.appendLine(`[filter] Suppressed by rule, will disable: ${ruleToDisable}`);
         } else {
            languageToolLog.appendLine(`[filter] Suppressed by rule (no rule ID): ${diag.message.substring(0, 50)}...`);
         }
      } else if (isForesterSyntaxFalsePositive(text, doc, content, diag)) {
         // This is definitely Forester syntax (command name, math content, etc.)
         // Safe to add to dictionary
         suppressCount++;
         const wordToAdd = extractWordForDictionary(text, diag);
         if (wordToAdd) {
            wordsToAdd.push(wordToAdd);
            languageToolLog.appendLine(`[filter] Forester syntax, adding to dictionary: "${wordToAdd}"`);
         } else {
            languageToolLog.appendLine(`[filter] Forester syntax but cannot add to dictionary: "${text}"`);
         }
      } else {
         // This is regular prose - let LTeX handle it normally
         // Do NOT add to dictionary - it might be a real spelling error!
         languageToolLog.appendLine(`[filter] Regular prose, letting LTeX handle: "${text}" (${ruleId})`);
      }
   }

   // Log filtering results
   languageToolLog.appendLine(`[filter] ${path.basename(uri.fsPath)}: ${grammarDiagnostics.length} diagnostics -> ${suppressCount} to suppress`);
   
   // Queue updates to LTeX config (batched and deduplicated)
   if (wordsToAdd.length > 0) {
      languageToolLog.appendLine(`[filter] Queueing ${wordsToAdd.length} words for dictionary`);
      queueLtexConfigUpdate("dictionary", wordsToAdd);
   }
   if (rulesToDisable.length > 0) {
      languageToolLog.appendLine(`[filter] Queueing ${rulesToDisable.length} rules to disable`);
      queueLtexConfigUpdate("disabledRules", rulesToDisable);
   }
}

/**
 * Check if a diagnostic is likely a spelling error (vs grammar error)
 */
function isLikelySpellingError(diag: vscode.Diagnostic): boolean {
   const msg = diag.message.toLowerCase();
   const ruleId = extractRuleId(diag)?.toLowerCase() || "";
   
   // Common spelling error indicators
   return msg.includes("spelling") ||
          msg.includes("unknown word") ||
          msg.includes("not in dictionary") ||
          msg.includes("spell") ||
          ruleId.includes("spelling") ||
          ruleId.includes("typo") ||
          ruleId === "morfologik_rule_en_us" ||
          ruleId.startsWith("morfologik");
}

/**
 * Known Forester command names that LTeX might flag as spelling errors.
 * We add these to the dictionary so LTeX stops complaining.
 */
const FORESTER_COMMANDS = new Set([
   // Common Forester structural commands
   "ul", "li", "ol", "em", "strong", "taxon", "subtree", "title",
   "transclude", "codeblock", "blockquote", "scope", "put", "get",
   "def", "tex", "namespace", "open", "alloc", "patch", "xml",
   "href", "img", "pre", "kbd", "var", "samp", "abbr", "dfn",
   "sup", "sub", "br", "hr", "thead", "tbody", "tfoot", "colgroup",
   "col", "dd", "dt", "dl", "figcaption", "hgroup", "nav", "bdo",
   "wbr", "rp", "rt", "rtc", "datalist", "keygen", "menuitem",
   "param", "noscript", "optgroup", "ref", "date", "author",
   "contributor", "tag", "meta", "query", "object", "call",
   // Common short abbreviations in technical docs
   "eg", "ie", "etc", "vs", "nb", "cf"
]);

/**
 * Check if this diagnostic is definitely a false positive due to Forester syntax.
 * Only returns true for things we're CONFIDENT are not real spelling errors.
 */
function isForesterSyntaxFalsePositive(text: string, doc: vscode.TextDocument, content: string, diag: vscode.Diagnostic): boolean {
   // Strip leading backslash
   const cleanText = text.startsWith("\\") ? text.slice(1) : text;
   const lowerText = cleanText.toLowerCase().replace(/[\[\]{}()]+$/, "");
   
   // Known Forester command names are definitely false positives
   if (FORESTER_COMMANDS.has(lowerText)) {
      return true;
   }
   
   // Starts with backslash = command
   if (text.startsWith("\\")) {
      return true;
   }
   
   // Contains special syntax characters
   if (/[\\{}$#]/.test(text)) {
      return true;
   }
   
   // Very short tokens (1-2 chars) are likely syntax fragments
   if (cleanText.length <= 2 && /^[a-zA-Z]+$/.test(cleanText)) {
      return true;
   }
   
   // Check if inside math block #{} or ##{}
   const startOffset = doc.offsetAt(diag.range.start);
   const beforeText = content.slice(Math.max(0, startOffset - 50), startOffset);
   if (/#\{[^}]*$/.test(beforeText) || /##\{[^}]*$/.test(beforeText)) {
      return true;
   }
   
   // Check if immediately after a backslash (part of command name)
   const charBefore = content.slice(Math.max(0, startOffset - 1), startOffset);
   if (charBefore === "\\") {
      return true;
   }
   
   return false;
}

/**
 * Extract a word suitable for adding to the dictionary from diagnostic text.
 * Returns undefined if no suitable word can be extracted.
 * Only called for confirmed Forester syntax false positives.
 */
function extractWordForDictionary(text: string, diag: vscode.Diagnostic): string | undefined {
   // Only add words for spelling errors
   if (!isLikelySpellingError(diag)) {
      return undefined;
   }
   
   // Strip leading backslash if present (Forester commands)
   let word = text.startsWith("\\") ? text.slice(1) : text;
   
   // Strip trailing braces/brackets
   word = word.replace(/[\[\]{}()]+$/, "").trim();
   
   // Must be at least 2 characters
   if (word.length < 2) {
      return undefined;
   }
   
   // Must only contain letters
   if (!/^[a-zA-Z]+$/.test(word)) {
      return undefined;
   }
   
   // If it's a known Forester command, add it
   if (FORESTER_COMMANDS.has(word.toLowerCase())) {
      return word.toLowerCase();
   }
   
   // Only add very short tokens if they're known commands (already handled above)
   // Don't add random short words
   if (word.length < 4) {
      return undefined;
   }
   
   return word;
}

/**
 * Check if a word is valid to add to the dictionary
 * (not too short, not containing special chars, etc.)
 * @deprecated Use extractWordForDictionary instead
 */
function isValidDictionaryWord(word: string): boolean {
   // Must be at least 2 characters
   if (word.length < 2) return false;
   
   // Must only contain letters (possibly with hyphens/apostrophes for compound words)
   if (!/^[a-zA-Z][a-zA-Z'-]*[a-zA-Z]$/.test(word) && !/^[a-zA-Z]{2}$/.test(word)) {
      return false;
   }
   
   // Not a Forester command name (these are syntax, not words)
   const foresterCommands = [
      "ul", "li", "ol", "em", "strong", "taxon", "title", "subtree",
      "transclude", "codeblock", "blockquote", "scope", "put", "get",
      "def", "let", "tex", "import", "export", "namespace", "open",
      "alloc", "object", "patch", "call", "query", "ref", "date", "author"
   ];
   if (foresterCommands.includes(word.toLowerCase())) {
      return false;
   }
   
   return true;
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
      // Note: removed generic /\{[^}]*\}/g as it was too aggressive
      // and was hiding legitimate content inside Forester blocks
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
   
   // Check if it's a known Forester command
   const lowerText = text.toLowerCase().replace(/^\\/, "");
   if (FORESTER_COMMANDS.has(lowerText)) {
      languageToolLog.appendLine(`${logPrefix} -> IGNORE (known Forester command)`);
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
   const ruleId = extractRuleId(diag)?.toUpperCase() || "";

   // Common whitespace rule id/message from LT
   if (src.toLowerCase().includes("whitespace") || msg.includes("whitespace") ||
       ruleId === "WHITESPACE_RULE") {
      languageToolLog.appendLine(`[shouldIgnoreRule] IGNORE whitespace rule: ruleId="${ruleId}", msg="${msg.slice(0, 50)}"`);
      return true;
   }
   
   // Parenthesis/bracket spacing rules - very common in Forester due to syntax
   // Common LTeX rule IDs for these
   if (ruleId === "COMMA_PARENTHESIS_WHITESPACE" ||
       ruleId === "WHITESPACE_PARENTHESIS" ||
       ruleId === "WHITESPACE_PUNCTUATION" ||
       msg.includes("before the closing parenthesis") || 
       msg.includes("after the opening parenthesis") ||
       msg.includes("before the closing bracket") ||
       msg.includes("after the opening bracket") ||
       msg.includes("before comma") || 
       msg.includes("before ,") || 
       msg.includes("before )") ||
       msg.includes("after (")) {
      languageToolLog.appendLine(`[shouldIgnoreRule] IGNORE punctuation spacing rule: ruleId="${ruleId}", msg="${msg.slice(0, 50)}"`);
      return true;
   }

   return false;
}

/**
 * Get the rule ID to disable for a diagnostic that should be ignored by rule.
 * Returns undefined if no specific rule can be identified.
 */
function getRuleIdToDisable(diag: vscode.Diagnostic): string | undefined {
   const ruleId = extractRuleId(diag)?.toUpperCase();
   if (!ruleId) return undefined;
   
   const msg = diag.message.toLowerCase();
   
   // Only return rule IDs for rules we explicitly want to disable
   // (not for content-based filtering)
   if (ruleId === "WHITESPACE_RULE" || 
       ruleId === "COMMA_PARENTHESIS_WHITESPACE" ||
       ruleId === "WHITESPACE_PARENTHESIS" ||
       ruleId === "WHITESPACE_PUNCTUATION") {
      return ruleId;
   }
   
   // For message-based matches, try to extract the rule ID
   if (msg.includes("whitespace") && ruleId) {
      return ruleId;
   }
   if ((msg.includes("before the closing parenthesis") || 
        msg.includes("after the opening parenthesis") ||
        msg.includes("before comma") ||
        msg.includes("before )") ||
        msg.includes("after (")) && ruleId) {
      return ruleId;
   }
   
   return undefined;
}

export async function initLanguageToolBridge(context: vscode.ExtensionContext): Promise<void> {
   languageToolLog.appendLine("[init] Starting LanguageTool bridge initialization...");

   // Initialize tracking sets from existing LTeX config to avoid duplicates
   initializeFromExistingConfig();

   // Create our own diagnostic collection for filtered diagnostics
   foresterDiagnostics = vscode.languages.createDiagnosticCollection("forester-languagetool-filtered");
   context.subscriptions.push(foresterDiagnostics);

   // Listen for diagnostic changes from ALL sources (including original LanguageTool extension)
   // We detect Forester-specific false positives and automatically add them to LTeX's config
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
         
         // Reload tracking sets if LTeX config was changed externally
         if (event.affectsConfiguration("ltex.dictionary") || 
             event.affectsConfiguration("ltex.disabledRules") ||
             event.affectsConfiguration("ltex.hiddenFalsePositives")) {
            languageToolLog.appendLine("[ltex-config] LTeX config changed, reloading tracking sets");
            initializeFromExistingConfig();
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
