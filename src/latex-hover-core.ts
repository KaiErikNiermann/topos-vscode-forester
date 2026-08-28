import { match } from "ts-pattern";
import { rawGroupEnd } from "./raw-group.js";

export interface TextRange {
   start: number
   end: number
}

export interface ForesterMacroDefinition {
   name: string
   args: string[]
   body: string
   range: TextRange
}

export interface ForesterPutAssignment {
   path: string
   value: string
   range: TextRange
   isDefault: boolean
}

export interface ForesterMacroCall {
   name: string
   definition: ForesterMacroDefinition
   args: ReadonlyMap<string, string>
   range: TextRange
}

export interface ForesterTexSnippet {
   kind: "tex"
   range: TextRange
   preamble: string
   body: string
}

export interface ForesterMathSnippet {
   kind: "math-inline" | "math-display"
   range: TextRange
   body: string
}

export type HoverTexSnippet = ForesterTexSnippet | ForesterMathSnippet;

const macroNameChar = /[A-Za-z0-9\-\/?]/;
const texCommandName = /^[A-Za-z]+$/;
const foresterStructuralCommand = /\\(scope|put\??|subtree|import|export|namespace|open|let|def|alloc|object|patch|datalog|transclude|taxon|title|author|date|tag|meta|figure|call|xmlns:[A-Za-z]+)/;

function skipWhitespace(text: string, start: number): number {
   let i = start;
   while (i < text.length && /\s/.test(text[i])) {
      i++;
   }
   return i;
}

function readCommandName(text: string, start: number): { name: string; end: number } {
   let i = start;
   let name = "";
   while (i < text.length && macroNameChar.test(text[i])) {
      name += text[i];
      i++;
   }
   return { name, end: i };
}

function parseBalanced(
   text: string,
   start: number,
   open: "{" | "[",
   close: "}" | "]",
): { content: string; end: number } | null {
   if (text[start] !== open) {
      return null;
   }

   let depth = 1;
   let i = start + 1;
   while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
         i += 2;
         continue;
      }

      if (ch === open) {
         depth++;
      } else if (ch === close) {
         depth--;
         if (depth === 0) {
            return {
               content: text.slice(start + 1, i),
               end: i + 1,
            };
         }
      }
      i++;
   }

   return null;
}

function parseBalancedBraces(text: string, start: number): { content: string; end: number } | null {
   return parseBalanced(text, start, "{", "}");
}

function parseBalancedBrackets(text: string, start: number): { content: string; end: number } | null {
   return parseBalanced(text, start, "[", "]");
}

export function findHoverTexSnippetAtOffset(text: string, offset: number): HoverTexSnippet | undefined {
   let i = 0;
   while (i < text.length) {
      if (text.startsWith("##{", i)) {
         const parsed = parseBalancedBraces(text, i + 2);
         if (parsed) {
            const range: TextRange = { start: i, end: parsed.end };
            if (offset >= range.start && offset < range.end) {
               return {
                  kind: "math-display",
                  range,
                  body: parsed.content,
               };
            }
            i = parsed.end;
            continue;
         }
      }

      if (text.startsWith("#{", i)) {
         const parsed = parseBalancedBraces(text, i + 1);
         if (parsed) {
            const range: TextRange = { start: i, end: parsed.end };
            if (offset >= range.start && offset < range.end) {
               return {
                  kind: "math-inline",
                  range,
                  body: parsed.content,
               };
            }
            i = parsed.end;
            continue;
         }
      }

      if (text[i] === "\\") {
         const command = readCommandName(text, i + 1);
         if (command.name === "tex") {
            let cursor = skipWhitespace(text, command.end);
            const preamble = parseBalancedBraces(text, cursor);
            if (!preamble) {
               i = command.end;
               continue;
            }

            cursor = skipWhitespace(text, preamble.end);
            const body = parseBalancedBraces(text, cursor);
            if (!body) {
               i = preamble.end;
               continue;
            }

            const range: TextRange = { start: i, end: body.end };
            if (offset >= range.start && offset < range.end) {
               return {
                  kind: "tex",
                  range,
                  preamble: preamble.content,
                  body: body.content,
               };
            }

            i = body.end;
            continue;
         }
      }

      i++;
   }

   return undefined;
}

