## Summary

<!-- Brief description of the changes -->

## Checklist

- [ ] `pnpm run check-types` passes
- [ ] `pnpm run lint` passes
- [ ] Relevant tests added/updated and passing
- [ ] If grammar changed: verified both Langium and tree-sitter grammars are in sync (run `pnpm run test:corpus`)
- [ ] If Neovim plugin changed: `luacheck editors/neovim/lua/ editors/neovim/plugin/ --globals vim` passes
