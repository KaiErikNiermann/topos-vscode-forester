/**
 * link-aliases-config.ts - Configurable link aliasing for autocomplete
 *
 * This module manages a configuration file that allows users to define custom
 * link patterns for tree autocomplete. For example, users can add patterns like
 * \cite{link} to get the same autocomplete as [text](link).
 *
 * Config file: .forester-links.json in workspace root
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { match, P } from "ts-pattern";

const CONFIG_FILE_NAME = ".forester-links.json";
const CONFIG_VERSION = 1;

/**
 * Link alias pattern definition
 * 
 * @example
 * { pattern: "\\cite{", closingChar: "}", triggerChar: "{" }
 * { pattern: "\\textcite{", closingChar: "}", triggerChar: "{" }
 * { pattern: "[[", closingChar: "]]", triggerChar: "[" }
 */
export interface LinkAliasPattern {
   /** The opening pattern to match (e.g., "\\cite{", "[[") */
   pattern: string;
   /** The closing character(s) for the pattern (e.g., "}", "]]") */
   closingChar: string;
   /** The character that triggers autocomplete (e.g., "{", "(", "[") */
   triggerChar: string;
   /** Optional description for the pattern */
   description?: string;
}

interface LinkAliasConfig {
   version: number;
   lastModified: string;
   /** User-defined custom patterns */
   customPatterns: LinkAliasPattern[];
   /** Whether to include built-in patterns (default: true) */
   includeBuiltins: boolean;
}

/**
 * Built-in link patterns that are always available unless disabled
 */
const BUILTIN_PATTERNS: LinkAliasPattern[] = [
   { pattern: "\\transclude{", closingChar: "}", triggerChar: "{", description: "Transclude a tree" },
   { pattern: "\\import{", closingChar: "}", triggerChar: "{", description: "Import a tree" },
   { pattern: "\\export{", closingChar: "}", triggerChar: "{", description: "Export a tree" },
   { pattern: "\\ref{", closingChar: "}", triggerChar: "{", description: "Reference a tree" },
   { pattern: "](", closingChar: ")", triggerChar: "(", description: "Markdown-style link [text](id)" },
   { pattern: "[[", closingChar: "]]", triggerChar: "[", description: "Wiki-style link [[id]]" },
];

// Cache for the loaded config
let cachedConfig: LinkAliasConfig | null = null;
let fileWatcher: vscode.FileSystemWatcher | null = null;

/**
 * Get the path to the config file in the workspace root
 */
function getConfigFilePath(): string | undefined {
   const workspaceFolders = vscode.workspace.workspaceFolders;
   if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
   }
   return path.join(workspaceFolders[0].uri.fsPath, CONFIG_FILE_NAME);
}

/**
 * Create default config file content
 */
function createDefaultConfig(): LinkAliasConfig {
   return {
      version: CONFIG_VERSION,
      lastModified: new Date().toISOString(),
      customPatterns: [
         // Example patterns commented out in the actual file via description
         { pattern: "\\cite{", closingChar: "}", triggerChar: "{", description: "Example: LaTeX citation" },
      ],
      includeBuiltins: true,
   };
}

/**
 * Read the link alias config from file
 */
export async function readLinkAliasConfig(): Promise<LinkAliasConfig> {
   if (cachedConfig) {
      return cachedConfig;
   }

   const configPath = getConfigFilePath();
   if (!configPath) {
      return createDefaultConfig();
   }

   try {
      if (!fs.existsSync(configPath)) {
         return createDefaultConfig();
      }
      const content = fs.readFileSync(configPath, "utf-8");
      const config: LinkAliasConfig = JSON.parse(content);

      // Handle version migration if needed
      const migratedConfig = match(config.version)
         .with(CONFIG_VERSION, () => config)
         .otherwise(() => {
            // Future: handle version migration
            console.log(`Migrating link alias config from version ${config.version} to ${CONFIG_VERSION}`);
            return { ...config, version: CONFIG_VERSION };
         });

      cachedConfig = migratedConfig;
      return migratedConfig;
   } catch (error) {
      console.error("Failed to read link alias config:", error);
      return createDefaultConfig();
   }
}

/**
 * Write link alias config to file
 */
