; Forester tree-sitter text objects for nvim-treesitter-textobjects
;
; Usage: select/move/swap with @function.outer, @function.inner, @block.outer, etc.

; Commands as "function" objects
(command) @function.outer
(command (brace_group) @function.inner)

; Brace groups as "block" objects
(brace_group) @block.outer
(brace_group (_) @block.inner)

; Comments
(comment) @comment.outer
