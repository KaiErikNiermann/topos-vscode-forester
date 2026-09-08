/**
 * subtree-location-core.ts — pure location logic for inline `\subtree[id]{…}`.
 *
 * A forest addresses two kinds of tree by the same syntax: a *file* tree, which
 * owns `<id>.tree`, and an inline *subtree*, which lives inside some parent
 * file and has no file of its own. Navigation (go-to-definition on
 * `\transclude{009k}`) used to resolve only the first kind and report
 * "File for tree '009k' not found" for the second, which is not what happened —
 * the tree exists, it just is not a file.
 *
 * This module has no VSCode dependency so both the extension-side definition
 * provider and the Langium LSP provider can share it, and so it is testable
 * standalone (`pnpm run test:subtree-location`).
 */

/** Zero-based position, matching both `vscode.Position` and LSP `Position`. */
export interface SubtreePosition {
   readonly line: number;
   readonly character: number;
}

/** Where an inline `\subtree[id]` is declared inside a `.tree` file. */
export interface SubtreeDeclarationLocation {
   readonly id: string;
   /** The backslash of `\subtree`. */
   readonly start: SubtreePosition;
   /** Just past the `]` closing the address bracket. */
   readonly end: SubtreePosition;
   /** First character of the address itself, inside the brackets. */
   readonly idStart: SubtreePosition;
   /** Just past the last character of the address. */
   readonly idEnd: SubtreePosition;
}

/**
 * Mirrors `SUBTREE_WITH_ID_REGEX` in `subtree-auto-id-core.ts`: forester writes
 * the address in brackets, and whitespace between the command and the bracket
 * is legal.
 */
const SUBTREE_DECLARATION_REGEX = /\\subtree[ \t\r\n]*\[([^\]]*)\]/g;

/** Offsets at which each line starts, for offset → {line, character}. */
function computeLineStarts(text: string): readonly number[] {
   const starts: number[] = [0];
   for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      starts.push(index + 1);
   }
   return starts;
}

/** Binary search for the line containing `offset`. */
function offsetToPosition(lineStarts: readonly number[], offset: number): SubtreePosition {
   let low = 0;
   let high = lineStarts.length - 1;
   while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) {
         low = mid;
      } else {
         high = mid - 1;
      }
   }
   return { line: low, character: offset - (lineStarts[low] ?? 0) };
}

/**
 * Every inline `\subtree[id]{…}` declared in `text`, in source order.
 *
 * The address is trimmed, since `\subtree[ 009k ]` addresses `009k`.
 */
export function findSubtreeDeclarations(text: string): readonly SubtreeDeclarationLocation[] {
   const lineStarts = computeLineStarts(text);
   const declarations: SubtreeDeclarationLocation[] = [];

   SUBTREE_DECLARATION_REGEX.lastIndex = 0;
   for (
      let match = SUBTREE_DECLARATION_REGEX.exec(text);
      match !== null;
      match = SUBTREE_DECLARATION_REGEX.exec(text)
   ) {
      const raw = match[1] ?? "";
      const id = raw.trim();
      if (!id) {
         continue;
      }

      // Offset of the address inside the whole match, honouring the trim.
      const bracketOffset = match.index + match[0].indexOf("[") + 1;
      const idOffset = bracketOffset + raw.indexOf(id);

      declarations.push({
         id,
         start: offsetToPosition(lineStarts, match.index),
         end: offsetToPosition(lineStarts, match.index + match[0].length),
         idStart: offsetToPosition(lineStarts, idOffset),
         idEnd: offsetToPosition(lineStarts, idOffset + id.length),
      });
   }

   return declarations;
}

/** The first inline `\subtree[treeId]` declared in `text`, if any. */
export function findSubtreeDeclaration(
   text: string,
   treeId: string,
): SubtreeDeclarationLocation | null {
   const wanted = treeId.trim();
   if (!wanted) {
      return null;
   }
   return findSubtreeDeclarations(text).find((declaration) => declaration.id === wanted) ?? null;
}

/** Cheap pre-filter: worth parsing this file for `treeId` at all? */
export function mayContainSubtree(text: string, treeId: string): boolean {
   return text.includes("\\subtree") && text.includes(treeId);
}
