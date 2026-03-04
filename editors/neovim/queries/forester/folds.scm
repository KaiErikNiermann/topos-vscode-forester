; Forester tree-sitter fold rules

; Brace groups (subtrees, command bodies) are foldable
(brace_group) @fold

; Math blocks are foldable
(display_math) @fold

; Verbatim blocks are foldable
(verbatim) @fold
