/**
 * Go-to-definition provider for Forester .tree files.
 *
 * Implements Langium's DefinitionProvider interface without relying on the
 * cross-reference linker (Forester's grammar has no Langium cross-refs).
 * Resolution is done directly from the AST + workspace document index.
 *
 * Current capabilities (Task 26 infrastructure + Task 28 tree-id navigation):
 *   • \transclude{tree-id} → jump to the target .tree file
 *   • \import{tree-id}     → jump to the target .tree file
 *   • \export{tree-id}     → jump to the target .tree file
 *   • \ref{tree-id}        → jump to the target .tree file
 *
 * Task 27 (def/let macro go-to-def) extends this provider — see that task
 * for the implementation plan.
 */
import type { DefinitionParams } from 'vscode-languageserver';
import type { CancellationToken } from 'langium';
import { CstUtils } from 'langium';
import type { LangiumServices } from 'langium/lsp';
import type { LangiumDocuments, LangiumDocument } from 'langium';
import { LocationLink } from 'vscode-languageserver';
import { isCommand, isBraceArg, isTextFragment } from './generated/ast.js';
import type { DefinitionProvider } from 'langium/lsp';

// Commands whose first brace arg is a tree-id / URI to navigate to
const PATH_ARG_COMMANDS: ReadonlySet<string> = new Set([
    'transclude', 'import', 'export', 'ref',
]);

export class ForesterDefinitionProvider implements DefinitionProvider {
    private readonly documents: LangiumDocuments;

    constructor(services: LangiumServices) {
        this.documents = services.shared.workspace.LangiumDocuments;
    }

    getDefinition(
        document: LangiumDocument,
        params: DefinitionParams,
        _cancelToken?: CancellationToken,
    ): LocationLink[] | undefined {
        const offset = document.textDocument.offsetAt(params.position);
        const rootCst = document.parseResult.value.$cstNode;
        if (!rootCst) {
            return undefined;
        }

        const leafNode = CstUtils.findLeafNodeAtOffset(rootCst, offset);
        if (!leafNode) {
            return undefined;
        }

        const astNode = leafNode.astNode;

        // Case: cursor is on a TextFragment inside the first BraceArg of a path command
        if (isTextFragment(astNode) && isBraceArg(astNode.$container)) {
            const braceArg = astNode.$container;
            if (isCommand(braceArg.$container)) {
                const cmd = braceArg.$container;
                const firstBrace = cmd.args.find(isBraceArg);
                if (firstBrace === braceArg && PATH_ARG_COMMANDS.has(cmd.name.slice(1))) {
                    const treeId = astNode.value.trim();
                    return this.resolveTreeId(treeId, leafNode.range);
                }
            }
        }

        return undefined;
    }

    /**
     * Search all loaded workspace documents for a .tree file matching the given
     * tree-id (filename without extension). Returns a LocationLink to the file's
     * start, or undefined if not found in the workspace index.
     */
    private resolveTreeId(treeId: string, sourceRange: { start: { line: number; character: number }; end: { line: number; character: number } }): LocationLink[] | undefined {
        const targetFilename = `${treeId}.tree`;

        for (const doc of this.documents.all) {
            const uriPath = doc.uri.path;
            const basename = uriPath.slice(uriPath.lastIndexOf('/') + 1);
            if (basename === targetFilename) {
                const targetRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
                return [LocationLink.create(
                    doc.uri.toString(),
                    targetRange,
                    targetRange,
                    sourceRange,
                )];
            }
        }

        return undefined;
    }
}