export function findFirstTexCommand(text: string): ForesterTexSnippet | undefined {
   let i = 0;
   while (i < text.length) {
      if (text[i] !== "\\") {
         i++;
         continue;
      }

      const command = readCommandName(text, i + 1);
      if (command.name !== "tex") {
         i = command.end;
         continue;
      }

      let cursor = skipWhitespace(text, command.end);
      const preamble = parseBalancedBraces(text, cursor);
      if (!preamble) {
         i = command.end;
         continue;
      }

      cursor = skipWhitespace(text, preamble.end);
      const body = parseBalancedBraces(text, cursor);
      if (!body) {
         i = preamble.end;
         continue;
      }

      return {
         kind: "tex",
         range: { start: i, end: body.end },
         preamble: preamble.content,
         body: body.content,
      };
   }

   return undefined;
}

export function parseForesterImports(text: string): string[] {
   const imports: string[] = [];

   let i = 0;
   while (i < text.length) {
      if (text[i] !== "\\") {
         i++;
         continue;
      }

      const command = readCommandName(text, i + 1);
      const isImportCommand = command.name === "import" || command.name === "export";
      if (!isImportCommand) {
         i = command.end;
         continue;
      }

      const contentStart = skipWhitespace(text, command.end);
      const parsed = parseBalancedBraces(text, contentStart);
      if (!parsed) {
         i = command.end;
         continue;
      }

      const importId = parsed.content.trim();
      if (importId.length > 0) {
         imports.push(importId);
      }

      i = parsed.end;
   }

   return imports;
}

