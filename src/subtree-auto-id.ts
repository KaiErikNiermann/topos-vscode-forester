import * as path from "path";
import { TextDecoder } from "util";
import * as vscode from "vscode";

import {
   computeSubtreeIdScanState,
   DEFAULT_SUBTREE_TEMPLATE,
   extractSubtreeReferenceIds,
   fromBase36Stem,
   isCanonicalBase36Stem,
   nextCanonicalBase36Id,
   renderSubtreeTemplate,
} from "./subtree-auto-id-core";
import { getRoot, getTreesDirectories } from "./utils";

const AUTO_ID_ENABLED_KEY = "subtree.autoId.enabled";
const TEMPLATE_KEY = "subtree.autoId.template";
const RESERVE_SUBTREE_ID_COMMAND = "forester.internal.reserveSubtreeId";

const BARE_SUBTREE_REGEX = /\\subtree\{/g;

function findSubtreeCompletionStart(linePrefix: string): number | undefined {
   const typedSubtree = /\\subtr[a-zA-Z-]*$/.exec(linePrefix);
   if (typedSubtree) {
      return typedSubtree.index;
   }

   const typedBareSubtree = /\\subtree\{$/.exec(linePrefix);
   if (typedBareSubtree) {
      return typedBareSubtree.index;
   }

   return undefined;
}

export class SubtreeAutoIdFeature implements vscode.Disposable {
   private readonly decoder = new TextDecoder("utf-8");
   private readonly disposables: vscode.Disposable[] = [];

   private knownCanonicalIds = new Set<string>();
   private nextCanonicalValue = 0;
   private stale = true;
   private scanPromise: Promise<void> | null = null;
   private applyingInlineEdit = false;

   public activate(context: vscode.ExtensionContext): void {
      this.disposables.push(
         vscode.commands.registerCommand(RESERVE_SUBTREE_ID_COMMAND, (generatedId: unknown) => {
            if (typeof generatedId === "string" && generatedId.length > 0) {
               this.reserveId(generatedId);
            }
         }),
      );

      this.disposables.push(
         vscode.languages.registerCompletionItemProvider(
            { scheme: "file", language: "forester" },
            {
               provideCompletionItems: async (document, position) => this.provideSubtreeCompletionItems(document, position),
            },
            "\\",
            "r",
            "{",
         ),
      );

      this.disposables.push(
         vscode.workspace.onDidChangeTextDocument((event) => {
            if (!this.isEnabled() || this.applyingInlineEdit) {
               return;
            }

            if (event.document.languageId !== "forester") {
               return;
            }

            const likelyContainsSubtree = event.contentChanges.some((change) => change.text.includes("{") || change.text.includes("subtree"));
            if (!likelyContainsSubtree) {
               return;
            }

            void this.spliceGeneratedIdsIntoBareSubtrees(event);
         }),
      );

      this.disposables.push(
         vscode.workspace.onDidSaveTextDocument((document) => {
            if (this.shouldInvalidateFromPath(document.fileName)) {
               this.markStale();
            }
         }),
      );

      this.disposables.push(
         vscode.workspace.onDidCreateFiles((event) => {
            if (event.files.some((file) => this.shouldInvalidateFromPath(file.fsPath))) {
               this.markStale();
            }
         }),
      );

      this.disposables.push(
         vscode.workspace.onDidDeleteFiles((event) => {
            if (event.files.some((file) => this.shouldInvalidateFromPath(file.fsPath))) {
               this.markStale();
            }
         }),
      );

      this.disposables.push(
         vscode.workspace.onDidRenameFiles((event) => {
            const hasTreeFileRename = event.files.some((entry) => this.shouldInvalidateFromPath(entry.oldUri.fsPath) || this.shouldInvalidateFromPath(entry.newUri.fsPath));
            if (hasTreeFileRename) {
               this.markStale();
            }
         }),
      );

      this.disposables.push(
         vscode.workspace.onDidChangeConfiguration((event) => {
            const affectsAutoIdToggle = event.affectsConfiguration(`forester.${AUTO_ID_ENABLED_KEY}`);
            if (event.affectsConfiguration("forester.config") || affectsAutoIdToggle) {
               this.markStale();
            }

            if (affectsAutoIdToggle && this.isEnabled()) {
               void this.ensureScanned();
            }
         }),
      );

      context.subscriptions.push(this);
      if (this.isEnabled()) {
         void this.ensureScanned();
      }
   }

   public dispose(): void {
      this.disposables.forEach((disposable) => disposable.dispose());
   }

   private isEnabled(): boolean {
      const config = vscode.workspace.getConfiguration("forester");
      return config.get<boolean>(AUTO_ID_ENABLED_KEY, false);
   }

   private getTemplate(): string {
      const config = vscode.workspace.getConfiguration("forester");
      return config.get<string>(TEMPLATE_KEY, DEFAULT_SUBTREE_TEMPLATE);
   }

   private shouldInvalidateFromPath(fsPath: string): boolean {
      return fsPath.endsWith(".tree") || path.basename(fsPath) === "forest.toml";
   }

   private markStale(): void {
      this.stale = true;
   }

   private async provideSubtreeCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
      if (!this.isEnabled() || document.languageId !== "forester") {
         return [];
      }

      const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
      const completionStart = findSubtreeCompletionStart(linePrefix);
      if (completionStart === undefined) {
         return [];
      }

      let generatedId: string;
      try {
         generatedId = await this.peekNextId();
      } catch (error) {
         this.reportGenerationError(error);
         return [];
      }

      const snippet = renderSubtreeTemplate(this.getTemplate(), generatedId);

      const completion = new vscode.CompletionItem(`subtree [${generatedId}]`, vscode.CompletionItemKind.Snippet);
      completion.range = new vscode.Range(new vscode.Position(position.line, completionStart), position);
      completion.insertText = new vscode.SnippetString(snippet);
      completion.filterText = "\\subtree";
      completion.sortText = "0000-subtree-auto-id";
      completion.preselect = true;
      completion.detail = "Insert subtree template with the next canonical 4-char base36 ID";
      completion.documentation = "ID generation scans tree filenames and existing \\subtree[...] references for canonical IDs matching ^[0-9a-z]{4}$.";
      completion.command = {
         command: RESERVE_SUBTREE_ID_COMMAND,
         title: "Reserve generated subtree ID",
         arguments: [generatedId],
      };

      return [completion];
   }

   private async spliceGeneratedIdsIntoBareSubtrees(event: vscode.TextDocumentChangeEvent): Promise<void> {
      const insertionPoints = this.findBareSubtreeInsertionPoints(event.document, event.contentChanges);
      if (insertionPoints.length === 0) {
         return;
      }

      const edit = new vscode.WorkspaceEdit();
      for (const insertionPoint of insertionPoints) {
         let generatedId: string;
         try {
            generatedId = await this.reserveNextId();
         } catch (error) {
            this.reportGenerationError(error);
            return;
         }

         edit.insert(event.document.uri, insertionPoint, `[${generatedId}]`);
      }

      this.applyingInlineEdit = true;
      try {
         await vscode.workspace.applyEdit(edit);
      } finally {
         this.applyingInlineEdit = false;
      }
   }

   private findBareSubtreeInsertionPoints(document: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[]): vscode.Position[] {
      const insertionKeys = new Set<string>();
      const insertionPoints: vscode.Position[] = [];

      for (const change of changes) {
         const changedLineCount = Math.max(1, change.text.split(/\r?\n/).length);
         const startLine = Math.max(0, change.range.start.line - 1);
         const endLine = Math.min(document.lineCount - 1, change.range.start.line + changedLineCount + 1);

         for (let line = startLine; line <= endLine; line += 1) {
            const lineText = document.lineAt(line).text;
            BARE_SUBTREE_REGEX.lastIndex = 0;

            let matchResult: RegExpExecArray | null;
            while ((matchResult = BARE_SUBTREE_REGEX.exec(lineText)) !== null) {
               const insertCharacter = matchResult.index + "\\subtree".length;
               const key = `${line}:${insertCharacter}`;
               if (insertionKeys.has(key)) {
                  continue;
               }

               insertionKeys.add(key);
               insertionPoints.push(new vscode.Position(line, insertCharacter));
            }
         }
      }

      insertionPoints.sort((left, right) => {
         if (left.line === right.line) {
            return right.character - left.character;
         }
         return right.line - left.line;
      });

      return insertionPoints;
   }

   private async ensureScanned(): Promise<void> {
      if (!this.stale) {
         return;
      }

      if (this.scanPromise) {
         await this.scanPromise;
         return;
      }

      this.scanPromise = this.refreshIndex().finally(() => {
         this.scanPromise = null;
      });

      await this.scanPromise;
   }

   private async refreshIndex(): Promise<void> {
      try {
         const root = getRoot();
         const treesDirectories = await getTreesDirectories();
         const treeFilesByDirectory = await Promise.all(
            treesDirectories.map((directory) =>
               vscode.workspace.findFiles(
                  new vscode.RelativePattern(root, `${directory}/**/*.tree`),
                  "**/node_modules/**",
               ),
            ),
         );

         const fileMap = new Map<string, vscode.Uri>();
         for (const treeFiles of treeFilesByDirectory) {
            for (const treeFile of treeFiles) {
               fileMap.set(treeFile.fsPath, treeFile);
            }
         }

         const treeIds: string[] = [];
         const subtreeIds: string[] = [];

         for (const treeFile of fileMap.values()) {
            treeIds.push(path.basename(treeFile.fsPath, ".tree"));

            try {
               const raw = await vscode.workspace.fs.readFile(treeFile);
               const content = this.decoder.decode(raw);
               subtreeIds.push(...extractSubtreeReferenceIds(content));
            } catch (error) {
               console.error(`Failed to read tree file for subtree ID scan: ${treeFile.fsPath}`, error);
            }
         }

         const state = computeSubtreeIdScanState(treeIds, subtreeIds);
         this.knownCanonicalIds = state.knownCanonicalIds;
         this.nextCanonicalValue = state.nextCanonicalValue;
         this.stale = false;
      } catch (error) {
         console.error("Failed to refresh subtree ID cache:", error);

         // Fall back to a sensible local state, while preserving already reserved IDs.
         if (this.knownCanonicalIds.size === 0) {
            this.knownCanonicalIds = new Set<string>();
            this.nextCanonicalValue = 0;
         }

         this.stale = false;
      }
   }

   private reportGenerationError(error: unknown): void {
      console.error("Failed generating canonical subtree ID:", error);
      vscode.window.showErrorMessage("Forester subtree auto-ID failed: no canonical 4-character base36 IDs are available.");
   }

   private async peekNextId(): Promise<string> {
      await this.ensureScanned();

      const candidate = nextCanonicalBase36Id(this.knownCanonicalIds, this.nextCanonicalValue);
      return candidate.id;
   }

   private async reserveNextId(): Promise<string> {
      await this.ensureScanned();

      const candidate = nextCanonicalBase36Id(this.knownCanonicalIds, this.nextCanonicalValue);
      this.knownCanonicalIds.add(candidate.id);
      this.nextCanonicalValue = candidate.nextValue;
      return candidate.id;
   }

   private reserveId(id: string): void {
      const trimmedId = id.trim();
      if (!isCanonicalBase36Stem(trimmedId)) {
         return;
      }

      this.knownCanonicalIds.add(trimmedId);

      const decodedId = fromBase36Stem(trimmedId);
      if (decodedId === undefined) {
         return;
      }

      if (decodedId >= this.nextCanonicalValue) {
         this.nextCanonicalValue = decodedId + 1;
      }
   }
}
