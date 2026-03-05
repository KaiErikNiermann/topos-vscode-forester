/**
 * Core formatter logic for Forester .tree files
 * 
 * This module contains pure formatting functions without any VS Code dependencies,
 * allowing it to be used both in the VS Code extension and in standalone tests.
 */

import { match, P } from "ts-pattern";

// Top-level metadata commands that should be on their own line
export const TOP_LEVEL_COMMANDS: readonly string[] = [
    "title", "taxon", "author", "contributor", "date", "parent", "tag", "meta", "number",
    "import", "export", "namespace", "def", "let", "alloc", "open", "solution"
];

// Block-level commands that typically contain multi-line content
export const BLOCK_COMMANDS: readonly string[] = [
    "p", "ul", "ol", "li", "blockquote", "pre", "subtree", "query", "solution",
    "texfig", "ltexfig", "scope", "figure"
];

// Commands whose content should be preserved exactly (like \tex{preamble}{content})
// \texfig and \ltexfig contain LaTeX/TikZ that must not be reformatted
export const TEX_CONTENT_COMMANDS: readonly string[] = ["tex", "texfig", "ltexfig"];

// Commands where the last brace argument contains code/content that should be preserved
// but the command itself should be properly formatted (indented, on its own line)
export const CODE_CONTENT_COMMANDS: readonly string[] = ["codeblock", "pre"];

// Token types
export type TokenType =
    | "command" | "text" | "brace_open" | "brace_close" | "bracket_open" | "bracket_close"
    | "paren_open" | "paren_close" | "comment" | "whitespace" | "newline" | "math_inline"
    | "math_display" | "verbatim_start" | "verbatim_end" | "verbatim_content" | "ignored_block";

export interface Token {
    type: TokenType;
    value: string;
    commandName?: string;
}

export interface FormatOptions {
    tabSize?: number;
    insertSpaces?: boolean;
    ignoredCommands?: Set<string>;
    subtreeMacros?: Set<string>;
}

/**
 * Check if a command should have its content ignored/preserved
 */
export function isIgnoredCommand(commandName: string, ignoredCommands: Set<string>): boolean {
    return ignoredCommands.has(commandName);
}

/**
 * Consume a balanced bracket/brace block from text starting at position i.
 * Returns the consumed content and new position.
 */
function consumeBalancedBlock(
    text: string, 
    startPos: number, 
    openChar: string, 
    closeChar: string
): { content: string; endPos: number } {
    let i = startPos;
    let content = openChar;
    let depth = 1;
    i++; // Skip opening char
    
    while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === openChar) { depth++; }
        else if (ch === closeChar) { depth--; }
        content += ch;
        i++;
    }
    
    return { content, endPos: i };
}

/**
 * Skip whitespace characters in text from startPos.
 * Returns consumed whitespace and new position.
 */
function skipWhitespace(
    text: string, 
    startPos: number, 
    pattern: RegExp = /[ \t]/
): { whitespace: string; endPos: number } {
    let i = startPos;
    let whitespace = "";
    while (i < text.length && pattern.test(text[i])) {
        whitespace += text[i];
        i++;
    }
    return { whitespace, endPos: i };
}

/**
 * Consume a command name (alphanumeric, hyphens) starting with backslash.
 */
function consumeCommandName(text: string, startPos: number): { content: string; endPos: number } {
    let i = startPos;
    let content = "\\";
    i++; // Skip backslash
    while (i < text.length && /[A-Za-z0-9\-]/.test(text[i])) {
        content += text[i];
        i++;
    }
    return { content, endPos: i };
}

/**
 * Extract the full block content for an ignored command, including all its arguments.
 */
