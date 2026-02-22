import * as vscode from "vscode";

import { collectTagClosureHints, DEFAULT_TAG_CLOSURE_HINT_TAGS } from "./tag-closure-inlay-core";

const TAG_CLOSURE_HINT_SETTING = "inlayHints.tagClosures.enabled";
const TAG_CLOSURE_HINT_TAGS_SETTING = "inlayHints.tagClosures.tags";

export class ForesterTagClosureInlayHintsProvider implements vscode.InlayHintsProvider {
   private readonly changeEmitter = new vscode.EventEmitter<void>();
   public readonly onDidChangeInlayHints = this.changeEmitter.event;

   public dispose(): void {
      this.changeEmitter.dispose();
   }

   public refresh(): void {
      this.changeEmitter.fire();
   }

   public provideInlayHints(
      document: vscode.TextDocument,
      range: vscode.Range,
      token: vscode.CancellationToken,
   ): vscode.InlayHint[] {
      if (token.isCancellationRequested) {
         return [];
      }

      const config = vscode.workspace.getConfiguration("forester", document.uri);
      const enabled = config.get<boolean>(TAG_CLOSURE_HINT_SETTING, true);
      if (!enabled) {
         return [];
      }

      const source = document.getText();
      const configuredTags = config.get<readonly string[]>(TAG_CLOSURE_HINT_TAGS_SETTING, DEFAULT_TAG_CLOSURE_HINT_TAGS);
      const hints = collectTagClosureHints(source, {
         enabledTags: configuredTags,
      });
      if (hints.length === 0) {
         return [];
      }

      const startOffset = document.offsetAt(range.start);
      const endOffset = document.offsetAt(range.end);

      return hints
         .filter(entry => entry.offset >= startOffset && entry.offset <= endOffset)
         .map(entry => {
            const position = document.positionAt(entry.offset + 1);
            const hint = new vscode.InlayHint(position, entry.label, vscode.InlayHintKind.Type);
            hint.paddingLeft = true;
            hint.tooltip = `Closes \\${entry.label}{...}`;
            return hint;
         });
   }
}