// A brace-less argument in text mode is the whole next TEXT token -- this class
// is the TEXT terminal from forester.langium, so hover and the parser agree on
// where a word ends. Punctuation rides along: \em word, rest binds "word,".
const bareTextArgument = /^[^\s\\{}[\]()%#`]+/;

// In math the lexer hands back x^2 as ONE token, so the whole-word rule would
// read \norm x^2 as \norm{x^2}. Stopping at the first non-alphanumeric
// character reproduces TeX: \norm{x}^2.
const bareMathArgument = /^[A-Za-z0-9]+/;

// The #{...} and ##{...} spans of a document, so an argument can be read with
// the right rule. Collected once per call rather than re-derived per argument.
function mathSpans(text: string): TextRange[] {
   const spans: TextRange[] = [];
   let i = 0;
   while (i < text.length) {
      if (text.startsWith("##{", i)) {
         const parsed = parseBalancedBraces(text, i + 2);
         if (parsed) {
            spans.push({ start: i, end: parsed.end });
            i = parsed.end;
            continue;
         }
      }
      if (text.startsWith("#{", i)) {
         const parsed = parseBalancedBraces(text, i + 1);
         if (parsed) {
            spans.push({ start: i, end: parsed.end });
            i = parsed.end;
            continue;
         }
      }
      i++;
   }
   return spans;
}

// Whitespace before an argument is skipped, but a paragraph break ends the
// scan -- LaTeX's \par rule for ordinary macros, so a dangling command cannot
// reach across a blank line to take the next paragraph's first word.
function skipArgWhitespace(text: string, start: number): number | null {
   let i = start;
   let newlines = 0;
   while (i < text.length && /\s/.test(text[i])) {
      if (text[i] === "\n") {
         newlines++;
      }
      i++;
   }
   return newlines >= 2 ? null : i;
}

function readBareArgument(
   text: string,
   start: number,
   inMath: boolean,
): { content: string; end: number } | null {
   // A control sequence is a complete token and stands in for a braced group:
   // #{\vec\alpha} is \vec{\alpha}.
   if (inMath && text[start] === "\\") {
      const cs = readCommandName(text, start + 1);
      return cs.name ? { content: "\\" + cs.name, end: cs.end } : null;
   }
   const match = (inMath ? bareMathArgument : bareTextArgument).exec(text.slice(start));
   return match ? { content: match[0], end: start + match[0].length } : null;
}

export function findForesterMacroCallAtOffset(
   text: string,
   offset: number,
   definitions: ReadonlyMap<string, ForesterMacroDefinition>,
): ForesterMacroCall | undefined {
   let result: ForesterMacroCall | undefined;
   let i = 0;
   const spans = mathSpans(text);
   const inMath = (at: number): boolean =>
      spans.some((span) => at >= span.start && at < span.end);

   while (i < text.length) {
      if (text[i] !== "\\") {
         i++;
         continue;
      }

      const command = readCommandName(text, i + 1);
      if (!command.name) {
         i++;
         continue;
      }

      const definition = definitions.get(command.name);
      if (!definition) {
         i = command.end;
         continue;
      }

      let cursor = skipArgWhitespace(text, command.end);
      const args = new Map<string, string>();
      let callEnd = command.end;
      let parseFailed = false;

      for (const argName of definition.args) {
         if (cursor === null) {
            parseFailed = true;
            break;
         }

         // Braces first, then a brace-less token -- the same order the
         // compiler's tape pops in.
         const braced = parseBalancedBraces(text, cursor);
         const argument = braced ?? readBareArgument(text, cursor, inMath(cursor));
         if (!argument) {
            parseFailed = true;
            break;
         }

         args.set(argName, argument.content);
         callEnd = argument.end;
         cursor = skipArgWhitespace(text, argument.end);
      }

      if (!parseFailed) {
         const range: TextRange = { start: i, end: callEnd };
         if (offset >= range.start && offset < range.end) {
            result = {
               name: command.name,
               definition,
               args,
               range,
            };
            // Continue scanning from just past the command name so we descend
            // into the argument text and can find a more specific (innermost)
            // macro call that also contains the offset.
            i = command.end;
            continue;
         }
         i = callEnd;
         continue;
      }

      i = command.end;
   }

   return result;
}

export function parseForesterMacroDefinitions(text: string): ForesterMacroDefinition[] {
   const definitions: ForesterMacroDefinition[] = [];

   let i = 0;
   while (i < text.length) {
      if (!text.startsWith("\\def\\", i)) {
         i++;
         continue;
      }

      const nameStart = i + 5;
      const { name, end } = readCommandName(text, nameStart);
      if (!name) {
         i++;
         continue;
      }

      const args: string[] = [];
      let cursor = skipWhitespace(text, end);
      while (cursor < text.length && text[cursor] === "[") {
         const arg = parseBalancedBrackets(text, cursor);
         if (!arg) {
            break;
         }

         let argName = arg.content.trim();
         if (argName.startsWith("~")) {
            argName = argName.slice(1).trim();
         }

         if (argName.length > 0) {
            args.push(argName);
         }

         cursor = skipWhitespace(text, arg.end);
      }

      const body = parseBalancedBraces(text, cursor);
      if (!body) {
         i = end;
         continue;
      }

      definitions.push({
         name,
         args,
         body: body.content,
         range: {
            start: i,
            end: body.end,
         },
      });

      i = body.end;
   }

   return definitions;
}

export function parseForesterPutAssignments(text: string): ForesterPutAssignment[] {
   const assignments: ForesterPutAssignment[] = [];

   let i = 0;
   while (i < text.length) {
      if (!text.startsWith("\\put", i)) {
         i++;
         continue;
      }

      let cursor = i + 4;
      let isDefault = false;
      if (text[cursor] === "?") {
         isDefault = true;
         cursor++;
      }

      if (text[cursor] !== "\\") {
         i++;
         continue;
      }
      cursor++;

      const path = readCommandName(text, cursor);
      if (!path.name) {
         i++;
         continue;
      }

      cursor = skipWhitespace(text, path.end);
      const value = parseBalancedBraces(text, cursor);
      if (!value) {
         i = path.end;
         continue;
      }

      assignments.push({
         path: path.name,
         value: value.content,
         isDefault,
         range: {
            start: i,
            end: value.end,
         },
      });

      i = value.end;
   }

   return assignments;
}

export function filterTopLevelPutAssignments(
   assignments: readonly ForesterPutAssignment[],
   macroDefinitions: readonly ForesterMacroDefinition[],
): ForesterPutAssignment[] {
   return assignments.filter((assignment) => {
      return !macroDefinitions.some((definition) => {
         return (
            assignment.range.start >= definition.range.start &&
            assignment.range.end <= definition.range.end
         );
      });
   });
}

function escapeRegExp(text: string): string {
   return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unwrapMathBody(rawBody: string): string {
   const trimmed = rawBody.trim();

   const tryUnwrap = (prefix: "#{" | "##{"): string | null => {
      if (!trimmed.startsWith(prefix)) {
         return null;
      }
      const parsed = parseBalancedBraces(trimmed, prefix.length - 1);
      if (!parsed || parsed.end !== trimmed.length) {
         return null;
      }
      return parsed.content;
   };

   return tryUnwrap("##{") ?? tryUnwrap("#{") ?? rawBody;
}

function replaceArgReferences(body: string, args: string[]): string {
   let out = body;

   for (const [index, argName] of args.entries()) {
      const slot = `#${index + 1}`;
      const escaped = escapeRegExp(argName);

      const thunkPattern = new RegExp(`\\\\${escaped}\\s*\\{\\s*\\}`, "g");
      out = out.replace(thunkPattern, slot);

      const directPattern = new RegExp(`\\\\${escaped}(?![A-Za-z0-9\\-\\/?])`, "g");
      out = out.replace(directPattern, slot);
   }

   return out;
}

export function substituteForesterMacroArgs(
   template: string,
   args: ReadonlyMap<string, string>,
): string {
   let out = template;

   for (const [argName, value] of args.entries()) {
      const escaped = escapeRegExp(argName);
      const thunkPattern = new RegExp(`\\\\${escaped}\\s*\\{\\s*\\}`, "g");
      out = out.replace(thunkPattern, () => value);

      const directPattern = new RegExp(`\\\\${escaped}(?![A-Za-z0-9\\-\\/?])`, "g");
      out = out.replace(directPattern, () => value);
   }

   return out;
}

function isLikelyTeXCompatibleBody(body: string): boolean {
   if (body.includes("\\<")) {
      return false;
   }
   if (foresterStructuralCommand.test(body)) {
      return false;
   }
   return true;
}

export function isTexCommandName(name: string): boolean {
   return texCommandName.test(name);
}

export function extractLatexDefinedCommandNames(text: string): Set<string> {
   const names = new Set<string>();

   const addMatches = (regex: RegExp, index: number): void => {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
         const name = match[index];
         if (name) {
            names.add(name);
         }
      }
   };

   addMatches(/\\(?:newcommand|renewcommand|providecommand)\s*\{\\([A-Za-z]+)\}/g, 1);
   addMatches(/\\(?:newcommand|renewcommand|providecommand)\s*\\([A-Za-z]+)\b/g, 1);
   addMatches(/\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z]+)\b/g, 1);
   addMatches(/\\expandafter\s*\\(?:def|gdef|edef|xdef)\s*\\csname\s+([A-Za-z]+)\s*\\endcsname/g, 1);

   return names;
}

