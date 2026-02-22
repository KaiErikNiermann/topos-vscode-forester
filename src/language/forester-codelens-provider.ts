/**
 * CodeLens provider for Forester .tree files.
 *
 * Provides inline action hints above definitions and at file headers:
 *   • Top of file: "N incoming links" (transclude + import + export + ref) — Task 14
 *   • Above \def\macroName: "N references" — Task 13
 *   • Above \datalog{…}: "Run datalog query" or "Datalog rules" action
 *
 * This also serves as the lightweight workspace-index implementation (Task 16):
 * all reference counting is computed on demand by walking loaded workspace
 * documents via LangiumDocuments.all. A persistent index cache would be the
 * next step for larger forests.
 */
import type { CodeLens, CodeLensParams, Range } from 'vscode-languageserver';
import type { CancellationToken, AstNode, LangiumDocuments, LangiumDocument } from 'langium';
import { AstUtils } from 'langium';
import type { LangiumServices, CodeLensProvider } from 'langium/lsp';
import {
    isCommand,
    isBraceArg,
    isTextFragment,
    type Command,
} from './generated/ast.js';

// Commands that create cross-file references (used for backlink counting)
const CROSS_REF_COMMANDS: ReadonlySet<string> = new Set([
    '\\transclude', '\\import', '\\export', '\\ref',
]);

// Commands that introduce a macro binding (\def\name or \let\name)
const BINDING_COMMANDS: ReadonlySet<string> = new Set(['\\def', '\\let']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function firstBraceArgText(node: Command): string {
    const braceArg = node.args.find(isBraceArg);
    if (!braceArg) {
        return '';
    }
    return braceArg.nodes
        .filter(isTextFragment)
        .map(n => n.value)
        .join('')
        .trim();
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class ForesterCodeLensProvider implements CodeLensProvider {
    private readonly documents: LangiumDocuments;

    constructor(services: LangiumServices) {
        this.documents = services.shared.workspace.LangiumDocuments;
    }

    provideCodeLens(
        document: LangiumDocument,
        _params: CodeLensParams,
        _cancelToken?: CancellationToken,
    ): CodeLens[] | undefined {
        const lenses: CodeLens[] = [];

        // ── Backlinks count at the top of each .tree file (Task 14) ──────────
        const treeId = treeIdFromUriPath(document.uri.path);
        if (treeId) {
            const count = this.countBacklinks(treeId, document.uri.toString());
            const label = count === 1 ? '1 incoming link' : `${count} incoming links`;
            lenses.push(makeCodeLens({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, label));
        }

        // ── Reference counts above macro definitions (Task 13) ────────────────
        for (const { macroName, range } of this.findMacroDefinitionSites(document)) {
            const count = this.countMacroReferences(macroName);
            const label = count === 1 ? '1 reference' : `${count} references`;
            lenses.push(makeCodeLens(range, label));
        }

        // ── Run query / datalog rules for \datalog{…} blocks ─────────────────
        for (const node of AstUtils.streamAllContents(document.parseResult.value)) {
            if (!isCommand(node) || node.name !== '\\datalog') {continue;}

            const cst = node.$cstNode;
            if (!cst) {continue;}

            const bodyArg = node.args.find(isBraceArg);
            if (!bodyArg?.$cstNode) {continue;}

            // Extract text inside the braces (strip leading '{' and trailing '}')
            const rawText = document.textDocument.getText(bodyArg.$cstNode.range);
            const queryText = rawText.startsWith('{') && rawText.endsWith('}')
                ? rawText.slice(1, -1).trim()
                : rawText.trim();

            const isQuery = queryText.includes('-:');
            const label = isQuery ? '$(play) Run datalog query' : '$(symbol-misc) Datalog rules';

            lenses.push({
                range: cst.range,
                command: {
                    title: label,
                    command: 'forester.runDatalogQuery',
                    arguments: [queryText],
                },
            });
        }

        return lenses.length > 0 ? lenses : undefined;
    }

    /**
     * Count all incoming cross-file references to `treeId` across the loaded
     * workspace, excluding the tree's own document.
     */
    private countBacklinks(treeId: string, ownUri: string): number {
        let count = 0;
        for (const doc of this.documents.all) {
            if (doc.uri.toString() === ownUri) {
                continue;
            }
            for (const node of AstUtils.streamAllContents(doc.parseResult.value)) {
                if (isCommand(node) && CROSS_REF_COMMANDS.has(node.name)) {
                    if (firstBraceArgText(node) === treeId) {
                        count++;
                    }
                }
            }
        }
        return count;
    }

    /**
     * Find all \def\name and \let\name binding sites in `document`.
     * Returns the macro name and the CST range of the name command.
     */
    private findMacroDefinitionSites(document: LangiumDocument): Array<{ macroName: string; range: Range }> {
        const results: Array<{ macroName: string; range: Range }> = [];

        for (const node of AstUtils.streamAllContents(document.parseResult.value)) {
            if (!isCommand(node) || !BINDING_COMMANDS.has(node.name)) {
                continue;
            }

            // The name being defined is the Command node immediately following \def/\let
            const container = node.$container as AstNode & { nodes?: AstNode[] };
            const siblings = container.nodes;
            if (!siblings) {
                continue;
            }
            const idx = siblings.indexOf(node);
            if (idx < 0 || idx + 1 >= siblings.length) {
                continue;
            }
            const next = siblings[idx + 1];
            if (!isCommand(next) || !next.$cstNode) {
                continue;
            }

            results.push({ macroName: next.name, range: next.$cstNode.range });
        }

        return results;
    }

    /**
     * Count all call sites for `macroName` across the loaded workspace.
     * Call sites are Command nodes with the given name that are NOT immediately
     * preceded by \def or \let (those are definition sites, not calls).
     */
    private countMacroReferences(macroName: string): number {
        let count = 0;
        for (const doc of this.documents.all) {
            for (const node of AstUtils.streamAllContents(doc.parseResult.value)) {
                if (!isCommand(node) || node.name !== macroName) {
                    continue;
                }
                // Skip definition sites
                const container = node.$container as AstNode & { nodes?: AstNode[] };
                const siblings = container.nodes;
                if (siblings) {
                    const idx = siblings.indexOf(node);
                    const prev = idx > 0 ? siblings[idx - 1] : undefined;
                    if (prev && isCommand(prev) && BINDING_COMMANDS.has(prev.name)) {
                        continue;
                    }
                }
                count++;
            }
        }
        return count;
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function treeIdFromUriPath(path: string): string | undefined {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    return basename.endsWith('.tree') ? basename.slice(0, -5) : undefined;
}

function makeCodeLens(range: Range, title: string): CodeLens {
    return {
        range,
        command: {
            title,
            command: '', // informational only; no action
        },
    };
}
