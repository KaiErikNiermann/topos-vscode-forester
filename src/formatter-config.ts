import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { hasForestConfig } from "./utils";

/**
 * Scans workspace for Forester macro definitions and manages the formatter configuration.
 * 
 * Macro definitions in Forester look like:
 * \def\macroname[arg1][arg2]{...}
 * \def\macroname[~body]{...}  (thunked argument)
 * 
 * This module:
 * 1. Scans all .tree files for \def commands
 * 2. Extracts macro names
 * 3. Caches them in .forester-formatter.json
 * 4. Provides them to the formatter as ignored commands or subtree aliases
 */

const CACHE_FILE_NAME = ".forester-formatter.json";

interface FormatterCache {
   version: number;
   lastScan: string;
   macros: string[];
   subtreeMacros: string[];
}

interface MacroScanResult {
   macros: string[];
   subtreeMacros: string[];
   dictionaryAdded?: number;
}

interface FormatterMacroConfig {
   ignoredCommands: Set<string>;
   subtreeMacros: Set<string>;
}

const CACHE_VERSION = 2;

/**
 * Get the path to the cache file in the workspace root
 */
function getCacheFilePath(): string | undefined {
   const workspaceFolders = vscode.workspace.workspaceFolders;
   if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
   }
   return path.join(workspaceFolders[0].uri.fsPath, CACHE_FILE_NAME);
}

/**
 * Read the cached macros from the cache file
 */
export async function readCachedMacros(): Promise<MacroScanResult> {
   const cachePath = getCacheFilePath();
   if (!cachePath) {
      return { macros: [], subtreeMacros: [] };
   }

   try {
      if (!fs.existsSync(cachePath)) {
         return { macros: [], subtreeMacros: [] };
      }
      const content = fs.readFileSync(cachePath, "utf-8");
      const cache: FormatterCache = JSON.parse(content);
      
      if (cache.version !== CACHE_VERSION) {
         // Cache version mismatch, needs rescan
         return { macros: [], subtreeMacros: [] };
      }
      
      return {
         macros: cache.macros || [],
         subtreeMacros: cache.subtreeMacros || []
      };
   } catch (error) {
      console.error("Failed to read formatter cache:", error);
      return { macros: [], subtreeMacros: [] };
   }
}

/**
 * Write macros to the cache file
 */
async function writeCachedMacros(macros: string[], subtreeMacros: string[]): Promise<void> {
   const cachePath = getCacheFilePath();
   if (!cachePath) {
      return;
   }

   // Only write cache files in valid Forester projects
   if (!await hasForestConfig()) {
      return;
   }

   const cache: FormatterCache = {
      version: CACHE_VERSION,
      lastScan: new Date().toISOString(),
      macros: macros.sort(),
      subtreeMacros: subtreeMacros.sort()
   };

   try {
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
   } catch (error) {
      console.error("Failed to write formatter cache:", error);
   }
}

/**
 * Get the path to the LTeX dictionary file for the current language (in .vscode folder)
 */
function getLtexDictionaryPath(): string | undefined {
   const workspaceFolders = vscode.workspace.workspaceFolders;
   if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
   }
   
   // Get the LTeX language setting, default to en-US
   const ltexConfig = vscode.workspace.getConfiguration("ltex");
   const language = ltexConfig.get<string>("language", "en-US");
   
   // Dictionary filename follows LTeX convention: ltex.dictionary.<language>.txt
   // Store in .vscode folder for better workspace organization
   const vscodeFolder = path.join(workspaceFolders[0].uri.fsPath, ".vscode");
   const dictionaryFileName = `ltex.dictionary.${language}.txt`;
   return path.join(vscodeFolder, dictionaryFileName);
}

/**
 * Add macros to the LTeX dictionary file, avoiding duplicates
 */
