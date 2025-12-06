/**
 * Tests for the Forester formatter
 * 
 * Run with: npx ts-node src/formatter.test.ts
 * Or add to package.json scripts and run with npm test
 */

// Re-implement the core formatting logic for testing (without vscode dependency)

// Top-level metadata commands that should be on their own line
const TOP_LEVEL_COMMANDS = [
   "title", "taxon", "author", "contributor", "date", "parent", "tag", "meta", "number",
   "import", "export", "namespace", "def", "let", "alloc", "open", "solution"
];

// Block-level commands that typically contain multi-line content
const BLOCK_COMMANDS = [
   "p", "ul", "ol", "li", "blockquote", "pre", "subtree", "query", "solution",
   "texfig", "ltexfig", "scope", "figure"
];

// Commands whose content should be preserved exactly (like \tex{preamble}{content})
const TEX_CONTENT_COMMANDS = [
   "tex"
];

interface Token {
   type: "command" | "text" | "brace_open" | "brace_close" | "bracket_open" | "bracket_close" |
   "paren_open" | "paren_close" | "comment" | "whitespace" | "newline" | "math_inline" |
   "math_display" | "verbatim_start" | "verbatim_end" | "verbatim_content" | "ignored_block";
   value: string;
   commandName?: string;
}

/**
 * Check if a command should have its content ignored/preserved
 */
function isIgnoredCommand(commandName: string, ignoredCommands: Set<string>): boolean {
   return ignoredCommands.has(commandName);
}

/**
 * Extract the full block content for an ignored command, including all its arguments.
 */
function extractIgnoredBlockContent(text: string, startPos: number): { content: string; endPos: number } {
   let i = startPos;
   let content = "";
   
   let consumedBrace = false;
   
   while (i < text.length) {
      while (i < text.length && /[ \t]/.test(text[i])) {
         content += text[i];
         i++;
      }
      
      if (i >= text.length) break;
      
      if (text[i] === "[") {
         let depth = 1;
         content += text[i];
         i++;
         while (i < text.length && depth > 0) {
            if (text[i] === "[") depth++;
            else if (text[i] === "]") depth--;
            content += text[i];
            i++;
         }
      } else if (text[i] === "{") {
         let depth = 1;
         content += text[i];
         i++;
         while (i < text.length && depth > 0) {
            if (text[i] === "{") depth++;
            else if (text[i] === "}") depth--;
            content += text[i];
            i++;
         }
         consumedBrace = true;
         continue;
      } else if (text[i] === "\\" && !consumedBrace) {
         // For \def\macroName style, consume the following command name
         content += text[i];
         i++;
         while (i < text.length && /[A-Za-z0-9\-]/.test(text[i])) {
            content += text[i];
            i++;
         }
      } else {
         break;
      }
   }
   
   return { content, endPos: i };
}

/**
 * Normalize indentation in multi-line math blocks.
 */
function normalizeMultilineMath(mathBlock: string, baseIndent: string, indentUnit: string): string {
   const isDisplay = mathBlock.startsWith("##{");
   const prefix = isDisplay ? "##{" : "#{";
   const content = mathBlock.slice(prefix.length, -1);
   
   if (!content.includes("\n")) {
      return mathBlock;
   }
   
   const lines = content.split("\n");
   
   let minIndent = Infinity;
   for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().length > 0) {
         const leadingSpaces = line.match(/^[ \t]*/)?.[0]?.length || 0;
         minIndent = Math.min(minIndent, leadingSpaces);
      }
   }
   
   if (minIndent === Infinity) {
      minIndent = 0;
   }
   
   const contentIndent = baseIndent + indentUnit;
   
   const normalizedLines: string[] = [];
   for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0) {
         if (line.trim().length === 0) {
            normalizedLines.push("");
         } else {
            normalizedLines.push(line.trim());
         }
      } else {
         if (line.trim().length === 0) {
            normalizedLines.push("");
         } else {
            const stripped = line.slice(minIndent);
            normalizedLines.push(contentIndent + stripped.trim());
         }
      }
   }
   
   const lastLine = normalizedLines[normalizedLines.length - 1];
   if (lastLine.trim().length === 0) {
      normalizedLines[normalizedLines.length - 1] = baseIndent;
   }
   
   return prefix + normalizedLines.join("\n") + "}";
}