export function extractIgnoredBlockContent(text: string, startPos: number): { content: string; endPos: number } {
    let i = startPos;
    let content = "";
    let consumedBrace = false;

    while (i < text.length) {
        // Skip whitespace (including newlines) between arguments
        const ws = skipWhitespace(text, i, /[\s]/);
        content += ws.whitespace;
        i = ws.endPos;

        if (i >= text.length) { break; }

        if (text[i] === "[") {
            const block = consumeBalancedBlock(text, i, "[", "]");
            content += block.content;
            i = block.endPos;
        } else if (text[i] === "{") {
            const block = consumeBalancedBlock(text, i, "{", "}");
            content += block.content;
            i = block.endPos;
            consumedBrace = true;
            continue;
        } else if (text[i] === "\\" && !consumedBrace) {
            // For \def\macroName style, consume the following command name
            const cmd = consumeCommandName(text, i);
            content += cmd.content;
            i = cmd.endPos;
        } else {
            break;
        }
    }

    return { content, endPos: i };
}

/**
 * Extract the content of a code content block (like \codeblock{lang}{content})
 * Returns just the final brace-delimited content block.
 */
export function extractCodeContentBlock(text: string, startPos: number): { content: string; endPos: number; fullMatch: string } {
    let i = startPos;
    let fullMatch = "";

    // Skip whitespace between arguments
    const ws1 = skipWhitespace(text, i);
    fullMatch += ws1.whitespace;
    i = ws1.endPos;

    // First, consume the language argument {lang}
    if (i < text.length && text[i] === "{") {
        const block = consumeBalancedBlock(text, i, "{", "}");
        fullMatch += block.content;
        i = block.endPos;
    }

    // Skip whitespace/newlines between language and content
    const ws2 = skipWhitespace(text, i, /[\s]/);
    fullMatch += ws2.whitespace;
    i = ws2.endPos;

    // Now extract the actual code content block
    if (i < text.length && text[i] === "{") {
        const block = consumeBalancedBlock(text, i, "{", "}");
        fullMatch += block.content;
        return { content: block.content, endPos: block.endPos, fullMatch };
    }

    return { content: "", endPos: i, fullMatch };
}

/**
 * Normalize indentation of a code block
 * Preserves relative indentation within the block while adjusting base indentation
 * Format: {<content on same line or newline>
 *   <indented code>
 * }
 */
export function normalizeCodeBlock(codeBlock: string, baseIndent: string, indentUnit: string): string {
    // Parse the code block - format is { ... } or {\n ... \n}
    const trimmed = codeBlock.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
        return "{" + codeBlock + "}";
    }

    // Extract the content between braces
    const inner = trimmed.slice(1, -1);

    // Split into lines and analyze
    const lines = inner.split("\n");

    // If single-line content (no newlines), keep it inline: {content}
    if (lines.length === 1) {
        const content = lines[0].trim();
        if (content === "") {
            return "{\n" + baseIndent + "}";
        }
        // Single line content - keep inline if short enough
        return "{\n" + baseIndent + indentUnit + content + "\n" + baseIndent + "}";
    }

    // Multi-line content: find minimum indentation (ignoring empty lines)
    let minIndent = Infinity;
    const nonEmptyLines: { line: string; index: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") { continue; }

        const match = line.match(/^([ \t]*)/);
        const indent = match ? match[1].length : 0;
        minIndent = Math.min(minIndent, indent);
        nonEmptyLines.push({ line, index: i });
    }

    if (minIndent === Infinity) { minIndent = 0; }

    // Build normalized content with proper indentation
    const contentIndent = baseIndent + indentUnit;
    const normalizedLines: string[] = [];

    // Opening brace on same line (no baseIndent - it follows \codeblock{lang})
    normalizedLines.push("{");

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") {
            // Preserve empty lines within content
            if (i > 0 && i < lines.length - 1) {
                normalizedLines.push("");
            }
        } else {
            // Strip the common minimum indentation and add our base indentation
            const stripped = line.slice(minIndent);
            normalizedLines.push(contentIndent + stripped.trimEnd());
        }
    }

    // Closing brace on its own line at base indentation
    normalizedLines.push(baseIndent + "}");

    return normalizedLines.join("\n");
}

/**
 * Normalize multi-line math indentation.
 * Handles ##{...} format.
 */
