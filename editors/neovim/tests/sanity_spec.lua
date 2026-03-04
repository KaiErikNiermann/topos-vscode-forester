-- Headless Neovim sanity tests for forester.nvim
--
-- Run with:
--   nvim --headless -u editors/neovim/tests/minimal_init.lua -l editors/neovim/tests/sanity_spec.lua

local passed = 0
local failed = 0
local errors = {}

local function test(name, fn)
  local ok, err = pcall(fn)
  if ok then
    passed = passed + 1
    io.write("  PASS  " .. name .. "\n")
  else
    failed = failed + 1
    table.insert(errors, { name = name, err = err })
    io.write("  FAIL  " .. name .. ": " .. tostring(err) .. "\n")
  end
end

local function assert_eq(got, expected, msg)
  if got ~= expected then
    error((msg or "") .. " expected " .. vim.inspect(expected) .. ", got " .. vim.inspect(got))
  end
end

local function assert_truthy(val, msg)
  if not val then
    error(msg or "expected truthy value, got " .. vim.inspect(val))
  end
end

-- ============================================
io.write("\n=== Filetype detection ===\n")
-- ============================================

test("extension .tree maps to filetype 'forester'", function()
  assert_eq(vim.filetype.match({ filename = "foo.tree" }), "forester")
end)

test("extension .tree in subdirectory", function()
  assert_eq(vim.filetype.match({ filename = "trees/abc-0001.tree" }), "forester")
end)

-- ============================================
io.write("\n=== Module loading ===\n")
-- ============================================

test("require('forester') succeeds", function()
  local m = require("forester")
  assert_truthy(m, "module is nil")
  assert_truthy(m.setup, "setup function missing")
end)

test("require('forester.config') succeeds", function()
  local m = require("forester.config")
  assert_truthy(m.defaults, "defaults missing")
  assert_truthy(m.apply, "apply function missing")
end)

test("require('forester.lsp') succeeds", function()
  local m = require("forester.lsp")
  assert_truthy(m.find_server, "find_server missing")
  assert_truthy(m.setup, "setup function missing")
end)

test("require('forester.commands') succeeds", function()
  local m = require("forester.commands")
  assert_truthy(m.new_tree, "new_tree missing")
  assert_truthy(m.rename_tree, "rename_tree missing")
  assert_truthy(m.transclude_new, "transclude_new missing")
end)

test("require('forester.decorations') succeeds", function()
  local m = require("forester.decorations")
  assert_truthy(m.setup, "setup missing")
  assert_truthy(m.update, "update missing")
end)

test("require('forester.subtree_auto_id') succeeds", function()
  local m = require("forester.subtree_auto_id")
  assert_truthy(m.to_base36, "to_base36 missing")
  assert_truthy(m.from_base36, "from_base36 missing")
  assert_truthy(m.next_id, "next_id missing")
end)

test("require('forester.statusline') succeeds", function()
  local m = require("forester.statusline")
  assert_truthy(m.setup, "setup missing")
end)

test("require('forester.cmp') succeeds", function()
  local m = require("forester.cmp")
  assert_truthy(m.setup, "setup missing")
end)

-- ============================================
io.write("\n=== Config ===\n")
-- ============================================

test("config defaults are sane", function()
  local cfg = require("forester.config")
  assert_eq(cfg.defaults.lsp.enabled, true)
  assert_eq(cfg.defaults.forester_path, "forester")
  assert_eq(cfg.defaults.decorations.enabled, true)
end)

test("config.apply merges user options", function()
  local cfg = require("forester.config")
  cfg.apply({ forester_path = "/usr/bin/forester", lsp = { enabled = false } })
  assert_eq(cfg.current.forester_path, "/usr/bin/forester")
  assert_eq(cfg.current.lsp.enabled, false)
  -- Other defaults preserved
  assert_eq(cfg.current.decorations.enabled, true)
  -- Reset
  cfg.apply({})
end)

-- ============================================
io.write("\n=== Base36 encoding ===\n")
-- ============================================

test("to_base36(0) = '0000'", function()
  local m = require("forester.subtree_auto_id")
  assert_eq(m.to_base36(0), "0000")
end)

test("to_base36(1) = '0001'", function()
  local m = require("forester.subtree_auto_id")
  assert_eq(m.to_base36(1), "0001")
end)

test("to_base36(36) = '0010'", function()
  local m = require("forester.subtree_auto_id")
  assert_eq(m.to_base36(36), "0010")
end)

