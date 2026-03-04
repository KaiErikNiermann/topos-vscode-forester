# forester.nvim

Neovim plugin for [Forester](https://www.jonmsterling.com/jms-005P.xml), a tool for managing forests of evergreen notes.

Part of the [forester-lang-support](https://github.com/ToposInstitute/forester-lang-support) monorepo.

## Prerequisites

- **Neovim** >= 0.10
- **Node.js** >= 18
- **forester** CLI installed and on `$PATH`
- A `forest.toml` in your project root

## Installation

### lazy.nvim

```lua
{
  "ToposInstitute/forester-lang-support",
  ft = "forester",
  config = function()
    require("forester").setup({
      -- Options (all optional, shown with defaults):
      forester_path = "forester",
      lsp = {
        enabled = true,
        cmd = nil, -- auto-detected
        root_markers = { "forest.toml" },
      },
      decorations = { enabled = true },
      completion = { show_id = false },
    })
  end,
  -- Tell lazy.nvim the plugin lives in a subdirectory:
  dir = nil, -- set this if using a local clone
}
```

### rocks.nvim

```
:Rocks install forester.nvim
```

### Manual

Clone the repo and add the Neovim plugin directory to your runtimepath:

```lua
vim.opt.rtp:prepend("/path/to/forester-lang-support/editors/neovim")
require("forester").setup()
```

## Features

| Feature | Description |
|---------|-------------|
| **LSP** | Full language server via Langium (formatting, hover, inlay hints, code actions, go-to-definition, completions, semantic tokens) |
| **Tree-sitter** | Syntax highlighting, folding, indentation, text objects, LaTeX injection via [tree-sitter-forester](https://github.com/KaiErikNiermann/tree-sitter-forester) |
| **Tree management** | `:ForesterNew`, `:ForesterRename`, `:ForesterTranscludeNew` |
| **Subtree auto-ID** | `:ForesterSubtreeId` — insert `\subtree[]{}` with sequential base36 IDs |
| **Decorations** | Inline virtual text showing tree titles after `\transclude{}`, `\import{}`, `\export{}` |
| **Completion** | nvim-cmp source for tree IDs inside link patterns |
| **Statusline** | Lualine-compatible forest validity indicator |

## Commands

| Command | Description |
|---------|-------------|
| `:ForesterNew` | Create a new tree (prompts for prefix and title) |
| `:ForesterRename` | Edit the current tree's title and taxon |
| `:ForesterTranscludeNew` | Create a new tree and insert `\transclude{id}` at cursor |
| `:ForesterSubtreeId` | Insert a `\subtree[]{}` block with auto-generated ID |

## Suggested Keybindings

```lua
vim.keymap.set("n", "<leader>fn", "<cmd>ForesterNew<cr>", { desc = "New tree" })
vim.keymap.set("n", "<leader>fr", "<cmd>ForesterRename<cr>", { desc = "Rename tree" })
vim.keymap.set("n", "<leader>ft", "<cmd>ForesterTranscludeNew<cr>", { desc = "Transclude new" })
vim.keymap.set("n", "<leader>fs", "<cmd>ForesterSubtreeId<cr>", { desc = "Insert subtree" })
```

## Statusline

### Lualine

```lua
require("lualine").setup({
  sections = {
    lualine_x = { require("forester.statusline").component },
  },
})
```

### Custom statusline

```lua
-- Returns "Forest OK", "Forest ERR", "Forest ...", or ""
require("forester.statusline").text()
```

## Completion (nvim-cmp)

The plugin automatically registers a `forester` source with nvim-cmp if available.
Add it to your cmp sources:

```lua
require("cmp").setup({
  sources = {
    { name = "forester" },
    -- ... other sources
  },
})
```

## Tree-sitter

Install the forester parser:

```lua
-- In your tree-sitter config:
require("nvim-treesitter.configs").setup({
  ensure_installed = { "forester" },
})
```

Query files (highlights, indents, folds, textobjects, injections) are bundled with this plugin.

## Link Aliases

Create a `.forester-links.json` in your project root to define custom link patterns
for completion:

```json
{
  "version": 1,
  "customPatterns": [
    { "pattern": "\\cite{", "closingChar": "}", "triggerChar": "{" }
  ],
  "includeBuiltins": true
}
```

## License

MIT