export function normalizeMultilineMath(mathBlock: string, currentIndent: string, indentUnit: string): string {
    // Split the math block into lines
    const lines = mathBlock.split("\n");

    // If single line, return as-is
    if (lines.length <= 1) {
        return mathBlock;
    }

    // First line includes ##{ and potentially content
    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1];

    // Check if this is brace-delimited: ##{...}
    if (!firstLine.startsWith("##{")) {
        return mathBlock; // Not a valid math block
    }

    // Find minimum indentation of content lines (excluding first and last)
    let minIndent = Infinity;
    for (let i = 1; i < lines.length - 1; i++) {
        const line = lines[i];
        if (line.trim() === "") { continue; }
        const match = line.match(/^([ \t]*)/);
        const indent = match ? match[1].length : 0;
        minIndent = Math.min(minIndent, indent);
    }

    if (minIndent === Infinity) { minIndent = 0; }

    // Build normalized output
    const result: string[] = [];
    const contentIndent = currentIndent + indentUnit;

    // First line - ##{ with any inline content
    result.push(firstLine.trimEnd());

    // Middle lines - normalize indentation
    for (let i = 1; i < lines.length - 1; i++) {
        const line = lines[i];
        if (line.trim() === "") {
            result.push("");
        } else {
            const stripped = line.slice(minIndent);
            result.push(contentIndent + stripped.trimEnd());
        }
    }

    // Last line - closing }
    if (lastLine.trim() === "}") {
        result.push(currentIndent + "}");
    } else {
        // Last line has content before the closing brace
        const stripped = lastLine.slice(minIndent);
        result.push(contentIndent + stripped.trimEnd());
    }

    return result.join("\n");
}

/**
 * Tokenize forester source code into a stream of tokens.
 */
