/**
 * Go-to-definition provider for Forester .tree files.
 *
 * Implements Langium's DefinitionProvider interface without relying on the
 * cross-reference linker (Forester's grammar has no Langium cross-refs).
 * Resolution is done directly from the AST + workspace document index.
 *
 * Capabilities (Tasks 26, 27, 28):
 *   • \transclude{tree-id} → jump to the target .tree file
 *   • \import{tree-id}     → jump to the target .tree file
 *   • \export{tree-id}     → jump to the target .tree file
 *   • \ref{tree-id}        → jump to the target .tree file
 *   • Cursor on \macro call → navigate to its \def\macro or \let\macro definition
 */
import type { DefinitionParams } from 'vscode-languageserver';
import type { CancellationToken, AstNode, LangiumDocuments, LangiumDocument } from 'langium';
import { CstUtils, AstUtils } from 'langium';
import type { LangiumServices, DefinitionProvider } from 'langium/lsp';
import { LocationLink } from 'vscode-languageserver';
import {
    isCommand,
    isBraceArg,
    isTextFragment,
    type Command,
} from './generated/ast.js';

// Commands whose first brace arg is a tree-id / URI to navigate to
const PATH_ARG_COMMANDS: ReadonlySet<string> = new Set([
    'transclude', 'import', 'export', 'ref',
]);

// Definition-introducing keywords whose immediately following Command is the name being bound
const BINDING_COMMANDS: ReadonlySet<string> = new Set(['\\def', '\\let']);

type SimpleRange = { start: { line: number; character: number }; end: { line: number; character: number } };

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

        // Case 1: text inside first BraceArg of a path command → navigate to .tree file
        if (isTextFragment(astNode) && isBraceArg(astNode.$container)) {
            const braceArg = astNode.$container;
            if (isCommand(braceArg.$container)) {
                const cmd = braceArg.$container;
                const firstBrace = cmd.args.find(isBraceArg);
                if (firstBrace === braceArg && PATH_ARG_COMMANDS.has(cmd.name.slice(1))) {
                    return this.resolveTreeId(astNode.value.trim(), leafNode.range);
                }
            }
        }

        // Case 2: cursor on a Command name → find its \def or \let binding site
        if (isCommand(astNode)) {
            return this.resolveMacroDefinition(astNode.name, leafNode.range);
        }

        return undefined;
    }

    /**
     * Search all loaded workspace documents for a .tree file matching the given
     * tree-id (filename without extension).
     */
    private resolveTreeId(treeId: string, sourceRange: SimpleRange): LocationLink[] | undefined {
        const targetFilename = `${treeId}.tree`;
        for (const doc of this.documents.all) {
            const uriPath = doc.uri.path;
            const basename = uriPath.slice(uriPath.lastIndexOf('/') + 1);
            if (basename === targetFilename) {
                const zero = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
                return [LocationLink.create(doc.uri.toString(), zero, zero, sourceRange)];
            }
        }
        return undefined;
    }

    /**
     * Search all loaded workspace documents for the \def or \let binding of the
     * given command name.
     *
     * Detection: a Command node C with name === macroName is a definition site if
     * the node immediately preceding C in its parent container's nodes array is a
     * Command with name \def or \let.
     *
     * Example:  \def\myMacro[args]{body}
     *   → Document.nodes = [..., Command(\def,[]), Command(\myMacro,[...]), ...]
     *   → Command(\def) precedes Command(\myMacro) in the same array.
     */
    private resolveMacroDefinition(macroName: string, sourceRange: SimpleRange): LocationLink[] | undefined {
        // Skip built-in \def/\let/etc. — they are keywords, not user macros
        if (BINDING_COMMANDS.has(macroName)) {
            return undefined;
        }

        const results: LocationLink[] = [];

        for (const doc of this.documents.all) {
            const root = doc.parseResult.value;
            for (const node of AstUtils.streamAllContents(root)) {
                if (!isCommand(node) || node.name !== macroName) {
                    continue;
                }
                const defCmd = this.precedingCommand(node);
                if (defCmd && BINDING_COMMANDS.has(defCmd.name)) {
                    const cstNode = node.$cstNode;
                    if (cstNode) {
                        results.push(LocationLink.create(
                            doc.uri.toString(),
                            cstNode.range,
                            cstNode.range,
                            sourceRange,
                        ));
                    }
                }
            }
        }

        return results.length > 0 ? results : undefined;
    }

    /**
     * Return the Command node that immediately precedes `node` in its parent
     * container's nodes array, or undefined if there is no such preceding Command.
     */
    private precedingCommand(node: Command): Command | undefined {
        const container = node.$container as AstNode & { nodes?: AstNode[] };
        const siblings = container.nodes;
        if (!siblings) {
            return undefined;
        }
        const idx = siblings.indexOf(node);
        if (idx <= 0) {
            return undefined;
        }
        const prev = siblings[idx - 1];
        return isCommand(prev) ? prev : undefined;
    }
}
