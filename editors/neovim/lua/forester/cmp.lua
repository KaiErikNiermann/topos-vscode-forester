--- nvim-cmp completion source for Forester tree IDs.
---
--- Provides tree ID completions when the cursor is inside a link pattern
--- such as \transclude{}, \import{}, \ref{}, [[]], [text](), or custom
--- patterns from .forester-links.json.

local config = require("forester.config")

local M = {}

--- Built-in link patterns that trigger tree ID completion.
local BUILTIN_PATTERNS = {
  { pattern = "\\transclude{", closing = "}" },
  { pattern = "\\import{",     closing = "}" },
  { pattern = "\\export{",     closing = "}" },
  { pattern = "\\ref{",        closing = "}" },
  { pattern = "](",            closing = ")" },
  { pattern = "[[",            closing = "]]" },
}

---@type table<string, { title: string|nil, taxon: string|nil }>|nil
local forest_cache = nil

--- Find the project root.
---@return string|nil
local function find_root()
  return vim.fs.root(0, config.current.lsp.root_markers)
end

--- Read .forester-links.json for custom link patterns.
---@param root string
---@return table[]
local function read_custom_patterns(root)
  local path = root .. "/.forester-links.json"
  local f = io.open(path, "r")
  if not f then return {} end
  local content = f:read("*a")
  f:close()

  local ok, data = pcall(vim.json.decode, content)
  if not ok or type(data) ~= "table" then return {} end

  local patterns = {}
  local custom = data.customPatterns or {}
  for _, p in ipairs(custom) do
    if p.pattern and p.closingChar then
      table.insert(patterns, { pattern = p.pattern, closing = p.closingChar })
    end
  end
  return patterns
end

--- Get all link patterns (builtin + custom).
---@return table[]
local function get_all_patterns()
  local patterns = vim.deepcopy(BUILTIN_PATTERNS)
  local root = find_root()
  if root then
    vim.list_extend(patterns, read_custom_patterns(root))
  end
  return patterns
end

--- Refresh the forest cache synchronously (blocking).
local function refresh_cache()
  local root = find_root()
  if not root then return end

  local result = vim.system(
    { config.current.forester_path, "query", "all" },
    { cwd = root, text = true }
  ):wait()

  if result.code ~= 0 then return end

  local ok, data = pcall(vim.json.decode, result.stdout or "")
  if not ok or type(data) ~= "table" then return end

  local cache = {}
  for _, tree in ipairs(data) do
    if tree.uri then
      cache[tree.uri] = { title = tree.title, taxon = tree.taxon }
    end
  end
  forest_cache = cache
end

--- Check if the cursor is inside a link pattern.
--- Returns the partial text typed so far, or nil.
---@param line string
---@param col integer 0-based cursor column
---@return string|nil partial_text
---@return integer|nil start_col 0-based
local function find_link_context(line, col)
  local before = line:sub(1, col)
  local patterns = get_all_patterns()

  for _, p in ipairs(patterns) do
    -- Find the last occurrence of this pattern before cursor
    local pat_escaped = vim.pesc(p.pattern)
    local start = nil
    local search_from = 1
    while true do
      local s = before:find(pat_escaped, search_from, true)
      if not s then break end
      start = s
      search_from = s + 1
    end

    if start then
      local after_pat = start + #p.pattern - 1
      -- Check no closing char between pattern and cursor
      local between = before:sub(after_pat + 1)
      if not between:find(vim.pesc(p.closing), 1, true) then
        local partial = between
        return partial, after_pat
      end
    end
  end

  return nil, nil
end

-----------------------------------------------------------------------------
-- nvim-cmp source
-----------------------------------------------------------------------------

local source = {}

function source.new()
  return setmetatable({}, { __index = source })
end

function source:get_trigger_characters()
  return { "{", "(", "[" }
end

function source:is_available()
  return vim.bo.filetype == "forester"
end

function source:complete(params, callback)
  local line = params.context.cursor_before_line
  local col = params.context.cursor.col

  local partial, start_col = find_link_context(line, col)
  if not partial then
    callback({ items = {}, isIncomplete = false })
    return
  end

  -- Ensure cache is populated
  if not forest_cache then
    refresh_cache()
  end

  if not forest_cache then
    callback({ items = {}, isIncomplete = false })
    return
  end

  local show_id = config.current.completion.show_id
  local items = {}

  for tree_id, info in pairs(forest_cache) do
    local label = tree_id
    local detail = info.title or ""

    if show_id and info.title then
      label = tree_id .. " — " .. info.title
    end

    table.insert(items, {
      label = tree_id,
      detail = detail,
      filterText = tree_id .. " " .. (info.title or ""),
      sortText = tree_id,
      documentation = info.taxon and (info.taxon .. ": " .. (info.title or tree_id)) or nil,
    })
  end

  callback({ items = items, isIncomplete = false })
end

function source:get_keyword_pattern()
  return [[\k\+]]
end

--- Register with nvim-cmp if available.
function M.setup()
  local has_cmp, cmp = pcall(require, "cmp")
  if has_cmp then
    cmp.register_source("forester", source.new())
  end
end

--- Invalidate the cached forest data.
function M.invalidate_cache()
  forest_cache = nil
end

return M