export function tokenize(text: string, options: FormatOptions = {}): Token[] {
    const tokens: Token[] = [];
    const ignoredCommands = options.ignoredCommands || new Set<string>();
    let i = 0;

    // Track braces and commands to detect when a command's arguments are complete
    const commandStack: { name: string; braceDepth: number; bracketsSeen: number; bracesSeen: number }[] = [];
    let globalBraceDepth = 0;

    while (i < text.length) {
        // Track newlines
        if (text[i] === "\n") {
            tokens.push({ type: "newline", value: "\n" });
            i++;
            continue;
        }

        // Whitespace (not newlines)
        if (/[ \t]/.test(text[i])) {
            let ws = "";
            while (i < text.length && /[ \t]/.test(text[i])) {
                ws += text[i];
                i++;
            }
            tokens.push({ type: "whitespace", value: ws });
            continue;
        }

        // Comments - everything from % to end of line
        if (text[i] === "%") {
            let comment = "";
            while (i < text.length && text[i] !== "\n") {
                comment += text[i];
                i++;
            }
            tokens.push({ type: "comment", value: comment });
            continue;
        }

        // Verbatim blocks ```...```
        if (text.slice(i, i + 3) === "```") {
            // Find the end of opening ``` (may have language after it)
            let j = i + 3;
            while (j < text.length && text[j] !== "\n") {
                j++;
            }
            const openingLine = text.slice(i, j);
            tokens.push({ type: "verbatim_start", value: openingLine });
            i = j;

            // Consume content until closing ```
            let content = "";
            if (text[i] === "\n") {
                content += text[i];
                i++;
            }
            while (i < text.length) {
                if (text.slice(i, i + 3) === "```" && (i === 0 || text[i - 1] === "\n")) {
                    break;
                }
                content += text[i];
                i++;
            }
            tokens.push({ type: "verbatim_content", value: content });

            // Consume closing ```
            if (text.slice(i, i + 3) === "```") {
                let endLine = "```";
                i += 3;
                while (i < text.length && text[i] !== "\n") {
                    endLine += text[i];
                    i++;
                }
                tokens.push({ type: "verbatim_end", value: endLine });
            }
            continue;
        }

        // Display math: ##{...}
        if (text.slice(i, i + 3) === "##{") {
            let math = "##{";
            i += 3;
            let braceDepth = 1;
            while (i < text.length && braceDepth > 0) {
                if (text[i] === "{") {
                    braceDepth++;
                } else if (text[i] === "}") {
                    braceDepth--;
                }
                math += text[i];
                i++;
            }
            tokens.push({ type: "math_display", value: math });
            continue;
        }

        // Inline math: #{...}
        if (text.slice(i, i + 2) === "#{") {
            let math = "#{";
            i += 2;
            let braceDepth = 1;
            while (i < text.length && braceDepth > 0) {
                const ch = text[i];
                math += ch;
                if (ch === "{") { braceDepth++; }
                else if (ch === "}") { braceDepth--; }
                i++;
            }
            tokens.push({ type: "math_inline", value: math });
            continue;
        }

        // Commands - \commandname
        if (text[i] === "\\") {
            // Escaped percent - treat as literal text to avoid starting a comment
            if (text[i + 1] === "%") {
                tokens.push({ type: "text", value: "\\%" });
                i += 2;
                continue;
            }

            let cmd = "\\";
            i++;
            // Command name: alphanumeric, hyphens, slashes, and question marks
            while (i < text.length && /[A-Za-z0-9\-\/\?]/.test(text[i])) {
                cmd += text[i];
                i++;
            }

            if (cmd.length > 1) {
                const cmdName = cmd.slice(1); // Remove backslash

                // Check if this is a tex content command (like \tex{preamble}{content})
                if (TEX_CONTENT_COMMANDS.includes(cmdName)) {
                    // Extract all the arguments and preserve them exactly
                    const { content, endPos } = extractIgnoredBlockContent(text, i);
                    tokens.push({ type: "command", value: cmd, commandName: cmdName });
                    tokens.push({ type: "ignored_block", value: content, commandName: "tex_content" });
                    i = endPos;
                    continue;
                }

                // Check if this is a code content command (like \codeblock{lang}{content})
                if (CODE_CONTENT_COMMANDS.includes(cmdName)) {
                    // Emit the command token
                    tokens.push({ type: "command", value: cmd, commandName: cmdName });

                    // Skip whitespace between command and first arg
                    while (i < text.length && /[ \t]/.test(text[i])) {
                        i++;
                    }

                    // Consume the language argument {lang}
                    if (i < text.length && text[i] === "{") {
                        let langArg = "{";
                        let depth = 1;
                        i++;
                        while (i < text.length && depth > 0) {
                            if (text[i] === "{") { depth++; }
                            else if (text[i] === "}") { depth--; }
                            langArg += text[i];
                            i++;
                        }
                        tokens.push({ type: "brace_open", value: "{" });
                        // Extract content without braces
                        const langContent = langArg.slice(1, -1);
                        if (langContent) {
                            tokens.push({ type: "text", value: langContent });
                        }
                        tokens.push({ type: "brace_close", value: "}" });
                        globalBraceDepth++; // Account for the open
                        globalBraceDepth--; // Account for the close
                    }

                    // Skip whitespace/newlines between language and content
                    // Don't emit newline tokens here - they would reset line tracking state
                    // The code_content block will be properly indented based on the \codeblock line
                    while (i < text.length && /[\s]/.test(text[i])) {
                        i++;
                    }

                    // Now extract the code content block as an ignored block
                    if (i < text.length && text[i] === "{") {
                        let codeContent = "{";
                        let depth = 1;
                        i++;
                        while (i < text.length && depth > 0) {
                            if (text[i] === "{") { depth++; }
                            else if (text[i] === "}") { depth--; }
                            codeContent += text[i];
                            i++;
                        }
                        tokens.push({ type: "ignored_block", value: codeContent, commandName: "code_content" });
                    }
                    continue;
                }

                // Check if this command should be ignored (like \startverb...\stopverb)
                if (isIgnoredCommand(cmdName, ignoredCommands)) {
                    // Extract all the arguments and preserve them exactly
                    const { content, endPos } = extractIgnoredBlockContent(text, i);
                    tokens.push({ type: "command", value: cmd, commandName: cmdName });
                    tokens.push({ type: "ignored_block", value: content, commandName: cmdName });
                    i = endPos;
                    continue;
                }

                tokens.push({ type: "command", value: cmd, commandName: cmdName });

                // Track this command for potential block detection
                commandStack.push({ name: cmdName, braceDepth: globalBraceDepth, bracketsSeen: 0, bracesSeen: 0 });
            } else {
                // Just a backslash
                tokens.push({ type: "text", value: cmd });
            }
            continue;
        }

        // Braces
        if (text[i] === "{") {
            tokens.push({ type: "brace_open", value: "{" });
            globalBraceDepth++;
            // Update command tracking
            if (commandStack.length > 0) {
                commandStack[commandStack.length - 1].bracesSeen++;
            }
            i++;
            continue;
        }

        if (text[i] === "}") {
            tokens.push({ type: "brace_close", value: "}" });
            globalBraceDepth = Math.max(0, globalBraceDepth - 1);
            // Pop completed commands
            while (commandStack.length > 0 && globalBraceDepth < commandStack[commandStack.length - 1].braceDepth + 1) {
                commandStack.pop();
            }
            i++;
            continue;
        }

        // Brackets
        if (text[i] === "[") {
            tokens.push({ type: "bracket_open", value: "[" });
            if (commandStack.length > 0) {
                commandStack[commandStack.length - 1].bracketsSeen++;
            }
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

        // Regular text - consume until special character
        // Note: # is only special when followed by { (for math), so we check for #{
        // rather than stopping at any #
        let textContent = "";
        while (i < text.length && text.slice(i, i + 3) !== "```") {
            const ch = text[i];
            // Stop at known special characters (but not #)
            if (/[\\\{\}\[\]\(\)%\n\t ]/.test(ch)) {
                break;
            }
            // Stop at # only if it starts a math expression (followed by { or #{)
            if (ch === "#") {
                if (text[i + 1] === "{" || text.slice(i, i + 3) === "##{") {
                    break;
                }
            }
            textContent += ch;
            i++;
        }

        if (textContent) {
            tokens.push({ type: "text", value: textContent });
        }
    }

    return tokens;
}

/**
 * Format forester source code.
 */
export function format(text: string, options: FormatOptions = {}): string {
    const tabSize = options.tabSize ?? 2;
    const insertSpaces = options.insertSpaces ?? true;
    const indent = insertSpaces ? " ".repeat(tabSize) : "\t";
    const subtreeMacros = options.subtreeMacros || new Set<string>();

    const tokens = tokenize(text, options);

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

    // Get the indentation of the current/last line in result
    function getLastLineIndent(): string {
        const lastNewline = result.lastIndexOf("\n");
        if (lastNewline === -1) {
            // No newline yet, get leading whitespace of entire result
            const match = result.match(/^([ \t]*)/);
            return match ? match[1] : "";
        }
        const lastLine = result.slice(lastNewline + 1);
        const match = lastLine.match(/^([ \t]*)/);
        return match ? match[1] : "";
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
        return BLOCK_COMMANDS.includes(name) || subtreeMacros.has(name);
    }

    // Track the most recent command that could introduce a block body, even through optional args
    let pendingBlockCommand: string | null = null;

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

        // Pattern-matched token handling
        match(token)
            .with({ type: "ignored_block", commandName: "code_content" }, (t) => {
                // Handle code content blocks - normalize their indentation
                const baseIndent = getLastLineIndent();
                const normalizedCode = normalizeCodeBlock(t.value, baseIndent, indent);
                result += normalizedCode;
                lineStart = false;
                lastWasNewline = t.value.endsWith("\n");
                lastWasCommand = false;
                consecutiveNewlines = 0;
                pendingBlockCommand = null;
            })
            .with({ type: "ignored_block" }, (t) => {
                // Preserve other ignored blocks exactly as-is
                if (lineStart) {
                    result += currentIndent();
                }
                result += t.value;
                lineStart = false;
                lastWasNewline = t.value.endsWith("\n");
                lastWasCommand = false;
                consecutiveNewlines = 0;
                pendingBlockCommand = null;
            })
            .with({ type: "comment" }, (t) => {
                if (!lineStart) {
                    if (!lastWasNewline && result.length > 0 && !result.endsWith(" ")) {
                        result += " ";
                    }
                } else {
                    result += currentIndent();
                }
                result += t.value;
                lineStart = false;
                lastWasNewline = false;
                lastWasCommand = false;
                consecutiveNewlines = 0;
            })
            .with({ type: "newline" }, () => {
                consecutiveNewlines++;
                if (consecutiveNewlines <= 2) {
                    result += "\n";
                }
                lineStart = true;
                lastWasNewline = true;
                lastWasCommand = false;
            })
            .with({ type: "whitespace" }, () => {
                // Convert whitespace to single space, unless at start of line
                if (!lineStart && !lastWasNewline && lastCommandName !== "def") {
                    const afterOpening = prevToken && ["brace_open", "bracket_open", "paren_open"].includes(prevToken.type);
                    const beforeClosing = nextToken && ["brace_close", "bracket_close", "paren_close"].includes(nextToken.type);
                    if (!afterOpening && !beforeClosing && !result.endsWith(" ") && !result.endsWith("\n")) {
                        result += " ";
                    }
                }
            })
            .with({ type: "command" }, (t) => {
                const cmdName = t.commandName || "";
                pendingBlockCommand = isBlockCommand(cmdName) ? cmdName : null;
                const isAfterDef = lastCommandName === "def";

                // Top-level commands should start on a new line
                if (isTopLevelCommand(cmdName) && !isAfterDef && !lineStart && !lastWasNewline) {
                    result += "\n";
                    lineStart = true;
                }

                // Block commands at depth 0 should start on a new line
                if (isBlockCommand(cmdName) && depth === 0 && !lineStart && !isAfterDef) {
                    result += "\n";
                    lineStart = true;
                }

                if (lineStart) {
                    result += currentIndent();
                }

                result += t.value;
                lineStart = false;
                lastWasNewline = false;
                lastWasCommand = true;
                lastCommandName = cmdName;
                consecutiveNewlines = 0;
            })
            .with({ type: "brace_open" }, () => {
                result += "{";
                depth++;
                const braceContext = pendingBlockCommand || (lastWasCommand ? lastCommandName : "brace");
                pushContext(braceContext || "brace");

                if (braceContext && isBlockCommand(braceContext)) {
                    if (nextToken && nextToken.type !== "newline") {
                        result += "\n";
                        lineStart = true;
                        lastWasNewline = true;
                    } else {
                        lineStart = false;
                        lastWasNewline = false;
                    }
                } else {
                    lineStart = false;
                    lastWasNewline = false;
                }

                lastWasCommand = false;
                pendingBlockCommand = null;
                consecutiveNewlines = 0;
            })
            .with({ type: "brace_close" }, () => {
                depth = Math.max(0, depth - 1);
                const ctx = popContext();

                if (ctx && isBlockCommand(ctx)) {
                    // Remove trailing whitespace
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
                    result += (lineStart || result.endsWith("\n")) ? currentIndent() + "}" : "}";
                }

                lineStart = false;
                lastWasNewline = false;
                lastWasCommand = false;
                consecutiveNewlines = 0;
            })
            .with({ type: "bracket_open" }, () => {
                if (lineStart) {
                    result += currentIndent();
                }
                result += "[";
                // Note: brackets do NOT affect indentation depth - only braces do
                // This is important for markdown-style links like [text](url) in content
                pushContext("bracket");
                lineStart = false;
                lastWasNewline = false;
                lastWasCommand = false;
                consecutiveNewlines = 0;
            })
            .with({ type: "bracket_close" }, () => {
                // Note: brackets do NOT affect indentation depth
                popContext();
                if (result.endsWith(" ")) {
                    result = result.slice(0, -1);
                }
                result += "]";
                lineStart = false;
                lastWasNewline = false;
                lastWasCommand = false;
                consecutiveNewlines = 0;
            })
            .with({ type: "paren_open" }, () => {
                if (lineStart) {
                    result += currentIndent();
                }
                result += "(";
                lineStart = false;
                lastWasNewline = false;
                lastWasCommand = false;
                consecutiveNewlines = 0;
            })
            .with({ type: "paren_close" }, () => {
                if (result.endsWith(" ")) {
                    result = result.slice(0, -1);
                }
                result += ")";
                lineStart = false;
                lastWasNewline = false;
                lastWasCommand = false;
                consecutiveNewlines = 0;
            })
            .with({ type: "math_inline" }, (t) => {
                if (lineStart) {
                    result += currentIndent();
                }
                result += t.value;
                lineStart = false;
                lastWasNewline = false;
                lastWasCommand = false;
                consecutiveNewlines = 0;
            })
            .with({ type: "math_display" }, (t) => {
                if (lineStart) {
                    result += currentIndent();
                }
                result += normalizeMultilineMath(t.value, currentIndent(), indent);
                lineStart = false;
                lastWasNewline = false;
                lastWasCommand = false;
                consecutiveNewlines = 0;
            })
            .with({ type: "text" }, (t) => {
                if (lineStart) {
                    result += currentIndent();
                }
                result += t.value;
                lineStart = false;
                lastWasNewline = false;
                lastWasCommand = false;
                consecutiveNewlines = 0;
            })
            .otherwise(() => {
                // Verbatim tokens already handled above
            });
    }

    // Ensure file ends with single newline
    result = result.trimEnd() + "\n";

    return result;
}

