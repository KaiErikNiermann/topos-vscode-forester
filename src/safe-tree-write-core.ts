/**
 * safe-tree-write-core.ts — the invariants that make a whole-file `.tree` write safe.
 *
 * `vscode.WorkspaceEdit.createFile(uri, { overwrite: true })` replaces a file
 * wholesale, is not undoable from the editor, and leaves no trace in local
 * history when the write comes from an extension rather than a save. A wrong
 * target therefore destroys an unrelated tree silently — this has happened
 * three times (977eefb, 700c5b5, and the 2026-09-06 loss of trees/005b.tree,
 * 17,774 bytes, recovered only because it was committed).
 *
 * These are the checks every such write must pass. They are pure so they can be
 * tested without a workspace; `edit-forest.ts` routes both of its overwrite
 * sites through them and is the only caller.
 */

export type TreeWriteVerdict =
   | { readonly ok: true }
   | { readonly ok: false; readonly reason: string };

const OK: TreeWriteVerdict = { ok: true };
const deny = (reason: string): TreeWriteVerdict => ({ ok: false, reason });

/** Basename of a path, without depending on `path` (keeps this module pure). */
const basename = (filePath: string): string =>
   filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);

/** The address a `.tree` path claims, or `null` when it is not a tree file. */
export const treeIdOfPath = (filePath: string): string | null => {
   const name = basename(filePath);
   return name.endsWith('.tree') ? name.slice(0, -'.tree'.length) : null;
};

/**
 * The resolved path must be the file that actually claims `treeId`.
 *
 * Comparison is case-SENSITIVE on purpose. Forester's base36 alphabet is
 * uppercase, so `005b` and `005B` are different addresses that the compiler
 * treats as one on a case-folding filesystem; a glob (`workspace.findFiles`)
 * can hand back either. Writing `005b`'s content over `005B.tree` is exactly
 * the cross-file overwrite this module exists to stop.
 */
export const checkPathClaimsTree = (filePath: string, treeId: string): TreeWriteVerdict => {
   const claimed = treeIdOfPath(filePath);
   if (claimed === null) {
      return deny(`${filePath} is not a .tree file`);
   }
   if (claimed !== treeId) {
      return deny(
         `refusing to write tree "${treeId}" into ${basename(filePath)} — that file holds ` +
         `"${claimed}". The resolved path does not match the tree being edited.`
      );
   }
   return OK;
};

/** Lines `renameTreeById` is allowed to add, drop or rewrite. */
export const RENAME_EDITABLE_LINE = /^\\(?:title|taxon)\{/;

/**
 * A rewrite must change ONLY the lines the operation is entitled to change.
 *
 * This is the structural guard: strip the editable lines from both sides and
 * the remainder must be byte-identical. Writing one tree's content over
 * another differs on essentially every line, so it cannot survive this check
 * however the path was resolved — which is what makes the class of bug
 * impossible rather than merely unlikely.
 */
export const checkOnlyEditableLinesChanged = (
   original: string,
   updated: string,
   editable: RegExp = RENAME_EDITABLE_LINE,
): TreeWriteVerdict => {
   const fixed = (text: string): string[] =>
      text.split(/\r?\n/).filter(line => !editable.test(line));

   const before = fixed(original);
   const after = fixed(updated);

   if (before.length !== after.length) {
      return deny(
         `refusing the rewrite: it changes ${Math.abs(after.length - before.length)} line(s) ` +
         `outside \\title/\\taxon (${before.length} → ${after.length} non-metadata lines).`
      );
   }
   for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) {
         return deny(
            `refusing the rewrite: it alters a line outside \\title/\\taxon — ` +
            `${JSON.stringify(before[i]?.slice(0, 60))} became ${JSON.stringify(after[i]?.slice(0, 60))}.`
         );
      }
   }
   return OK;
};

/**
 * A freshly allocated tree must land on a path that did not exist before the
 * command ran. forester allocates from its forest index, and a stale index
 * hands back an address that is already spent.
 */
export const checkCreateTarget = (
   filePath: string,
   preExistingTreePaths: ReadonlySet<string>,
): TreeWriteVerdict => {
   if (treeIdOfPath(filePath) === null) {
      return deny(`${filePath} is not a .tree file`);
   }
   if (preExistingTreePaths.has(filePath)) {
      return deny(
         `refusing to create tree "${treeIdOfPath(filePath)}": ${filePath} already existed ` +
         `before this command ran. forester allocated an address that is already in use; ` +
         `the existing tree has been left untouched.`
      );
   }
   return OK;
};
