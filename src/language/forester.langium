/**
 * Forester .tree language grammar for Langium 4.x
 *
 * Task coverage:
 *   Task 5  – Terminal rules (COMMAND_NAME, delimiters, math, verbatim, text, hidden)
 *   Task 6  – Top-level metadata command rules (\title, \taxon, \author, …)
 *   Task 7  – Block command rules (\p, \ul, \li, \subtree, …)
 *   Task 8  – Verbatim blocks (```…``` fence and \startverb…\stopverb span)
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
 * • Verbatim ``` fences and \startverb…\stopverb spans (task 8) are captured as
 *   single opaque terminals using a non-greedy [\s\S]*? pattern, so the formatter
 *   can emit the content unchanged. Their bodies are not Forester syntax — the
 *   compiler's lexer swallows them wholesale — so parsing into them only ever
 *   invented errors.
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
// Per spec §4.2, groups [ ] ( ) are first-class nodes (not just command args).
// This allows [text](url) markdown links, standalone [groups], and (groups)
// to appear at any node position without error.
Node:
    Command<false> | VerbatimBlock | MathDisplay | MathInline | WikiLink
    | BraceGroup | BracketGroup | ParenGroup | TextFragment | Escape;

// ============================================================================
// TASK 5 — Terminal rules
// ============================================================================

// Verbatim span:  \startverb …anything… \stopverb
// Forester's lexer swallows everything up to the \stopverb herald, so the body
// is not Forester syntax at all — it is routinely JavaScript or TeX whose
// brackets do not balance. Parsing \startverb as an ordinary command made every
// such body a cascade of phantom bracket errors. Must precede COMMAND_NAME so
// the longer match wins.
terminal VERBATIM_SPAN: /\\startverb[\s\S]*?\\stopverb/;

// XML namespace declaration: \xmlns:prefix  (spec §4.6)
//   e.g. \xmlns:html{http://www.w3.org/1999/xhtml}
//   Must be ordered before COMMAND_NAME so the longer match wins.
terminal DECL_XMLNS: /\\xmlns:[a-zA-Z]+/;

// XML-style element command: \<tag> or \<prefix:tag>
//   e.g. \<html:div>, \<svg:rect>
//   Must be ordered before COMMAND_NAME (longer match wins).
terminal XML_COMMAND_NAME: /\\<[A-Za-z][A-Za-z0-9-]*(?::[A-Za-z][A-Za-z0-9-]*)?>/;

// Backslash command: \name
//   name chars: A-Z a-z 0-9  -  /  ?  *
//   The * allows starred LaTeX commands like \inferrule*, \operatorname*
terminal COMMAND_NAME: /\\[A-Za-z0-9\-\/\?\*]+/;

// Wiki-style cross-reference: [[tree-id]]
//   Captures [[...]] as a single opaque token.
//   Must be ordered before the '[' keyword (longer match wins).
terminal WIKI_LINK: /\[\[[^\]\n]*\]\]/;

// Escape sequences per spec §2.3: \\ \{ \} \[ \] \# \% \  \, \" \` \_ \; \|
// These produce their literal character. Covers all special-char escapes.
// Must be ordered before COMMAND_NAME (Langium: longer/earlier match wins).
terminal ESCAPE: /\\[\\{}\[\]#%, "`;_|]/;

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

// Bare # not followed by { (i.e. not starting math #{  or ##{).
// Covers LaTeX #1 parameter references inside \tex bodies.
// Must be after HASH_DISPLAY and HASH_INLINE (they win when followed by {).
terminal BARE_HASH: /#(?!#?{)/;

// Bare ` not part of a ``` fence.
// Must be after VERBATIM_BLOCK (which wins for ```...```).
terminal BARE_BACKTICK: /`(?!``)/;

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

// In math a command takes brace arguments only. Bracket and paren args are a
// Forester calling convention that TeX does not share: \left( opens a
// delimiter that \right] is free to close, and the [n] of \sqrt[n]{x} is
// notation. Consuming them as arguments demands a matching closer that a
// formula need not have.
Command<Math>:
    name=(COMMAND_NAME | XML_COMMAND_NAME | DECL_XMLNS)
    (<Math> args+=BraceArg<true>* | <!Math> args+=Argument*);

// ============================================================================
// Argument forms: {}, [], ()
// ============================================================================

Argument:
    BraceArg<false> | BracketArg | ParenArg;

// Braces group in TeX as well as in Forester, so a math command's argument
// stays in math: its body keeps the relaxed bracket and paren handling.
BraceArg<Math>:
    '{' (<Math> nodes+=MathNode* | <!Math> nodes+=Node*) '}';

BracketArg:
    '[' nodes+=Node* ']';

ParenArg:
    '(' nodes+=Node* ')';

// ============================================================================
// Standalone groups (spec §4.2: group := '{' nodes '}' | '[' nodes ']' | '(' nodes ')')
// All three delimiter forms can appear as standalone nodes, not just as command
// args. BraceGroup handles TeX-style grouping like _{\alpha}, BracketGroup
// handles [text](url) markdown links, ParenGroup handles (parenthetical).
// ============================================================================

BraceGroup:
    '{' nodes+=Node* '}';

BracketGroup:
    '[' nodes+=Node* ']';

ParenGroup:
    '(' nodes+=Node* ')';

// ============================================================================
// TASK 8 — Verbatim blocks
//   ``` fences         → VERBATIM_BLOCK terminal above.
//   \startverb…\stopverb → VERBATIM_SPAN terminal above.
// Both are opaque, so the formatter emits them unchanged.
// ============================================================================

VerbatimBlock:
    content=(VERBATIM_BLOCK | VERBATIM_SPAN);

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

// Nodes inside math: nested commands, more math, explicit brace groups,
// escapes (e.g. \\ line break), and text
MathNode:
    Command<true> | VerbatimBlock | MathInline | MathDisplay | MathBraceGroup
    | MathEscape | MathText;

// Explicit { } group inside math (e.g. for TeX grouping)
MathBraceGroup:
    '{' nodes+=MathNode* '}';

// Escape sequence inside math (e.g. \\ for line break, \{ for literal brace)
MathEscape:
    value=ESCAPE;

// Raw text content inside math (LaTeX tokens, digits, operators, …)
//
// Brackets and parens are text here, deliberately — they are TeX notation, not
// Forester grouping, and TeX does not require them to balance: (a, b] and
// [a, b) mismatch by design, and \left. \right) leaves one side unpaired.
// Matching them as groups turned ordinary formulae into parse errors. Braces
// above stay structural: they group in TeX too, and one has to close the math.
MathText:
    value=(TEXT | BARE_HASH | BARE_BACKTICK | '[' | ']' | '(' | ')');

// ============================================================================
// Escaped percent and plain text fragments
// ============================================================================

// Escape sequence (spec §2.3): backslash + special char → literal char
Escape:
    value=ESCAPE;

// Plain text run (TEXT, or bare # / ` that didn't start math / verbatim)
TextFragment:
    value=(TEXT | BARE_HASH | BARE_BACKTICK);

// ============================================================================
// Wiki-style cross-references:  [[tree-id]]
// ============================================================================

WikiLink:
    content=WIKI_LINK;
