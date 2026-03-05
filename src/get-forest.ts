/**
 * server.ts - Wrapper around the Forester executable
 *
 * This module provides functions to interact with the Forester command-line tool,
 * including querying for trees and executing commands. It also manages caching
 * of query results to avoid redundant calls to the Forester executable.
 */

import * as vscode from "vscode";
import * as util from "util";
import * as childProcess from "child_process";
import { getRoot } from "./utils";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { publishForesterDiagnostics } from "./forester-diagnostics";

const execFile = util.promisify(childProcess.execFile);

// See lib/render/Render_json.ml in forester
export interface ForesterTree {
   title: string | null;
   taxon: string | null;
   tags: string[];
   route: string;
   metas: Map<string, string>;
   sourcePath: string;
   uri: string;
}

export type Forest = ForesterTree[];

// For managing the global cache flow
let queryInProgressPromise: Promise<Forest> | null = null;
let mostRecentQueryResult: Forest | null = null;
let isInitialLoad = true;

// For tracking the build status of the forest
let forestStatus: { valid?: boolean; updating?: boolean, error?: string, step?: string };
let statusBarItem: vscode.StatusBarItem | null = null;

// File event handlers and callbacks
let fileEventDisposables: vscode.Disposable[] = [];
const forestChangeCallbacks = new Set<() => void>();

/**
 * Get the current forest status
 */
export function getForestStatus() {
   return forestStatus;
}

/**
 * Initialize the status bar item
 */
export function initStatusBar(context: vscode.ExtensionContext) {
   if (!statusBarItem) {
      statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      statusBarItem.command = 'forester.showForestStatus';
      context.subscriptions.push(statusBarItem);
   }
   updateStatusBar({ valid: true });
}

/**
 * Update the status bar based on current forest status
 */