async function addMacrosToLtexDictionary(macros: string[]): Promise<number> {
   const dictionaryPath = getLtexDictionaryPath();
   if (!dictionaryPath) {
      return 0;
   }
   
   // Ensure .vscode folder exists
   const vscodeFolder = path.dirname(dictionaryPath);
   try {
      if (!fs.existsSync(vscodeFolder)) {
         fs.mkdirSync(vscodeFolder, { recursive: true });
      }
   } catch (error) {
      console.error("Failed to create .vscode folder:", error);
      return 0;
   }
   
   // Read existing dictionary content
   let existingWords: Set<string> = new Set();
   let existingContent = "";
   
   try {
      if (fs.existsSync(dictionaryPath)) {
         existingContent = fs.readFileSync(dictionaryPath, "utf-8");
         // Parse existing words (skip comments and empty lines)
         for (const line of existingContent.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#")) {
               existingWords.add(trimmed.toLowerCase());
            }
         }
      }
   } catch (error) {
      console.error("Failed to read LTeX dictionary:", error);
   }
   
   // Find macros that aren't already in the dictionary
   const newMacros = macros.filter(macro => !existingWords.has(macro.toLowerCase()));
   
   if (newMacros.length === 0) {
      return 0;
   }
   
   // Append new macros to the dictionary
   try {
      let newContent = existingContent;
      
      // Ensure file ends with newline before adding
      if (newContent && !newContent.endsWith("\n")) {
         newContent += "\n";
      }
      
      // Add a section header if this is a new addition
      if (!existingContent.includes("# Forester macros")) {
         newContent += "\n# Forester macros (auto-added by extension)\n";
      }
      
      // Add each new macro
      for (const macro of newMacros.sort()) {
         newContent += macro + "\n";
      }
      
      fs.writeFileSync(dictionaryPath, newContent, "utf-8");
      return newMacros.length;
   } catch (error) {
      console.error("Failed to write to LTeX dictionary:", error);
      return 0;
   }
}

/**
 * Parse a macro definition starting at the given position and return its body (without outer braces).
 * Returns null if a body cannot be found.
 */
function extractMacroBody(content: string, startPos: number): { body: string; endPos: number } | null {
   const len = content.length;
   let i = startPos;

   // Skip whitespace between the macro name and its arguments/body
   while (i < len && /\s/.test(content[i])) {
      i++;
   }

   // Consume optional bracket arguments: [arg][~body]...
   while (i < len && content[i] === "[") {
      let depth = 1;
      i++; // skip initial "["
      while (i < len && depth > 0) {
         if (content[i] === "[") {depth++;}
         else if (content[i] === "]") {depth--;}
         i++;
      }
      // Skip whitespace between arguments
      while (i < len && /\s/.test(content[i])) {
         i++;
      }
   }

   if (i >= len || content[i] !== "{") {
      return null;
   }

   // Extract body inside balanced braces
   let braceDepth = 1;
   const bodyStart = i + 1;
   i++; // Skip opening brace
   while (i < len && braceDepth > 0) {
      if (content[i] === "{") {
         braceDepth++;
      } else if (content[i] === "}") {
         braceDepth--;
      }
      i++;
   }

   if (braceDepth !== 0) {
      return null;
   }

   const bodyEnd = i - 1; // Position before the closing brace
   return { body: content.slice(bodyStart, bodyEnd), endPos: i };
}

/**
 * Parse a .tree file and extract macro names from \def commands, along with subtree aliases.
 */
