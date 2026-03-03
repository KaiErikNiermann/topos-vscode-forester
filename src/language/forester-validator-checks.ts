/* eslint-disable curly */
/**
 * Semantic validation checks for Forester .tree files.
 *
 * Registered into Langium's ValidationRegistry via registerForesterValidationChecks().
 *
 * Fast checks (run on every keystroke):
 *   • checkBuiltinArity    — brace-arg counts for known built-in commands (Task 4)
 *   • checkDateFormat      — \date{…} must be ISO 8601 YYYY-MM-DD (Task 5)
 *   • checkDuplicateImports — detect \import{id} repeated in same document (Task 3)
 *
 * Slow checks (run on save / explicit trigger):
 *   • checkImportExportTarget — \import/\export/\transclude{id} must reference a
 *                               known .tree file in the workspace index (Task 3)
 *   • checkUnresolvedCommand  — warn on unknown commands in Text_mode; suppressed
 *                               inside #{}, ##{}, and \tex{}{} bodies (Task 2)
 *   • checkMissingImport      — hint when \macro is defined in another tree that is
 *                               not yet imported; provides data for the quick-fix
 *                               CodeActionProvider to offer "Add \import{id}" (Task 7)
 *   • checkTransclusionCycle  — warn when \transclude{id} would create a cycle in the
 *                               transclusion graph across the loaded workspace (Task 3)
 */
import type { AstNode, ValidationAcceptor, ValidationChecks, LangiumDocuments } from 'langium';
import { AstUtils } from 'langium';
import type { ForesterAstType, Command, Document, TextFragment } from './generated/ast.js';
import {
    isBraceArg,
    isBracketGroup,
    isCommand,
    isDocument,
    isTextFragment,
    isMathInline,
    isMathDisplay,
    isMathBraceGroup,
    isMathBracketGroup,
    isMathParenGroup,
} from './generated/ast.js';
import type { ForesterServices } from './forester-module.js';

// ── Arity table ──────────────────────────────────────────────────────────────
// Maps command name (with leading backslash) → expected brace-arg count +
// human-readable signature for the diagnostic message.
//
// Bracket args ([…]) are intentionally excluded from the count: many commands
// accept optional bracket args alongside their required brace args
// (e.g. \subtree[id]{body}, \def\name[params]{body}).
const BUILTIN_ARITY: ReadonlyMap<string, { braceArgs: number; signature: string }> = new Map([
    // ── Single brace-arg commands ──────────────────────────────────────────
    ['\\title',       { braceArgs: 1, signature: '\\title{text}' }],
    ['\\taxon',       { braceArgs: 1, signature: '\\taxon{name}' }],
    ['\\author',      { braceArgs: 1, signature: '\\author{name}' }],
    ['\\contributor', { braceArgs: 1, signature: '\\contributor{name}' }],
    ['\\date',        { braceArgs: 1, signature: '\\date{YYYY-MM-DD}' }],
    ['\\parent',      { braceArgs: 1, signature: '\\parent{tree-id}' }],
    ['\\tag',         { braceArgs: 1, signature: '\\tag{name}' }],
    ['\\number',      { braceArgs: 1, signature: '\\number{n}' }],
    ['\\import',      { braceArgs: 1, signature: '\\import{tree-id}' }],
    ['\\export',      { braceArgs: 1, signature: '\\export{tree-id}' }],
    ['\\transclude',  { braceArgs: 1, signature: '\\transclude{tree-id}' }],
    ['\\ref',         { braceArgs: 1, signature: '\\ref{tree-id}' }],
    // ── Two brace-arg commands ─────────────────────────────────────────────
    ['\\link',        { braceArgs: 2, signature: '\\link{uri}{text}' }],
    ['\\tex',         { braceArgs: 2, signature: '\\tex{preamble}{body}' }],
    ['\\meta',        { braceArgs: 2, signature: '\\meta{key}{value}' }],
    ['\\patch',       { braceArgs: 2, signature: '\\patch{object}{methods}' }],
]);

// ISO 8601 date: YYYY-MM-DD with basic month/day range validation
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Commands whose brace arg is a cross-file tree reference
const CROSS_REF_COMMANDS: ReadonlySet<string> = new Set([
    '\\import', '\\export', '\\transclude', '\\ref',
]);

