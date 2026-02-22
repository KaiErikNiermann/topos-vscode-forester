/**
 * Forester Langium AbstractFormatter (tasks 15-20).
 *
 * Replaces the hand-rolled tokenizer+formatter in formatter-core.ts with a
 * declarative Langium AbstractFormatter that operates on the parsed AST/CST.
 *
 * Task 15 – Design: AbstractFormatter extension with format() dispatch
 * Task 16 – Top-level metadata commands: \title, \taxon, \author, … on new lines
 * Task 17 – Block commands: \ul, \li, \subtree … with indented children
 * Task 18 – Verbatim / \tex preservation: no reformatting of preserved content
 * Task 19 – Code block normalisation: \codeblock / \pre content preserved
 * Task 20 – ignoredCommands config hook: injected via ForesterFormatterConfig
 */
import type { AstNode } from 'langium';
import { AbstractFormatter, Formatting } from 'langium/lsp';
import {
    type BraceArg, type Command, type Document, type Node,
    isBraceArg, isCommand, isDocument, isMathDisplay, isMathInline,
    isVerbatimBlock,
} from './generated/ast.js';

// ─── Command category lists (mirroring formatter-core.ts) ──────────────────

/** Commands that must always start on their own line at the document level. */
const TOP_LEVEL_COMMANDS = new Set([
    'title', 'taxon', 'author', 'contributor', 'date', 'parent', 'tag',
    'meta', 'number', 'import', 'export', 'namespace', 'def', 'let',
    'alloc', 'open', 'solution',
]);

/** Commands whose brace-arg body is indented (content is structured). */
const BLOCK_COMMANDS = new Set([
    'p', 'ul', 'ol', 'li', 'blockquote', 'subtree', 'query', 'solution',
    'texfig', 'ltexfig', 'scope', 'figure',
]);

/**
 * Commands whose brace-arg content must be preserved verbatim.
 *   TEX_CONTENT_COMMANDS  (task 18): \tex{preamble}{body}
 *   CODE_CONTENT_COMMANDS (task 19): \codeblock{lang}{code}, \pre{lang}{code}
 */
const TEX_CONTENT_COMMANDS  = new Set(['tex']);
const CODE_CONTENT_COMMANDS = new Set(['codeblock', 'pre']);

// ─── Service interface for ignoredCommands injection (task 20) ──────────────

/**
 * Thin config object injected from formatter-config.ts's cache.
 * Wire this via the Langium DI container in forester-module.ts once the LSP
 * integration is complete (task 29).  Until then the formatter reads it
 * via the setConfig() method called from formatter.ts.
 */
export interface ForesterFormatterConfig {
    ignoredCommands: Set<string>;
    subtreeMacros: Set<string>;
}

// ─── AbstractFormatter implementation ───────────────────────────────────────

export class ForesterFormatter extends AbstractFormatter {

    // Task 20: populated by ForesterFormatterConfig service / setConfig()
    private ignoredCommands: Set<string> = new Set();
    private subtreeMacros: Set<string> = new Set();

    /** Called from the VSCode provider (task 21) before formatting. */
    setConfig(config: Partial<ForesterFormatterConfig>): void {
        if (config.ignoredCommands) this.ignoredCommands = config.ignoredCommands;
        if (config.subtreeMacros)   this.subtreeMacros   = config.subtreeMacros;
    }

    // ── Task 15: format() dispatch ──────────────────────────────────────────

    protected format(node: AstNode): void {
        if (isDocument(node)) {
            this.formatDocumentNode(node);
        } else if (isCommand(node)) {
            this.formatCommand(node);
        } else if (isBraceArg(node)) {
            this.formatBraceArg(node);
        }
        // BracketArg, ParenArg, MathInline, MathDisplay, VerbatimBlock,
        // TextFragment, Escape, MathText, MathBraceGroup — no reformatting.
    }

    // ── Document: top-level nodes inherit no extra indentation ─────────────

