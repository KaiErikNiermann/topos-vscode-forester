; Forester tree-sitter injections
;
; Embed LaTeX highlighting inside math blocks and \tex commands.

; Inline math #{...} → LaTeX
(inline_math) @injection.content
(#set! injection.language "latex")
(#set! injection.combined)

; Display math ##{...} → LaTeX
(display_math) @injection.content
(#set! injection.language "latex")
(#set! injection.combined)

; \tex{preamble}{body} → LaTeX in both arguments
((command
  (command_name) @_cmd
  (brace_group) @injection.content)
 (#eq? @_cmd "\\tex")
 (#set! injection.language "latex")
 (#set! injection.combined))
