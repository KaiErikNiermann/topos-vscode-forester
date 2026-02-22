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
 */
import type { ValidationAcceptor, ValidationChecks, LangiumDocuments } from 'langium';
import { AstUtils } from 'langium';
import type { ForesterAstType, Command, Document } from './generated/ast.js';
import { isBraceArg, isCommand, isDocument, isTextFragment } from './generated/ast.js';
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
    ['\\texfig',      { braceArgs: 2, signature: '\\texfig{preamble}{body}' }],
    ['\\ltexfig',     { braceArgs: 2, signature: '\\ltexfig{preamble}{body}' }],
    ['\\meta',        { braceArgs: 2, signature: '\\meta{key}{value}' }],
    ['\\patch',       { braceArgs: 2, signature: '\\patch{object}{methods}' }],
    ['\\codeblock',   { braceArgs: 2, signature: '\\codeblock{lang}{code}' }],
]);

// ISO 8601 date: YYYY-MM-DD with basic month/day range validation
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Commands whose brace arg is a cross-file tree reference
const CROSS_REF_COMMANDS: ReadonlySet<string> = new Set([
    '\\import', '\\export', '\\transclude', '\\ref',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

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
        ],
    };

    registry.register(fastChecks, checker, 'fast');
    registry.register(slowChecks, checker, 'slow');
}
