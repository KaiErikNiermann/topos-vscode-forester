import * as vscode from "vscode";
import { getIgnoredCommandsSync } from "./formatter-config";

/**
 * A document formatter for Forester (.tree) files.
 * 
 * Formatting rules:
 * - Consistent indentation (configurable, defaults to 2 spaces)
 * - Proper spacing around commands
 * - Newlines before top-level commands (\title, \taxon, \author, etc.)
 * - Preserve content within verbatim blocks
 * - Preserve math content
 * - Preserve content within user-defined macros (from config)
 */

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
// These commands contain LaTeX or other content that should not be reformatted
const TEX_CONTENT_COMMANDS = [
   "tex"
];

// Commands that should remain inline (single-line content)
const INLINE_BLOCK_COMMANDS = [
   "transclude", "code", "ref", "em", "strong"
];

// Inline formatting commands
const INLINE_COMMANDS = [
   "em", "strong", "ref"
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
 * This handles commands like \texfig[~body]{...} or \def\name[arg]{...}
 * Returns the end position after consuming all brackets and braces.
 */
function extractIgnoredBlockContent(text: string, startPos: number): { content: string; endPos: number } {
   let i = startPos;
   let content = "";
   
   // Consume all consecutive parts until we've consumed at least one brace block
   // or there's nothing more to consume
   let consumedBrace = false;
   
   while (i < text.length) {
      // Skip whitespace between arguments (preserve it)
      while (i < text.length && /[ \t]/.test(text[i])) {
         content += text[i];
         i++;
      }
      
      if (i >= text.length) break;
      
      if (text[i] === "[") {
         // Bracket argument
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
         // Brace argument - this is usually the last/main content block
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
         // After consuming a brace block, check if more arguments follow
         // (some commands have multiple brace arguments)
         continue;
      } else if (text[i] === "\\" && !consumedBrace) {
         // For \def\macroName style, consume the following command name
         content += text[i];
         i++;
         // Consume command name characters
         while (i < text.length && /[A-Za-z0-9\-]/.test(text[i])) {
            content += text[i];
            i++;
         }
      } else {
         // No more arguments
         break;
      }
   }
   
   return { content, endPos: i };
}

/**
 * Normalize indentation in multi-line math blocks.
 * For single-line math, return as-is.
 * For multi-line math, ensure consistent indentation relative to the opening ##{ or #{.
 */
function normalizeMultilineMath(mathBlock: string, baseIndent: string, indentUnit: string): string {
   // Check if it's a display math block
   const isDisplay = mathBlock.startsWith("##{");
   const prefix = isDisplay ? "##{" : "#{";
   
   // Extract content between the braces
   const content = mathBlock.slice(prefix.length, -1); // Remove ##{ or #{ and final }
   
   // If content doesn't contain newlines, return as-is
   if (!content.includes("\n")) {
      return mathBlock;
   }
   
   // Split into lines
   const lines = content.split("\n");
   
   // Find the minimum indentation of non-empty lines (excluding the first line which follows ##{ directly)
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
   
   // Reconstruct with normalized indentation
   // The content should be indented one level from the base
   const contentIndent = baseIndent + indentUnit;
   
   const normalizedLines: string[] = [];
   for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0) {
         // First line follows directly after ##{
         if (line.trim().length === 0) {
            normalizedLines.push("");
         } else {
            normalizedLines.push(line.trim());
         }
      } else {
         // Subsequent lines: strip minIndent and add contentIndent
         if (line.trim().length === 0) {
            normalizedLines.push("");
         } else {
            const stripped = line.slice(minIndent);
            normalizedLines.push(contentIndent + stripped.trim());
         }
      }
   }
   
   // Check if the last line is empty or just whitespace (the closing brace will be on its own line)
   const lastLine = normalizedLines[normalizedLines.length - 1];
   if (lastLine.trim().length === 0) {
      // The closing } should be on the same line as baseIndent
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
            // Find the end of the \startverb line (could have %tex or similar)
            let startEnd = i + 10; // length of "\\startverb"
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
            i = endIndex + 9; // length of "\\stopverb"
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
         // Check for escaped characters
         if (i + 1 < text.length && (text[i + 1] === "%" || text[i + 1] === "\\")) {
            tokens.push({ type: "text", value: text.slice(i, i + 2) });
            i += 2;
            continue;
         }

         // XML element \<name>
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

         // Regular command
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
            // Just a backslash followed by something else
            tokens.push({ type: "text", value: "\\" });
            i++;
            continue;
         }
      }

      // Braces
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

      // Brackets
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

      // Parentheses
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

      // Newlines
      if (text[i] === "\n") {
         tokens.push({ type: "newline", value: "\n" });
         i++;
         continue;
      }

      // Whitespace (excluding newlines)
      if (/[ \t\r]/.test(text[i])) {
         let j = i;
         while (j < text.length && /[ \t\r]/.test(text[j])) {
            j++;
         }
         tokens.push({ type: "whitespace", value: text.slice(i, j) });
         i = j;
         continue;
      }

      // Regular text
      let j = i;
      while (j < text.length && !/[\\{}\[\]()%\n\r\t #]/.test(text[j])) {
         j++;
      }
      // Also include # if not followed by { or #
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
         // Single character that didn't match anything else
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

   // Track if we're inside certain contexts
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

   function currentContext(): string | undefined {
      return contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined;
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

      // Handle verbatim blocks - preserve exactly as-is
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
               // Comment at end of line - add space before
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
            // Limit consecutive blank lines to 1
            if (consecutiveNewlines <= 2) {
               result += "\n";
            }
            lineStart = true;
            lastWasNewline = true;
            lastWasCommand = false;
            break;

         case "whitespace":
            // Convert whitespace to single space, unless at start of line
            if (!lineStart && !lastWasNewline) {
               // Don't add space right after opening brace/bracket or before closing
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

            // Top-level commands should start on a new line
            if (isTopLevelCommand(cmdName)) {
               if (!lineStart && !lastWasNewline) {
                  result += "\n";
                  lineStart = true;
               }
               // Add blank line before certain commands if not at start
               if (result.length > 0 && !result.endsWith("\n\n") && consecutiveNewlines < 2) {
                  // Only add blank line before metadata commands after content
                  if (depth === 0 && contextStack.length === 0) {
                     // result += "\n";
                  }
               }
            }

            // Block commands at depth 0 should start on a new line
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

            // For block commands, put closing brace on new line
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
               // Remove trailing space before closing brace
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
            // For multi-line math blocks, normalize the indentation
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

   // Ensure file ends with single newline
   result = result.trimEnd() + "\n";

   return result;
}

export class ForesterDocumentFormattingEditProvider implements vscode.DocumentFormattingEditProvider {
   provideDocumentFormattingEdits(
      document: vscode.TextDocument,
      options: vscode.FormattingOptions,
      _token: vscode.CancellationToken
   ): vscode.TextEdit[] {
      const text = document.getText();
      const ignoredCommands = getIgnoredCommandsSync();
      const formatted = format(text, {
         tabSize: options.tabSize,
         insertSpaces: options.insertSpaces,
         ignoredCommands
      });

      if (text === formatted) {
         return [];
      }

      const fullRange = new vscode.Range(
         document.positionAt(0),
         document.positionAt(text.length)
      );

      return [vscode.TextEdit.replace(fullRange, formatted)];
   }
}

export class ForesterDocumentRangeFormattingEditProvider implements vscode.DocumentRangeFormattingEditProvider {
   provideDocumentRangeFormattingEdits(
      document: vscode.TextDocument,
      range: vscode.Range,
      options: vscode.FormattingOptions,
      _token: vscode.CancellationToken
   ): vscode.TextEdit[] {
      // For range formatting, we need to be careful about context
      // For simplicity, we'll format the whole document and return only the changes in the range
      // This ensures proper indentation based on context

      const text = document.getText();
      const ignoredCommands = getIgnoredCommandsSync();
      const formatted = format(text, {
         tabSize: options.tabSize,
         insertSpaces: options.insertSpaces,
         ignoredCommands
      });

      if (text === formatted) {
         return [];
      }

      // Get the formatted text for the selected range
      const startOffset = document.offsetAt(range.start);
      const endOffset = document.offsetAt(range.end);

      // Find corresponding positions in formatted text
      // This is a simplified approach - we replace the whole document
      const fullRange = new vscode.Range(
         document.positionAt(0),
         document.positionAt(text.length)
      );

      return [vscode.TextEdit.replace(fullRange, formatted)];
   }
}

// Export for testing
export { format, tokenize, FormatOptions };
