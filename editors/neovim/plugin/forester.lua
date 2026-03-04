-- Guard against double-loading
if vim.g.loaded_forester then
  return
end
vim.g.loaded_forester = true

-- User commands (lazy-loaded: actual logic lives in lua/forester/)
vim.api.nvim_create_user_command("ForesterNew", function()
  vim.notify("[forester] :ForesterNew not yet implemented", vim.log.levels.INFO)
end, { desc = "Create a new Forester tree" })

vim.api.nvim_create_user_command("ForesterRename", function()
  vim.notify("[forester] :ForesterRename not yet implemented", vim.log.levels.INFO)
end, { desc = "Rename the current Forester tree" })