/**
 * Normalize text for comparison: remove whitespace differences that don't affect content
 */
export function normalizeForComparison(text: string): string {
    return text
        // Normalize line endings
        .replace(/\r\n/g, "\n")
        // Remove trailing whitespace on lines
        .replace(/[ \t]+$/gm, "")
        // Collapse multiple blank lines into one
        .replace(/\n{3,}/g, "\n\n")
        // Remove leading/trailing whitespace
        .trim();
}

/**
 * Extract "content tokens" from text for preservation checking.
 * This extracts words, numbers, and significant punctuation, ignoring whitespace.
 * Used as a heuristic to detect if content was lost during formatting.
 */
export function extractContentTokens(text: string): string[] {
    const tokens: string[] = [];

    // Match words (including LaTeX commands like \strong), numbers
    const wordRegex = /\\?[a-zA-Z_][a-zA-Z0-9_-]*/g;
    const numberRegex = /\d+(?:\.\d+)?/g;

    // Extract words/commands
    let match;
    while ((match = wordRegex.exec(text)) !== null) {
        tokens.push(match[0]);
    }

    // Extract numbers
    while ((match = numberRegex.exec(text)) !== null) {
        tokens.push(match[0]);
    }

    return tokens;
}

/**
 * Check if content was preserved during formatting.
 * Returns { preserved: true } if content is preserved, or { preserved: false, details: string } if not.
 */
