/**
 * transclude-decorations.ts - Adds inline title hints after transclude commands
 */

import * as vscode from 'vscode';
import { getTree, onForestChange } from './get-forest';
import { Forest } from './get-forest';
import { getTaxonAbbreviation } from './utils';

export class TranscludeDecorationProvider {
   private decorationType: vscode.TextEditorDecorationType;
   private disposables: vscode.Disposable[] = [];

   constructor() {
      // Create decoration type with subtle styling
      this.decorationType = vscode.window.createTextEditorDecorationType({
         rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
         after: {
            color: new vscode.ThemeColor('editorInlayHint.foreground'),
            fontStyle: 'italic',
            margin: '0 0 0 0.5em',
         },
         
      });
   }

   public activate(context: vscode.ExtensionContext) {
      // Update decorations when visible editors change
      this.disposables.push(
         vscode.window.onDidChangeVisibleTextEditors(editors => {
            this.updateAllVisibleEditors();
         })
      );

      // Update decorations when active editor changes
      this.disposables.push(
         vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
               this.updateDecorations(editor);
            }
         })
      );

      // Update decorations when text changes
      this.disposables.push(
         vscode.workspace.onDidChangeTextDocument(event => {
            // Find all visible editors showing this document
            const affectedEditors = vscode.window.visibleTextEditors.filter(
               editor => editor.document === event.document
            );

            // Update all affected editors with debounce
            for (const editor of affectedEditors) {
               setTimeout(() => this.updateDecorations(editor), 100);
            }
         })
      );

      // Update when forest data changes
      this.disposables.push(
         onForestChange(() => {
            // Update all visible editors when forest changes
            this.updateAllVisibleEditors();
         })
      );

      // Update decorations when configuration changes
      this.disposables.push(
         vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('forester.decorations.enabled')) {
               this.updateAllVisibleEditors();
            }
         })
      );

      // Add disposables to context
      context.subscriptions.push(...this.disposables);
      context.subscriptions.push(this.decorationType);

      // Initial update for all visible editors
      this.updateAllVisibleEditors();
   }

   private updateAllVisibleEditors() {
      for (const editor of vscode.window.visibleTextEditors) {
         this.updateDecorations(editor);
      }
   }

   private async updateDecorations(editor: vscode.TextEditor) {
      // Only decorate forester files
      if (editor.document.languageId !== 'forester') {
         editor.setDecorations(this.decorationType, []);
         return;
      }

      // Check if decorations are enabled
      const config = vscode.workspace.getConfiguration('forester');
      const decorationsEnabled = config.get<boolean>('decorations.enabled', true);

      if (!decorationsEnabled) {
         editor.setDecorations(this.decorationType, []);
         return;
      }

      const decorations: vscode.DecorationOptions[] = [];
      const text = editor.document.getText();

      // Match various transclude patterns:
      // \transclude{id}
      // \import{id}
      // \export{id}
      const transcludePattern = /\\(transclude|import|export)\{([^}]+)\}/g;

      let match;
      while ((match = transcludePattern.exec(text)) !== null) {
         const treeId = match[2];
         const startPos = editor.document.positionAt(match.index);
         const endPos = editor.document.positionAt(match.index + match[0].length);

         // Skip if there's a same-line trailing comment (user-provided title)
         const line = editor.document.lineAt(startPos.line).text;
         const afterMatch = line.slice(endPos.character);
         if (afterMatch.includes('%')) {
            continue;
         }

         // Get the title for this tree ID
         const title = await this.getTreeTitle(treeId);

         if (title && title !== treeId) {  // Only show if we have a meaningful title
            const decoration: vscode.DecorationOptions = {
               range: new vscode.Range(startPos, endPos),
               renderOptions: {
                  after: {
                     contentText: `(${title})`,
                  }
               }
            };
            decorations.push(decoration);
         }
      }

      editor.setDecorations(this.decorationType, decorations);
   }

   private async getTreeTitle(treeId: string): Promise<string | null> {
      try {
         const tree = await getTree(treeId);
         if (!tree) {return null;}

         // Format like TOC: include taxon abbreviation if present
         if (tree.taxon) {
            const abbreviation = getTaxonAbbreviation(tree.taxon);
            return `${abbreviation}: ${tree.title || treeId}`;
         }

         return tree.title || null;
      } catch (error) {
         console.error(`Failed to get title for tree ${treeId}:`, error);
         return null;
      }
   }

   public dispose() {
      for (const d of this.disposables) {d.dispose();}
      this.decorationType.dispose();
   }
}