// ── Macro conversion ────────────────────────────────────────────────────────

/**
 * Names the typesetter itself uses to build a document, which a forest macro must
 * never be allowed to take over.
 *
 * A forest defines its macros for KaTeX, where these names mean nothing special —
 * `\span` is free for the linear-algebra operator. TeX is not so lucky: `\span` is
 * the primitive `\halign` uses when it reads an alignment preamble, so redefining it
 * breaks every `align`, `array` and `tabular` in the document with a baffling
 * "Missing # inserted in alignment preamble", nowhere near the macro at fault — and
 * in a forest that defines one, it breaks them in *every* preview, since the macro
 * preamble is assembled from the whole import closure regardless of what the span
 * being rendered actually uses.
 *
 * Restricted to primitives that are load-bearing for document structure. Symbol-like
 * kernel names (`\Im`, `\ker`, `\deg`) are deliberately absent: overriding those is
 * exactly what a forest means to do, and the blast radius is the one symbol.
 */
export const structuralTexPrimitives: ReadonlySet<string> = new Set([
   // \halign / \valign — alignment construction.
   "span", "cr", "crcr", "noalign", "omit", "halign", "valign", "tabskip",
   // Grouping, expansion and definition.
   "def", "edef", "gdef", "xdef", "let", "futurelet", "expandafter", "noexpand",
   "csname", "endcsname", "begingroup", "endgroup", "relax", "the", "string",
   "catcode", "meaning", "afterassignment", "aftergroup",
   // Boxes and paragraph structure.
   "hbox", "vbox", "vtop", "vcenter", "par", "hskip", "vskip", "kern", "unskip",
   // Math construction that is syntax rather than a symbol.
   "over", "atop", "above", "left", "right", "mathchoice", "discretionary",
]);

