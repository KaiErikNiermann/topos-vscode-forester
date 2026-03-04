--- Forester tree management commands for Neovim.
---
--- Ports the core operations from the VSCode extension's edit-forest.ts:
---   :ForesterNew           – create a new tree via `forester new`
---   :ForesterRename        – edit title/taxon of the current tree
---   :ForesterTranscludeNew – create a new tree and insert \transclude{id} at cursor

local config = require("forester.config")

local M = {}

-----------------------------------------------------------------------------
-- Helpers
-----------------------------------------------------------------------------

--- Find the project root containing forest.toml by walking up from cwd.
---@return string|nil
local function find_root()
  local markers = config.current.lsp.root_markers
  return vim.fs.root(0, markers)
end

--- Read and parse forest.toml, returning a table (or nil on failure).
---@param root string
---@return table|nil
local function read_forest_toml(root)
  local path = root .. "/forest.toml"
  local f = io.open(path, "r")
  if not f then
    return nil
  end
  local content = f:read("*a")
  f:close()

  -- Minimal TOML parsing: extract prefixes and trees arrays.
  -- For full TOML we'd need a library; this covers the common cases.
  local tbl = { forest = {} }

  -- Parse prefixes = ["a", "b"]
  local prefixes_str = content:match('prefixes%s*=%s*%[(.-)%]')
  if prefixes_str then
    tbl.forest.prefixes = {}
    for p in prefixes_str:gmatch('"([^"]+)"') do
      table.insert(tbl.forest.prefixes, p)
    end
  end

  -- Parse trees = ["trees"]
  local trees_str = content:match('trees%s*=%s*%[(.-)%]')
  if trees_str then
    tbl.forest.trees = {}
    for t in trees_str:gmatch('"([^"]+)"') do
      table.insert(tbl.forest.trees, t)
    end
  end

  return tbl
end

--- Run the forester CLI and return stdout (trimmed), or nil on error.
---@param args string[]
---@param root string
---@return string|nil
local function forester_cmd(args, root)
  local cmd = vim.list_extend({ config.current.forester_path }, args)
  local result = vim.system(cmd, { cwd = root, text = true }):wait()
  if result.code ~= 0 then
    vim.notify(
      "[forester] command failed: " .. (result.stderr or "unknown error"),
      vim.log.levels.ERROR
    )
    return nil
  end
  return vim.trim(result.stdout or "")
end

--- Taxon abbreviation map (mirrors utils.ts TAXON_MAP / ALTERNATIVE_ABBREVIATIONS).
local ABBREV_TO_FULL = {
  thm = "theorem",
  def = "definition",
  defn = "definition",
  prop = "proposition",
  lem = "lemma",
  cor = "corollary",
  ex = "example",
  eg = "example",
  rem = "remark",
  rmk = "remark",
  pf = "proof",
  sec = "section",
  ch = "chapter",
  note = "note",
  conj = "conjecture",
  ax = "axiom",
  const = "construction",
  obs = "observation",
  exer = "exercise",
  prob = "problem",
  soln = "solution",
  alg = "algorithm",
  disc = "discussion",
  warn = "warning",
  nb = "nota-bene",
  app = "appendix",
  expl = "explication",
  fig = "figure",
}

--- Full taxon names that are also valid as-is.
local FULL_TAXON_NAMES = {}
for _, full in pairs(ABBREV_TO_FULL) do
  FULL_TAXON_NAMES[full] = true
end

--- Parse "taxon: title" input. Returns { taxon = string|nil, title = string }.
---@param input string
---@return { taxon: string|nil, title: string }
local function parse_taxon_and_title(input)
  local colon = input:find(":")
  if colon and colon > 1 and colon < 30 then
    local potential = vim.trim(input:sub(1, colon - 1)):lower()
    local title = vim.trim(input:sub(colon + 1))

    if ABBREV_TO_FULL[potential] then
      return { taxon = ABBREV_TO_FULL[potential], title = title }
    end
    if FULL_TAXON_NAMES[potential] then
      return { taxon = potential, title = title }
    end
    -- Accept any short lowercase word as custom taxon
    if potential:match("^[a-z%-]+$") and #potential <= 20 then
      return { taxon = potential, title = title }
    end
  end
  return { title = input }
end

