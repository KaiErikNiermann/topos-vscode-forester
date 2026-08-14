import * as vscode from "vscode";

/**
 * Close `\{` with `\}` rather than a bare `}`.
 *
 * This cannot be an auto-closing pair in language-configuration.json, though
 * it looks exactly like one. Given a pair `\{` → `\}`, monaco looks for a
 * second pair *contained* in it — `_findContainedAutoClosingPair`, which takes
 * any candidate where `pair.open.includes(candidate.open) &&
 * pair.close.endsWith(candidate.close)`. The ordinary `{` → `}` pair satisfies
 * both. When the character after the cursor is then a `}`, monaco assumes that
 * brace will serve as the tail of the escape and inserts only the part it
 * thinks is missing:
 *
 *     pair.close.substring(0, pair.close.length - containedPairClose.length)
 *
 * which for `\}` minus `}` is a lone backslash. So typing `\{` at `##{|}`
 * yielded `##{\{\}` — the brace closing the math block silently became the
 * tail of an escape. The behaviour is deliberate upstream (it is what makes
 * `${` do the right thing before an existing `}` in a template literal), it is
 * not reachable by `autoCloseBefore` — `_isBeforeClosingBrace` bypasses that
 * check entirely for a `}` — and it cannot be switched off per pair.
 *
 * So `\{` is left to the plain `{` → `}` pair, which is single-character and
 * therefore has no contained pair to subtract, and the escape is finished
 * here: when the editor auto-closes a brace that a backslash opened, the
 * inserted `}` is upgraded to `\}`. Only ever the brace the editor just
 * inserted, never one already in the file — which is what keeps a math block's
 * closer out of it.
 */

const AUTO_CLOSED_BRACE_PAIR = "{}";

/** Whether the `{` at `braceOffset` is escaped, i.e. preceded by an odd run of backslashes. */
function bracePrefixIsEscape(text: string, braceOffset: number): boolean {
   let backslashes = 0;
   for (let index = braceOffset - 1; index >= 0 && text.charAt(index) === "\\"; index -= 1) {
      backslashes += 1;
   }

   // An even run is that many literal `\\` escapes, leaving the brace structural.
   return backslashes % 2 === 1;
}

export class EscapeBraceAutoCloseFeature implements vscode.Disposable {
   private readonly disposables: vscode.Disposable[] = [];
   private applyingEdit = false;

   public activate(context: vscode.ExtensionContext): void {
      this.disposables.push(
         vscode.workspace.onDidChangeTextDocument((event) => {
            void this.upgradeAutoClosedBrace(event);
         }),
      );

      context.subscriptions.push(this);
   }

   public dispose(): void {
      for (const disposable of this.disposables) {
         disposable.dispose();
      }
   }

   private async upgradeAutoClosedBrace(event: vscode.TextDocumentChangeEvent): Promise<void> {
      if (this.applyingEdit || event.document.languageId !== "forester") {
         return;
      }

      // The editor emits its auto-close as one edit inserting both characters,
      // so a single `{}` insertion is the signature of "the editor closed this
      // brace", as distinct from a paste, an undo, or a typed `{` that was not
      // auto-closed at all. Any of those must be left alone.
      if (event.contentChanges.length !== 1) {
         return;
      }

      const [change] = event.contentChanges;
      if (change === undefined || change.text !== AUTO_CLOSED_BRACE_PAIR || change.rangeLength !== 0) {
         return;
      }

      const document = event.document;
      const braceOffset = document.offsetAt(change.range.start);
      if (!bracePrefixIsEscape(document.getText(), braceOffset)) {
         return;
      }

      const editor = vscode.window.activeTextEditor;
      if (editor?.document !== document) {
         return;
      }

      // The backslash goes in ahead of the closer, and the cursor belongs
      // between `\{` and the `\}` it now opens — which is where the editor was
      // about to put it anyway. Reading the selection here would not find it
      // there: the caret has not yet moved between the braces when the change
      // event fires, so it is computed rather than saved and restored.
      const caretOffset = braceOffset + 1;

      this.applyingEdit = true;
      try {
         // Both undo stops are suppressed so the backslash joins the keystroke
         // that provoked it: one undo should take back the whole `\{\}`, not
         // peel the escape apart into `\{}` first.
         const applied = await editor.edit(
            (builder) => builder.insert(document.positionAt(caretOffset), "\\"),
            { undoStopBefore: false, undoStopAfter: false },
         );

         if (applied) {
            const caret = document.positionAt(caretOffset);
            editor.selections = [new vscode.Selection(caret, caret)];
         }
      } finally {
         this.applyingEdit = false;
      }
   }
}
