vim.filetype.add({
  extension = {
    tree = "forester",
  },
})

-- Register tree-sitter language so Neovim maps filetype → parser
vim.treesitter.language.register("forester", "forester")