export async function writeLinkAliasConfig(config: LinkAliasConfig): Promise<void> {
   const configPath = getConfigFilePath();
   if (!configPath) {
      return;
   }

   const updatedConfig: LinkAliasConfig = {
      ...config,
      lastModified: new Date().toISOString(),
   };

   try {
      fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2), "utf-8");
      cachedConfig = updatedConfig;
   } catch (error) {
      console.error("Failed to write link alias config:", error);
      throw error;
   }
}

/**
 * Add a custom link pattern to the config
 */
export async function addLinkAliasPattern(pattern: LinkAliasPattern): Promise<void> {
   const config = await readLinkAliasConfig();

   // Check if pattern already exists
   const exists = config.customPatterns.some(p => p.pattern === pattern.pattern);
   if (exists) {
      vscode.window.showWarningMessage(`Link pattern "${pattern.pattern}" already exists`);
      return;
   }

   config.customPatterns.push(pattern);
   await writeLinkAliasConfig(config);
}

/**
 * Remove a custom link pattern from the config
 */
export async function removeLinkAliasPattern(pattern: string): Promise<void> {
   const config = await readLinkAliasConfig();
   config.customPatterns = config.customPatterns.filter(p => p.pattern !== pattern);
   await writeLinkAliasConfig(config);
}

/**
 * Get all active link patterns (builtins + custom)
 */
export async function getAllLinkPatterns(): Promise<LinkAliasPattern[]> {
   const config = await readLinkAliasConfig();

   return match(config.includeBuiltins)
      .with(true, () => [...BUILTIN_PATTERNS, ...config.customPatterns])
      .with(false, () => config.customPatterns)
      .exhaustive();
}

/**
 * Get only the custom link patterns
 */
export async function getCustomLinkPatterns(): Promise<LinkAliasPattern[]> {
   const config = await readLinkAliasConfig();
   return config.customPatterns;
}

/**
 * Get the built-in patterns
 */
export function getBuiltinPatterns(): LinkAliasPattern[] {
   return BUILTIN_PATTERNS;
}

/**
 * Build a regex pattern for autocomplete matching from link alias patterns
 * Returns the pattern and the number of capture groups
 */
export async function buildAutocompleteRegex(): Promise<{ regex: RegExp; patternCount: number }> {
   const patterns = await getAllLinkPatterns();

   // Group patterns by closing char type for efficient regex building
   const patternParts = patterns.map(p => {
      // Escape special regex characters in the pattern
      const escapedPattern = escapeRegex(p.pattern);
      // Build the capture group based on closing char
      const closingEscaped = escapeRegex(p.closingChar);

      return match(p.closingChar)
         .with("}", () => `${escapedPattern}([^}]*)$`)
         .with(")", () => `${escapedPattern}([^)]*)$`)
         .with("]]", () => `${escapedPattern}([^\\]]*)$`)
         .otherwise(() => `${escapedPattern}([^${closingEscaped}]*)$`);
   });

   // Join all patterns with alternation
   const combinedPattern = patternParts.join("|");

   return {
      regex: new RegExp(combinedPattern, "d"),
      patternCount: patterns.length,
   };
}

/**
 * Build a regex pattern for definition provider matching
 * This matches complete link references (with closing chars)
 */
export async function buildDefinitionRegex(): Promise<RegExp[]> {
   const patterns = await getAllLinkPatterns();

   return patterns.map(p => {
      const escapedPattern = escapeRegex(p.pattern);
      const escapedClosing = escapeRegex(p.closingChar);

      return match(p.closingChar)
         .with("}", () => new RegExp(`${escapedPattern}([^}]*)\\}`, "g"))
         .with(")", () => new RegExp(`${escapedPattern}([^)]*)\\)`, "g"))
         .with("]]", () => new RegExp(`${escapedPattern}([^\\]]*)]\\]`, "g"))
         .otherwise(() => new RegExp(`${escapedPattern}([^${escapedClosing}]*)${escapedClosing}`, "g"));
   });
}

/**
 * Get all unique trigger characters from link patterns
 */
