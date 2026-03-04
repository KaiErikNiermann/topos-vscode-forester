; Forester tree-sitter highlights
; See node types at https://github.com/KaiErikNiermann/tree-sitter-forester

; Comments
(comment) @comment @spell

; Commands
(command (command_name) @function)

; Well-known metadata commands get keyword highlighting
((command (command_name) @keyword)
 (#any-of? @keyword
   "\\title" "\\taxon" "\\author" "\\date" "\\meta"
   "\\import" "\\export" "\\transclude"
   "\\def" "\\let" "\\alloc" "\\put" "\\get"
   "\\namespace" "\\open" "\\scope"
   "\\subtree" "\\xmlns"))

; XML-style commands
((command_name) @tag
 (#match? @tag "^\\\\<"))

; Punctuation
(brace_group "{" @punctuation.bracket)
(brace_group "}" @punctuation.bracket)
(bracket_group "[" @punctuation.bracket)
(bracket_group "]" @punctuation.bracket)
(paren_group "(" @punctuation.bracket)
(paren_group ")" @punctuation.bracket)

; Math
(inline_math "#{" @punctuation.special)
(inline_math "}" @punctuation.special)
(display_math "##{" @punctuation.special)
(display_math "}" @punctuation.special)

(inline_math) @markup.math
(display_math) @markup.math

; Math internals
(math_text) @markup.math
(math_escape) @string.escape
(math_command (command_name) @function)
(math_brace_group "{" @punctuation.bracket)
(math_brace_group "}" @punctuation.bracket)
(math_bracket_group "[" @punctuation.bracket)
(math_bracket_group "]" @punctuation.bracket)

; Escape sequences
(escape) @string.escape

; Links
(wiki_link) @markup.link
(markdown_link) @markup.link

; Verbatim blocks
(verbatim) @markup.raw

; Plain text (low priority, spell-checked)
(text) @spell