// Complete set of Forester built-in commands (full name, including leading backslash).
// Commands matching this set are never "unresolved".
const ALL_BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
    // Metadata / top-level
    '\\title', '\\taxon', '\\author', '\\contributor', '\\date', '\\parent',
    '\\tag', '\\meta', '\\number', '\\solution',
    // Links and cross-references
    '\\transclude', '\\import', '\\export', '\\ref', '\\link',
    // Block-level layout
    '\\p', '\\ul', '\\ol', '\\li', '\\blockquote', '\\subtree', '\\scope',
    '\\figure', '\\query',
    // Inline
    '\\em', '\\strong', '\\code',
    // Code / verbatim
    '\\pre', '\\startverb', '\\stopverb',
    // Math / TeX
    '\\tex',
    // Macro / binding system
    '\\def', '\\let', '\\put', '\\get', '\\alloc', '\\open', '\\namespace',
    // Object system
    '\\object', '\\patch', '\\call',
]);

// Commands whose arguments are TeX content — suppress unresolved-command warnings
// inside any of their BraceArg children.
const TEX_CONTENT_COMMANDS: ReadonlySet<string> = new Set([
    '\\tex', '\\texfig', '\\ltexfig',
]);

// Commands that introduce a lexical binding (\\def \\let)
const LEXICAL_BINDING_COMMANDS: ReadonlySet<string> = new Set(['\\def', '\\let']);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return true if `node` is inside a TeX-mode context:
 *   • directly inside a MathInline (#{…}) or MathDisplay (##{…}) subtree
 *   • directly inside any BraceArg of a \tex / \texfig / \ltexfig command
 *
 * Walk up the $container chain until we either find a math/TeX ancestor
 * or reach the document root.
 */
function isInTexMode(node: AstNode): boolean {
    let current: AstNode | undefined = node.$container;
    while (current !== undefined) {
        // Inside math #{…} or ##{…}
        if (isMathInline(current) || isMathDisplay(current)) {
            return true;
        }
        // Inside an explicit { } group within math
        if (isMathBraceGroup(current) || isMathBracketGroup(current) || isMathParenGroup(current)) {
            return true;
        }
        // Inside a BraceArg of \tex, \texfig, or \ltexfig
        if (isBraceArg(current)) {
            const parent = current.$container;
            if (isCommand(parent) && TEX_CONTENT_COMMANDS.has(parent.name)) {
                return true;
            }
        }
        current = current.$container;
    }
    return false;
}

/**
 * Return true if `node` is the Command immediately following a \def or \let
 * in the same parent nodes array — i.e., it is the name being bound.
 */
function isBindingSite(node: Command): boolean {
    const container = node.$container as AstNode & { nodes?: AstNode[] };
    const siblings = container.nodes;
    if (!siblings) return false;
    const idx = siblings.indexOf(node);
    if (idx <= 0) return false;
    const prev = siblings[idx - 1];
    return isCommand(prev) && LEXICAL_BINDING_COMMANDS.has(prev.name);
}

/** Extract the raw text content from the first BraceArg of a Command. */
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

// ── Validator class ───────────────────────────────────────────────────────────

export class ForesterChecks {
    private readonly documents?: LangiumDocuments;

    constructor(documents?: LangiumDocuments) {
        this.documents = documents;
    }

    // ── Fast checks ─────────────────────────────────────────────────────────

    /**
     * Validate brace-argument counts for known built-in commands.
     *
     * Only brace args ({…}) are counted; bracket args ([…]) are ignored since
     * commands like \subtree[id]{body} take an optional bracket arg in addition
     * to their required brace args.
     */
    checkBuiltinArity(node: Command, accept: ValidationAcceptor): void {
        const spec = BUILTIN_ARITY.get(node.name);
        if (!spec) {
            return;
        }

        const braceCount = node.args.filter(isBraceArg).length;
        if (braceCount !== spec.braceArgs) {
            const n = spec.braceArgs;
            accept(
                'warning',
                `${node.name} expects ${n} brace argument${n === 1 ? '' : 's'}, `
                + `got ${braceCount}. Expected form: ${spec.signature}`,
                { node },
            );
        }
    }

    /**
     * Validate that \date{…} contains an ISO 8601 date string (YYYY-MM-DD).
     */
    checkDateFormat(node: Command, accept: ValidationAcceptor): void {
        if (node.name !== '\\date') {
            return;
        }

        const braceArg = node.args.find(isBraceArg);
        if (!braceArg) {
            return; // missing brace arg already caught by checkBuiltinArity
        }

        const dateText = braceArg.nodes
            .filter(isTextFragment)
            .map(n => n.value)
            .join('')
            .trim();

        if (!ISO_DATE_RE.test(dateText)) {
            accept(
                'warning',
                `\\date expects an ISO 8601 date (YYYY-MM-DD), got: "${dateText}"`,
                { node: braceArg },
            );
        }
    }

    /**
     * Detect duplicate \import{tree-id} declarations within a single document.
     * Duplicate imports are legal in Forester but generally indicate a mistake.
     */
    checkDuplicateImports(node: Document, accept: ValidationAcceptor): void {
        const seen = new Map<string, Command>();

        for (const child of AstUtils.streamAllContents(node)) {
            if (!isCommand(child) || child.name !== '\\import') {
                continue;
            }
            const treeId = firstBraceArgText(child);
            if (!treeId) {
                continue;
            }

            const prior = seen.get(treeId);
            if (prior) {
                const braceArg = child.args.find(isBraceArg);
                accept(
                    'warning',
                    `Duplicate import: '${treeId}' is already imported in this file`,
                    { node: braceArg ?? child },
                );
            } else {
                seen.set(treeId, child);
            }
        }
    }

    // ── Slow checks ─────────────────────────────────────────────────────────

    /**
     * Verify that \import, \export, \transclude, and \ref arguments reference a
     * tree file that exists in the loaded workspace.
     *
     * Registered as a 'slow' check so it does not run on every keystroke.
     * Falls back silently when the workspace index is empty (e.g. in tests).
     */
    checkCrossRefTarget(node: Command, accept: ValidationAcceptor): void {
        if (!this.documents || !CROSS_REF_COMMANDS.has(node.name)) {
            return;
        }

        const treeId = firstBraceArgText(node);
        if (!treeId) {
            return; // empty arg already caught by arity check
        }

        const targetFilename = `${treeId}.tree`;
        for (const doc of this.documents.all) {
            const uriPath = doc.uri.path;
            const basename = uriPath.slice(uriPath.lastIndexOf('/') + 1);
            if (basename === targetFilename) {
                return; // found
            }
        }

        const braceArg = node.args.find(isBraceArg);
        accept(
            'warning',
            `Tree '${treeId}' not found in the workspace index. `
            + 'The forest may not be fully loaded, or the tree ID may be misspelled.',
            { node: braceArg ?? node },
        );
    }

    /**
     * Warn when a command is neither a Forester built-in nor a macro defined
     * anywhere in the loaded workspace.
     *
     * Suppressed when:
     *   • The command is a known built-in (ALL_BUILTIN_COMMANDS).
     *   • The command is an XML namespace declaration (\\xmlns:…) or XML element (\\<…>).
     *   • The command is in TeX mode: inside #{…}, ##{…}, or an arg of \\tex/\\texfig/\\ltexfig.
     *   • The command is a binding site (the name being introduced by \\def/\\let).
     *   • The workspace index is empty (avoids false positives in tests / fresh workspaces).
     *
     * Registered as a 'slow' check — does not run on every keystroke.
     */
    checkUnresolvedCommand(node: Command, accept: ValidationAcceptor): void {
        if (!this.documents) return;

        // Skip XML-special command name forms
        if (node.name.startsWith('\\xmlns:') || node.name.startsWith('\\<')) return;

        // Skip known builtins
        if (ALL_BUILTIN_COMMANDS.has(node.name)) return;

        // Skip if in a TeX-mode context (math or \tex{}{} body)
        if (isInTexMode(node)) return;

        // Skip binding sites (name being introduced by \def or \let)
        if (isBindingSite(node)) return;

        // Collect workspace-defined macros (all \def\name and \let\name across all docs)
        const workspaceMacros = this.collectWorkspaceMacros();

        // Skip if the workspace index is effectively empty (avoid spurious warnings)
        if (workspaceMacros.size === 0) return;

        if (!workspaceMacros.has(node.name)) {
            accept(
                'warning',
                `Unknown command ${node.name} — not a Forester built-in or workspace macro. `
                + 'Check spelling or add a \\def/\\let binding.',
                { node },
            );
        }
    }

    /**
     * Hint-level check: \foo is defined in a different workspace tree that is not
     * yet imported by the current document.
     *
     * Emits a 'hint' diagnostic with code 'missing-import' and data { treeId }
     * so the ForesterCodeActionProvider can offer "Add \import{treeId}".
     * Registered as a 'slow' check — does not run on every keystroke.
     */
    checkMissingImport(node: Command, accept: ValidationAcceptor): void {
        if (!this.documents) return;
        if (node.name.startsWith('\\xmlns:') || node.name.startsWith('\\<')) return;
        if (ALL_BUILTIN_COMMANDS.has(node.name)) return;
        if (isInTexMode(node)) return;
        if (isBindingSite(node)) return;

        // Determine the current document's tree ID
        const currentDoc = AstUtils.getDocument(node);
        const currentTreeId = treeIdFromUriPath(currentDoc.uri.path);
        if (!currentTreeId) return;

        // Find other tree files (in the workspace) that define this macro
        const definingTrees: string[] = [];
        for (const doc of this.documents.all) {
            if (doc.uri.toString() === currentDoc.uri.toString()) continue;
            const docTreeId = treeIdFromUriPath(doc.uri.path);
            if (!docTreeId) continue;

            for (const n of AstUtils.streamAllContents(doc.parseResult.value)) {
                if (!isCommand(n) || !LEXICAL_BINDING_COMMANDS.has(n.name)) continue;
                const container2 = n.$container as AstNode & { nodes?: AstNode[] };
                const siblings2 = container2.nodes;
                if (!siblings2) continue;
                const idx2 = siblings2.indexOf(n);
                if (idx2 < 0 || idx2 + 1 >= siblings2.length) continue;
                const next2 = siblings2[idx2 + 1];
                if (isCommand(next2) && next2.name === node.name) {
                    definingTrees.push(docTreeId);
                    break; // found in this doc — move to next doc
                }
            }
        }

        if (definingTrees.length === 0) return;

        // Collect what the current document already imports
        const importedTrees = new Set<string>();
        for (const n of AstUtils.streamAllContents(currentDoc.parseResult.value)) {
            if (isCommand(n) && n.name === '\\import') {
                const id = firstBraceArgText(n);
                if (id) importedTrees.add(id);
            }
        }

        // Report for the first unimported defining tree
        for (const treeId of definingTrees) {
            if (!importedTrees.has(treeId)) {
                accept(
                    'hint',
                    `Command ${node.name} is defined in tree '${treeId}' which is not imported`,
                    { node, code: 'missing-import', data: { treeId } },
                );
                return; // one suggestion per call site is enough
            }
        }
    }

    /**
     * Warn when a \transclude{target} creates a cycle in the transclusion graph
     * across the loaded workspace (A → B → … → A).
     *
     * Uses BFS from the target tree: if BFS reaches the current tree ID, there is
     * a cycle.  Registered as a 'slow' check.
     */
    checkTransclusionCycle(node: Command, accept: ValidationAcceptor): void {
        if (!this.documents || node.name !== '\\transclude') return;

        const target = firstBraceArgText(node);
        if (!target) return;

        const currentDoc = AstUtils.getDocument(node);
        const currentTreeId = treeIdFromUriPath(currentDoc.uri.path);
        if (!currentTreeId) return;

        // Build the workspace-wide transclusion graph lazily
        const graph = this.buildTransclusionGraph();

        // BFS from `target`; if we can reach `currentTreeId` → cycle
        const visited = new Set<string>();
        const queue: string[] = [target];
        while (queue.length > 0) {
            const current = queue.shift()!;
            if (current === currentTreeId) {
                const braceArg = node.args.find(isBraceArg);
                accept(
                    'warning',
                    `Transclusion cycle detected: '${currentTreeId}' transitively transcludes itself via '${target}'`,
                    { node: braceArg ?? node },
                );
                return;
            }
            if (visited.has(current)) continue;
            visited.add(current);
            for (const next of graph.get(current) ?? []) {
                queue.push(next);
            }
        }
    }

    /**
     * Build a map from each tree ID to the set of tree IDs it directly transcludes,
     * by scanning all loaded workspace documents.
     */
    private buildTransclusionGraph(): Map<string, Set<string>> {
        const graph = new Map<string, Set<string>>();
        if (!this.documents) return graph;

        for (const doc of this.documents.all) {
            const docTreeId = treeIdFromUriPath(doc.uri.path);
            if (!docTreeId) continue;

            const targets = new Set<string>();
            for (const n of AstUtils.streamAllContents(doc.parseResult.value)) {
                if (isCommand(n) && n.name === '\\transclude') {
                    const id = firstBraceArgText(n);
                    if (id) targets.add(id);
                }
            }
            if (targets.size > 0) graph.set(docTreeId, targets);
        }

        return graph;
    }

    /**
     * Scan all loaded workspace documents for \\def\\name and \\let\\name
     * binding sites and return the set of defined macro names (with leading backslash).
     */
    private collectWorkspaceMacros(): Set<string> {
        const macros = new Set<string>();
        if (!this.documents) return macros;

        for (const doc of this.documents.all) {
            for (const node of AstUtils.streamAllContents(doc.parseResult.value)) {
                if (!isCommand(node) || !LEXICAL_BINDING_COMMANDS.has(node.name)) continue;

                // The macro name is the Command immediately following \def or \let
                const container = node.$container as AstNode & { nodes?: AstNode[] };
                const siblings = container.nodes;
                if (!siblings) continue;
                const idx = siblings.indexOf(node);
                if (idx < 0 || idx + 1 >= siblings.length) continue;
                const next = siblings[idx + 1];
                if (isCommand(next)) {
                    macros.add(next.name);
                }
            }
        }

        return macros;
    }

    // ── Object method call checks ─────────────────────────────────────────────

    /**
     * Warn when a `#methodName` call site refers to a method that is not
     * defined in any \object or \patch block in the loaded workspace.
     *
     * Detection: TextFragment.value is the method name AND the immediately
     * preceding sibling in the same container is TextFragment('#').
     *
     * Emitted as 'hint' to keep it unobtrusive — the workspace index may
     * be incomplete (e.g. not all files loaded yet).
     */
    checkUnresolvedMethod(node: TextFragment, accept: ValidationAcceptor): void {
        const val = node.value.trim();
        if (!val || val === '#') return;
        if (!this.isMethodNameSite(node)) return;

        const known = this.collectWorkspaceMethods();
        if (!known.has(val)) {
            accept('hint', `Method '${val}' is not defined in any workspace object or patch block`, {
                node,
                property: 'value',
            });
        }
    }

    /**
     * Return true when `node` is immediately preceded by a TextFragment('#')
     * in its parent container's nodes array — i.e. it is the name part of
     * a `#methodName` method call.
     */
    private isMethodNameSite(node: TextFragment): boolean {
        const container = node.$container as AstNode & { nodes?: AstNode[] };
        const siblings = container.nodes;
        if (!siblings) return false;
        const idx = siblings.indexOf(node);
        if (idx <= 0) return false;
        const prev = siblings[idx - 1];
        return isTextFragment(prev) && prev.value === '#';
    }

    /**
     * Collect every method name defined inside \object or \patch body blocks
     * across all loaded workspace documents.
     */
    private collectWorkspaceMethods(): Set<string> {
        const methods = new Set<string>();
        if (!this.documents) return methods;
        const OBJECT_CMDS: ReadonlySet<string> = new Set(['\\object', '\\patch']);

        for (const doc of this.documents.all) {
            const root = doc.parseResult.value;
            for (const node of AstUtils.streamAllContents(root)) {
                if (!isCommand(node) || !OBJECT_CMDS.has(node.name)) continue;
                const bodyArg = [...node.args].reverse().find(isBraceArg);
                if (!bodyArg) continue;
                for (const bodyNode of bodyArg.nodes) {
                    if (!isBracketGroup(bodyNode)) continue;
                    const frag = bodyNode.nodes.find(isTextFragment);
                    if (frag?.value.trim()) methods.add(frag.value.trim());
                }
            }
        }
        return methods;
    }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/** Extract tree ID from a URI path (basename without .tree extension). */
export function treeIdFromUriPath(path: string): string | undefined {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    return basename.endsWith('.tree') ? basename.slice(0, -5) : undefined;
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register all Forester semantic validation checks into the ValidationRegistry.
 * Call this once after injecting ForesterServices (in createForesterServices).
 */
export function registerForesterValidationChecks(services: ForesterServices): void {
    const registry = services.validation.ValidationRegistry;
    const documents = services.shared.workspace.LangiumDocuments;
    const checker = new ForesterChecks(documents);

    const fastChecks: ValidationChecks<ForesterAstType> = {
        Command: [
            checker.checkBuiltinArity,
            checker.checkDateFormat,
        ],
        Document: [
            checker.checkDuplicateImports,
        ],
    };

    const slowChecks: ValidationChecks<ForesterAstType> = {
        Command: [
            checker.checkCrossRefTarget,
            checker.checkUnresolvedCommand,
            checker.checkMissingImport,
            checker.checkTransclusionCycle,
        ],
        TextFragment: [
            checker.checkUnresolvedMethod,
        ],
    };

    registry.register(fastChecks, checker, 'fast');
    registry.register(slowChecks, checker, 'slow');
}
