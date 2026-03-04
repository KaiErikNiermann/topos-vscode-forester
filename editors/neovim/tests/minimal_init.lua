-- Minimal init.lua for headless Neovim testing.
-- Adds the plugin to rtp without any plugin manager.

local plugin_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h")
vim.opt.rtp:prepend(plugin_root)

-- Disable swap/undo/shada for CI
vim.opt.swapfile = false
vim.opt.undofile = false
vim.opt.shadafile = "NONE"
