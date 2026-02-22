# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a VSCode extension (`topos-vscode-forester`) that provides language support for [Forester](https://www.jonmsterling.com/jms-005P.xml), a tool for managing forests of evergreen notes. The extension was forked from `vscode-forester` and extended by the Topos Institute.

## Commands

```bash
# Install dependencies
npm install

# Compile (type-check + bundle via esbuild)
npm run compile

# Watch mode for development
npm run watch

# Type-check only (no build)
npm run check-types

# Lint
npm run lint

# Run individual test suites (no test runner; tests are standalone scripts)
npm run test:formatter          # src/formatter.test.ts
npm run test:latex-hover        # src/latex-hover-core.test.ts
npm run test:tag-closure-inlay  # src/tag-closure-inlay-core.test.ts
npm run test:subtree-auto-id    # src/subtree-auto-id.test.ts
npm run test:language-server    # requires compile first

# Package the extension
npm run package

# Package and install locally in VSCode
npm run install-local
```

The build uses esbuild (configured in `esbuild.js`) to bundle `src/extension.ts` → `out/extension.js`. The `vscode` module is always external.

## Architecture

### Entry Point
`src/extension.ts` — `activate()` wires up all providers and commands; `deactivate()` cleans up the forester server.

### Core Modules

| File | Responsibility |
|------|---------------|
| `src/get-forest.ts` | Wrapper around the `forester` CLI executable. Manages a global cache (`mostRecentQueryResult`) of the forest data, file watching, and a status bar item showing forest validity. The `getForest()` function is the main API for getting tree data. |
| `src/edit-forest.ts` | Commands for creating and renaming trees by invoking `forester new` and editing file content. |
| `src/formatter-core.ts` | **Pure** formatting logic (no VSCode dependencies): tokenizer and formatter for `.tree` files. Used by both the extension and standalone tests. |
| `src/formatter.ts` | VSCode `DocumentFormattingEditProvider` and `DocumentRangeFormattingEditProvider` that wrap `formatter-core.ts`. |
| `src/formatter-config.ts` | Manages `forester.formatter.ignoredCommands` config, macro scanning (`forester.scanMacros` command), and an ignored-commands cache. |
| `src/languageToolIntegration.ts` | Bridges VSCode's LTeX/LanguageTool extension to filter false positives in `.tree` files; patches diagnostics and auto-populates `ltex.dictionary`. |
| `src/speedfix.ts` | `forester.speedFix` command for rapid spelling/grammar corrections. |
| `src/forestStructureView.ts` | WebView-based tree structure panel in the Explorer sidebar. |
| `src/transclude-decorations.ts` | Inline decoration provider that shows tree titles/taxons beside `\transclude{}`, `\import{}`, `\export{}` commands. |
| `src/latex-hover-core.ts` / `src/latex-hover.ts` | LaTeX preview on hover for `#{...}`, `##{...}`, `\tex{...}{...}`. Core is pure; the `.ts` wrapper adds VSCode integration. |
| `src/tag-closure-inlay-core.ts` / `src/tag-closure-inlay.ts` | Inlay hints showing the opening command name after closing braces (e.g., `} ul`). |
| `src/subtree-auto-id-core.ts` / `src/subtree-auto-id.ts` | Auto-assigns sequential base36 IDs to new `\subtree{}` blocks. |
| `src/link-aliases-config.ts` | Configurable link pattern aliases via `.forester-links.json`, used to extend definition navigation and completions beyond the built-in patterns. |
| `src/utils.ts` | Shared utilities: workspace root resolution, template discovery. |

### Data Flow Pattern
The `get-forest.ts` module calls the `forester` CLI (path from `forester.path` setting, config from `forester.config`) and caches the resulting JSON. Most features that need tree metadata call `getForest()` or `getTree()`. The completion provider uses `fastReturnStale: true` to avoid blocking on re-fetches.

### Testing Pattern
There is no Jest/Mocha setup. Test files (`*.test.ts`) are standalone scripts run via `npx tsx`. Each test file has its own minimal test framework. The `test/stubs/` directory provides stub modules for VSCode APIs in the language-server test.

### Grammar & Language Configuration
- `resources/language/forester.tmGrammar.json` — TextMate grammar for `.tree` syntax highlighting
- `resources/language/language-configuration.json` — VSCode language config (bracket pairs, comments, etc.)

### Key Formatting Concepts
The formatter in `formatter-core.ts` uses a tokenizer that recognizes: commands (`\name`), brace/bracket/paren delimiters, verbatim blocks (`\startverb`/`\stopverb`), math (`#{}`, `##{}`) and ignored/preserved blocks. `TOP_LEVEL_COMMANDS`, `BLOCK_COMMANDS`, and user-configured `ignoredCommands` control how content is reformatted vs. preserved.

## Model selection

**Use `claude-haiku-4-5-20251001` for mechanical, deterministic tasks:**
- Fixing ESLint errors reported by `npm run lint`
- Applying `npm run lint:fix` and then cleaning up remaining auto-fixable issues
- Correcting TypeScript type errors flagged by `npm run check-types`
- Renaming symbols, reordering imports, adjusting semicolons/formatting

**Use the current (larger) model for:**
- Architectural decisions, new features, complex refactors
- Debugging subtle runtime behaviour
- Anything requiring understanding of the Langium or VSCode API contracts

### Lint workflow
```bash
npm run lint:fix          # auto-fix deterministic issues (no AI needed)
npm run lint              # show remaining issues

# For remaining non-auto-fixable issues, prefer haiku:
# claude --model claude-haiku-4-5-20251001 -p "fix lint errors in src/foo.ts"
```

The post-edit Claude hook (`.claude/hooks/post-edit.sh`) runs `eslint --fix` automatically after every file edit and prints any remaining issues with a haiku invocation hint.
