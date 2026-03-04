; Forester tree-sitter indentation rules

; Brace groups increase indent
(brace_group) @indent.begin

; Math groups
(inline_math) @indent.begin
(display_math) @indent.begin

; Closing delimiters align with the opening
(brace_group "}" @indent.branch @indent.end)
(bracket_group "]" @indent.branch @indent.end)
(paren_group ")" @indent.branch @indent.end)
(inline_math "}" @indent.branch @indent.end)
(display_math "}" @indent.branch @indent.end)