test("to_base36(1679615) = 'zzzz'", function()
  local m = require("forester.subtree_auto_id")
  assert_eq(m.to_base36(36 ^ 4 - 1), "zzzz")
end)

test("from_base36 round-trips", function()
  local m = require("forester.subtree_auto_id")
  for _, v in ipairs({ 0, 1, 35, 36, 100, 1295, 46655, 1679615 }) do
    assert_eq(m.from_base36(m.to_base36(v)), v, "round-trip failed for " .. v)
  end
end)

test("from_base36 rejects invalid input", function()
  local m = require("forester.subtree_auto_id")
  assert_eq(m.from_base36(""), nil)
  assert_eq(m.from_base36("abc"), nil)    -- too short
  assert_eq(m.from_base36("ABCD"), nil)   -- uppercase
  assert_eq(m.from_base36("ab-d"), nil)   -- invalid char
end)

test("is_canonical validates correctly", function()
  local m = require("forester.subtree_auto_id")
  assert_eq(m.is_canonical("0000"), true)
  assert_eq(m.is_canonical("zzzz"), true)
  assert_eq(m.is_canonical("ab3f"), true)
  assert_eq(m.is_canonical("ABC"), false)
  assert_eq(m.is_canonical("abcde"), false)
end)

test("extract_subtree_ids finds IDs in content", function()
  local m = require("forester.subtree_auto_id")
  local content = [[\subtree[ab01]{ \title{Foo} } some text \subtree[cd02]{ \title{Bar} }]]
  local ids = m.extract_subtree_ids(content)
  assert_eq(#ids, 2)
  assert_eq(ids[1], "ab01")
  assert_eq(ids[2], "cd02")
end)

test("next_id avoids collisions", function()
  local m = require("forester.subtree_auto_id")
  assert_eq(m.next_id({}), "0000")
  assert_eq(m.next_id({ "0000" }), "0001")
  assert_eq(m.next_id({ "0000", "0001", "0002" }), "0003")
  -- Gaps
  assert_eq(m.next_id({ "0000", "0002" }), "0003")
end)

-- ============================================
io.write("\n=== Plugin guard ===\n")
-- ============================================

test("plugin/forester.lua sets loaded guard", function()
  -- Source the plugin file
  local plugin_file = vim.api.nvim_get_runtime_file("plugin/forester.lua", false)[1]
  assert_truthy(plugin_file, "plugin/forester.lua not on rtp")
  vim.cmd.source(plugin_file)
  assert_eq(vim.g.loaded_forester, true)
end)

test("user commands are registered after sourcing plugin", function()
  local cmds = vim.api.nvim_get_commands({})
  assert_truthy(cmds.ForesterNew, "ForesterNew not registered")
  assert_truthy(cmds.ForesterRename, "ForesterRename not registered")
  assert_truthy(cmds.ForesterTranscludeNew, "ForesterTranscludeNew not registered")
  assert_truthy(cmds.ForesterSubtreeId, "ForesterSubtreeId not registered")
end)

-- ============================================
io.write("\n=== Query files ===\n")
-- ============================================

test("highlights.scm is on rtp", function()
  local f = vim.api.nvim_get_runtime_file("queries/forester/highlights.scm", false)
  assert_truthy(f[1], "highlights.scm not found")
end)

test("indents.scm is on rtp", function()
  local f = vim.api.nvim_get_runtime_file("queries/forester/indents.scm", false)
  assert_truthy(f[1], "indents.scm not found")
end)

test("folds.scm is on rtp", function()
  local f = vim.api.nvim_get_runtime_file("queries/forester/folds.scm", false)
  assert_truthy(f[1], "folds.scm not found")
end)

test("textobjects.scm is on rtp", function()
  local f = vim.api.nvim_get_runtime_file("queries/forester/textobjects.scm", false)
  assert_truthy(f[1], "textobjects.scm not found")
end)

test("injections.scm is on rtp", function()
  local f = vim.api.nvim_get_runtime_file("queries/forester/injections.scm", false)
  assert_truthy(f[1], "injections.scm not found")
end)

-- ============================================
-- Summary
-- ============================================
io.write("\n" .. string.rep("=", 40) .. "\n")
io.write(string.format("%d passed, %d failed\n", passed, failed))

if #errors > 0 then
  io.write("\nFailures:\n")
  for _, e in ipairs(errors) do
    io.write("  - " .. e.name .. ": " .. tostring(e.err) .. "\n")
  end
end

io.write("\n")
if failed > 0 then
  vim.cmd("cquit 1")
else
  vim.cmd("quit")
end
