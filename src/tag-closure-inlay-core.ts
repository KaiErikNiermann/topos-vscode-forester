export interface TagClosureHint {
   offset: number
   label: string
}

export interface TagClosureHintOptions {
   enabledTags?: readonly string[]
}

export const DEFAULT_TAG_CLOSURE_HINT_TAGS = [
   "ol",
   "ul",
   "li",
   "p",
   "subtree",
   "##",
   "tex",
   "texmath",
   "solution",
] as const;

const OPAQUE_TEX_COMMANDS = new Set(["tex", "texmath", "texfig", "ltexfig"]);

interface CommandHeader {
   name: string
   endIndex: number
}

function isAsciiLetter(char: string): boolean {
   return /^[A-Za-z]$/.test(char);
}

function isCommandNameStart(char: string): boolean {
   return isAsciiLetter(char) || char === "@";
}

function isCommandNameContinue(char: string): boolean {
   return /^[A-Za-z0-9_\/:\-?@]$/.test(char);
}

function isEscaped(source: string, index: number): boolean {
   let backslashes = 0;
   for (let i = index - 1; i >= 0 && source[i] === "\\"; i -= 1) {
      backslashes += 1;
   }
   return backslashes % 2 === 1;
}

function skipComment(source: string, startIndex: number): number {
   let index = startIndex;
   while (index < source.length && source[index] !== "\n") {
      index += 1;
   }
   return index;
}

function skipWhitespaceAndComments(source: string, startIndex: number, endIndex: number): number {
   let index = startIndex;
   while (index < endIndex) {
      const char = source[index];
      if (/\s/.test(char)) {
         index += 1;
         continue;
      }
      if (char === "%" && !isEscaped(source, index)) {
         index = skipComment(source, index);
         continue;
      }
      break;
   }
   return index;
}

function scanBalanced(
   source: string,
   startIndex: number,
   endIndex: number,
   openChar: string,
   closeChar: string,
): number | null {
   let depth = 0;
   for (let index = startIndex; index < endIndex; index += 1) {
      const char = source[index];

      if (char === "%" && !isEscaped(source, index)) {
         index = skipComment(source, index);
         continue;
      }

      if (char === openChar && !isEscaped(source, index)) {
         depth += 1;
         continue;
      }

      if (char === closeChar && !isEscaped(source, index)) {
         depth -= 1;
         if (depth === 0) {
            return index;
         }
      }
   }

   return null;
}

function readCommandHeader(source: string, backslashIndex: number, endIndex: number): CommandHeader | null {
   if (backslashIndex + 1 >= endIndex) {
      return null;
   }

   let cursor = backslashIndex + 1;
   let name = "";

   if (isCommandNameStart(source[cursor])) {
      const start = cursor;
      cursor += 1;
      while (cursor < endIndex && isCommandNameContinue(source[cursor])) {
         cursor += 1;
      }
      name = source.slice(start, cursor);
   } else if (!/\s/.test(source[cursor])) {
      name = source[cursor];
      cursor += 1;
   }

   if (name.length === 0) {
      return null;
   }

   return {
      name,
      endIndex: cursor - 1,
   };
}

function normalizeEnabledTags(enabledTags?: readonly string[]): Set<string> {
   const raw = enabledTags ?? DEFAULT_TAG_CLOSURE_HINT_TAGS;
   const normalized = raw
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0)
      .map(tag => {
         if (tag === "##" || tag === "#") {
            return tag;
         }
         return tag.startsWith("\\") ? tag.slice(1) : tag;
      });
   return new Set(normalized);
}

export function collectTagClosureHints(source: string, options: TagClosureHintOptions = {}): TagClosureHint[] {
   const enabledTags = normalizeEnabledTags(options.enabledTags);
   const hints: TagClosureHint[] = [];

   const parseRegion = (startIndex: number, endIndex: number): void => {
      let index = startIndex;

      while (index < endIndex) {
         const char = source[index];

         if (char === "%" && !isEscaped(source, index)) {
            index = skipComment(source, index);
            continue;
         }

         if (char === "#" && !isEscaped(source, index)) {
            if (source[index + 1] === "#" && source[index + 2] === "{") {
               const openIndex = index + 2;
               const closeIndex = scanBalanced(source, openIndex, endIndex, "{", "}");
               if (closeIndex === null) {
                  return;
               }
               if (enabledTags.has("##")) {
                  hints.push({ offset: closeIndex, label: "##" });
               }
               index = closeIndex + 1;
               continue;
            }

            if (source[index + 1] === "{") {
               const openIndex = index + 1;
               const closeIndex = scanBalanced(source, openIndex, endIndex, "{", "}");
               if (closeIndex === null) {
                  return;
               }
               if (enabledTags.has("#")) {
                  hints.push({ offset: closeIndex, label: "#" });
               }
               index = closeIndex + 1;
               continue;
            }
         }

         if (char !== "\\" || isEscaped(source, index)) {
            index += 1;
            continue;
         }

         const header = readCommandHeader(source, index, endIndex);
         if (!header) {
            index += 1;
            continue;
         }

         let cursor = skipWhitespaceAndComments(source, header.endIndex + 1, endIndex);
         while (cursor < endIndex && source[cursor] === "[") {
            const bracketEnd = scanBalanced(source, cursor, endIndex, "[", "]");
            if (bracketEnd === null) {
               break;
            }
            cursor = skipWhitespaceAndComments(source, bracketEnd + 1, endIndex);
         }

         const argumentRanges: Array<{ open: number, close: number }> = [];
         while (cursor < endIndex && source[cursor] === "{") {
            const closeIndex = scanBalanced(source, cursor, endIndex, "{", "}");
            if (closeIndex === null) {
               break;
            }
            argumentRanges.push({ open: cursor, close: closeIndex });
            cursor = skipWhitespaceAndComments(source, closeIndex + 1, endIndex);
         }

         if (argumentRanges.length === 0) {
            index = header.endIndex + 1;
            continue;
         }

         const isOpaqueTexCommand = OPAQUE_TEX_COMMANDS.has(header.name);
         if (isOpaqueTexCommand) {
            if (enabledTags.has(header.name)) {
               const target = argumentRanges[argumentRanges.length - 1];
               hints.push({ offset: target.close, label: header.name });
            }
         } else {
            for (const argumentRange of argumentRanges) {
               if (argumentRange.close > argumentRange.open + 1) {
                  parseRegion(argumentRange.open + 1, argumentRange.close);
               }
            }

            if (enabledTags.has(header.name)) {
               hints.push({ offset: argumentRanges[0].close, label: header.name });
            }
         }

         index = cursor;
      }
   };

   parseRegion(0, source.length);
   return hints;
}
