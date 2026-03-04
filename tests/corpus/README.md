# Shared Grammar Test Corpus

This directory contains `.tree` fixture files covering all Forester syntax
constructs. Both the **Langium grammar** (used by the LSP server) and the
**tree-sitter-forester grammar** (used by Neovim/Helix) should parse these
files identically.

## Purpose

1. **Conformance testing**: CI runs both parsers against every fixture and
   verifies they produce structurally equivalent parse trees.
2. **Drift prevention**: When either grammar changes, the shared corpus
   catches regressions in the other.
3. **Documentation**: Each fixture file is annotated with comments explaining
   which syntax constructs it exercises.

## Fixture Naming Convention

Files are named `NNN-description.tree` where `NNN` is a zero-padded sequence
number and `description` summarizes the constructs covered.

## Terminal Regex Reference

These are the canonical patterns shared across grammars. Both Langium and
tree-sitter should match these exactly.

| Terminal         | Regex                                              | Notes                           |
|------------------|----------------------------------------------------|---------------------------------|
| `COMMAND_NAME`   | `\\[A-Za-z0-9\-\/\?\*]+`                          | Backslash + name chars          |
| `XML_COMMAND`    | `\\<[A-Za-z][A-Za-z0-9-]*(?::[A-Za-z][A-Za-z0-9-]*)?>`| XML-style `\<tag>`, `\<ns:tag>` |
| `DECL_XMLNS`     | `\\xmlns:[a-zA-Z]+`                               | Namespace declaration           |
| `ESCAPE`         | `\\[\\{}\[\]#%, "\x60;_\|]`                       | Special char escapes            |
| `WIKI_LINK`      | `\[\[[^\]\n]*\]\]`                                 | `[[tree-id]]`                   |
| `VERBATIM_BLOCK` | `` ```[\s\S]*?``` ``                               | Code fence (non-greedy)         |
| `HASH_DISPLAY`   | `##{`                                              | Display math opener             |
| `HASH_INLINE`    | `#{`                                               | Inline math opener              |
| `TEXT`           | `[^\\{}\[\]()\n\t %#\x60]+`                       | Non-special characters          |
| `BARE_HASH`      | `#(?!#?{)`                                         | Hash not starting math          |
| `BARE_BACKTICK`  | `` `(?!``) ``                                      | Backtick not starting fence     |
| `COMMENT`        | `%[^\n]*`                                          | Line comment                    |
| `WS`             | `[ \t]+`                                           | Horizontal whitespace (hidden)  |
| `NL`             | `\r?\n`                                            | Newline (hidden)                |

## Adding New Fixtures

When adding syntax to either grammar:

1. Add a `.tree` file to this directory exercising the new construct.
2. Ensure both Langium and tree-sitter tests pass against it.
3. Update the terminal regex table above if terminals changed.
