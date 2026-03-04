local M = {}

--- Set up forester.nvim with the given options.
---@param opts ForesterConfig|nil
function M.setup(opts)
  local config = require("forester.config")
  config.apply(opts)

  -- Set up the language server
  require("forester.lsp").setup(config.current)
end

return M
