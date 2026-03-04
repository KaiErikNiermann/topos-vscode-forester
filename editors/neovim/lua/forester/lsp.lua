local M = {}

--- Locate the forester language server binary.
--- Checks in order: user-configured cmd, npm global install, bundled in plugin.
---@return string[]|nil cmd The command to start the server, or nil if not found
function M.find_server()
  -- Check npm global install
  if vim.fn.executable("forester-language-server") == 1 then
    return { "forester-language-server", "--stdio" }
  end

  -- Check if node is available and the bundled server exists
  if vim.fn.executable("node") == 1 then
    -- Look relative to the plugin root for the bundled server
    local plugin_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h:h")
    local server_path = plugin_root .. "/../../out/language/main.js"
    local resolved = vim.fn.resolve(server_path)
    if vim.fn.filereadable(resolved) == 1 then
      return { "node", resolved, "--stdio" }
    end

    -- Also check two levels up from editors/neovim (the monorepo root)
    local monorepo_root = plugin_root .. "/../../"
    local bin_path = monorepo_root .. "bin/forester-language-server"
    if vim.fn.filereadable(vim.fn.resolve(bin_path)) == 1 then
      return { "node", vim.fn.resolve(bin_path) }
    end
  end

  return nil
end

--- Set up the Forester language server using Neovim's built-in LSP client.
---@param config ForesterConfig
function M.setup(config)
  if not config.lsp.enabled then
    return
  end

  local cmd = config.lsp.cmd or M.find_server()
  if not cmd then
    vim.notify(
      "[forester] Language server not found. Install with: npm install -g forest-keeper",
      vim.log.levels.WARN
    )
    return
  end

  vim.lsp.config("forester", {
    cmd = cmd,
    filetypes = { "forester" },
    root_markers = config.lsp.root_markers,
    settings = {},
  })

  vim.lsp.enable("forester")
end

return M