export function convertForesterMacroToLatexCommand(definition: ForesterMacroDefinition): string | undefined {
   if (!isTexCommandName(definition.name) || structuralTexPrimitives.has(definition.name)) {
      return undefined;
   }

   const unwrappedBody = unwrapMathBody(definition.body);
   if (!isLikelyTeXCompatibleBody(unwrappedBody)) {
      return undefined;
   }

   const replacedBody = replaceArgReferences(unwrappedBody, definition.args);
   const argCount = definition.args.length;
   if (argCount > 9) {
      return undefined;
   }

   const parameters = match(argCount)
      .with(0, () => "")
      .otherwise(count => Array.from({ length: count }, (_, index) => `#${index + 1}`).join(""));

   // Use \csname-based definitions to avoid "already defined" errors from \newcommand
   // while still allowing one-letter and project-specific command names.
   return `\\expandafter\\def\\csname ${definition.name}\\endcsname${parameters}{${replacedBody}}`;
}

export function buildLatexMacroPreamble(
   definitions: Iterable<ForesterMacroDefinition>,
   excludedNames: ReadonlySet<string> = new Set<string>(),
): string {
   const converted: string[] = [];
   for (const definition of definitions) {
      if (excludedNames.has(definition.name)) {
         continue;
      }
      const latexCommand = convertForesterMacroToLatexCommand(definition);
      if (latexCommand) {
         converted.push(latexCommand);
      }
   }

   return converted.join("\n");
}

function resolveGetReferences(input: string, puts: ReadonlyMap<string, string>): string {
   let out = "";
   let i = 0;

   while (i < input.length) {
      if (!input.startsWith("\\get\\", i)) {
         out += input[i];
         i++;
         continue;
      }

      const path = readCommandName(input, i + 5);
      if (!path.name) {
         out += input[i];
         i++;
         continue;
      }

      const value = puts.get(path.name);
      if (value !== undefined) {
         out += value;
      } else {
         out += input.slice(i, path.end);
      }
      i = path.end;
   }

   return out;
}

function expandSymbolicForesterMacros(
   input: string,
   definitions: ReadonlyMap<string, ForesterMacroDefinition>,
): { value: string; changed: boolean } {
   let out = "";
   let i = 0;
   let changed = false;

   while (i < input.length) {
      if (input[i] !== "\\") {
         out += input[i];
         i++;
         continue;
      }

      const command = readCommandName(input, i + 1);
      if (!command.name) {
         out += input[i];
         i++;
         continue;
      }

      const definition = definitions.get(command.name);
      const isSymbolicName = /[\-\/?]/.test(command.name);
      if (definition && definition.args.length === 0 && isSymbolicName) {
         out += unwrapMathBody(definition.body);
         changed = true;
         i = command.end;
         continue;
      }

      out += input.slice(i, command.end);
      i = command.end;
   }

   return { value: out, changed };
}

