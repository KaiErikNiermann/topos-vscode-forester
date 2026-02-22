# Forester Language Specification

A comprehensive, language-agnostic specification for implementing Forester markup language parsing and processing.

**Version:** 5.0
**Last Updated:** December 2024

---

## Table of Contents

1. [Overview](#1-overview)
2. [Lexical Structure](#2-lexical-structure)
3. [Abstract Syntax Tree](#3-abstract-syntax-tree)
4. [Grammar](#4-grammar)
5. [Evaluation Model](#5-evaluation-model)
6. [Built-in Commands](#6-built-in-commands)
7. [Object System](#7-object-system)
8. [Module System](#8-module-system)
9. [Datalog Query System](#9-datalog-query-system)
10. [LaTeX Rendering Pipeline](#10-latex-rendering-pipeline)
11. [XML Output Format](#11-xml-output-format)
12. [Theme Integration](#12-theme-integration)
13. [Configuration](#13-configuration)
14. [File Format](#14-file-format)

---

## 1. Overview

Forester is a markup language for creating interconnected documents ("forests"). It features:

- **TeX-like syntax** with backslash commands
- **Macro system** with lexical scoping
- **Object-oriented features** (prototypal inheritance)
- **Datalog integration** for querying document relationships
- **LaTeX rendering** for mathematical content
- **XML/XSLT output** with customizable themes

### Compilation Phases

```
Source (.tree files)
    ↓ Lexing
Tokens
    ↓ Parsing
Code AST (syntactic representation)
    ↓ Expansion (macro expansion, name resolution)
Syn AST (semantic representation)
    ↓ Evaluation
Values / Content
    ↓ Rendering
XML Output + Assets
```

---

## 2. Lexical Structure

### 2.1 Character Classes

```
alpha       = [a-zA-Z]
digit       = [0-9]
newline     = '\n' | '\r\n' | '\r'
whitespace  = ' ' | '\t' | newline
simple_char = alpha | digit | '-' | '_'
```

### 2.2 Token Types

#### Keywords (after backslash)

| Token | Lexeme | Description |
|-------|--------|-------------|
| `SCOPE` | `\scope` | Lexical scoping block |
| `PUT` | `\put` | Dynamic variable assignment |
| `DEFAULT` | `\put?` | Default value assignment |
| `GET` | `\get` | Dynamic variable retrieval |
| `IMPORT` | `\import` | Private import |
| `EXPORT` | `\export` | Public import (re-exported) |
| `NAMESPACE` | `\namespace` | Namespace declaration |
| `OPEN` | `\open` | Open namespace into scope |
| `DEF` | `\def` | Exported definition |
| `ALLOC` | `\alloc` | Allocate fresh symbol |
| `LET` | `\let` | Local definition |
| `FUN` | `\fun` | Anonymous function (lambda) |
| `SUBTREE` | `\subtree` | Nested document tree |
| `OBJECT` | `\object` | Object literal |
| `PATCH` | `\patch` | Object extension/override |
| `CALL` | `\call` | Explicit method call |
| `DATALOG` | `\datalog` | Datalog expression block |

#### Delimiters

| Token | Lexeme | Description |
|-------|--------|-------------|
| `LBRACE` | `{` | Left brace |
| `RBRACE` | `}` | Right brace |
| `LSQUARE` | `[` | Left square bracket |
| `RSQUARE` | `]` | Right square bracket |
| `LPAREN` | `(` | Left parenthesis |
| `RPAREN` | `)` | Right parenthesis |
| `HASH_LBRACE` | `#{` | Inline math start |
| `HASH_HASH_LBRACE` | `##{` | Display math start |

#### Special Tokens

| Token | Lexeme | Description |
|-------|--------|-------------|
| `SLASH` | `/` | Path separator in identifiers |
| `TICK` | `'` | Quote mark (datalog constant) |
| `AT_SIGN` | `@` | URI constant marker |
| `HASH` | `#` | Method call / hash identifier |
| `DX_ENTAILED` | `-:` | Datalog entailment |
| `COMMENT` | `%...` | Line comment (to EOL) |
| `EOF` | - | End of file |

#### Parameterized Tokens

| Token | Pattern | Description |
|-------|---------|-------------|
| `TEXT` | `[^%#\\{}[]()\r\n ]+` | Plain text content |
| `WHITESPACE` | `[ \t\r\n]+` | Whitespace |
| `IDENT` | `(alpha \| digit \| '-')+` | Identifier |
| `HASH_IDENT` | `#` + simple_name | Hash identifier |
| `DX_VAR` | `?` + simple_name | Datalog variable |
| `VERBATIM` | (see §2.4) | Literal content |
| `XML_ELT_IDENT` | `\<name>` or `\<prefix:name>` | XML element |
| `DECL_XMLNS` | `\xmlns:prefix` | XML namespace declaration |

### 2.3 Escape Sequences

After backslash, these characters produce their literal selves:

| Escape | Result |
|--------|--------|
| `\\` | `\` |
| `\{` | `{` |
| `\}` | `}` |
| `\[` | `[` |
| `\]` | `]` |
| `\#` | `#` |
| `\%` | `%` |
| `\` (space) | ` ` |
| `\,` | `,` |
| `\"` | `"` |
| `` \` `` | `` ` `` |
| `\_` | `_` |
| `\;` | `;` |
| `\|` | `|` |

### 2.4 Verbatim Syntax

#### Inline Verbatim

```
\verb<herald>|<content><herald>
```

Where `<herald>` is any sequence of non-whitespace, non-`|` characters.

Examples:

```
\verb|hello|           → "hello"
\verb<<|hello<<|       → "hello"
\verb!!!|code!!!       → "code"
```

#### Block Verbatim

```
\startverb
multi-line
content
\stopverb
```

### 2.5 Comments

Line comments start with `%` and continue to end of line:

```
% This is a comment
\title{Hello} % Inline comment
```

Comments that start a line and are followed by whitespace-only lines continue through those lines.

### 2.6 Lexer Modes

The lexer maintains a mode stack:

1. **Main** - Default tokenization
2. **Ident** - After `\`, scanning identifier
3. **Verbatim** - Collecting verbatim content until herald match

---

## 3. Abstract Syntax Tree

### 3.1 Base Types

```
binding_info = Strict | Lazy
binding<T> = (binding_info, T)
delim = Braces | Squares | Parens
math_mode = Inline | Display
visibility = Private | Public
path = list<string>  // e.g., ["foo", "bar", "baz"]
```

### 3.2 Node Types

```
node =
  // Content
  | Text(string)
  | Verbatim(string)
  | Comment(string)
  | Error(string)

  // Grouping
  | Group(delim, nodes)
  | Math(math_mode, nodes)

  // Identifiers
  | Ident(path)                    // \foo or \foo/bar
  | Hash_ident(string)             // #name
  | Xml_ident(option<string>, string)  // \<name> or \<prefix:name>

  // Binding constructs
  | Let(path, list<binding<string>>, nodes)
  | Def(path, list<binding<string>>, nodes)
  | Fun(list<binding<string>>, nodes)
  | Scope(nodes)
  | Namespace(path, nodes)
  | Open(path)

  // Dynamic variables
  | Put(path, nodes)
  | Default(path, nodes)
  | Get(path)
  | Alloc(path)

  // Objects
  | Object(object_def)
  | Patch(patch_def)
  | Call(nodes, string)

  // Document structure
  | Subtree(option<string>, nodes)
  | Import(visibility, string)
  | Decl_xmlns(string, string)

  // Datalog
  | Dx_sequent(nodes, list<nodes>)
  | Dx_query(string, list<nodes>, list<nodes>)
  | Dx_prop(nodes, list<nodes>)
  | Dx_var(string)
  | Dx_const_content(nodes)
  | Dx_const_uri(nodes)

nodes = list<located<node>>
located<T> = { value: T, location: option<source_range> }
```

### 3.3 Object Definitions

```
object_def = {
  self: option<string>,
  methods: list<(string, nodes)>
}

patch_def = {
  obj: nodes,
  self: option<string>,
  super: option<string>,
  methods: list<(string, nodes)>
}
```

---

## 4. Grammar

### 4.1 Top-Level

```
document := whitespace* head_nodes EOF

head_nodes := (head_node | import_decl)*

import_decl := IMPORT '{' text '}' | EXPORT '{' text '}'
```

### 4.2 Nodes

```
head_node :=
  | TEXT
  | WHITESPACE
  | COMMENT
  | VERBATIM
  | group
  | math
  | command
  | xml_element
  | hash_ident
  | datalog_special

group :=
  | '{' nodes '}'
  | '[' nodes ']'
  | '(' nodes ')'

math :=
  | '#{' nodes '}'      // Inline math
  | '##{' nodes '}'     // Display math

command :=
  | '\' ident args?
  | keyword_command

keyword_command :=
  | SCOPE '{' nodes '}'
  | PUT '\' ident '{' nodes '}'
  | DEFAULT '\' ident '{' nodes '}'
  | GET '\' ident
  | LET fun_spec
  | DEF fun_spec
  | FUN binders '{' nodes '}'
  | SUBTREE addr? '{' nodes '}'
  | OBJECT self? '{' methods '}'
  | PATCH '{' nodes '}' patch_binders '{' methods '}'
  | NAMESPACE '{' ident '}' '{' nodes '}'
  | OPEN '\' ident
  | ALLOC '\' ident
  | DATALOG '{' datalog_expr '}'
```

### 4.3 Identifiers and Paths

```
ident := IDENT ('/' IDENT)*

// Examples:
// foo         → ["foo"]
// foo/bar     → ["foo", "bar"]
// foo/bar/baz → ["foo", "bar", "baz"]
```

### 4.4 Function Definitions

```
fun_spec := '\' ident binders '{' nodes '}'

binders := ('[' bvar ']')*

bvar := '~'? TEXT

// Examples:
// \def\foo{body}           → no params
// \def\foo[x]{body}        → one strict param
// \def\foo[x][y]{body}     → two strict params
// \def\foo[~x]{body}       → one lazy param
// \def\foo[x][~y]{body}    → mixed
```

### 4.5 Objects

```
self := '[' TEXT ']'

methods := method*

method := '[' TEXT ']' '{' nodes '}'

patch_binders :=
  | '[' TEXT ']' '[' TEXT ']'    // [self][super]
  | '[' TEXT ']'                  // [self] only
  | ε                             // neither
```

### 4.6 XML Elements

```
xml_element := XML_ELT_IDENT args?

xmlns_decl := DECL_XMLNS '{' text '}'
```

### 4.7 Datalog

```
datalog_expr :=
  | datalog_sequent
  | datalog_query
  | datalog_prop

datalog_sequent := prop '-:' ('{' nodes '}')*

datalog_query := DX_VAR '-:' positives ('#' negatives)?

positives := ('{' nodes '}')*
negatives := ('{' nodes '}')*

datalog_prop := nodes ('{' nodes '}')*

// Special tokens in datalog context:
// ?var      → Dx_var
// 'content  → Dx_const_content
// @uri      → Dx_const_uri
```

---

## 5. Evaluation Model

### 5.1 Two-Phase Compilation

#### Phase 1: Expansion

- Macro expansion
- Name resolution
- Import handling
- Produces semantic AST (Syn)

#### Phase 2: Evaluation

- Runtime execution
- Content production
- Side effects (jobs, frontmatter)

### 5.2 Environments

#### Lexical Environment

- Maps variable names (strings) to values
- Used for function parameters
- Captured in closures

#### Dynamic Environment

- Maps symbols to values
- Used for `\put`/`\get`/`\put?`
- Dynamically scoped

#### Scope (Name Resolution)

- Two tries: visible (local) and export
- `\let` imports into visible
- `\def` includes in export
- `\import` brings in exports from other trees

### 5.3 Evaluation Modes

```
eval_mode = Text_mode | TeX_mode
```

In **Text_mode**: Unresolved identifiers produce errors.

In **TeX_mode**: Unresolved single-word identifiers become TeX control sequences (e.g., `\alpha` → `α`).

### 5.4 Tape-Based Argument Passing

Commands consume arguments from a "tape" (stream of nodes):

```
// Given: \foo{a}{b}
// \foo pops two arguments: {a} and {b}
```

Functions:

- `pop_arg()` - Get next braced group
- `pop_content_arg()` - Get and evaluate to content
- `pop_text_arg()` - Get and convert to string

### 5.5 Values

```
value =
  | Content(content)           // Document content
  | Closure(env, params, body) // Function closure
  | Symbol(symbol)             // Allocated symbol
  | Object(symbol)             // Heap reference
  | Dx_prop(...)               // Datalog proposition
  | Dx_query(...)              // Datalog query
  | Dx_var(string)             // Datalog variable
  | Dx_const(vertex)           // Datalog constant
```

---

## 6. Built-in Commands

### 6.1 Document Structure

| Command | Arguments | Description |
|---------|-----------|-------------|
| `\title` | `{content}` | Set document title |
| `\taxon` | `{content}` | Set taxon (e.g., "Definition") |
| `\date` | `{YYYY-MM-DD}` | Add publication date |
| `\author` | `{uri}` | Add author by URI |
| `\author/literal` | `{name}` | Add author by name |
| `\contributor` | `{uri}` | Add contributor by URI |
| `\contributor/literal` | `{name}` | Add contributor by name |
| `\tag` | `{name}` | Add tag |
| `\meta` | `{key}{value}` | Add custom metadata |
| `\number` | `{num}` | Set manual section number |
| `\parent` | `{uri}` | Set designated parent |

### 6.2 Cross-References

| Command | Arguments | Description |
|---------|-----------|-------------|
| `\ref` | `{uri}` | Reference with taxon + number |
| `\transclude` | `{uri}` | Embed another tree |
| `\link` | `{uri}{text}` | Hyperlink |

### 6.3 HTML Primitives

| Command | Arguments | Description |
|---------|-----------|-------------|
| `\p` | `{content}` | Paragraph |
| `\em` | `{content}` | Emphasis |
| `\strong` | `{content}` | Strong emphasis |
| `\code` | `{content}` | Inline code |
| `\pre` | `{content}` | Preformatted block |
| `\blockquote` | `{content}` | Block quote |
| `\ul` | `{items}` | Unordered list |
| `\ol` | `{items}` | Ordered list |
| `\li` | `{content}` | List item |
| `\figure` | `{content}` | Figure |
| `\figcaption` | `{content}` | Figure caption |

### 6.4 Math and TeX

| Command | Arguments | Description |
|---------|-----------|-------------|
| `#{...}` | - | Inline math (KaTeX) |
| `##{...}` | - | Display math (KaTeX) |
| `\tex` | `{preamble}{body}` | Embedded LaTeX → SVG |

### 6.5 Special

| Command | Arguments | Description |
|---------|-----------|-------------|
| `\current-tree` | - | Returns current tree URI |
| `\route-asset` | `{path}` | Route to asset file |
| `\query` | `{datalog}` | Display query results |
| `\execute` | `{datalog}` | Execute datalog rules |

### 6.6 TeX Control Sequences

~300+ built-in TeX commands are available in math mode:

```
\alpha, \beta, \gamma, ...     // Greek letters
\sum, \prod, \int, ...         // Big operators
\frac, \sqrt, \binom, ...      // Fractions
\mathbb, \mathcal, \mathfrak   // Math fonts
// ... and many more
```

---

## 7. Object System

### 7.1 Object Creation

```
\object[self]{
  [method1]{body using #self}
  [method2]{another method}
}
```

Objects are stored on a heap with:

- Symbol as identity
- Optional prototype reference
- Method table (string → method)

### 7.2 Method Structure

```
method = {
  body: nodes,
  self: option<string>,
  super: option<string>,
  env: lexical_env
}
```

### 7.3 Method Calls

```
// Implicit call (shorthand)
\get\myObj#methodName

// Or using call
\call{\get\myObj}{methodName}
```

Resolution follows prototype chain.

### 7.4 Object Extension (Patch)

```
\patch{\get\baseObj}[self][super]{
  [method1]{override using #super#method1}
}
```

Creates new object with:

- Prototype pointing to base object
- Access to `self` (new object)
- Access to `super` (base object for method calls)

---

## 8. Module System

### 8.1 Imports

```
\import{tree-name}    // Private import
\export{tree-name}    // Public import (re-exported)
```

### 8.2 Definitions

```
\let\name{value}      // Local binding (not exported)
\def\name{value}      // Exported binding
```

### 8.3 Namespaces

```
\namespace{prefix}{
  \def\foo{...}       // Defines prefix/foo
}

\open\prefix          // Brings prefix/* into scope
```

### 8.4 Export Mechanism

Each tree maintains:

- **Visible trie**: Names visible in current scope
- **Export trie**: Names exported to importers

---

## 9. Datalog Query System

### 9.1 Syntax

#### Variables

```
?X, ?Y, ?Z     // Variables start with ?
```

#### Constants

```
@{uri}        // URI constant
'{content}    // Content constant (literal value)
```

#### Propositions

```
\rel/relation{arg1}{arg2}
```

#### Sequents (Rules)

```
\datalog{
  conclusion -: {premise1}{premise2}
}
```

#### Queries

```
\datalog{
  ?X -: {positive1}{positive2} #{negative1}
}
```

### 9.2 Built-in Relations

| Relation | Arity | Description |
|----------|-------|-------------|
| `links-to` | 2 | X links to Y |
| `transcludes` | 2 | X transcludes Y (direct) |
| `transcludes/transitive-closure` | 2 | Transitive transclusion |
| `transcludes/reflexive-transitive-closure` | 2 | Reflexive-transitive |
| `has-author` | 2 | X authored by Y |
| `has-taxon` | 2 | X has taxon Y |
| `has-tag` | 2 | X has tag Y |
| `has-direct-contributor` | 2 | X has direct contributor Y |
| `has-indirect-contributor` | 2 | X has indirect contributor Y |
| `is-node` | 1 | X is a node |
| `is-article` | 1 | X is an article |
| `is-asset` | 1 | X is an asset |
| `is-reference` | 1 | X has taxon "Reference" |
| `is-person` | 1 | X has taxon "Person" |
| `in-host` | 1 | X is in host Y |
| `references` | 2 | X references Y (derived) |

### 9.3 Built-in Rules (Axioms)

```
// is-reference derived from taxon
is-reference(?X) :- has-taxon(?X, "Reference")

// is-person derived from taxon
is-person(?X) :- has-taxon(?X, "Person")

// Transitive closure of transclusion
transcludes-tc(?X, ?Y) :- transcludes(?X, ?Y)
transcludes-tc(?X, ?Z) :- transcludes-tc(?X, ?Y), transcludes(?Y, ?Z)

// Reflexive-transitive closure
transcludes-rtc(?X, ?X) :- is-node(?X)
transcludes-rtc(?X, ?Y) :- transcludes-tc(?X, ?Y)

// References (through transclusion tree)
references(?X, ?Z) :-
  transcludes-rtc(?X, ?Y),
  links-to(?Y, ?Z),
  is-reference(?Z)

// Direct contributor = author
has-direct-contributor(?X, ?Y) :- has-author(?X, ?Y)

// Indirect contributor through transclusion
has-indirect-contributor(?X, ?Z) :-
  transcludes-rtc(?X, ?Y),
  has-direct-contributor(?Y, ?Z)
```

### 9.4 Evaluation

1. Parse datalog expressions during expansion
2. Collect facts during content analysis:
   - Links create `links-to` edges
   - Transclusions create `transcludes` edges
   - Authors/contributors create attribution edges
   - Tags create `has-tag` edges
   - Taxons create `has-taxon` edges
3. Apply built-in axioms
4. Execute queries using bottom-up evaluation
5. Return set of matching vertices

---

## 10. LaTeX Rendering Pipeline

### 10.1 Overview

```
\tex{preamble}{body}
        ↓
   TeX Mode Evaluation
        ↓
   Template Generation
        ↓
   LaTeX Compilation (latex → DVI)
        ↓
   DVI → SVG Conversion (dvisvgm)
        ↓
   SVG Caching
        ↓
   <img> Reference in Output
```

### 10.2 Content Detection

LaTeX content is detected via:

1. `\tex{preamble}{body}` commands
2. Math mode `#{...}` and `##{...}` (rendered via KaTeX)

### 10.3 Template Structure

```latex
\documentclass[options]{class}

% Engine detection
\usepackage{iftex}
\ifPDFTeX
  \usepackage[T1]{fontenc}
  \usepackage[utf8]{inputenc}
\else
  \usepackage{fontspec}
\fi

% Math packages
\usepackage{amsmath,amssymb,mathtools}

% User preamble
{preamble}

\begin{document}
{body}
\end{document}
```

### 10.4 Compilation Commands

Default LaTeX command:

```bash
latex -halt-on-error -interaction=nonstopmode job.tex
```

Default DVI→SVG command:

```bash
dvisvgm --exact --clipjoin --font-format=woff \
        --bbox=papersize --zoom=1.5 --stdin --stdout
```

### 10.5 Caching

- SVG files named by MD5 hash of source
- Stored in `build/resources/{hash}.svg`
- Cache lookup before compilation
- Optional source persistence (`--persist-tex`)

### 10.6 Configuration

```toml
[forest.latex]
document_class = "standalone"
document_class_options = ["preview", "border=2pt", "10pt"]
compile_command = ["latex", "-halt-on-error", "-interaction=nonstopmode"]
dvisvgm_command = ["dvisvgm", "--exact", "--clipjoin",
                   "--font-format=woff", "--bbox=papersize",
                   "--zoom=1.5", "--stdin", "--stdout"]
```

---

## 11. XML Output Format

### 11.1 Namespaces

| Prefix | URI |
|--------|-----|
| `fr` | `http://www.forester-notes.org` |
| `html` | `http://www.w3.org/1999/xhtml` |
| `xml` | `http://www.w3.org/XML/1998/namespace` |

### 11.2 Document Structure

```xml
<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="default.xsl"?>
<fr:tree
  xmlns:fr="http://www.forester-notes.org"
  xmlns:html="http://www.w3.org/1999/xhtml"
  base-url="https://example.com/"
  numbered="true"
  toc="true"
  expanded="true"
  show-heading="true"
  show-metadata="true"
  root="true">

  <fr:frontmatter>
    <fr:title text="Plain Title">Formatted Title</fr:title>
    <fr:taxon>Definition</fr:taxon>
    <fr:uri>example.com/trees/xxx-0001</fr:uri>
    <fr:display-uri>xxx-0001</fr:display-uri>
    <fr:route>xxx-0001.xml</fr:route>
    <fr:source-path>trees/xxx-0001.tree</fr:source-path>
    <fr:date><fr:year>2024</fr:year>...</fr:date>
    <fr:last-changed>1701234567.0</fr:last-changed>
    <fr:authors>
      <fr:author>...</fr:author>
    </fr:authors>
    <fr:meta name="key">value</fr:meta>
  </fr:frontmatter>

  <fr:mainmatter>
    <!-- Content -->
  </fr:mainmatter>

  <fr:backmatter>
    <!-- References, backlinks, etc. -->
  </fr:backmatter>
</fr:tree>
```

### 11.3 Content Elements

| Element | Attributes | Description |
|---------|------------|-------------|
| `<fr:link>` | `href`, `type`, `title`, `taxon`, `addr` | Hyperlink |
| `<fr:ref>` | `href`, `taxon`, `number`, `title` | Cross-reference |
| `<fr:tex>` | `display` (inline/block) | LaTeX content |
| `<fr:img>` | `src` | Image |
| `<fr:embedded-tex>` | - | Embedded TeX artefact |
| `<fr:embedded-tex-body>` | - | Rendered content |
| `<fr:source>` | `type`, `part` | Raw source |
| `<fr:contextual-number>` | - | Dynamic numbering |

### 11.4 Section Structure

```xml
<fr:tree expanded="true" numbered="true" toc="true">
  <fr:frontmatter>
    <fr:title>Section Title</fr:title>
  </fr:frontmatter>
  <fr:mainmatter>
    <!-- Nested content and subsections -->
  </fr:mainmatter>
</fr:tree>
```

---

## 12. Theme Integration

### 12.1 Theme Components

```
theme/
├── default.xsl          # Main XSL stylesheet
├── elements.xsl         # HTML element templates
├── tree.xsl             # Tree structure templates
├── metadata.xsl         # Frontmatter templates
├── links.xsl            # Link rendering
├── style.css            # CSS styling
├── forester.js          # JavaScript (search, etc.)
├── katex.min.css        # KaTeX styles
└── fonts/               # Web fonts
```

### 12.2 XSL Processing

The XML output is transformed via XSLT:

1. Client loads `.xml` file
2. Browser applies XSL stylesheet
3. XSL templates produce HTML
4. CSS provides styling
5. JavaScript adds interactivity

### 12.3 Key Templates

```xsl
<!-- Root template -->
<xsl:template match="/">
  <html>
    <head>
      <link rel="stylesheet" href="{base-url}style.css"/>
      <link rel="stylesheet" href="{base-url}katex.min.css"/>
      <script src="{base-url}forester.js"/>
    </head>
    <body>
      <!-- Navigation, content, ToC -->
    </body>
  </html>
</xsl:template>

<!-- Tree section -->
<xsl:template match="fr:tree">
  <section>
    <details open="{@expanded}">
      <summary><!-- Heading --></summary>
      <!-- Content -->
    </details>
  </section>
</xsl:template>
```

### 12.4 CSS Classes

| Class | Purpose |
|-------|---------|
| `.tree` | Tree container |
| `.frontmatter` | Metadata section |
| `.mainmatter` | Main content |
| `.backmatter` | Back matter |
| `.link.local` | Internal link |
| `.link.external` | External link |
| `.taxon` | Taxon display |
| `.number` | Section number |

### 12.5 Customization Points

1. **XSL Templates**: Override or extend `default.xsl`
2. **CSS Variables**: Modify `style.css`
3. **JavaScript**: Extend `forester.js`
4. **Metadata**: Use `\meta{key}{value}` for custom data
5. **Namespaces**: Add custom XML namespaces via `\xmlns`

---

## 13. Configuration

### 13.1 `forest.toml` Structure

```toml
[forest]
trees = ["trees"]                    # Tree directories
assets = ["assets"]                  # Asset directories
url = "https://example.com/"         # Base URL
home = "index"                       # Home tree address

[[forest.foreign]]                   # Foreign forest imports
path = "./other-forest/output"
route_locally = true
include_in_manifest = true

[forest.latex]                       # LaTeX settings
document_class = "standalone"
document_class_options = ["preview", "border=2pt", "10pt"]
compile_command = ["latex", "-halt-on-error", "-interaction=nonstopmode"]
dvisvgm_command = ["dvisvgm", "--exact", "--clipjoin",
                   "--font-format=woff", "--bbox=papersize",
                   "--zoom=1.5", "--stdin", "--stdout"]
```

### 13.2 CLI Options

#### `forester build`

| Flag | Description |
|------|-------------|
| `--dev` | Development mode |
| `--no-theme` | Skip theme copying |
| `--persist-tex` | Keep LaTeX sources |
| `--latex-document-class` | Override document class |
| `--latex-document-class-option` | Override class options |
| `--latex-compile-command` | Override compile command |
| `--latex-dvisvgm-command` | Override dvisvgm command |

#### `forester new`

| Flag | Description |
|------|-------------|
| `--prefix` | Address prefix |
| `--dest` | Destination directory |
| `--template` | Template tree |
| `--random` | Random ID generation |

---

## 14. File Format

### 14.1 Tree Files (`.tree`)

```
trees/
├── index.tree           # Home tree
├── xxx-0001.tree        # Addressed tree
├── xxx-0002.tree
└── topics/
    └── math.tree        # Nested tree
```

- Extension: `.tree`
- Encoding: UTF-8
- Address derived from filename (without extension)
- Files starting with `.` are ignored

### 14.2 Example Tree

```forester
% example.tree
\title{Example Document}
\taxon{Definition}
\date{2024-01-15}
\author{person-001}
\tag{mathematics}
\meta{difficulty}{beginner}

\import{foundation}

\def\myMacro[x]{
  Definition: \em{#x}
}

\p{This is a paragraph with \myMacro{inline content}.}

\p{Math example: #{x^2 + y^2 = z^2}}

\subtree[example-subsection]{
  \title{Subsection}
  \p{Nested content here.}
}

\transclude{other-tree}

\object[self]{
  [render]{\p{Object method}}
}

\datalog{
  ?related -: {\rel/links-to{@{example}}{?related}}
}
```

### 14.3 Output Structure

```
output/
├── index.xml            # Home tree XML
├── xxx-0001.xml         # Tree XML files
├── xxx-0001/index.html  # HTML redirect
├── default.xsl          # XSL stylesheet
├── style.css            # CSS
├── forester.js          # JavaScript
├── {hash}.svg           # LaTeX-generated SVGs
└── manifest.json        # Search index
```

---

## Appendix A: Complete Token Reference

```
// Delimiters
LBRACE          = '{'
RBRACE          = '}'
LSQUARE         = '['
RSQUARE         = ']'
LPAREN          = '('
RPAREN          = ')'
HASH_LBRACE     = '#{'
HASH_HASH_LBRACE= '##{'

// Keywords (after \)
SCOPE           = "scope"
PUT             = "put"
DEFAULT         = "put?"
GET             = "get"
IMPORT          = "import"
EXPORT          = "export"
NAMESPACE       = "namespace"
OPEN            = "open"
DEF             = "def"
ALLOC           = "alloc"
LET             = "let"
FUN             = "fun"
SUBTREE         = "subtree"
OBJECT          = "object"
PATCH           = "patch"
CALL            = "call"
DATALOG         = "datalog"

// Operators
SLASH           = '/'
TICK            = '\''
AT_SIGN         = '@'
HASH            = '#'
DX_ENTAILED     = "-:"

// Parameterized
TEXT            = /[^%#\\{}[\]()\r\n \t]+/
WHITESPACE      = /[ \t\r\n]+/
IDENT           = /[a-zA-Z0-9-]+/
HASH_IDENT      = /#[a-zA-Z0-9-_]+/
DX_VAR          = /\?[a-zA-Z0-9-_]+/
COMMENT         = /%[^\r\n]*/
VERBATIM        = (see §2.4)
XML_ELT_IDENT   = /\\<([a-zA-Z]+:)?[a-zA-Z]+>/
DECL_XMLNS      = /\\xmlns:[a-zA-Z]+/

// Special
EOF             = end of input
ERROR           = lexer error
```

---

## Appendix B: Built-in TeX Commands

A non-exhaustive list of TeX control sequences recognized in math mode:

### Greek Letters

```
\alpha \beta \gamma \delta \epsilon \zeta \eta \theta
\iota \kappa \lambda \mu \nu \xi \pi \rho \sigma \tau
\upsilon \phi \chi \psi \omega
\Gamma \Delta \Theta \Lambda \Xi \Pi \Sigma \Upsilon
\Phi \Psi \Omega
```

### Binary Operators

```
\pm \mp \times \div \cdot \ast \star \circ \bullet
\cap \cup \vee \wedge \oplus \otimes \odot
```

### Relations

```
\leq \geq \neq \equiv \sim \simeq \approx \cong
\subset \supset \subseteq \supseteq \in \ni \notin
\prec \succ \preceq \succeq
```

### Big Operators

```
\sum \prod \coprod \int \oint \bigcup \bigcap
\bigoplus \bigotimes \bigvee \bigwedge
```

### Arrows

```
\leftarrow \rightarrow \leftrightarrow
\Leftarrow \Rightarrow \Leftrightarrow
\mapsto \hookrightarrow \leadsto
\uparrow \downarrow \updownarrow
```

### Delimiters

```
\langle \rangle \lfloor \rfloor \lceil \rceil
\lbrace \rbrace \lvert \rvert \lVert \rVert
```

### Accents

```
\hat \check \tilde \acute \grave \dot \ddot
\breve \bar \vec \overline \underline
\widehat \widetilde \overrightarrow
```

### Functions

```
\sin \cos \tan \cot \sec \csc
\arcsin \arccos \arctan
\sinh \cosh \tanh \coth
\log \ln \exp \lim \limsup \liminf
\max \min \sup \inf \arg \det \dim \ker \hom
```

### Constructs

```
\frac{num}{den}
\sqrt{expr} \sqrt[n]{expr}
\binom{n}{k}
\overset{top}{base}
\underset{bottom}{base}
```

---

## Appendix C: Content Node Types

Complete enumeration of content output nodes:

```
content_node =
  | Text(string)                    // Plain text
  | CDATA(string)                   // CDATA section
  | Xml_elt(xml_element)            // XML element
  | Transclude(transclusion)        // Embedded tree
  | Contextual_number(uri)          // Dynamic numbering
  | Section(section)                // Nested section
  | KaTeX(mode, content)            // Math content
  | Link(link)                      // Hyperlink
  | Artefact(artefact)              // Generated resource
  | Uri(uri)                        // URI reference
  | Route_of_uri(uri)               // Route path
  | Datalog_script(script)          // Datalog rules
  | Results_of_datalog_query(query) // Query results
```

---

*This specification is derived from the Forester 5.0 source code and is intended as a guide for implementing compatible parsers and processors in other programming languages.*
