/**
 * Forester .tree language grammar for Langium.
 *
 * Terminal rules (task 5):   COMMAND_NAME, LBRACE/RBRACE, LBRACKET/RBRACKET,
 *                             LPAREN/RPAREN, HASH_INLINE, HASH_DISPLAY,
 *                             TEXT_CONTENT, COMMENT
 * Parser rules (tasks 6-12): Document, Command, TopLevelCommand, BlockCommand,
 *                             VerbatimBlock, MathInline, MathDisplay,
 *                             TexBlock, CodeBlock, MacroDef, LinkCommand
 */
grammar Forester

// ---------------------------------------------------------------------------
// Entry rule
// ---------------------------------------------------------------------------

entry Document:
    nodes+=Node*;

// Placeholder node rule — will be expanded in tasks 5-12
Node:
    Command | VerbatimBlock | MathDisplay | MathInline | TextFragment;

// ---------------------------------------------------------------------------
// Terminals — defined in task 5
// ---------------------------------------------------------------------------

terminal COMMAND_NAME: /\\[A-Za-z0-9\-\/\?]+/;

// Math delimiters
terminal HASH_DISPLAY: /##{/;
terminal HASH_INLINE:  /#{/;

// Verbatim fence
terminal VERBATIM_FENCE: /```[^\n]*/;

// Plain text (anything that is not a special character)
terminal TEXT_CONTENT: /[^\\{}[\]()\n\t %#`][^\\{}[\]()\n%#`]*/;

// Line comment (Forester uses %)
hidden terminal COMMENT: /%[^\n]*/;

// Whitespace
hidden terminal WS: /[ \t]+/;
hidden terminal NL: /\r?\n[\r\n]*/;

// ---------------------------------------------------------------------------
// Parser rules — will be fleshed out in tasks 6-12
// ---------------------------------------------------------------------------

Command:
    name=COMMAND_NAME args+=Argument*;

Argument:
    BraceArg | BracketArg | ParenArg;

BraceArg:
    '{' nodes+=Node* '}';

BracketArg:
    '[' nodes+=Node* ']';

ParenArg:
    '(' nodes+=Node* ')';

// Verbatim block: ```...``` — detailed rule in task 8
VerbatimBlock:
    open=VERBATIM_FENCE content=TEXT_CONTENT? close=VERBATIM_FENCE;

// Math: ##{...} display — detailed rule in task 9
MathDisplay:
    HASH_DISPLAY content=TEXT_CONTENT? '}';

// Math: #{...} inline — detailed rule in task 9
MathInline:
    HASH_INLINE content=TEXT_CONTENT? '}';

// Plain text fragment
TextFragment:
    value=TEXT_CONTENT;