function unwrapForesterVerbatimBlocks(input: string): string {
   let out = "";
   let i = 0;

   while (i < input.length) {
      // !{…} — drop the delimiters and keep the body, the same as the herald
      // form below. Without this the preview would compile a literal "!{".
      if (input[i] === "!") {
         const end = rawGroupEnd(input, i);
         if (end !== null) {
            out += input.slice(i + 2, end - 1);
            i = end;
            continue;
         }
      }

      if (!input.startsWith("\\startverb", i)) {
         out += input[i];
         i++;
         continue;
      }

      const markerEnd = i + "\\startverb".length;
      const endMarker = input.indexOf("\\stopverb", markerEnd);
      if (endMarker === -1) {
         out += input.slice(markerEnd);
         break;
      }

      out += input.slice(markerEnd, endMarker);
      i = endMarker + "\\stopverb".length;
   }

   return out;
}

export function resolveForesterPreamble(
   preambleExpression: string,
   puts: ReadonlyMap<string, string>,
   definitions: ReadonlyMap<string, ForesterMacroDefinition>,
): string {
   let value = preambleExpression;

   for (let i = 0; i < 12; i++) {
      const afterGet = resolveGetReferences(value, puts);
      const expanded = expandSymbolicForesterMacros(afterGet, definitions);
      const nextValue = expanded.value;
      if (nextValue === value) {
         break;
      }
      value = nextValue;
   }

   return unwrapForesterVerbatimBlocks(value);
}

// A blank (empty or whitespace-only) line is read by TeX as `\par`, which is
// illegal inside math mode and aborts the compile with "Missing $ inserted".
// Such lines are produced when unwrapForesterVerbatimBlocks strips a
// \startverb / \stopverb herald that sat on its own line, leaving the
// surrounding indentation behind. Math bodies never need a blank line (\par is
// never valid between \(..\) or \[..\]), so drop them. NOT applied to `tex`
// bodies, which may be arbitrary text-mode LaTeX with intentional paragraphs.
function stripBlankLines(input: string): string {
   return input
      .split("\n")
      .filter(line => line.trim().length > 0)
      .join("\n");
}

export function buildRenderableLatexBody(snippet: HoverTexSnippet): string {
   const displayMathEnvironmentPattern =
      /^\s*\\begin\{(equation\*?|align\*?|aligned|alignat\*?|flalign\*?|gather\*?|multline\*?|mathpar)\}[\s\S]*\\end\{\1\}\s*$/;

   return match(snippet)
      .with({ kind: "math-inline" }, ({ body }) => {
         const normalized = stripBlankLines(unwrapForesterVerbatimBlocks(body));
         return `\\(${normalized}\\)`;
      })
      .with({ kind: "math-display" }, ({ body }) => {
         const normalized = stripBlankLines(unwrapForesterVerbatimBlocks(body));
         if (displayMathEnvironmentPattern.test(normalized)) {
            return normalized;
         }
         return `\\[${normalized}\\]`;
      })
      .with({ kind: "tex" }, ({ body }) => unwrapForesterVerbatimBlocks(body))
      .exhaustive();
}

// ── Standalone document assembly ─────────────────────────────────────────────

export interface LatexDocumentOptions {
   /** `\documentclass{…}` name, from `[forest.latex] document_class`. */
   documentClass: string
   /** Class options, joined with commas. Empty means a bare `\documentclass`. */
   documentClassOptions: readonly string[]
   /** Commands the forest's `\def` table contributed, already converted to LaTeX. */
   macroPreamble: string
   /** Preamble the snippet itself carries — a `\tex{…}{…}` first argument. */
   snippetPreamble: string
   /** The math or text body, already wrapped by {@link buildRenderableLatexBody}. */
   body: string
   /** Follows the editor theme, so the glyphs are legible against the popover. */
   foregroundColor: "black" | "white"
}

/**
 * quiver's `\usepackage` is expensive and only relevant to diagram bodies, so it is
 * loaded on demand — and guarded twice over, since the user preamble may have loaded
 * it already and the .sty may not be installed at all.
 */
const quiverProbePattern = /\\(?:begin\{tikzcd\}|ltexfig\b|texfig\b|arrow\b|tikzcdset\b)/;

/**
 * Compatibility shims for symbols Forester notes reach for that plain
 * amsmath+amssymb does not define. `\providecommand`, and emitted *after* the user
 * preamble, so a real package (stmaryrd owns `\llbracket`) always wins.
 */
