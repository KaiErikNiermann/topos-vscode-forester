local M = {}

function M.check()
  vim.health.start("forester.nvim")

  -- Check forester CLI
  local config = require("forester.config").current
  local forester_path = config.forester_path
  if vim.fn.executable(forester_path) == 1 then
    local version = vim.fn.system({ forester_path, "--version" }):gsub("%s+$", "")
    vim.health.ok("forester CLI found: " .. version)
  else
    vim.health.warn("forester CLI not found at '" .. forester_path .. "'")
  end

  -- Check node
  if vim.fn.executable("node") == 1 then
    local version = vim.fn.system({ "node", "--version" }):gsub("%s+$", "")
    vim.health.ok("node found: " .. version)
  else
    vim.health.error("node not found (required for language server)")
  end

  -- Check language server
  local lsp = require("forester.lsp")
  local cmd = config.lsp.cmd or lsp.find_server()
  if cmd then
    vim.health.ok("Language server: " .. table.concat(cmd, " "))
  else
    vim.health.warn("Language server not found. Install with: npm install -g forest-keeper")
  end

  -- Check forest.toml
  local root = vim.fs.find("forest.toml", { upward = true, type = "file" })
  if #root > 0 then
    vim.health.ok("forest.toml found: " .. root[1])
  else
    vim.health.info("No forest.toml found in current directory tree")
  end
end

return M