function extractMacrosFromContent(content: string): MacroScanResult {
   const macros: Set<string> = new Set();
   const subtreeMacros: Set<string> = new Set();
   
   // Match \def\macroname patterns
   // The macro name follows \def\ and consists of alphanumeric characters, hyphens, etc.
   // Pattern: \def\name where name can contain letters, numbers, hyphens
   const defRegex = /\\def\\([A-Za-z][A-Za-z0-9\-]*)/g;
   
   let match;
   while ((match = defRegex.exec(content)) !== null) {
      const macroName = match[1];
      if (macroName) {
         macros.add(macroName);
         // Attempt to extract the macro body to detect subtree aliases
         const bodyInfo = extractMacroBody(content, match.index + match[0].length);
         if (bodyInfo) {
            const bodyContainsSubtree = /\\subtree\s*\{/.test(bodyInfo.body);
            if (bodyContainsSubtree) {
               subtreeMacros.add(macroName);
            }
         }
      }
   }
   
   return { macros: Array.from(macros), subtreeMacros: Array.from(subtreeMacros) };
}

/**
 * Scan all .tree files in the workspace for macro definitions
 */
export async function scanWorkspaceForMacros(): Promise<MacroScanResult> {
   const workspaceFolders = vscode.workspace.workspaceFolders;
   if (!workspaceFolders || workspaceFolders.length === 0) {
      return { macros: [], subtreeMacros: [] };
   }

   // Only scan in valid Forester projects with a forest.toml
   if (!await hasForestConfig()) {
      return { macros: [], subtreeMacros: [] };
   }

   const allMacros: Set<string> = new Set();
   const subtreeMacros: Set<string> = new Set();

   // Find all .tree files
   const treeFiles = await vscode.workspace.findFiles("**/*.tree", "**/node_modules/**");
   
   for (const file of treeFiles) {
      try {
         const content = fs.readFileSync(file.fsPath, "utf-8");
         const macros = extractMacrosFromContent(content);
         for (const m of macros.macros) {allMacros.add(m);}
         for (const m of macros.subtreeMacros) {subtreeMacros.add(m);}
      } catch (error) {
         console.error(`Failed to read ${file.fsPath}:`, error);
      }
   }

   const macroList = Array.from(allMacros).sort();
   const subtreeMacroList = Array.from(subtreeMacros).sort();
   
   // Cache the results
   await writeCachedMacros(macroList, subtreeMacroList);
   
   // Also add macros to LTeX dictionary so they don't show as spelling errors
   const addedToDict = await addMacrosToLtexDictionary(macroList);
   if (addedToDict > 0) {
      console.log(`Added ${addedToDict} macros to LTeX dictionary`);
   }
   
   return { macros: macroList, subtreeMacros: subtreeMacroList, dictionaryAdded: addedToDict };
}

/**
 * Get the combined list of ignored commands from:
 * 1. User configuration (forester.formatter.ignoredCommands)
 * 2. Cached macros (if autoScanMacros is enabled)
 */
async function getFormatterMacroConfig(): Promise<FormatterMacroConfig> {
   const config = vscode.workspace.getConfiguration("forester.formatter");
   const userIgnored: string[] = config.get("ignoredCommands", []);
   const autoScan: boolean = config.get("autoScanMacros", true);
   
   const ignored = new Set<string>(userIgnored);
   const subtreeMacros = new Set<string>();
   
   if (autoScan) {
      const cachedMacros = await readCachedMacros();
      for (const m of cachedMacros.subtreeMacros) {subtreeMacros.add(m);}
      for (const m of cachedMacros.macros) {
         if (!subtreeMacros.has(m)) {
            ignored.add(m);
         }
      }
   }
   
   return { ignoredCommands: ignored, subtreeMacros };
}

/**
 * Backwards-compatible helper to only fetch ignored commands.
 */
export async function getIgnoredCommands(): Promise<Set<string>> {
   const config = await getFormatterMacroConfig();
   return config.ignoredCommands;
}

/**
 * VS Code command handler to manually trigger macro scanning
 */
export async function scanMacrosCommand(): Promise<void> {
   await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Scanning for Forester macros...",
      cancellable: false
   }, async () => {
      const result = await scanWorkspaceForMacros();
      
      if (result.macros.length === 0) {
         vscode.window.showInformationMessage("No macro definitions found in workspace.");
      } else {
         let message = `Found ${result.macros.length} macro definitions (${result.subtreeMacros.length} subtree alias).`;
         if (result.dictionaryAdded && result.dictionaryAdded > 0) {
            message += ` Added ${result.dictionaryAdded} new macros to LTeX dictionary.`;
         }
         vscode.window.showInformationMessage(message);
      }
   });
}

/**
 * Initialize the formatter configuration.
 * This should be called on extension activation.
 */
export async function initFormatterConfig(): Promise<void> {
   // Only initialize in valid Forester projects with a forest.toml
   if (!await hasForestConfig()) {
      return;
   }

   const config = vscode.workspace.getConfiguration("forester.formatter");
   const autoScan: boolean = config.get("autoScanMacros", true);

   if (autoScan) {
      const cachedMacros = await readCachedMacros();

      // If no cache exists, do an initial scan
      if (cachedMacros.macros.length === 0 && cachedMacros.subtreeMacros.length === 0) {
         await scanWorkspaceForMacros();
      }
   }
}

// In-memory cache of ignored commands for quick access during formatting
let _cachedMacroConfig: FormatterMacroConfig | null = null;

/**
 * Get ignored commands with caching for performance during formatting.
 * The cache is invalidated when configuration changes.
 */
export function getIgnoredCommandsSync(): Set<string> {
   if (_cachedMacroConfig === null) {
      // Return empty set if not initialized yet
      // The async initialization will populate this
      return new Set();
   }
   return _cachedMacroConfig.ignoredCommands;
}

/**
 * Get subtree alias macros with caching for performance during formatting.
 */
export function getSubtreeMacrosSync(): Set<string> {
   if (_cachedMacroConfig === null) {
      return new Set();
   }
   return _cachedMacroConfig.subtreeMacros;
}

/**
 * Refresh the in-memory cache of ignored commands
 */
export async function refreshIgnoredCommandsCache(): Promise<void> {
   _cachedMacroConfig = await getFormatterMacroConfig();
}

/**
 * Clear the in-memory cache (call when configuration changes)
 */
export function clearIgnoredCommandsCache(): void {
   _cachedMacroConfig = null;
}
