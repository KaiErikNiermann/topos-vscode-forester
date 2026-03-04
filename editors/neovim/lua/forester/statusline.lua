--- Statusline component for Forester forest validity.
---
--- Exposes a lualine-compatible component and a raw status function.
--- Watches .tree and forest.toml files for changes via BufWritePost
--- autocmd and invalidates the forest cache on change.

local config = require("forester.config")

local M = {}

---@type "valid"|"invalid"|"updating"|"unknown"
local status = "unknown"
local last_error = nil

--- Find the project root.
---@return string|nil
local function find_root()
  return vim.fs.root(0, config.current.lsp.root_markers)
end

--- Query the forest to check validity.
local function check_forest()
  local root = find_root()
  if not root then
    status = "unknown"
    return
  end

  status = "updating"

  vim.system(
    { config.current.forester_path, "query", "all" },
    { cwd = root, text = true },
    function(result)
      vim.schedule(function()
        if result.code == 0 then
          status = "valid"
          last_error = nil

          -- Invalidate decoration and completion caches
          local ok_dec, dec = pcall(require, "forester.decorations")
          if ok_dec then dec.update_all() end
          local ok_cmp, cmp = pcall(require, "forester.cmp")
          if ok_cmp then cmp.invalidate_cache() end
        else
          status = "invalid"
          last_error = result.stderr or "unknown error"
        end
      end)
    end
  )
end

--- Get current forest status.
---@return { status: string, error: string|nil }
function M.get_status()
  return { status = status, error = last_error }
end

--- Raw status text for custom statuslines.
---@return string
function M.text()
  if status == "valid" then return "Forest OK" end
  if status == "invalid" then return "Forest ERR" end
  if status == "updating" then return "Forest ..." end
  return ""
end

--- Lualine-compatible component function.
--- Usage: require('lualine').setup({ sections = { lualine_x = { require('forester.statusline').component } } })
function M.component()
  return M.text()
end

--- Set up file watching autocommands and initial check.
function M.setup()
  local group = vim.api.nvim_create_augroup("ForesterStatusline", { clear = true })

  vim.api.nvim_create_autocmd("BufWritePost", {
    group = group,
    pattern = { "*.tree", "forest.toml" },
    callback = function()
      check_forest()
    end,
  })

  -- Check on entering a forester buffer
  vim.api.nvim_create_autocmd("BufEnter", {
    group = group,
    pattern = "*.tree",
    callback = function()
      if status == "unknown" then
        check_forest()
      end
    end,
  })
end

return M
