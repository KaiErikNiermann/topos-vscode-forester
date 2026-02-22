/**
 * utils.ts - Common utilities for the Forester extension
 */

import * as vscode from "vscode";
import { readFile, access, constants } from "fs/promises";
import { join } from "path";

/**
 * TypeScript interface for forest.toml configuration
 * Based on Forester OCaml types in lib/core/Config.ml
 */

export interface ForestConfig {
   forest?: {
      trees?: string[];
      assets?: string[];
      prefixes?: string[];
      url?: string;
      home?: string;
      latex?: {
         document_class?: string;
         document_class_options?: string[];
         compile_command?: string[];
         dvisvgm_command?: string[];
      };

      /** Import trees from external forests */
      foreign?: Array<{
         path: string;
         route_locally?: boolean;
      }>;
   };
}

/**
 * Get the root workspace folder.
 * Throws an error if no workspace is open or if opening a single file.
 */
export function getRoot(): vscode.Uri {
   if (vscode.workspace.workspaceFolders?.length) {
      if (vscode.workspace.workspaceFolders.length !== 1) {
         vscode.window.showWarningMessage(
            "vscode-forester only supports opening one workspace folder.",
         );
      }
      return vscode.workspace.workspaceFolders[0].uri;
   } else {
      // Probably opened a single file
      throw new vscode.FileSystemError(
         "vscode-forester doesn't support opening a single file.",
      );
   }
}

export async function getForestConfig(): Promise<ForestConfig | null> {
   const root = getRoot();

   const config = vscode.workspace.getConfiguration("forester");

   let configFile = config.get<string>("config") || "forest.toml";

   const configPath = join(root.fsPath, configFile);

   const content = await readFile(configPath, "utf-8");

   const { parse } = await import("smol-toml");
   return parse(content);
}

/**
 * Get the trees directories from forest.toml config
 */
export async function getTreesDirectories(): Promise<string[]> {
   try {
      const config = await getForestConfig();
      return config?.forest?.trees || ["trees"]; // Default to ["trees"] if not specified
   } catch (error) {
      console.error("Failed to read forest.toml, defaulting to 'trees' directory:", error);
      return ["trees"];
   }
}

/**
 * Get the root trees directory for creating new trees
 */
export async function getRootTreeDirectory(): Promise<vscode.Uri> {
   const root = getRoot();
   const dirs = await getTreesDirectories();
   // Use the first directory as the root one
   return vscode.Uri.joinPath(root, dirs[0]);
}

/**
 * Get available templates from the templates directory
 * @returns Array of template names (without .tree extension), plus "(No template)" option
 */
export async function getAvailableTemplates(): Promise<string[]> {
   const root = getRoot();
   let templates: string[] = [];

   try {
      const templateFiles = await vscode.workspace.fs.readDirectory(
         vscode.Uri.joinPath(root, 'templates')
      );
      templates = templateFiles
         .filter(([n, f]) => f === vscode.FileType.File && n.endsWith(".tree"))
         .map(([n, f]) => n.slice(0, -5));
   } catch {
      // templates directory doesn't exist, return empty array
   }

   templates.push("(No template)");
   return templates;
}

/**
 * Get the prefix for new trees from config, or prompt if not set
 */
export async function getPrefix(): Promise<string | undefined> {
   // Get prefixes from configuration
   const extensionConfig = vscode.workspace.getConfiguration("forester");

   const defaultPrefix = extensionConfig.get<string>('defaultPrefix');
   if (defaultPrefix) {return defaultPrefix;}

   const configToml = await getForestConfig();
   const prefixes = configToml?.forest?.prefixes;

   let prefix: string | undefined;
   if (prefixes) {
      prefix = await vscode.window.showQuickPick(prefixes, {
         canPickMany: false,
         placeHolder: "Choose prefix or Escape to use a new one (run the \"set default prefix\" command if you always use the same prefix)",
         title: "Choose prefix"
      });
   }

   if (!prefix) {
      prefix = await vscode.window.showInputBox({
         placeHolder: "Enter a prefix or Escape to cancel (run the \"set default prefix\" command if you always use the same prefix)",
         title: "Enter prefix"
      });
   }

   return prefix;
}

/**
 * Taxon mapping: full name → primary abbreviation
 * Additional abbreviations can map to the same full name
 */
