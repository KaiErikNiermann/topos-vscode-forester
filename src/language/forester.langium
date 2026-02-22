/**
 * Forester .tree language grammar for Langium 4.x
 *
 * Task coverage:
 *   Task 5  – Terminal rules (COMMAND_NAME, delimiters, math, verbatim, text, hidden)
 *   Task 6  – Top-level metadata command rules (\title, \taxon, \author, …)
 *   Task 7  – Block command rules (\p, \ul, \li, \subtree, …)
 *   Task 8  – Verbatim blocks (```…``` fence; \startverb content handled via ignoredCommands)
 *   Task 9  – Math syntax  #{…} inline  and  ##{…} display
 *   Task 10 – Content-preserving commands (\tex{}{}, \codeblock{}{}, \pre{}{})
 *   Task 11 – Macro definition \def and macro calls
 *   Task 12 – Link-like commands (\transclude, \import, \export, \ref)
 *
 * Design decisions
 * ─────────────────
 * • Tasks 6, 7, 10, 11, 12 all share the same syntactic structure:
 *   \commandName followed by zero or more Argument{} [] ().
 *   A single `Command` parser rule covers all of them; the formatter and
 *   hover provider distinguish command categories by name at the semantic level,
 *   mirroring the BLOCK_COMMANDS / TOP_LEVEL_COMMANDS / TEX_CONTENT_COMMANDS
 *   constants in formatter-core.ts.
 *
 * • Math (task 9) is parsed with nested parser rules (MathNode*) rather than
 *   an opaque regex terminal so that balanced-brace nesting is handled correctly
 *   by the parser for arbitrary depth.
 *
 * • Verbatim ``` fences (task 8) are captured as a single opaque VERBATIM_BLOCK
 *   terminal using a non-greedy [\s\S]*? pattern, so the formatter can emit the
 *   content unchanged.  \startverb{…} is a plain Command; its brace content is
 *   preserved by the formatter via the ignoredCommands hook (task 20).
 *
 * • A lone backslash not followed by a name character is treated as plain TEXT.
 */
grammar Forester

// ============================================================================
// Entry rule
// ============================================================================

entry Document:
    nodes+=Node*;

// Top-level structural nodes
Node:
    Command | VerbatimBlock | MathDisplay | MathInline | WikiLink | TextFragment | Escape;

// ============================================================================
// TASK 5 — Terminal rules
// ============================================================================

// Backslash command: \name
//   name chars: A-Z a-z 0-9  -  /  ?
//   (mirrors the regex in formatter-core.ts tokenize())
terminal COMMAND_NAME: /\\[A-Za-z0-9\-\/\?]+/;

// XML-style element command: \<tag> or \<prefix:tag>
//   e.g. \<html:div>, \<svg:rect>
//   Must be ordered before COMMAND_NAME in grammar (longer match wins).
terminal XML_COMMAND_NAME: /\\<[A-Za-z][A-Za-z0-9-]*(?::[A-Za-z][A-Za-z0-9-]*)?>/;

// Wiki-style cross-reference: [[tree-id]]
//   Captures [[...]] as a single opaque token.
//   Must be ordered before the '[' keyword (longer match wins).
terminal WIKI_LINK: /\[\[[^\]\n]*\]\]/;

// Escaped percent  \%  — treat as literal text, not a comment start
// (the tokenizer special-cases this before the comment rule)
terminal ESCAPED_PERCENT: /\\%/;

// Math delimiters — ##{ must be checked before #{ by Langium terminal ordering
terminal HASH_DISPLAY: /##{/;
terminal HASH_INLINE:  /#{/;

// Verbatim code fence:  ```[lang]\n…content…\n```
// Captured as a single opaque token; the formatter preserves it verbatim.
// Non-greedy [\s\S]*? ensures we close at the first matching ```.
terminal VERBATIM_BLOCK: /```[\s\S]*?```/;

// Plain text: any run of characters that are not Forester special characters.
// Special: \ { } [ ] ( ) \n \t (space) % # `
terminal TEXT: /[^\\{}[\]()\n\t %#`]+/;

// Percent-line comment (Forester uses % like TeX)
// Hidden: silently consumed by parser, visible in CST for formatter queries.
hidden terminal COMMENT: /%[^\n]*/;

// Horizontal whitespace (spaces and tabs)
hidden terminal WS: /[ \t]+/;

// Newlines — hidden so the formatter controls vertical layout
hidden terminal NL: /\r?\n/;

// ============================================================================
// TASK 6 — Top-level metadata commands
//   \title \taxon \author \contributor \date \parent \tag \meta \number
//   \import \export \namespace \def \let \alloc \open \solution
//
// TASK 7 — Block commands (formatter indents their children)
//   \p \ul \ol \li \blockquote \pre \subtree \query \solution
//   \texfig \ltexfig \scope \figure
//
// TASK 10 — Content-preserving commands (formatter treats args as verbatim)
//   \tex{preamble}{body}        (TEX_CONTENT_COMMANDS)
//   \codeblock{lang}{code}      (CODE_CONTENT_COMMANDS)
//   \pre{lang}{code}            (CODE_CONTENT_COMMANDS)
//
// TASK 11 — Macro definition and calls
//   \def\macroName[arg1 arg2]{body}
//   Macro calls look identical to ordinary commands.
//
// TASK 12 — Link-like commands
//   \transclude{tree-id}  \import{tree-id}  \export{tree-id}  \ref{tree-id}
//
// All of the above share the same surface syntax: \name followed by
// zero or more Argument blocks.  Category is determined by name at
// the semantic/formatting layer.
// ============================================================================

Command:
    name=(COMMAND_NAME | XML_COMMAND_NAME) args+=Argument*;

// ============================================================================
// Argument forms: {}, [], ()
// ============================================================================

Argument:
    BraceArg | BracketArg | ParenArg;

BraceArg:
    '{' nodes+=Node* '}';

BracketArg:
    '[' nodes+=Node* ']';

ParenArg:
    '(' nodes+=Node* ')';

// ============================================================================
// TASK 8 — Verbatim blocks
//   ``` fences → captured as a single VERBATIM_BLOCK terminal above.
//   \startverb{…} / \stopverb → parsed as ordinary Commands; the formatter
//   skips reformatting their brace content when the command name appears in
//   the ignoredCommands set (task 20 / ForesterFormatterConfig).
// ============================================================================

VerbatimBlock:
    content=VERBATIM_BLOCK;

// ============================================================================
// TASK 9 — Math syntax
//   #{…}  — inline math
//   ##{…} — display math
//
// Content is parsed recursively as MathNode* so the parser handles balanced
// brace nesting at any depth without requiring a regex with lookaheads.
// ============================================================================

MathInline:
    HASH_INLINE nodes+=MathNode* '}';

MathDisplay:
    HASH_DISPLAY nodes+=MathNode* '}';

// Nodes inside math: nested commands, more math, explicit brace groups, text
MathNode:
    Command | MathInline | MathDisplay | MathBraceGroup | MathText;

// Explicit { } group inside math (e.g. for TeX grouping)
MathBraceGroup:
    '{' nodes+=MathNode* '}';

// Raw text content inside math (LaTeX tokens, digits, operators, …)
MathText:
    value=TEXT;

// ============================================================================
// Escaped percent and plain text fragments
// ============================================================================

// \% — escaped percent sign (not a comment)
Escape:
    value=ESCAPED_PERCENT;

// Plain text run
TextFragment:
    value=TEXT;

// ============================================================================
// Wiki-style cross-references:  [[tree-id]]
// ============================================================================

WikiLink:
    content=WIKI_LINK;