--- Prompt the user for a prefix, using forest.toml prefixes if available.
---@param root string
---@param callback fun(prefix: string|nil)
local function get_prefix(root, callback)
  local toml = read_forest_toml(root)
  local prefixes = toml and toml.forest and toml.forest.prefixes

  if prefixes and #prefixes > 0 then
    vim.ui.select(prefixes, { prompt = "Choose prefix:" }, function(choice)
      if choice then
        callback(choice)
      else
        -- Fallback to manual input if they escape select
        vim.ui.input({ prompt = "Enter prefix: " }, callback)
      end
    end)
  else
    vim.ui.input({ prompt = "Enter prefix: " }, callback)
  end
end

--- Get the trees directory for new files.
---@param root string
---@return string
local function get_trees_dir(root)
  local toml = read_forest_toml(root)
  local dirs = toml and toml.forest and toml.forest.trees
  if dirs and #dirs > 0 then
    return root .. "/" .. dirs[1]
  end
  return root .. "/trees"
end

-----------------------------------------------------------------------------
-- Commands
-----------------------------------------------------------------------------

--- Create a new tree. Prompts for prefix and title, invokes `forester new`.
function M.new_tree()
  local root = find_root()
  if not root then
    vim.notify("[forester] No forest.toml found in parent directories", vim.log.levels.ERROR)
    return
  end

  get_prefix(root, function(prefix)
    if not prefix or prefix == "" then
      return
    end

    vim.ui.input({
      prompt = "Title (e.g. 'thm: My Theorem'): ",
    }, function(input)
      if not input or vim.trim(input) == "" then
        return
      end

      local parsed = parse_taxon_and_title(input)
      if not parsed.title or vim.trim(parsed.title) == "" then
        vim.notify("[forester] Title cannot be empty", vim.log.levels.WARN)
        return
      end

      -- Determine destination directory
      local trees_dir = get_trees_dir(root)
      local prefix_dir = trees_dir .. "/" .. prefix
      local dest = vim.fn.isdirectory(prefix_dir) == 1 and prefix_dir or trees_dir

      -- Create the tree
      local new_path = forester_cmd({
        "new",
        "--dest", dest,
        "--prefix", prefix,
      }, root)

      if not new_path then
        return
      end

      -- Read the generated file and append metadata
      local f = io.open(new_path, "r")
      local content = f and f:read("*a") or ""
      if f then f:close() end

      local date = os.date("!%Y-%m-%dT%H:%M:%SZ")
      if not content:find("\\date") then
        content = content .. "\\date{" .. date .. "}\n"
      end
      if parsed.taxon and not content:find("\\taxon") then
        content = content .. "\\taxon{" .. parsed.taxon .. "}\n"
      end
      if not content:find("\\title") then
        content = content .. "\\title{" .. parsed.title .. "}\n\n"
      end

      -- Write back
      local fw = io.open(new_path, "w")
      if fw then
        fw:write(content)
        fw:close()
      end

      -- Open the new file
      vim.cmd.edit(new_path)

      local tree_id = vim.fn.fnamemodify(new_path, ":t:r")
      vim.notify("[forester] Created tree " .. tree_id, vim.log.levels.INFO)
    end)
  end)
end