const TAXON_MAP: { [fullName: string]: string } = {
   'theorem': 'thm',
   'definition': 'def',
   'proposition': 'prop',
   'lemma': 'lem',
   'corollary': 'cor',
   'example': 'ex',
   'remark': 'rem',
   'proof': 'pf',
   'section': 'sec',
   'chapter': 'ch',
   'note': 'note',
   'conjecture': 'conj',
   'axiom': 'ax',
   'construction': 'const',
   'observation': 'obs',
   'exercise': 'exer',
   'problem': 'prob',
   'solution': 'soln',
   'algorithm': 'alg',
   'discussion': 'disc',
   'warning': 'warn',
   'nota-bene': 'nb',
   'appendix': 'app',
   'explication': 'expl',
   'figure': 'fig',
};

/**
 * Alternative abbreviations that map to full taxon names
 * These are accepted as input but normalized to the primary abbreviation
 */
const ALTERNATIVE_ABBREVIATIONS: { [abbrev: string]: string } = {
   'defn': 'definition',
   'eg': 'example',
   'rmk': 'remark',
};

/**
 * Get the full set of abbreviation → full name mappings
 * Combines primary abbreviations (reversed from TAXON_MAP) with alternatives
 */
function getAbbreviationToFullNameMap(): { [abbrev: string]: string } {
   const map: { [abbrev: string]: string } = { ...ALTERNATIVE_ABBREVIATIONS };

   // Add reversed mappings from TAXON_MAP
   for (const [fullName, abbrev] of Object.entries(TAXON_MAP)) {
      map[abbrev] = fullName;
   }

   return map;
}

/**
 * Parse taxon and title from user input
 * Supports formats like:
 * - "thm: My Theorem Title"
 * - "theorem: My Theorem Title"
 * - "My Plain Title" (no taxon)
 */
export function parseTaxonAndTitle(input: string): { taxon?: string; title: string } {
   const colonIndex = input.indexOf(':');

   if (colonIndex > 0 && colonIndex < 30) { // Reasonable position for a taxon
      const potentialTaxon = input.slice(0, Math.max(0, colonIndex)).trim().toLowerCase();
      const titlePart = input.slice(Math.max(0, colonIndex + 1)).trim();

      // Check if it's a known abbreviation
      const abbreviationMap = getAbbreviationToFullNameMap();
      if (abbreviationMap[potentialTaxon]) {
         return {
            taxon: abbreviationMap[potentialTaxon],
            title: titlePart
         };
      }

      // Check if it's already a full taxon name
      if (TAXON_MAP[potentialTaxon]) {
         return {
            taxon: potentialTaxon,
            title: titlePart
         };
      }

      // Accept any reasonable word as a custom taxon
      if (/^[a-z-]+$/.test(potentialTaxon) && potentialTaxon.length <= 20) {
         return {
            taxon: potentialTaxon,
            title: titlePart
         };
      }
   }

   // No taxon detected, return full input as title
   return { title: input };
}

/**
 * Get the abbreviation for a taxon
 * Checks custom configuration first, then uses built-in abbreviations
 */
export function getTaxonAbbreviation(taxon?: string | null): string {
   if (!taxon) {return '';}

   const lowerTaxon = taxon.toLowerCase();

   // Check custom configuration first
   const customConfig = getCustomTaxonConfig();
   if (customConfig[lowerTaxon]?.abbreviation) {
      return customConfig[lowerTaxon].abbreviation as string;
   }

   // Check built-in taxon map
   if (TAXON_MAP[lowerTaxon]) {
      return TAXON_MAP[lowerTaxon];
   }

   // Default to first 3 letters
   return taxon.slice(0, 3).toLowerCase();
}

/**
 * Get custom taxon configuration from VS Code settings
 */
export function getCustomTaxonConfig(): { [key: string]: { emoji?: string; abbreviation?: string } } {
   const config = vscode.workspace.getConfiguration('forester');
   const customTaxons = config.get<{ [key: string]: { emoji?: string; abbreviation?: string } }>('taxonCustomization', {});

   // Convert keys to lowercase for case-insensitive matching
   const normalizedConfig: { [key: string]: { emoji?: string; abbreviation?: string } } = {};
   for (const [key, value] of Object.entries(customTaxons)) {
      normalizedConfig[key.toLowerCase()] = value;
   }

   return normalizedConfig;
}
