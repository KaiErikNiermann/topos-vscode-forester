--- Port of subtree-auto-id-core.ts to Lua.
---
--- Generates sequential base36 IDs for \subtree[] blocks, avoiding
--- collisions with existing tree file names and subtree references.

local config = require("forester.config")

local M = {}

-- Uppercase, byte-for-byte forester's own alphabet (`BaseN.Base36` in
-- lib/prelude/BaseN.ml). Emitting lowercase produces `009c` beside forester's
-- `009C.tree`: two trees to the index, one slot to every allocator, and a
-- case_folded_address warning at build time.
local BASE36_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
local BASE36_WIDTH = 4
local MAX_VALUE = 36 ^ 4 - 1

--- Case-folded key for "is this slot taken?" tests. Folds up, so the key of an
--- ID we emit is the ID itself.
---@param stem string
---@return string
function M.canonical_key(stem)
  return stem:upper()
end

--- Check if a string is a canonical 4-char base36 stem. Accepts either case: a
--- forest can already hold stems in both, and they name the same slot.
---@param id string
---@return boolean
function M.is_canonical(id)
  return #id == 4 and id:match("^[0-9a-zA-Z]+$") ~= nil
end

--- Convert a non-negative integer to a zero-padded base36 string.
---@param value integer
---@return string
function M.to_base36(value)
  if value == 0 then
    return ("0"):rep(BASE36_WIDTH)
  end

  local digits = {}
  local rem = value
  while rem > 0 do
    local idx = (rem % 36) + 1 -- Lua is 1-indexed
    table.insert(digits, 1, BASE36_DIGITS:sub(idx, idx))
    rem = math.floor(rem / 36)
  end

  local encoded = table.concat(digits)
  if #encoded > BASE36_WIDTH then
    error("Value exceeds allotted width for base-36 encoding.")
  end
  return ("0"):rep(BASE36_WIDTH - #encoded) .. encoded
end

--- Parse a 4-char base36 stem to its integer value, or nil if invalid.
---@param stem string
---@return integer|nil
function M.from_base36(stem)
  if not M.is_canonical(stem) then return nil end

  local value = 0
  local folded = M.canonical_key(stem)
  for i = 1, #folded do
    local ch = folded:sub(i, i)
    local digit = BASE36_DIGITS:find(ch, 1, true)
    if not digit then return nil end
    value = value * 36 + (digit - 1)
  end
  return value
end

--- Extract subtree reference IDs from file content.
---@param content string
---@return string[]
function M.extract_subtree_ids(content)
  local ids = {}
  for id in content:gmatch("\\subtree%s*%[([^%]]+)%]") do
    local trimmed = vim.trim(id)
    if #trimmed > 0 then
      table.insert(ids, trimmed)
    end
  end
  return ids
end

--- Compute the next available canonical base36 ID.
---@param known_ids string[] Existing IDs to avoid (tree filenames + subtree refs)
---@return string id The next available ID
function M.next_id(known_ids)
  local known_set = {}
  local max_val = -1

  for _, id in ipairs(known_ids) do
    local val = M.from_base36(id)
    if val then
      known_set[M.canonical_key(id)] = true
      if val > max_val then max_val = val end
    end
  end

  local start = max_val < 0 and 0 or (max_val + 1)
  for candidate = start, MAX_VALUE do
    local candidate_id = M.to_base36(candidate)
    if not known_set[M.canonical_key(candidate_id)] then
      return candidate_id
    end
  end

  error("No available canonical 4-char base36 subtree IDs remain.")
end

--- Collect all known IDs from the forest and current buffer.
---@return string[]
local function collect_known_ids()
  local ids = {}
  local root = vim.fs.root(0, config.current.lsp.root_markers)
  if not root then return ids end

  -- Collect IDs from tree filenames
  local tree_files = vim.fn.glob(root .. "/**/*.tree", false, true)
  for _, fpath in ipairs(tree_files) do
    local stem = vim.fn.fnamemodify(fpath, ":t:r")
    table.insert(ids, stem)
  end

  -- Collect subtree reference IDs from all open forester buffers
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].filetype == "forester" then
      local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
      local content = table.concat(lines, "\n")
      for _, id in ipairs(M.extract_subtree_ids(content)) do
        table.insert(ids, id)
      end
    end
  end

  return ids
end

--- Generate and insert a \subtree[id]{} block at the cursor.
function M.insert_subtree()
  local known = collect_known_ids()
  local id = M.next_id(known)

  local row = vim.api.nvim_win_get_cursor(0)[1]
  vim.api.nvim_buf_set_lines(0, row - 1, row - 1, false, {
    "\\subtree[" .. id .. "]{",
    "  \\title{}",
    "}",
  })

  -- Place cursor inside \title{}
  vim.api.nvim_win_set_cursor(0, { row + 1, 9 })
  vim.notify("[forester] Inserted subtree " .. id, vim.log.levels.INFO)
end

return M