function updateStatusBar(status: typeof forestStatus) {
   forestStatus = status;

   if (!statusBarItem) {
      return;
   }

   if (forestStatus.updating) {
      statusBarItem.text = forestStatus.step
         ? `$(sync~spin) ${forestStatus.step}`
         : "$(sync~spin) Forest updating...";
      statusBarItem.tooltip = forestStatus.step ?? "Forester is rebuilding";
      statusBarItem.backgroundColor = undefined;
   } else if (forestStatus.valid) {
      statusBarItem.text = "$(check) Forest valid";
      statusBarItem.tooltip = "Forester forest is valid";
      statusBarItem.backgroundColor = undefined;
   } else {
      statusBarItem.text = "$(error) Forest invalid (hover to view error)";
      statusBarItem.tooltip = `Forester error: ${forestStatus.error || 'Unknown error'}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
   }
   statusBarItem.show();
}

export async function getTree(treeId: string): Promise<ForesterTree | null> {
   // if we can find it in our most recent successful query just return (keeps things fast)
   if (mostRecentQueryResult) {
      let tree = mostRecentQueryResult.find((entry) => entry.uri === treeId);
      if (tree) {
         return tree;
      }
   }

   const forest = await getForest();
   return forest.find((entry) => entry.uri === treeId) || null;
}

// await to return a forest array, handles all the caching logic
export async function getForest({ forceReload, fastReturnStale }: { forceReload?: boolean, fastReturnStale?: boolean } = {}): Promise<Forest> {
   // If there's no query in progress (or we don't care that the data might be stale) and we have some then return it (unless we're forcing a reload). A reload is forced whenever a file changes by forestUpdatedOnDisk.
   if ((!queryInProgressPromise || fastReturnStale) && mostRecentQueryResult && !forceReload) {
      return mostRecentQueryResult;
   }

   // If we have a query in progress then return the promise which will resolve to result
   if (queryInProgressPromise && !forceReload) {
      return queryInProgressPromise;
   }

   // Show step progress in the status bar during initial load
   if (isInitialLoad) {
      updateStatusBar({ updating: true, step: '(1/2) Building forest cache...' });
   }

   queryInProgressPromise = queryForest();

   // setting the global promise and then awaiting means that if there are calls to getForest in the meantime they will await the same promise
   const result = mostRecentQueryResult = await queryInProgressPromise;

   for (const callback of forestChangeCallbacks) {
      try {
         callback();
      } catch (error) {
         console.error('Error in forest change callback:', error);
      }
   }

   if (isInitialLoad) {
      updateStatusBar({ updating: true, step: `(2/2) Loaded ${result.length} trees` });
      // Brief pause so the user can see the final step before it transitions
      setTimeout(() => { isInitialLoad = false; }, 1500);
   }

   queryInProgressPromise = null;

   return mostRecentQueryResult || [];
}

// handles actually calling forester
async function queryForest(): Promise<Forest> {
   const cwd = getRoot().fsPath;

   const config = vscode.workspace.getConfiguration("forester");
   const path = config.get("path") as string ?? "forester";
   const configfile = config.get("config") as string;

   const args = ["query", "all", ...(configfile ? [configfile] : [])];
   let forester = childProcess.spawn(path, args, { cwd, detached: false, stdio: "pipe", windowsHide: true });

   let timeoutToken;
   let stderr = "";
   let stdout = "";
   forester.stderr.on("data", (chunk) => { stderr += chunk; });
   forester.stdout.on("data", (chunk) => { stdout += chunk; });

   updateStatusBar({ updating: true });

   const [success, dataOrErrorMessage] = await new Promise<[boolean, { string: Omit<ForesterTree, 'uri'> } | Forest | string]>((resolve) => {
      timeoutToken = setTimeout(() => {
         resolve([false, 'Forester timed out after 30s']);
         forester.kill();
      }, 30000);

      forester.once('error', (error) => {
         vscode.window.showWarningMessage(`Forester: Critical error - ${error.message}`);
         resolve([false, error.message]);
      });

      forester.once('close', (code, signal) => {
         if (signal !== null || code !== 0) {
            resolve([false, `Forester: process exited with code ${code} and signal ${signal}.`]);
         } else {
            try {
               const result = JSON.parse(stdout);
               resolve([true, result]);
            } catch (e) {
               resolve([false, "Forester didn't return a valid JSON response:\n" + stdout]);
            }
         }
      });
   });;

   clearTimeout(timeoutToken);

   if (success) {
      updateStatusBar({ valid: true });
      publishForesterDiagnostics(stdout, true);
      if (Array.isArray(dataOrErrorMessage)) {
         return dataOrErrorMessage as Forest; // new query format
      } else {
         return Object.entries(dataOrErrorMessage).map(([id, entry]) => ({ uri: id, ...entry })); // old query format
      }
   } else {
      const errorMessage = dataOrErrorMessage + (stdout ? '\n\n' + stdout : '') + (stderr ? '\n\n' + stderr : '');
      updateStatusBar({ valid: false, error: errorMessage as string });
      // Parse stdout for structured diagnostics (Asai TTY format)
      publishForesterDiagnostics(stdout, false);

      console.log(errorMessage);;

      // if we can't get data via query try and fall back to most recent in-memory success
      if (mostRecentQueryResult) {
         return mostRecentQueryResult;
      }

      // if that doesn't work then see if we can get directly from the most recent successful build
      const buildData = await getForestFromBuild();
      if (buildData) {
         return buildData;
      }

      // if that doesn't work then we have no usable forest
      return [];
   }
}


/**
 * Initialize forest monitoring - starts watching for file changes
 */
export function initForestMonitoring(context: vscode.ExtensionContext) {
   // Clean up any existing handlers
   for (const d of fileEventDisposables) {d.dispose();}
   fileEventDisposables = [];

   const forestUpdatedOnDisk = async () => {
      // if the query takes 4s, and we call this a bunch of times in that time
      // then the first one will create the promise, and then rest will await it
      // and then when it's done whoever awaited first will re-do it
      if (queryInProgressPromise) {
         await queryInProgressPromise;
      }

      await getForest({ forceReload: true });
   };

   // Watch for .tree file changes using workspace events (more reliable than createFileSystemWatcher)
   fileEventDisposables.push(
      // Save events catch changes made in VS Code
      vscode.workspace.onDidSaveTextDocument((doc) => {
         if (doc.fileName.endsWith('.tree') || doc.fileName.endsWith('forest.toml')) {
            forestUpdatedOnDisk();
         }
      }),

      // File creation events
      vscode.workspace.onDidCreateFiles((event) => {
         if (event.files.some(uri => uri.fsPath.endsWith('.tree') || uri.fsPath.endsWith('forest.toml'))) {
            forestUpdatedOnDisk();
         }
      }),

      // File deletion events
      vscode.workspace.onDidDeleteFiles((event) => {
         if (event.files.some(uri => uri.fsPath.endsWith('.tree') || uri.fsPath.endsWith('forest.toml'))) {
            forestUpdatedOnDisk();
         }
      }),

      // File rename events
      vscode.workspace.onDidRenameFiles((event) => {
         if (event.files.some(f => f.oldUri.fsPath.endsWith('.tree') || f.newUri.fsPath.endsWith('.tree') ||
            f.oldUri.fsPath.endsWith('forest.toml') || f.newUri.fsPath.endsWith('forest.toml'))) {
            forestUpdatedOnDisk();
         }
      })
   );

   // Add to subscriptions for cleanup
   context.subscriptions.push(...fileEventDisposables);

   // Trigger initial load
   getForest({ forceReload: true });
}


/**
 * Register a callback to be called when the forest changes
 * Returns a disposable to unregister the callback
 */
export function onForestChange(callback: () => void): vscode.Disposable {
   forestChangeCallbacks.add(callback);

   // If we already have cached results, call the callback immediately
   if (mostRecentQueryResult) {
      callback();
   }

   return new vscode.Disposable(() => {
      forestChangeCallbacks.delete(callback);
   });
}


/**
 * Cleanup function for extension deactivation
 */
export function cleanupServer(): void {
   // Dispose file event handlers
   for (const d of fileEventDisposables) {d.dispose();}
   fileEventDisposables = [];

   // Clear callbacks
   forestChangeCallbacks.clear();

   // Clear cache
   queryInProgressPromise = null;
   mostRecentQueryResult = null;
}

/**
 * Read forest.json from the output directory
 * This provides an alternative way to get the forest data from the built output
 * The structure matches ForesterTree[] exactly
 */
export async function getForestFromBuild(): Promise<Forest | null> {
   try {
      const root = getRoot();
      const outputPath = join(root.fsPath, "output", "forest.json");

      if (!existsSync(outputPath)) {
         return null;
      }

      const content = await readFile(outputPath, "utf-8");
      const data = JSON.parse(content) as Forest;

      // Validate that it's an array of ForesterTree objects
      if (!Array.isArray(data)) {
         console.error("forest.json is not an array");
         return null;
      }

      // Basic validation of the structure
      for (const tree of data) {
         if (typeof tree.uri !== "string") {
            console.error("Invalid tree structure in forest.json: missing uri");
            return null;
         }
      }

      return data;
   } catch (error) {
      console.error("Failed to read forest.json from output:", error);
      return null;
   }
}

export async function command(command: string[]) {
   // Get some configurations
   const config = vscode.workspace.getConfiguration("forester");
   const path: string = config.get("path") ?? "forester";
   const configfile: string | undefined = config.get("config");
   const root = getRoot();

   console.log(command);

   try {
      let { stdout, stderr } = await execFile(
         path,
         configfile ? [...command, configfile] : command,
         {
            cwd: root.fsPath,
            windowsHide: true,
         },
      );
      if (stderr) {
         vscode.window.showErrorMessage(stderr);
      }
      return stdout;
   } catch (e: any) {
      const errorMessage = e.toString() + (e.stdout ? '\n\n' + e.stdout : '') + (e.stderr ? '\n\n' + e.stderr : '');

      vscode.window.showErrorMessage(errorMessage);
   }
}
