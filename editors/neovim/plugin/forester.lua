-- Guard against double-loading
if vim.g.loaded_forester then
  return
end
vim.g.loaded_forester = true

-- User commands (lazy-loaded: actual logic lives in lua/forester/commands.lua)
vim.api.nvim_create_user_command("ForesterNew", function()
  require("forester.commands").new_tree()
end, { desc = "Create a new Forester tree" })

vim.api.nvim_create_user_command("ForesterRename", function()
  require("forester.commands").rename_tree()
end, { desc = "Rename the current Forester tree" })

vim.api.nvim_create_user_command("ForesterTranscludeNew", function()
  require("forester.commands").transclude_new()
end, { desc = "Create a new tree and transclude it at cursor" })