const compatibilityShims: readonly string[] = [
   "\\providecommand{\\llbracket}{\\mathopen{[\\![}}",
   "\\providecommand{\\rrbracket}{\\mathclose{]\\!]}}",
   "\\providecommand{\\lBrack}{\\langle}",
   "\\providecommand{\\rBrack}{\\rangle}",
   "\\providecommand{\\exist}{\\exists}",
   // KaTeX's own extension, used by the `\notation` idiom to hang a hover annotation
   // on a symbol. LaTeX has never heard of it, so a forest that documents its symbols
   // that way would otherwise fail to preview every one of them. Keep the body, drop
   // the annotation — exactly what a forest's own LaTeX-side shim does.
   "\\providecommand{\\htmlData}[2]{#2}",
];

/**
 * Assemble the standalone .tex file whose DVI becomes the hover image.
 *
 * Pure, and deliberately so: this is the single point where "what the forest
 * declares" turns into "what LaTeX is asked to compile", which makes it the thing a
 * parity test has to be able to call without a running editor.
 */
export function buildLatexDocument(options: LatexDocumentOptions): string {
   const { documentClass, documentClassOptions, macroPreamble, snippetPreamble, body, foregroundColor } = options;

   const needsQuiverPreamble = quiverProbePattern.test([macroPreamble, snippetPreamble, body].join("\n"));
   const classOptions = documentClassOptions.join(",");
   const classDecl = classOptions.length > 0
      ? `\\documentclass[${classOptions}]{${documentClass}}`
      : `\\documentclass{${documentClass}}`;

   const userPreambleSections = [macroPreamble, snippetPreamble].filter(section => section.trim().length > 0);

   return [
      classDecl,
      "",
      "\\usepackage{iftex}",
      "\\ifPDFTeX",
      "  \\usepackage[T1]{fontenc}",
      "  \\usepackage[utf8]{inputenc}",
      "\\else",
      "  \\usepackage{fontspec}",
      "\\fi",
      "",
      "\\usepackage{xcolor}",
      "\\usepackage{amsmath,amssymb,mathtools}",
      "",
      ...userPreambleSections,
      ...(needsQuiverPreamble
         ? [
            "\\makeatletter",
            "\\@ifpackageloaded{quiver}{}{\\IfFileExists{quiver.sty}{\\usepackage{quiver}}{}}",
            "\\makeatother",
            "",
         ]
         : []),
      "",
      ...compatibilityShims,
      "",
      "\\begin{document}",
      `\\color{${foregroundColor}}`,
      body,
      "\\end{document}",
      "",
   ].join("\n");
}

// ── TeX search path ──────────────────────────────────────────────────────────

/**
 * Compose a `TEXINPUTS` value from the forest's own style directories.
 *
 * The hover compiles in a scratch directory, so a `.sty` sitting in the repo — the
 * forest's `tex/` or `theme/` — is invisible to `\usepackage`, and the span fails with
 * "File `polydiv.sty' not found" no matter how faithfully the preamble was
 * reconstructed. (Forester itself compiles figures in a temp dir for the same reason,
 * which is why a forest may have worked around it by inlining a package verbatim into
 * its preamble tree.)
 *
 * `//` after each directory makes kpathsea recurse into it, and the trailing empty
 * entry — TEXINPUTS' own convention — appends the system tree rather than replacing
 * it, so ordinary packages keep resolving.
 *
 * Returns undefined when there is nothing to add, so the caller can leave the child's
 * environment untouched rather than setting an empty override.
 */
export function composeTexInputs(
   directories: readonly string[],
   inherited?: string,
): string | undefined {
   const seen = new Set<string>();
   const entries: string[] = [];
   for (const dir of directories) {
      const trimmed = dir.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) { continue; }
      seen.add(trimmed);
      entries.push(`${trimmed}//`);
   }
   if (entries.length === 0) { return undefined; }

   // An inherited TEXINPUTS already ends in the separator that re-appends the system
   // tree; keep it whole and simply take precedence over it.
   const tail = inherited && inherited.trim().length > 0 ? inherited : "";
   return `${entries.join(":")}:${tail}`;
}
