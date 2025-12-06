import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

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
 * 4. Provides them to the formatter as ignored commands
 */

const CACHE_FILE_NAME = ".forester-formatter.json";

interface FormatterCache {
   version: number;
   lastScan: string;
   macros: string[];
}

const CACHE_VERSION = 1;

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
export async function readCachedMacros(): Promise<string[]> {
   const cachePath = getCacheFilePath();
   if (!cachePath) {
      return [];
   }

   try {
      if (!fs.existsSync(cachePath)) {
         return [];
      }
      const content = fs.readFileSync(cachePath, "utf-8");
      const cache: FormatterCache = JSON.parse(content);
      
      if (cache.version !== CACHE_VERSION) {
         // Cache version mismatch, needs rescan
         return [];
      }
      
      return cache.macros || [];
   } catch (error) {
      console.error("Failed to read formatter cache:", error);
      return [];
   }
}

/**
 * Write macros to the cache file
 */
async function writeCachedMacros(macros: string[]): Promise<void> {
   const cachePath = getCacheFilePath();
   if (!cachePath) {
      return;
   }

   const cache: FormatterCache = {
      version: CACHE_VERSION,
      lastScan: new Date().toISOString(),
      macros: macros.sort()
   };

   try {
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
   } catch (error) {
      console.error("Failed to write formatter cache:", error);
   }
}

/**
 * Parse a .tree file and extract macro names from \def commands
 */
function extractMacrosFromContent(content: string): string[] {
   const macros: string[] = [];
   
   // Match \def\macroname patterns
   // The macro name follows \def\ and consists of alphanumeric characters, hyphens, etc.
   // Pattern: \def\name where name can contain letters, numbers, hyphens
   const defRegex = /\\def\\([A-Za-z][A-Za-z0-9\-]*)/g;
   
   let match;
   while ((match = defRegex.exec(content)) !== null) {
      const macroName = match[1];
      if (macroName && !macros.includes(macroName)) {
         macros.push(macroName);
      }
   }
   
   return macros;
}

/**
 * Scan all .tree files in the workspace for macro definitions
 */
export async function scanWorkspaceForMacros(): Promise<string[]> {
   const workspaceFolders = vscode.workspace.workspaceFolders;
   if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
   }

   const allMacros: Set<string> = new Set();

   // Find all .tree files
   const treeFiles = await vscode.workspace.findFiles("**/*.tree", "**/node_modules/**");
   
   for (const file of treeFiles) {
      try {
         const content = fs.readFileSync(file.fsPath, "utf-8");
         const macros = extractMacrosFromContent(content);
         macros.forEach(m => allMacros.add(m));
      } catch (error) {
         console.error(`Failed to read ${file.fsPath}:`, error);
      }
   }

   const macroList = Array.from(allMacros).sort();
   
   // Cache the results
   await writeCachedMacros(macroList);
   
   return macroList;
}

/**
 * Get the combined list of ignored commands from:
 * 1. User configuration (forester.formatter.ignoredCommands)
 * 2. Cached macros (if autoScanMacros is enabled)
 */
export async function getIgnoredCommands(): Promise<Set<string>> {
   const config = vscode.workspace.getConfiguration("forester.formatter");
   const userIgnored: string[] = config.get("ignoredCommands", []);
   const autoScan: boolean = config.get("autoScanMacros", true);
   
   const ignored = new Set<string>(userIgnored);
   
   if (autoScan) {
      const cachedMacros = await readCachedMacros();
      cachedMacros.forEach(m => ignored.add(m));
   }
   
   return ignored;
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
      const macros = await scanWorkspaceForMacros();
      
      if (macros.length === 0) {
         vscode.window.showInformationMessage("No macro definitions found in workspace.");
      } else {
         vscode.window.showInformationMessage(
            `Found ${macros.length} macro definitions. They will be preserved during formatting.`
         );
      }
   });
}

/**
 * Initialize the formatter configuration.
 * This should be called on extension activation.
 */
export async function initFormatterConfig(): Promise<void> {
   const config = vscode.workspace.getConfiguration("forester.formatter");
   const autoScan: boolean = config.get("autoScanMacros", true);
   
   if (autoScan) {
      const cachedMacros = await readCachedMacros();
      
      // If no cache exists, do an initial scan
      if (cachedMacros.length === 0) {
         await scanWorkspaceForMacros();
      }
   }
}

// In-memory cache of ignored commands for quick access during formatting
let _cachedIgnoredCommands: Set<string> | null = null;

/**
 * Get ignored commands with caching for performance during formatting.
 * The cache is invalidated when configuration changes.
 */
export function getIgnoredCommandsSync(): Set<string> {
   if (_cachedIgnoredCommands === null) {
      // Return empty set if not initialized yet
      // The async initialization will populate this
      return new Set();
   }
   return _cachedIgnoredCommands;
}

/**
 * Refresh the in-memory cache of ignored commands
 */
export async function refreshIgnoredCommandsCache(): Promise<void> {
   _cachedIgnoredCommands = await getIgnoredCommands();
}

/**
 * Clear the in-memory cache (call when configuration changes)
 */
export function clearIgnoredCommandsCache(): void {
   _cachedIgnoredCommands = null;
}
