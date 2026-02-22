import { match } from "ts-pattern";

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

export function findForesterMacroCallAtOffset(
   text: string,
   offset: number,
   definitions: ReadonlyMap<string, ForesterMacroDefinition>,
): ForesterMacroCall | undefined {
   let result: ForesterMacroCall | undefined;
   let i = 0;

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

      let cursor = skipWhitespace(text, command.end);
      const args = new Map<string, string>();
      let callEnd = command.end;
      let parseFailed = false;

      for (const argName of definition.args) {
         const argument = parseBalancedBraces(text, cursor);
         if (!argument) {
            parseFailed = true;
            break;
         }

         args.set(argName, argument.content);
         callEnd = argument.end;
         cursor = skipWhitespace(text, argument.end);
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

export function convertForesterMacroToLatexCommand(definition: ForesterMacroDefinition): string | undefined {
   if (!isTexCommandName(definition.name)) {
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

export function buildRenderableLatexBody(snippet: HoverTexSnippet): string {
   const displayMathEnvironmentPattern =
      /^\s*\\begin\{(equation\*?|align\*?|aligned|alignat\*?|flalign\*?|gather\*?|multline\*?|mathpar)\}[\s\S]*\\end\{\1\}\s*$/;

   return match(snippet)
      .with({ kind: "math-inline" }, ({ body }) => {
         const normalized = unwrapForesterVerbatimBlocks(body);
         return `\\(${normalized}\\)`;
      })
      .with({ kind: "math-display" }, ({ body }) => {
         const normalized = unwrapForesterVerbatimBlocks(body);
         if (displayMathEnvironmentPattern.test(normalized)) {
            return normalized;
         }
         return `\\[${normalized}\\]`;
      })
      .with({ kind: "tex" }, ({ body }) => unwrapForesterVerbatimBlocks(body))
      .exhaustive();
}
