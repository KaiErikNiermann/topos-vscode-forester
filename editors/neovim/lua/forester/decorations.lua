--- Transclude decorations via extmarks.
---
--- Shows tree titles as virtual text after \transclude{id}, \import{id},
--- \export{id} lines. Queries the forester CLI for tree metadata and
--- caches results.

local config = require("forester.config")

local M = {}

local ns = vim.api.nvim_create_namespace("forester_decorations")

---@type table<string, { title: string|nil, taxon: string|nil }>
local forest_cache = {}
local cache_valid = false

--- Taxon abbreviation map (subset of the full map from commands.lua).
local TAXON_ABBREV = {
  theorem = "thm", definition = "def", proposition = "prop",
  lemma = "lem", corollary = "cor", example = "ex",
  remark = "rem", proof = "pf", section = "sec",
  chapter = "ch", note = "note", conjecture = "conj",
  axiom = "ax", construction = "const", observation = "obs",
  exercise = "exer", problem = "prob", solution = "soln",
  algorithm = "alg", discussion = "disc", warning = "warn",
  ["nota-bene"] = "nb", appendix = "app", explication = "expl",
  figure = "fig",
}

---@param taxon string|nil
---@return string
local function taxon_abbrev(taxon)
  if not taxon or taxon == vim.NIL then return "" end
  return TAXON_ABBREV[taxon:lower()] or taxon:sub(1, 3):lower()
end

--- Find the project root.
---@return string|nil
local function find_root()
  return vim.fs.root(0, config.current.lsp.root_markers)
end

--- Refresh the forest cache by calling `forester query all`.
local function refresh_cache()
  local root = find_root()
  if not root then return end

  local cmd = { config.current.forester_path, "query", "all" }
  vim.system(cmd, { cwd = root, text = true }, function(result)
    if result.code ~= 0 then
      cache_valid = false
      return
    end

    local ok, data = pcall(vim.json.decode, result.stdout or "")
    if not ok or type(data) ~= "table" then
      cache_valid = false
      return
    end

    local new_cache = {}
    for _, tree in ipairs(data) do
      if tree.uri then
        new_cache[tree.uri] = { title = tree.title, taxon = tree.taxon }
      end
    end

    forest_cache = new_cache
    cache_valid = true

    -- Schedule decoration update on main thread
    vim.schedule(function()
      M.update_all()
    end)
  end)
end

--- Format a tree title for display.
---@param tree_id string
---@return string|nil
local function format_title(tree_id)
  local info = forest_cache[tree_id]
  if not info or not info.title or info.title == vim.NIL then return nil end
  if info.title == tree_id then return nil end

  if info.taxon and info.taxon ~= vim.NIL then
    local abbr = taxon_abbrev(info.taxon)
    return abbr .. ": " .. info.title
  end
  return info.title
end

--- Update decorations for a single buffer.
---@param buf integer
function M.update(buf)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  if vim.bo[buf].filetype ~= "forester" then return end
  if not config.current.decorations.enabled then
    vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
    return
  end

  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)

  if not cache_valid then return end

  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)

  for i, line in ipairs(lines) do
    -- Use vim.regex for the pattern since Lua patterns don't support alternation
    for cmd_type, tree_id in line:gmatch("\\(transclude)%{([^}]+)%}") do
      local title = format_title(tree_id)
      if title then
        vim.api.nvim_buf_set_extmark(buf, ns, i - 1, #line, {
          virt_text = { { "(" .. title .. ")", "Comment" } },
          virt_text_pos = "eol",
        })
      end
    end
    for cmd_type, tree_id in line:gmatch("\\(import)%{([^}]+)%}") do
      local title = format_title(tree_id)
      if title then
        vim.api.nvim_buf_set_extmark(buf, ns, i - 1, #line, {
          virt_text = { { "(" .. title .. ")", "Comment" } },
          virt_text_pos = "eol",
        })
      end
    end
    for cmd_type, tree_id in line:gmatch("\\(export)%{([^}]+)%}") do
      local title = format_title(tree_id)
      if title then
        vim.api.nvim_buf_set_extmark(buf, ns, i - 1, #line, {
          virt_text = { { "(" .. title .. ")", "Comment" } },
          virt_text_pos = "eol",
        })
      end
    end
  end
end

--- Update decorations for all visible forester buffers.
function M.update_all()
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    local buf = vim.api.nvim_win_get_buf(win)
    if vim.bo[buf].filetype == "forester" then
      M.update(buf)
    end
  end
end

--- Set up autocommands for automatic decoration updates.
function M.setup()
  local group = vim.api.nvim_create_augroup("ForesterDecorations", { clear = true })

  vim.api.nvim_create_autocmd({ "BufEnter", "BufWritePost" }, {
    group = group,
    pattern = "*.tree",
    callback = function(ev)
      if not cache_valid then
        refresh_cache()
      else
        M.update(ev.buf)
      end
    end,
  })

  vim.api.nvim_create_autocmd("TextChanged", {
    group = group,
    pattern = "*.tree",
    callback = function(ev)
      M.update(ev.buf)
    end,
  })

  -- Invalidate cache when .tree files are written (forest may have changed)
  vim.api.nvim_create_autocmd("BufWritePost", {
    group = group,
    pattern = "*.tree",
    callback = function()
      refresh_cache()
    end,
  })

  -- Initial cache load
  refresh_cache()
end

return M