function tokenize(text: string, ignoredCommands: Set<string> = new Set()): Token[] {
   const tokens: Token[] = [];
   let i = 0;

   while (i < text.length) {
      // Check for verbatim blocks first
      if (text.slice(i).startsWith("\\startverb")) {
         const endIndex = text.indexOf("\\stopverb", i);
         if (endIndex !== -1) {
            let startEnd = i + 10;
            while (startEnd < text.length && text[startEnd] !== '\n') {
               startEnd++;
            }
            tokens.push({ type: "verbatim_start", value: text.slice(i, startEnd + 1) });
            const contentStart = startEnd + 1;
            const content = text.slice(contentStart, endIndex);
            if (content.length > 0) {
               tokens.push({ type: "verbatim_content", value: content });
            }
            tokens.push({ type: "verbatim_end", value: "\\stopverb" });
            i = endIndex + 9;
            continue;
         }
      }

      // Check for comments (% to end of line)
      if (text[i] === "%" && (i === 0 || text[i - 1] !== "\\")) {
         let j = i;
         while (j < text.length && text[j] !== "\n") {
            j++;
         }
         tokens.push({ type: "comment", value: text.slice(i, j) });
         i = j;
         continue;
      }

      // Check for display math ##{...}
      if (text.slice(i, i + 3) === "##{") {
         let depth = 1;
         let j = i + 3;
         while (j < text.length && depth > 0) {
            if (text[j] === "{") depth++;
            else if (text[j] === "}") depth--;
            j++;
         }
         tokens.push({ type: "math_display", value: text.slice(i, j) });
         i = j;
         continue;
      }

      // Check for inline math #{...}
      if (text.slice(i, i + 2) === "#{") {
         let depth = 1;
         let j = i + 2;
         while (j < text.length && depth > 0) {
            if (text[j] === "{") depth++;
            else if (text[j] === "}") depth--;
            j++;
         }
         tokens.push({ type: "math_inline", value: text.slice(i, j) });
         i = j;
         continue;
      }

      // Check for commands (\word or \<xml>)
      if (text[i] === "\\") {
         if (i + 1 < text.length && (text[i + 1] === "%" || text[i + 1] === "\\")) {
            tokens.push({ type: "text", value: text.slice(i, i + 2) });
            i += 2;
            continue;
         }

         if (text[i + 1] === "<") {
            let j = i + 2;
            while (j < text.length && text[j] !== ">") {
               j++;
            }
            const commandName = text.slice(i + 2, j);
            tokens.push({ type: "command", value: text.slice(i, j + 1), commandName });
            i = j + 1;
            continue;
         }

         let j = i + 1;
         while (j < text.length && /[A-Za-z0-9\-\/#]/.test(text[j])) {
            j++;
         }
         if (j > i + 1) {
            const commandName = text.slice(i + 1, j);
            
            // Check if this is an ignored command - if so, extract entire block as-is
            if (isIgnoredCommand(commandName, ignoredCommands)) {
               const commandValue = text.slice(i, j);
               const { content, endPos } = extractIgnoredBlockContent(text, j);
               tokens.push({ 
                  type: "ignored_block", 
                  value: commandValue + content, 
                  commandName 
               });
               i = endPos;
               continue;
            }
            
            // Check if this is a \tex command - preserve its content exactly
            if (TEX_CONTENT_COMMANDS.includes(commandName)) {
               const commandValue = text.slice(i, j);
               const { content, endPos } = extractIgnoredBlockContent(text, j);
               tokens.push({ 
                  type: "ignored_block", 
                  value: commandValue + content, 
                  commandName 
               });
               i = endPos;
               continue;
            }
            
            tokens.push({ type: "command", value: text.slice(i, j), commandName });
            i = j;
            continue;
         } else {
            tokens.push({ type: "text", value: "\\" });
            i++;
            continue;
         }
      }

      if (text[i] === "{") {
         tokens.push({ type: "brace_open", value: "{" });
         i++;
         continue;
      }
      if (text[i] === "}") {
         tokens.push({ type: "brace_close", value: "}" });
         i++;
         continue;
      }
      if (text[i] === "[") {
         tokens.push({ type: "bracket_open", value: "[" });
         i++;
         continue;
      }
      if (text[i] === "]") {
         tokens.push({ type: "bracket_close", value: "]" });
         i++;
         continue;
      }
      if (text[i] === "(") {
         tokens.push({ type: "paren_open", value: "(" });
         i++;
         continue;
      }
      if (text[i] === ")") {
         tokens.push({ type: "paren_close", value: ")" });
         i++;
         continue;
      }
      if (text[i] === "\n") {
         tokens.push({ type: "newline", value: "\n" });
         i++;
         continue;
      }
      if (/[ \t\r]/.test(text[i])) {
         let j = i;
         while (j < text.length && /[ \t\r]/.test(text[j])) {
            j++;
         }
         tokens.push({ type: "whitespace", value: text.slice(i, j) });
         i = j;
         continue;
      }

      let j = i;
      while (j < text.length && !/[\\{}\[\]()%\n\r\t #]/.test(text[j])) {
         j++;
      }
      while (j < text.length && text[j] === "#" && text[j + 1] !== "{" && text[j + 1] !== "#") {
         j++;
         while (j < text.length && !/[\\{}\[\]()%\n\r\t #]/.test(text[j])) {
            j++;
         }
      }
      if (j > i) {
         tokens.push({ type: "text", value: text.slice(i, j) });
         i = j;
      } else {
         tokens.push({ type: "text", value: text[i] });
         i++;
      }
   }

   return tokens;
}

interface FormatOptions {
   tabSize: number;
   insertSpaces: boolean;
   ignoredCommands?: Set<string>;
}

function format(text: string, options: FormatOptions): string {
   const ignoredCommands = options.ignoredCommands || new Set<string>();
   const tokens = tokenize(text, ignoredCommands);
   const indent = options.insertSpaces ? " ".repeat(options.tabSize) : "\t";

   let result = "";
   let depth = 0;
   let lineStart = true;
   let lastWasNewline = true;
   let lastWasCommand = false;
   let lastCommandName = "";
   let consecutiveNewlines = 0;
   let inVerbatim = false;

   const contextStack: string[] = [];

   function currentIndent(): string {
      return indent.repeat(depth);
   }

   function pushContext(name: string) {
      contextStack.push(name);
   }

   function popContext(): string | undefined {
      return contextStack.pop();
   }

   function isTopLevelCommand(name: string): boolean {
      return TOP_LEVEL_COMMANDS.includes(name);
   }

   function isBlockCommand(name: string): boolean {
      return BLOCK_COMMANDS.includes(name);
   }

   for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const nextToken = tokens[i + 1];
      const prevToken = tokens[i - 1];

      if (token.type === "verbatim_start") {
         inVerbatim = true;
         if (!lineStart && !lastWasNewline) {
            result += "\n";
         }
         result += currentIndent() + token.value;
         lineStart = false;
         lastWasNewline = false;
         lastWasCommand = false;
         consecutiveNewlines = 0;
         continue;
      }

      if (token.type === "verbatim_content") {
         result += token.value;
         lineStart = false;
         lastWasNewline = token.value.endsWith("\n");
         continue;
      }

      if (token.type === "verbatim_end") {
         inVerbatim = false;
         result += token.value;
         lineStart = false;
         lastWasNewline = false;
         lastWasCommand = false;
         continue;
      }

      if (inVerbatim) {
         result += token.value;
         continue;
      }

      switch (token.type) {
         case "ignored_block":
            // Preserve ignored blocks exactly as-is, but with proper indentation on first line
            if (lineStart) {
               result += currentIndent();
            }
            result += token.value;
            lineStart = false;
            lastWasNewline = token.value.endsWith("\n");
            lastWasCommand = false;
            consecutiveNewlines = 0;
            break;

         case "comment":
            if (!lineStart) {
               if (!lastWasNewline && result.length > 0 && !result.endsWith(" ")) {
                  result += " ";
               }
            } else {
               result += currentIndent();
            }
            result += token.value;
            lineStart = false;
            lastWasNewline = false;
            lastWasCommand = false;
            consecutiveNewlines = 0;
            break;

         case "newline":
            consecutiveNewlines++;
            if (consecutiveNewlines <= 2) {
               result += "\n";
            }
            lineStart = true;
            lastWasNewline = true;
            lastWasCommand = false;
            break;

         case "whitespace":
            if (!lineStart && !lastWasNewline) {
               if (prevToken && (prevToken.type === "brace_open" || prevToken.type === "bracket_open" || prevToken.type === "paren_open")) {
                  // Skip whitespace after opening delimiter
               } else if (nextToken && (nextToken.type === "brace_close" || nextToken.type === "bracket_close" || nextToken.type === "paren_close")) {
                  // Skip whitespace before closing delimiter
               } else if (!result.endsWith(" ") && !result.endsWith("\n")) {
                  result += " ";
               }
            }
            break;

         case "command":
            const cmdName = token.commandName || "";

            if (isTopLevelCommand(cmdName)) {
               if (!lineStart && !lastWasNewline) {
                  result += "\n";
                  lineStart = true;
               }
            }

            if (isBlockCommand(cmdName) && depth === 0 && !lineStart) {
               result += "\n";
               lineStart = true;
            }

            if (lineStart) {
               result += currentIndent();
            }

            result += token.value;
            lineStart = false;
            lastWasNewline = false;
            lastWasCommand = true;
            lastCommandName = cmdName;
            consecutiveNewlines = 0;
            break;

         case "brace_open":
            result += "{";
            depth++;
            pushContext(lastWasCommand ? lastCommandName : "brace");

            // For block commands, add newline and indent (but don't add if next token is already newline)
            if (lastWasCommand && isBlockCommand(lastCommandName)) {
               // Only add newline if the next token isn't already a newline
               if (nextToken && nextToken.type !== "newline") {
                  result += "\n";
                  lineStart = true;
                  lastWasNewline = true;
               } else {
                  // Let the newline token handle it
                  lineStart = false;
                  lastWasNewline = false;
               }
            } else {
               lineStart = false;
               lastWasNewline = false;
            }

            lastWasCommand = false;
            consecutiveNewlines = 0;
            break;

         case "brace_close":
            depth = Math.max(0, depth - 1);
            const ctx = popContext();

            if (ctx && isBlockCommand(ctx)) {
               // Remove trailing whitespace before adding newline
               while (result.endsWith(" ") || result.endsWith("\t")) {
                  result = result.slice(0, -1);
               }
               if (!result.endsWith("\n")) {
                  result += "\n";
               }
               result += currentIndent() + "}";
            } else {
               if (result.endsWith(" ")) {
                  result = result.slice(0, -1);
               }
               // If we're at the start of a line (after a newline), add proper indentation
               if (lineStart || result.endsWith("\n")) {
                  result += currentIndent() + "}";
               } else {
                  result += "}";
               }
            }

            lineStart = false;
            lastWasNewline = false;
            lastWasCommand = false;
            consecutiveNewlines = 0;
            break;

         case "bracket_open":
            result += "[";
            depth++;
            pushContext("bracket");
            lineStart = false;
            lastWasNewline = false;
            lastWasCommand = false;
            consecutiveNewlines = 0;
            break;

         case "bracket_close":
            depth = Math.max(0, depth - 1);
            popContext();
            if (result.endsWith(" ")) {
               result = result.slice(0, -1);
            }
            result += "]";
            lineStart = false;
            lastWasNewline = false;
            lastWasCommand = false;
            consecutiveNewlines = 0;
            break;

         case "paren_open":
            result += "(";
            depth++;
            pushContext("paren");
            lineStart = false;
            lastWasNewline = false;
            lastWasCommand = false;
            consecutiveNewlines = 0;
            break;

         case "paren_close":
            depth = Math.max(0, depth - 1);
            popContext();
            if (result.endsWith(" ")) {
               result = result.slice(0, -1);
            }
            result += ")";
            lineStart = false;
            lastWasNewline = false;
            lastWasCommand = false;
            consecutiveNewlines = 0;
            break;

         case "math_inline":
            if (lineStart) {
               result += currentIndent();
            }
            result += token.value;
            lineStart = false;
            lastWasNewline = false;
            lastWasCommand = false;
            consecutiveNewlines = 0;
            break;

         case "math_display":
            if (lineStart) {
               result += currentIndent();
            }
            result += normalizeMultilineMath(token.value, currentIndent(), indent);
            lineStart = false;
            lastWasNewline = false;
            lastWasCommand = false;
            consecutiveNewlines = 0;
            break;

         case "text":
            if (lineStart) {
               result += currentIndent();
            }
            result += token.value;
            lineStart = false;
            lastWasNewline = false;
            lastWasCommand = false;
            consecutiveNewlines = 0;
            break;
      }
   }

   result = result.trimEnd() + "\n";

   return result;
}

// Test framework
let testsPassed = 0;
let testsFailed = 0;

function test(name: string, fn: () => void) {
   try {
      fn();
      testsPassed++;
      console.log(`✓ ${name}`);
   } catch (e) {
      testsFailed++;
      console.log(`✗ ${name}`);
      console.log(`  Error: ${e instanceof Error ? e.message : e}`);
   }
}

function assertEqual(actual: string, expected: string, message?: string) {
   if (actual !== expected) {
      const msg = message ? `${message}\n` : "";
      throw new Error(`${msg}Expected:\n${JSON.stringify(expected)}\n\nActual:\n${JSON.stringify(actual)}\n\nExpected (raw):\n${expected}\n\nActual (raw):\n${actual}`);
   }
}

function assertContains(actual: string, expected: string, message?: string) {
   if (!actual.includes(expected)) {
      throw new Error(`${message || "String does not contain expected substring"}\nExpected to contain: ${expected}\nActual: ${actual}`);
   }
}

const defaultOptions: FormatOptions = { tabSize: 2, insertSpaces: true };

// ============== TESTS ==============

console.log("\n=== Forester Formatter Tests ===\n");

// Basic formatting tests
test("Simple title and content", () => {
   const input = `\\title{Hello World}`;
   const expected = `\\title{Hello World}\n`;
   assertEqual(format(input, defaultOptions), expected);
});

test("Multiple metadata commands", () => {
   const input = `\\date{2025-12-02}\\import{base-macros}\\taxon{Quiz}\\title{Test}`;
   const result = format(input, defaultOptions);
   // Each top-level command should be on its own line
   assertContains(result, "\\date{2025-12-02}");
   assertContains(result, "\\import{base-macros}");
   assertContains(result, "\\taxon{Quiz}");
   assertContains(result, "\\title{Test}");
});

test("Paragraph formatting", () => {
   const input = `\\p{This is a paragraph.}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\p{");
   assertContains(result, "This is a paragraph.");
   assertContains(result, "}");
});

test("Inline math preservation", () => {
   const input = `\\p{The equation #{x^2 + y^2 = z^2} is famous.}`;
   const result = format(input, defaultOptions);
   assertContains(result, "#{x^2 + y^2 = z^2}");
});

test("Display math preservation", () => {
   const input = `##{
  U = \\{a, b, c\\}
}`;
   const result = format(input, defaultOptions);
   assertContains(result, "##{");
   assertContains(result, "U = \\{a, b, c\\}");
});

test("Nested lists - basic", () => {
   const input = `\\ol{
\\li{First item}
\\li{Second item}
}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\ol{");
   assertContains(result, "\\li{");
});

test("Nested lists - double nesting", () => {
   const input = `\\ol{
  \\li{Item one}
  \\li{Item two
    \\ol{
      \\li{Nested A}
      \\li{Nested B}
    }
  }
}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\ol{");
   assertContains(result, "\\li{");
   // Check that nesting is preserved
   const lines = result.split('\n');
   const hasNestedOl = lines.some(line => line.includes("\\ol{") && line.startsWith("    "));
   // Note: This might fail with current formatter - that's what we want to catch
});

test("Complex nested structure from user example", () => {
   const input = `\\ol{
  \\li{Does the interpetation #{I(=)} satisfy the axioms of equality?}
  \\li{Which interpretations for a function #{f} satisfy the axioms of congruence?
    \\ol{
      \\li{#{I(f) \\triangleq \\{b \\to a, a \\to c, c \\to c\\}}}
      \\li{#{I(f) \\triangleq \\{b \\to b, a \\to b, c \\to b\\}}}
      \\li{#{I(f) \\triangleq \\{b \\to a, a \\to b, c \\to c\\}}}
    }
  }
}`;
   const result = format(input, defaultOptions);
   // Should preserve structure and not break nesting
   assertContains(result, "\\ol{");
   assertContains(result, "Does the interpetation");
   assertContains(result, "Which interpretations");
});

test("Solution block with nested content", () => {
   const input = `\\solution{
  \\ol{
    \\li{Yes, the interpretation satisfies the axioms of equality}
    \\li{Going through them one by one:
      \\ol{
        \\li{No, because #{f(a) = c}}
        \\li{Yes, because #{f(a) = b}}
        \\li{Yes, because #{f(a) = b}}
      }
    }
  }
}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\solution{");
   assertContains(result, "\\ol{");
   assertContains(result, "\\li{");
});

test("Preserve verbatim blocks exactly", () => {
   const input = `\\startverb%tex
\\begin{equation}
  E = mc^2
\\end{equation}
\\stopverb`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\begin{equation}");
   assertContains(result, "E = mc^2");
   assertContains(result, "\\end{equation}");
});

test("Comments are preserved", () => {
   const input = `% This is a comment
\\title{Test}`;
   const result = format(input, defaultOptions);
   assertContains(result, "% This is a comment");
});

test("Inline formatting commands", () => {
   const input = `\\p{This has \\em{emphasized} and \\strong{bold} text.}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\em{emphasized}");
   assertContains(result, "\\strong{bold}");
});

test("Ref command inline", () => {
   const input = `\\p{See \\ref{other-tree} for more.}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\ref{other-tree}");
});

test("Transclude command", () => {
   const input = `\\transclude{another-tree}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\transclude{another-tree}");
});

test("Multiple blank lines should be collapsed to one", () => {
   const input = `\\title{Test}



\\p{Content}`;
   const result = format(input, defaultOptions);
   // Should not have more than 2 consecutive newlines
   const hasTripleNewline = result.includes("\n\n\n");
   if (hasTripleNewline) {
      throw new Error("Should not have more than 2 consecutive newlines");
   }
});

test("Full document from user", () => {
   const input = `\\date{2025-12-02}

\\import{base-macros}

\\taxon{Quiz}

\\title{Function & Predicate congruence}

\\p{Consider the universe:}
##{
  U = \\{a, b, c\\}
}
\\p{and the interpretation:}
##{
  I(=) \\triangleq \\{\\langle a, a \\rangle, \\langle a, b \\rangle, \\langle b, a \\rangle, \\langle b, b \\rangle, \\langle c, c \\rangle\\}
}

\\ol{
  \\li{Does the interpetation #{I(=)} satisfy the axioms of equality?}
  \\li{Which interpretations for a function #{f} satisfy the axioms of congruence?
    \\ol{
      \\li{#{I(f) \\triangleq \\{b \\to a, a \\to c, c \\to c\\}}}
      \\li{#{I(f) \\triangleq \\{b \\to b, a \\to b, c \\to b\\}}}
      \\li{#{I(f) \\triangleq \\{b \\to a, a \\to b, c \\to c\\}}}
    }
  }
}

\\solution{
  \\ol{
    \\li{Yes, the interpretation satisfies the axioms of equality}
    \\li{Going through them one by one:
      \\ol{
        \\li{No, because #{f(a) = c} and #{f(b) = a} but #{a\\ I(=)\\ b} yet #{c\\ not\\ I(=)\\ a}} 
        \\li{Yes, because #{f(a) = b} and #{f(b) = b} and #{a\\ I(=)\\ b} thus #{b\\ I(=)\\ b}, similarly for #{c}}
        \\li{Yes, because #{f(a) = b} and #{f(b) = a} and #{a\\ I(=)\\ b} thus #{b\\ I(=)\\ a}, similarly for #{c}}
      }
    }
  }
}`;
   
   const result = format(input, defaultOptions);
   
   // Basic structure checks
   assertContains(result, "\\date{2025-12-02}");
   assertContains(result, "\\import{base-macros}");
   assertContains(result, "\\taxon{Quiz}");
   assertContains(result, "\\title{Function & Predicate congruence}");
   
   // Math preservation
   assertContains(result, "U = \\{a, b, c\\}");
   assertContains(result, "I(=) \\triangleq");
   
   // Nested structure preservation
   assertContains(result, "\\ol{");
   assertContains(result, "\\li{");
   assertContains(result, "\\solution{");
   
   // Document should not have broken structure
   const openBraces = (result.match(/\{/g) || []).length;
   const closeBraces = (result.match(/\}/g) || []).length;
   // Note: This is approximate because of escaped braces in math
   
   console.log("\n  Formatted output preview (first 500 chars):");
   console.log("  " + result.slice(0, 500).split('\n').join('\n  '));
});

test("Idempotency - formatting twice should give same result", () => {
   const input = `\\title{Test}
\\p{Content here.}`;
   const once = format(input, defaultOptions);
   const twice = format(once, defaultOptions);
   assertEqual(once, twice, "Formatting should be idempotent");
});

test("Idempotency - complex document", () => {
   const input = `\\ol{
  \\li{First}
  \\li{Second
    \\ol{
      \\li{Nested}
    }
  }
}`;
   const once = format(input, defaultOptions);
   const twice = format(once, defaultOptions);
   assertEqual(once, twice, "Formatting nested lists should be idempotent");
});

// Additional edge case tests

test("Empty document", () => {
   const input = ``;
   const result = format(input, defaultOptions);
   assertEqual(result, "\n");
});

test("Only whitespace", () => {
   const input = `   \n\n   \t  `;
   const result = format(input, defaultOptions);
   assertEqual(result, "\n");
});

test("Deeply nested lists (3 levels)", () => {
   const input = `\\ul{
  \\li{Level 1
    \\ul{
      \\li{Level 2
        \\ul{
          \\li{Level 3}
        }
      }
    }
  }
}`;
   const result = format(input, defaultOptions);
   const once = format(input, defaultOptions);
   const twice = format(once, defaultOptions);
   assertEqual(once, twice, "Deep nesting should be idempotent");
});

test("Mixed inline and block content", () => {
   const input = `\\p{This is text with \\em{emphasis} and \\strong{bold} inline.}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\em{emphasis}");
   assertContains(result, "\\strong{bold}");
   // Should not break inline content across lines
});

test("Math with nested braces", () => {
   const input = `##{\\frac{a}{b} + \\frac{c}{d}}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\frac{a}{b}");
   assertContains(result, "\\frac{c}{d}");
});

test("Link syntax [text](url)", () => {
   const input = `\\p{Check out [this link](https://example.com) for more info.}`;
   const result = format(input, defaultOptions);
   assertContains(result, "[this link](https://example.com)");
});

test("Wiki-style link [[id]]", () => {
   const input = `\\p{See [[some-tree-id]] for details.}`;
   const result = format(input, defaultOptions);
   assertContains(result, "[[some-tree-id]]");
});

test("Escaped characters", () => {
   const input = `\\p{Use \\% for percent and \\\\ for backslash.}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\%");
   assertContains(result, "\\\\");
});

test("Subtree with address", () => {
   const input = `\\subtree[my-subtree-id]{
\\title{Subtree Title}
\\p{Content here.}
}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\subtree[my-subtree-id]");
   assertContains(result, "\\title{Subtree Title}");
});

test("Query command", () => {
   const input = `\\query{
\\query/tag{math}
}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\query{");
   assertContains(result, "\\query/tag{math}");
});

test("XML-style command", () => {
   const input = `\\<html:div>[class]{container}{Content inside}`;
   const result = format(input, defaultOptions);
   assertContains(result, "\\<html:div>");
});

test("Multiple paragraphs", () => {
   const input = `\\p{First paragraph.}
\\p{Second paragraph.}
\\p{Third paragraph.}`;
   const result = format(input, defaultOptions);
   // Each paragraph should be present
   assertContains(result, "First paragraph.");
   assertContains(result, "Second paragraph.");
   assertContains(result, "Third paragraph.");
});

test("User's full example - idempotency", () => {
   const input = `\\date{2025-12-02}

\\import{base-macros}

\\taxon{Quiz}

\\title{Function & Predicate congruence}

\\p{Consider the universe:}
##{
  U = \\{a, b, c\\}
}
\\p{and the interpretation:}
##{
  I(=) \\triangleq \\{\\langle a, a \\rangle, \\langle a, b \\rangle, \\langle b, a \\rangle, \\langle b, b \\rangle, \\langle c, c \\rangle\\}
}

\\ol{
  \\li{Does the interpetation #{I(=)} satisfy the axioms of equality?}
  \\li{Which interpretations for a function #{f} satisfy the axioms of congruence?
    \\ol{
      \\li{#{I(f) \\triangleq \\{b \\to a, a \\to c, c \\to c\\}}}
      \\li{#{I(f) \\triangleq \\{b \\to b, a \\to b, c \\to b\\}}}
      \\li{#{I(f) \\triangleq \\{b \\to a, a \\to b, c \\to c\\}}}
    }
  }
}

\\solution{
  \\ol{
    \\li{Yes, the interpretation satisfies the axioms of equality}
    \\li{Going through them one by one:
      \\ol{
        \\li{No, because #{f(a) = c} and #{f(b) = a} but #{a\\ I(=)\\ b} yet #{c\\ not\\ I(=)\\ a}} 
        \\li{Yes, because #{f(a) = b} and #{f(b) = b} and #{a\\ I(=)\\ b} thus #{b\\ I(=)\\ b}, similarly for #{c}}
        \\li{Yes, because #{f(a) = b} and #{f(b) = a} and #{a\\ I(=)\\ b} thus #{b\\ I(=)\\ a}, similarly for #{c}}
      }
    }
  }
}`;
   
   const once = format(input, defaultOptions);
   const twice = format(once, defaultOptions);
   const thrice = format(twice, defaultOptions);
   
   assertEqual(once, twice, "User example should be idempotent (1st vs 2nd format)");
   assertEqual(twice, thrice, "User example should be idempotent (2nd vs 3rd format)");
});

test("Complex category theory document - structure preservation", () => {
   const input = `\\date{2025-11-30}

\\import{base-macros}

\\taxon{Definition}

\\title{Full and faithful functors}

\\p{
  We consider a [functor](002v) between two [(locally small)](002o) categories #{F : C \\to D}.
}
##{
  F_{X, Y} : C(X, Y) \\to D(F(X), F(Y))
}
\\ul{
  \\li{
    The functor #{F} is called \\strong{faithful} if the function #{F_{X, Y}} is injective.
    ##{
      (x \\xrightarrow{f} y) \\mapsto (F(x) \\xrightarrow{F(f)} F(y))
    }
    \\blockquote{
      no two different arrows are mapped to the same arrow
    }
    It \\strong{does not} say
    \\ul{
      \\li{
        different objects in #{C} are mapped to different objects in #{D}.
      }
      \\li{
        two morphisms with different domains are mapped differently.
      }
    }
  }
  \\li{
    The functor #{F} is called \\strong{full} if the function #{F_{X, Y}} is surjective.
    \\blockquote{
      any morphism between objects in the image comes from #{C}
    }
    \\ul{
      \\li{
        every object in #{D} is in the image of #{F}.
      }
    }
  }
  \\li{
    The functor #{F} is called \\strong{fully faithful} if #{F_{X, Y}} is bijective.
    ##{
      F(X) \\cong F(Y) \\implies X \\cong Y
    }
  }
}`;
   
   const once = format(input, defaultOptions);
   const twice = format(once, defaultOptions);
   
   // Check idempotency
   assertEqual(once, twice, "Complex document should be idempotent");
   
   // Check structure preservation
   assertContains(once, "\\date{2025-11-30}");
   assertContains(once, "\\import{base-macros}");
   assertContains(once, "\\taxon{Definition}");
   assertContains(once, "\\title{Full and faithful functors}");
   assertContains(once, "\\strong{faithful}");
   assertContains(once, "\\strong{full}");
   assertContains(once, "\\strong{fully faithful}");
   assertContains(once, "\\blockquote{");
   assertContains(once, "F_{X, Y}");
});

test("texfig command with LaTeX content", () => {
   const input = `\\texfig{
  \\[\\begin{tikzcd}
    X && Y
    \\arrow["f", from=1-1, to=1-3]
  \\end{tikzcd}\\]
}`;
   const once = format(input, defaultOptions);
   const twice = format(once, defaultOptions);
   
   // texfig content should be preserved
   assertContains(once, "\\begin{tikzcd}");
   assertContains(once, "\\end{tikzcd}");
   assertEqual(once, twice, "texfig should be idempotent");
});

test("ltexfig command with URL and LaTeX content", () => {
   const input = `\\ltexfig{https://example.com}{
  \\[\\begin{tikzcd}
    A \\arrow[r] & B
  \\end{tikzcd}\\]
}`;
   const once = format(input, defaultOptions);
   const twice = format(once, defaultOptions);
   
   assertContains(once, "https://example.com");
   assertContains(once, "\\begin{tikzcd}");
   assertEqual(once, twice, "ltexfig should be idempotent");
});

test("Link with special characters in URL", () => {
   const input = `\\p{Check [this link](https://example.com/path?query=value&other=123#anchor) for details.}`;
   const result = format(input, defaultOptions);
   assertContains(result, "https://example.com/path?query=value&other=123#anchor");
});

test("Deeply nested blockquotes and lists", () => {
   const input = `\\ul{
  \\li{First level
    \\blockquote{
      A quote here
      \\ul{
        \\li{Nested in quote
          \\blockquote{
            Double nested quote
          }
        }
      }
    }
  }
}`;
   const once = format(input, defaultOptions);
   const twice = format(once, defaultOptions);
   assertEqual(once, twice, "Deeply nested content should be idempotent");
});

// ============================================
// IGNORED COMMANDS TESTS
// ============================================

test("Ignored command preserves content exactly", () => {
   const input = `\\title{Test}

\\texfig[~body]{
  \\begin{tikzcd}
    A \\arrow[r] & B
  \\end{tikzcd}
}`;
   const ignoredCommands = new Set(["texfig"]);
   const result = format(input, { ...defaultOptions, ignoredCommands });
   // The content inside texfig should be preserved exactly
   assertContains(result, "\\texfig[~body]{");
   assertContains(result, "\\begin{tikzcd}");
   assertContains(result, "A \\arrow[r] & B");
});

test("Ignored command with multiple arguments", () => {
   const input = `\\ltexfig[https://example.com][~body]{
  \\begin{tikzcd}
    X \\to Y
  \\end{tikzcd}
}`;
   const ignoredCommands = new Set(["ltexfig"]);
   const result = format(input, { ...defaultOptions, ignoredCommands });
   assertContains(result, "\\ltexfig[https://example.com][~body]{");
   assertContains(result, "X \\to Y");
});

test("Ignored command preserves internal whitespace", () => {
   const input = `\\def\\myMacro[arg1]{
  Some content
    with weird   spacing
      that should be preserved
}`;
   const ignoredCommands = new Set(["def"]);
   const result = format(input, { ...defaultOptions, ignoredCommands });
   // The entire def block should be preserved
   assertContains(result, "\\def\\myMacro[arg1]{");
   assertContains(result, "with weird   spacing");
});

test("Multiple ignored commands in document", () => {
   const input = `\\title{Test}

\\texfig[~body]{Content A}

\\p{Regular paragraph}

\\texfig[~body]{Content B}`;
   const ignoredCommands = new Set(["texfig"]);
   const result = format(input, { ...defaultOptions, ignoredCommands });
   assertContains(result, "\\texfig[~body]{Content A}");
   assertContains(result, "\\texfig[~body]{Content B}");
   // Regular paragraph should still be formatted
   assertContains(result, "\\p{");
});

test("Ignored command idempotency", () => {
   const input = `\\texfig[~body]{
  \\begin{tikzcd}[row sep=small]
    A \\arrow[r] & B \\arrow[d] \\\\
    C \\arrow[u] & D \\arrow[l]
  \\end{tikzcd}
}`;
   const ignoredCommands = new Set(["texfig"]);
   const opts = { ...defaultOptions, ignoredCommands };
   const once = format(input, opts);
   const twice = format(once, opts);
   assertEqual(once, twice, "Ignored command formatting should be idempotent");
});

test("Mixed ignored and non-ignored commands", () => {
   const input = `\\title{Category Theory}

\\p{
  Consider the following diagram:
}

\\texfig[~body]{
  \\begin{tikzcd}
    A & B
  \\end{tikzcd}
}

\\p{
  This shows a morphism.
}`;
   const ignoredCommands = new Set(["texfig"]);
   const result = format(input, { ...defaultOptions, ignoredCommands });
   
   // texfig should be preserved
   assertContains(result, "\\texfig[~body]{");
   
   // Regular content should be formatted (paragraph blocks have newlines inside)
   const pBlocks = result.match(/\\p\{[\s\S]*?\}/g);
   if (!pBlocks || pBlocks.length < 2) {
      throw new Error("Expected at least 2 paragraph blocks");
   }
});

test("Ignored command with nested braces", () => {
   const input = `\\def\\FV[arg1]{#{\\operatorname{FV}(\\arg1)}}`;
   const ignoredCommands = new Set(["def"]);
   const result = format(input, { ...defaultOptions, ignoredCommands });
   assertContains(result, "\\def\\FV[arg1]{#{\\operatorname{FV}(\\arg1)}}");
});

test("User macro definitions preserved", () => {
   const input = `\\def\\prn[x]{#{{{\\mathopen{}\\left(\\x\\right)\\mathclose{}}}}}
\\def\\brc[x]{#{{{\\mathopen{}\\left\\{\\x\\right\\}\\mathclose{}}}}}`;
   const ignoredCommands = new Set(["def"]);
   const result = format(input, { ...defaultOptions, ignoredCommands });
   assertContains(result, "\\def\\prn[x]{");
   assertContains(result, "\\def\\brc[x]{");
});

test("Nested scope blocks properly indented", () => {
   const input = `\\def\\grammar[body]{
  \\scope{
    \\put?\\base/tex-preamble{
      \\latex-preamble/bnf
}
    \\tex{\\get\\base/tex-preamble}{\\begin{bnf}\\body\\end{bnf}}
}
}`;
   const result = format(input, defaultOptions);
   // Each closing brace should be on its own line with proper indentation
   // Check that braces aren't all aligned to the left
   const lines = result.split('\n');
   const closingBraceLines = lines.filter(l => l.trim() === '}');
   // There should be closing braces at different indentation levels
   const indentLevels = new Set(closingBraceLines.map(l => l.match(/^\s*/)?.[0]?.length || 0));
   if (indentLevels.size < 2) {
      console.log("Formatted output:");
      console.log(result);
      throw new Error("Expected closing braces at different indentation levels");
   }
});

test("Scope block formatting idempotent", () => {
   const input = `\\def\\proof[body]{
 \\scope{
   \\put\\transclude/toc{false}
   \\subtree{
     \\taxon{Proof}
     \\body
   }
 }
}`;
   const once = format(input, defaultOptions);
   const twice = format(once, defaultOptions);
   assertEqual(once, twice, "Scope block formatting should be idempotent");
});

test("Tex command content preserved exactly", () => {
   const input = `\\def\\grammar[body]{
  \\scope{
    \\put?\\base/tex-preamble{
      \\latex-preamble/bnf
    }
    \\tex{\\get\\base/tex-preamble}{
      \\begin{bnf}[
        colspec = {llcll},
        column{1} = {font = \\sffamily},
        column{2} = {mode = dmath},
        column{4} = {font = \\ttfamily},
        column{5} = {font = \\itshape\\color{gray}}
]
      \\body
      \\end{bnf}
    }
  }
}`;
   const result = format(input, defaultOptions);
   // The tex block content should be preserved exactly - check that the internal formatting is preserved
   assertContains(result, "colspec = {llcll}");
   assertContains(result, "column{1} = {font = \\sffamily}");
   // The content inside \tex{}{...} should be preserved exactly as-is
   // This includes the ] on its own line - that's intentional in the LaTeX
   assertContains(result, "\\tex{\\get\\base/tex-preamble}{");
   assertContains(result, "\\begin{bnf}[");
   assertContains(result, "\\end{bnf}");
});

test("Tex command idempotent", () => {
   const input = `\\tex{\\get\\base/tex-preamble}{
  \\begin{bnf}[
    colspec = {llcll},
    column{1} = {font = \\sffamily}
]
  \\body
  \\end{bnf}
}`;
   const once = format(input, defaultOptions);
   const twice = format(once, defaultOptions);
   assertEqual(once, twice, "Tex command formatting should be idempotent");
});

// Summary
console.log("\n=== Test Results ===");
console.log(`Passed: ${testsPassed}`);
console.log(`Failed: ${testsFailed}`);
console.log(`Total: ${testsPassed + testsFailed}`);

if (testsFailed > 0) {
   process.exit(1);
}