export function checkContentPreservation(original: string, formatted: string): { preserved: boolean; details?: string } {
    // Quick check: if normalized versions are equal, definitely preserved
    const normOriginal = normalizeForComparison(original);
    const normFormatted = normalizeForComparison(formatted);

    if (normOriginal === normFormatted) {
        return { preserved: true };
    }

    // Extract content tokens and compare
    const originalTokens = extractContentTokens(original);
    const formattedTokens = extractContentTokens(formatted);

    // Check if any tokens are missing
    const originalSet = new Set(originalTokens);
    const formattedSet = new Set(formattedTokens);

    const missingTokens: string[] = [];
    for (const token of originalTokens) {
        if (!formattedSet.has(token)) {
            missingTokens.push(token);
        }
    }

    const extraTokens: string[] = [];
    for (const token of formattedTokens) {
        if (!originalSet.has(token)) {
            extraTokens.push(token);
        }
    }

    // If we have missing or extra tokens, content may be lost
    if (missingTokens.length > 0 || extraTokens.length > 0) {
        const details: string[] = [];
        if (missingTokens.length > 0) {
            details.push(`Missing: ${missingTokens.slice(0, 10).join(", ")}${missingTokens.length > 10 ? "..." : ""}`);
        }
        if (extraTokens.length > 0) {
            details.push(`Extra: ${extraTokens.slice(0, 10).join(", ")}${extraTokens.length > 10 ? "..." : ""}`);
        }
        return { preserved: false, details: details.join("; ") };
    }

    return { preserved: true };
}
