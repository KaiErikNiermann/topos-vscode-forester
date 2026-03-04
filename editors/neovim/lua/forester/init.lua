local M = {}

--- Register the tree-sitter-forester parser with nvim-treesitter so that
--- :TSInstall forester works out of the box.
local function register_ts_parser()
  local ok, parsers = pcall(require, "nvim-treesitter.parsers")
  if not ok then return end

  local configs = parsers.get_parser_configs()
  if configs.forester then return end -- already registered

  configs.forester = {
    install_info = {
      url = "https://github.com/KaiErikNiermann/tree-sitter-forester",
      files = { "src/parser.c", "src/scanner.c" },
      branch = "main",
    },
    filetype = "forester",
  }
end

--- Set up forester.nvim with the given options.
---@param opts ForesterConfig|nil
function M.setup(opts)
  local config = require("forester.config")
  config.apply(opts)

  -- Register tree-sitter parser so :TSInstall forester works
  register_ts_parser()

  -- Set up the language server
  require("forester.lsp").setup(config.current)

  -- Set up transclude decorations
  if config.current.decorations.enabled then
    require("forester.decorations").setup()
  end

  -- Register nvim-cmp source if available
  require("forester.cmp").setup()

  -- Set up statusline and file watching
  require("forester.statusline").setup()

end

return M