    private formatDocumentNode(node: Document): void {
        if (node.nodes.length === 0) return;
        const formatter = this.getNodeFormatter(node);
        // All top-level nodes start at column 0 (no extra indentation).
        formatter.nodes(...node.nodes).prepend(Formatting.noIndent());
    }

    // ── Task 16 & 17: Command formatting ───────────────────────────────────

    private formatCommand(node: Command): void {
        const name = this.cmdName(node);
        const formatter = this.getNodeFormatter(node);

        if (TOP_LEVEL_COMMANDS.has(name)) {
            // Task 16: top-level metadata commands always start on a new line,
            // unless they directly follow \def (the macro name is inline after \def).
            if (!this.isDirectlyAfterDef(node)) {
                formatter.property('name').prepend(Formatting.newLine());
            }
        } else if (BLOCK_COMMANDS.has(name) || this.subtreeMacros.has(name)) {
            // Task 17: block commands start on a new line.
            formatter.property('name').prepend(Formatting.newLine());
        }
    }

    // ── Task 17, 18, 19, 20: BraceArg formatting ───────────────────────────

    private formatBraceArg(node: BraceArg): void {
        const parent = node.$container;
        if (!isCommand(parent)) return;

        const name = this.cmdName(parent);

        // Task 18: \tex{preamble}{body} — preserve both args verbatim.
        if (TEX_CONTENT_COMMANDS.has(name)) return;

        // Task 19: \codeblock{lang}{code} / \pre — preserve code content.
        // The language arg ({lang}) is plain text so we leave it as-is;
        // the code arg (second BraceArg) is also preserved verbatim here.
        if (CODE_CONTENT_COMMANDS.has(name)) return;

        // Task 20: user-configured ignoredCommands — preserve content.
        if (this.ignoredCommands.has(name)) return;

        // Task 17: block commands — indent the body brace arg.
        // Only the LAST BraceArg of a block command is the body.
        if (BLOCK_COMMANDS.has(name) || this.subtreeMacros.has(name)) {
            const braceArgs = parent.args.filter(isBraceArg);
            if (node === braceArgs[braceArgs.length - 1]) {
                const formatter = this.getNodeFormatter(node);
                const open  = formatter.keyword('{');
                const close = formatter.keyword('}');
                open.append(Formatting.newLine());
                formatter.interior(open, close).prepend(Formatting.indent());
                close.prepend(Formatting.newLine());
            }
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /** Strip the leading backslash from a COMMAND_NAME token value. */
    private cmdName(node: Command): string {
        return node.name.slice(1);
    }

    /**
     * Returns true when `node` is the command name that immediately follows
     * a \def command in the same parent node list.
     *
     * In Forester syntax:  \def\macroName[params]{body}
     * The grammar parses \def and \macroName as separate Command siblings
     * (since bare COMMAND_NAMEs cannot be Argument tokens).  We therefore
     * suppress the leading newline for \macroName to keep the def on one line.
     */
    private isDirectlyAfterDef(node: Command): boolean {
        const parent = node.$container;
        if (!parent) return false;

        // Retrieve the nodes array from the parent (Document or BraceArg).
        let siblings: Node[] | undefined;
        if (isDocument(parent)) {
            siblings = parent.nodes;
        } else if (isBraceArg(parent)) {
            siblings = parent.nodes;
        }
        if (!siblings) return false;

        const idx = siblings.indexOf(node);
        if (idx <= 0) return false;

        // Walk backwards over non-command nodes (text, whitespace in AST)
        // to find the nearest preceding Command.
        for (let i = idx - 1; i >= 0; i--) {
            const prev = siblings[i];
            if (isCommand(prev)) {
                return this.cmdName(prev) === 'def';
            }
            // Skip verbatim, math, text fragments between commands
            if (isVerbatimBlock(prev) || isMathInline(prev) || isMathDisplay(prev)) {
                break;
            }
        }
        return false;
    }
}