--- Rename the current tree's title/taxon by editing the file directly.
function M.rename_tree()
  local buf = vim.api.nvim_get_current_buf()
  local filepath = vim.api.nvim_buf_get_name(buf)

  if not filepath:match("%.tree$") then
    vim.notify("[forester] Current file is not a .tree file", vim.log.levels.WARN)
    return
  end

  -- Read current title/taxon from the buffer
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local current_title = ""
  local current_taxon = ""
  local title_line_idx = nil
  local taxon_line_idx = nil

  for i, line in ipairs(lines) do
    local t = line:match("^\\title{(.*)}$")
    if t then
      current_title = t
      title_line_idx = i
    end
    local tx = line:match("^\\taxon{(.*)}$")
    if tx then
      current_taxon = tx
      taxon_line_idx = i
    end
  end

  local default_value = current_taxon ~= ""
    and (current_taxon .. ": " .. current_title)
    or current_title

  vim.ui.input({
    prompt = "New title (taxon: title): ",
    default = default_value,
  }, function(input)
    if not input or vim.trim(input) == "" then
      return
    end

    local parsed = parse_taxon_and_title(input)
    if not parsed.title or vim.trim(parsed.title) == "" then
      vim.notify("[forester] Title cannot be empty", vim.log.levels.WARN)
      return
    end

    -- Update title line
    if title_line_idx then
      vim.api.nvim_buf_set_lines(
        buf, title_line_idx - 1, title_line_idx, false,
        { "\\title{" .. parsed.title .. "}" }
      )
    else
      -- Insert title at top
      vim.api.nvim_buf_set_lines(buf, 0, 0, false, { "\\title{" .. parsed.title .. "}" })
      -- Adjust indices
      if taxon_line_idx then taxon_line_idx = taxon_line_idx + 1 end
    end

    -- Update taxon line
    if parsed.taxon then
      if taxon_line_idx then
        vim.api.nvim_buf_set_lines(
          buf, taxon_line_idx - 1, taxon_line_idx, false,
          { "\\taxon{" .. parsed.taxon .. "}" }
        )
      else
        -- Insert taxon after title
        local insert_at = title_line_idx or 1
        vim.api.nvim_buf_set_lines(
          buf, insert_at, insert_at, false,
          { "\\taxon{" .. parsed.taxon .. "}" }
        )
      end
    else
      -- Remove taxon if present and user didn't specify one
      if taxon_line_idx then
        vim.api.nvim_buf_set_lines(buf, taxon_line_idx - 1, taxon_line_idx, false, {})
      end
    end

    local msg = parsed.taxon
      and ("Renamed to \"" .. parsed.taxon .. ": " .. parsed.title .. "\"")
      or ("Renamed to \"" .. parsed.title .. "\"")
    vim.notify("[forester] " .. msg, vim.log.levels.INFO)
  end)
end

--- Create a new tree and insert \transclude{id} at the current cursor position.
function M.transclude_new()
  local root = find_root()
  if not root then
    vim.notify("[forester] No forest.toml found in parent directories", vim.log.levels.ERROR)
    return
  end

  local source_buf = vim.api.nvim_get_current_buf()
  local source_file = vim.api.nvim_buf_get_name(source_buf)

  if not source_file:match("%.tree$") then
    vim.notify("[forester] Current file is not a .tree file", vim.log.levels.WARN)
    return
  end

  local cursor = vim.api.nvim_win_get_cursor(0)

  get_prefix(root, function(prefix)
    if not prefix or prefix == "" then
      return
    end

    vim.ui.input({
      prompt = "Title for new tree (taxon: title): ",
    }, function(input)
      if not input or vim.trim(input) == "" then
        return
      end

      local parsed = parse_taxon_and_title(input)
      if not parsed.title or vim.trim(parsed.title) == "" then
        vim.notify("[forester] Title cannot be empty", vim.log.levels.WARN)
        return
      end

      local trees_dir = get_trees_dir(root)
      local prefix_dir = trees_dir .. "/" .. prefix
      local dest = vim.fn.isdirectory(prefix_dir) == 1 and prefix_dir or trees_dir

      local new_path = forester_cmd({
        "new",
        "--dest", dest,
        "--prefix", prefix,
      }, root)

      if not new_path then
        return
      end

      -- Populate the new tree file
      local f = io.open(new_path, "r")
      local content = f and f:read("*a") or ""
      if f then f:close() end

      local date = os.date("!%Y-%m-%dT%H:%M:%SZ")
      if not content:find("\\date") then
        content = content .. "\\date{" .. date .. "}\n"
      end
      if parsed.taxon and not content:find("\\taxon") then
        content = content .. "\\taxon{" .. parsed.taxon .. "}\n"
      end
      if not content:find("\\title") then
        content = content .. "\\title{" .. parsed.title .. "}\n\n"
      end

      local fw = io.open(new_path, "w")
      if fw then
        fw:write(content)
        fw:close()
      end

      -- Insert \transclude{tree-id} at the original cursor position
      local tree_id = vim.fn.fnamemodify(new_path, ":t:r")
      local transclude_line = "\\transclude{" .. tree_id .. "}"
      vim.api.nvim_buf_set_lines(
        source_buf, cursor[1] - 1, cursor[1] - 1, false,
        { transclude_line }
      )

      -- Open the new tree in a split
      vim.cmd("split " .. vim.fn.fnameescape(new_path))

      vim.notify("[forester] Created and transcluded " .. tree_id, vim.log.levels.INFO)
    end)
  end)
end

return M