export async function getTriggerCharacters(): Promise<string[]> {
   const patterns = await getAllLinkPatterns();
   const triggers = new Set(patterns.map(p => p.triggerChar));
   return Array.from(triggers);
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
   return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clear the cached config (useful when file changes)
 */
export function clearLinkAliasCache(): void {
   cachedConfig = null;
}

/**
 * Initialize the link alias config system with file watching
 */
export function initLinkAliasConfig(context: vscode.ExtensionContext): void {
   const configPath = getConfigFilePath();
   if (!configPath) {
      return;
   }

   // Create file watcher for config changes
   const pattern = new vscode.RelativePattern(
      vscode.workspace.workspaceFolders![0],
      CONFIG_FILE_NAME
   );

   fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

   fileWatcher.onDidChange(() => {
      clearLinkAliasCache();
      vscode.window.showInformationMessage("Forester link aliases config reloaded");
   });

   fileWatcher.onDidCreate(() => {
      clearLinkAliasCache();
   });

   fileWatcher.onDidDelete(() => {
      clearLinkAliasCache();
   });

   context.subscriptions.push(fileWatcher);
}

/**
 * Create a default config file in the workspace if it doesn't exist
 */
export async function createDefaultConfigFile(): Promise<void> {
   const configPath = getConfigFilePath();
   if (!configPath) {
      vscode.window.showErrorMessage("No workspace folder found");
      return;
   }

   if (fs.existsSync(configPath)) {
      const action = await vscode.window.showWarningMessage(
         `${CONFIG_FILE_NAME} already exists. Overwrite?`,
         "Overwrite",
         "Open Existing"
      );

      return match(action)
         .with("Overwrite", async () => {
            await writeLinkAliasConfig(createDefaultConfig());
            await openConfigFile();
         })
         .with("Open Existing", async () => {
            await openConfigFile();
         })
         .otherwise(() => undefined);
   }

   await writeLinkAliasConfig(createDefaultConfig());
   await openConfigFile();
   vscode.window.showInformationMessage(`Created ${CONFIG_FILE_NAME} - add your custom link patterns here`);
}

/**
 * Open the config file in the editor
 */
export async function openConfigFile(): Promise<void> {
   const configPath = getConfigFilePath();
   if (!configPath) {
      return;
   }

   if (!fs.existsSync(configPath)) {
      await createDefaultConfigFile();
      return;
   }

   const doc = await vscode.workspace.openTextDocument(configPath);
   await vscode.window.showTextDocument(doc);
}

/**
 * Interactive command to add a new link pattern
 */
export async function addLinkPatternCommand(): Promise<void> {
   const pattern = await vscode.window.showInputBox({
      prompt: "Enter the opening pattern (e.g., \\cite{)",
      placeHolder: "\\cite{",
      validateInput: (value) => {
         if (!value || value.trim().length === 0) {
            return "Pattern cannot be empty";
         }
         return null;
      },
   });

   if (!pattern) {
      return;
   }

   const closingChar = await vscode.window.showInputBox({
      prompt: "Enter the closing character(s) (e.g., } or ]])",
      placeHolder: "}",
      validateInput: (value) => {
         if (!value || value.trim().length === 0) {
            return "Closing character cannot be empty";
         }
         return null;
      },
   });

   if (!closingChar) {
      return;
   }

   // Infer trigger character from the last character of the pattern
   const triggerChar = pattern.slice(-1);

   const description = await vscode.window.showInputBox({
      prompt: "Enter a description (optional)",
      placeHolder: "My custom citation command",
   });

   await addLinkAliasPattern({
      pattern,
      closingChar,
      triggerChar,
      description: description || undefined,
   });

   vscode.window.showInformationMessage(`Added link pattern: ${pattern}...${closingChar}`);
}

/**
 * Interactive command to remove a link pattern
 */
export async function removeLinkPatternCommand(): Promise<void> {
   const config = await readLinkAliasConfig();

   if (config.customPatterns.length === 0) {
      vscode.window.showInformationMessage("No custom link patterns to remove");
      return;
   }

   const items = config.customPatterns.map(p => ({
      label: `${p.pattern}...${p.closingChar}`,
      description: p.description,
      pattern: p.pattern,
   }));

   const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a pattern to remove",
   });

   if (!selected) {
      return;
   }

   await removeLinkAliasPattern(selected.pattern);
   vscode.window.showInformationMessage(`Removed link pattern: ${selected.label}`);
}
