local M = {}

---@class ForesterConfig
---@field lsp ForesterLspConfig
---@field forester_path string Path to forester CLI executable
---@field decorations ForesterDecorationsConfig
---@field completion ForesterCompletionConfig

---@class ForesterLspConfig
---@field enabled boolean Enable the language server
---@field cmd string[]|nil Command to start the server (auto-detected if nil)
---@field root_markers string[] Files that identify the project root

---@class ForesterDecorationsConfig
---@field enabled boolean Show transclude title decorations

---@class ForesterCompletionConfig
---@field show_id boolean Show tree ID in completion items

---@type ForesterConfig
M.defaults = {
  lsp = {
    enabled = true,
    cmd = nil,
    root_markers = { "forest.toml" },
  },
  forester_path = "forester",
  decorations = {
    enabled = true,
  },
  completion = {
    show_id = false,
  },
}

---@type ForesterConfig
M.current = vim.deepcopy(M.defaults)

---@param opts ForesterConfig|nil
function M.apply(opts)
  M.current = vim.tbl_deep_extend("force", vim.deepcopy(M.defaults), opts or {})
end

return M
