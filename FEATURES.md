# Feature Parity: VSCode / Neovim

This document tracks feature implementation status across editor integrations.
Keep it updated when adding or porting features.

## Conventions

1. **Pure logic** belongs in `src/*-core.ts` modules with zero editor dependencies.
2. **LSP-exposable features** should be registered in `src/language/forester-module.ts`
   so all LSP clients benefit automatically.
3. **Editor-specific UI** (WebView, extmarks, decorations) is implemented separately
   per editor but documented together here.
4. **Custom LSP methods** use the `forester/` namespace for features beyond standard
   LSP (e.g. `forester/getForestData`, `forester/getTreeTitle`).

## Feature Matrix

| Feature | Pure Core | LSP | VSCode | Neovim | Notes |
|---------|-----------|-----|--------|--------|-------|
| **Syntax Highlighting** | — | Semantic tokens | TextMate + Semantic | tree-sitter queries | Neovim uses tree-sitter-forester |
| **Formatting** | `formatter-core.ts` | `textDocument/formatting` | VSCode provider + LSP | LSP | Full document formatting |
| **LaTeX Hover** | `latex-hover-core.ts` | `textDocument/hover` | VSCode provider + LSP | LSP | Math preview on hover |
| **Tag Closure Inlay Hints** | `tag-closure-inlay-core.ts` | `textDocument/inlayHint` | VSCode provider + LSP | LSP | Shows command name after `}` |
| **Subtree Auto-ID** | `subtree-auto-id-core.ts` | — | VSCode provider | Lua port | Base36 sequential IDs |
| **Transclude Decorations** | — | — | VSCode decorations | Lua extmarks | Inline tree titles |
| **Tree Completion** | — | LSP completions | VSCode provider | nvim-cmp source | Tree ID + title |
| **Link Alias Config** | `link-aliases-config.ts` | — | VSCode commands | Lua port | `.forester-links.json` |
| **Definition / Go-to** | — | `textDocument/definition` | LSP | LSP | Jump to tree file |
| **Code Lens** | — | `textDocument/codeLens` | LSP | LSP | Actions above trees |
| **Code Actions** | — | `textDocument/codeAction` | LSP | LSP | Quick fixes |
| **Semantic Tokens** | — | `textDocument/semanticTokens` | LSP | LSP | Enhanced highlighting |
| **Tree Management** | — | — | VSCode commands | Lua commands | `:ForesterNew`, `:ForesterRename`, `:ForesterTranscludeNew` |
| **Forest Structure View** | — | — | WebView panel | — | Planned: Telescope pickers |
| **Statusline** | — | — | Status bar item | Lualine component | Forest validity indicator |
| **File Watching** | — | — | VSCode events | `BufWritePost` autocmd | Cache invalidation |
| **LanguageTool** | — | — | LTeX integration | — | Planned: ltex-ls bridge |
| **Folding** | — | — | TextMate scopes | tree-sitter folds | `folds.scm` queries |
| **Text Objects** | — | — | — | tree-sitter textobjects | `textobjects.scm` queries |
| **Indentation** | — | — | Language config | tree-sitter indents | `indents.scm` queries |
| **LaTeX Injection** | — | — | — | tree-sitter injections | Embedded LaTeX in math blocks |

## Legend

- **Pure Core**: Editor-agnostic TypeScript module
- **LSP**: Available to all LSP clients automatically
- **VSCode / Neovim**: Editor-specific implementation
- `—` = Not applicable or not implemented
