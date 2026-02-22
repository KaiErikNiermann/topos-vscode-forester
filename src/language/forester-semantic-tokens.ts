/**
 * Semantic token provider for Forester .tree files.
 *
 * Provides semantic highlighting on top of the TextMate grammar:
 *   • Built-in commands (\title, \date, \transclude, …) → keyword
 *   • User-defined macros (\myMacro, \foo, …)           → function
 *   • XML element commands (\<html:div>)                 → macro
 *   • XML namespace declarations (\xmlns:html)           → namespace
 *   • Tree-id content in path commands                   → string
 *
 * Task 14: infrastructure — AbstractSemanticTokenProvider subclass.
 * Task 15: command vs identifier vs path vs namespace categories.
 */
import type { AstNode } from 'langium';
import type { LangiumServices, SemanticTokenAcceptor } from 'langium/lsp';
import { AbstractSemanticTokenProvider } from 'langium/lsp';
import { SemanticTokenModifiers, SemanticTokenTypes } from 'vscode-languageserver';
import {
    isCommand,
    isBraceArg,
    isTextFragment,
    type Command,
    type TextFragment,
} from './generated/ast.js';

// ── Built-in command registry ─────────────────────────────────────────────────
// Commands defined in the Forester spec as first-class built-ins.
// User macro calls use any other \name token.
const BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
    // Metadata / top-level
    'title', 'taxon', 'author', 'contributor', 'date', 'parent', 'tag',
    'meta', 'number', 'solution',
    // Links and cross-references
    'transclude', 'import', 'export', 'ref', 'link',
    // Block-level layout
    'p', 'ul', 'ol', 'li', 'blockquote', 'subtree', 'scope', 'figure',
    'query', 'texfig', 'ltexfig',
    // Inline
    'em', 'strong', 'code',
    // Code / verbatim
    'codeblock', 'pre', 'startverb', 'stopverb',
    // Math / TeX
    'tex',
    // Macro / binding system
    'def', 'let', 'put', 'get', 'alloc', 'open', 'namespace',
    // Object system
    'object', 'patch', 'call',
]);

// Commands whose first brace arg is a tree-id / URI path (highlighted as string)
const PATH_ARG_COMMANDS: ReadonlySet<string> = new Set([
    'transclude', 'import', 'export', 'ref',
]);

// Commands that introduce a lexical binding (\def\name or \let\name)
// The Command immediately following these in the same parent nodes array
// is the name being defined — it gets the `declaration` modifier.
const LEXICAL_BINDING_COMMANDS: ReadonlySet<string> = new Set(['\\def', '\\let']);

// Dynamic variable operations — get a `modification` modifier to distinguish
// them visually from lexical bindings (def/let).
const DYNAMIC_VAR_COMMANDS: ReadonlySet<string> = new Set(['\\put', '\\get', '\\alloc']);

// ── Provider ──────────────────────────────────────────────────────────────────

export class ForesterSemanticTokenProvider extends AbstractSemanticTokenProvider {
    constructor(services: LangiumServices) {
        super(services);
    }

    protected highlightElement(node: AstNode, accept: SemanticTokenAcceptor): void | undefined | 'prune' {
        if (isCommand(node)) {
            this.highlightCommand(node, accept);
            return;
        }
        if (isTextFragment(node)) {
            this.maybeHighlightTreeId(node, accept);
        }
    }

    private highlightCommand(node: Command, accept: SemanticTokenAcceptor): void {
        const rawName = node.name; // includes leading backslash

        // XML namespace declaration: \xmlns:html → namespace token
        if (rawName.startsWith('\\xmlns:')) {
            accept({ node, property: 'name', type: SemanticTokenTypes.namespace });
            return;
        }

        // XML element command: \<html:div> → macro token
        if (rawName.startsWith('\\<')) {
            accept({ node, property: 'name', type: SemanticTokenTypes.macro });
            return;
        }

        const name = rawName.slice(1);
        const tokenType = BUILTIN_COMMANDS.has(name)
            ? SemanticTokenTypes.keyword
            : SemanticTokenTypes.function;

        // Dynamic variable operations (\put, \get, \alloc) → modification modifier
        if (DYNAMIC_VAR_COMMANDS.has(rawName)) {
            accept({ node, property: 'name', type: tokenType, modifier: SemanticTokenModifiers.modification });
            return;
        }

        // Lexical binding keywords (\def, \let) → definition modifier
        if (LEXICAL_BINDING_COMMANDS.has(rawName)) {
            accept({ node, property: 'name', type: tokenType, modifier: SemanticTokenModifiers.definition });
            return;
        }

        // User macro that is the name being defined (immediately after \def or \let)
        // → declaration modifier so editors can show it differently from call sites
        if (!BUILTIN_COMMANDS.has(name) && this.isBindingSite(node)) {
            accept({ node, property: 'name', type: tokenType, modifier: SemanticTokenModifiers.declaration });
            return;
        }

        accept({ node, property: 'name', type: tokenType });
    }

    /**
     * Return true if `node` is the Command immediately following a \def or \let
     * in the same parent container — i.e., it is the name being bound.
     *
     * Example: \def\myMacro{body}
     *   parent.nodes = [..., Command(\def), Command(\myMacro), ...]
     */
    private isBindingSite(node: Command): boolean {
        const container = node.$container as { nodes?: AstNode[] };
        const siblings = container.nodes;
        if (!siblings) {
            return false;
        }
        const idx = siblings.indexOf(node);
        if (idx <= 0) {
            return false;
        }
        const prev = siblings[idx - 1];
        return isCommand(prev) && LEXICAL_BINDING_COMMANDS.has(prev.name);
    }

    /**
     * Highlight tree-id text fragments (e.g. `jms-0001` in `\transclude{jms-0001}`)
     * as `string` tokens to make them visually distinct from prose text.
     */
    private maybeHighlightTreeId(node: TextFragment, accept: SemanticTokenAcceptor): void {
        if (!isBraceArg(node.$container)) {
            return;
        }
        const braceArg = node.$container;
        if (!isCommand(braceArg.$container)) {
            return;
        }
        const cmd = braceArg.$container;
        // Only the first brace arg of a path command carries the tree-id
        const firstBrace = cmd.args.find(isBraceArg);
        if (firstBrace !== braceArg) {
            return;
        }
        if (PATH_ARG_COMMANDS.has(cmd.name.slice(1))) {
            accept({ node, property: 'value', type: SemanticTokenTypes.string });
        }
    }
}
