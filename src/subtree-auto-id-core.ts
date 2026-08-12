import { match } from "ts-pattern";

const SUBTREE_WITH_ID_REGEX = /\\subtree\s*\[([^\]]+)\]/g;
// Reading is case-insensitive because a forest can already contain stems in
// either case: `008A` and `008a` name one slot, since address allocation folds
// case. Reading only one case makes the other's ids look free, and the "next"
// id we hand out lands on a tree that already exists.
const BASE36_STEM_REGEX = /^[0-9a-zA-Z]{4}$/;

export const DEFAULT_SUBTREE_TEMPLATE = "\\subtree[<id>]{\n  \\title{$1}\n}$0";
export const MAX_BASE36_VALUE = 36 ** 4 - 1;
// Writing, by contrast, is uppercase — byte-for-byte forester's own alphabet
// (`BaseN.Base36` in lib/prelude/BaseN.ml). Emitting lowercase used to produce
// `009c` beside forester's `009C.tree`: two trees to the index, one slot to
// every allocator, and a case_folded_address warning at build time. Worse,
// forester's `int_of_string` only accepts its own alphabet, so a lowercase stem
// is not a number to it — it drops out of the allocator's sequence entirely and
// the very next `forester new` reissues that slot in uppercase.
export const BASE36_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE36_WIDTH = 4;

export interface SubtreeIdScanState {
   knownCanonicalIds: Set<string>;
   nextCanonicalValue: number;
}

export interface NextCanonicalIdResult {
   id: string;
   nextValue: number;
}

export function isCanonicalBase36Stem(id: string): boolean {
   return BASE36_STEM_REGEX.test(id);
}

export function toBase36(value: number, width = BASE36_WIDTH): string {
   if (!Number.isInteger(value) || value < 0) {
      throw new RangeError("Base36 conversion only supports non-negative integers.");
   }

   let remainder = value;
   const digits: string[] = [];
   if (remainder === 0) {
      digits.push("0");
   } else {
      while (remainder > 0) {
         const next = Math.floor(remainder / 36);
         const index = remainder % 36;
         digits.push(BASE36_DIGITS[index]);
         remainder = next;
      }
   }

   const encoded = digits.reverse().join("");
   if (encoded.length > width) {
      throw new RangeError("Value exceeds allotted width for base-36 encoding.");
   }

   return encoded.padStart(width, "0");
}

export function fromBase36Stem(stem: string): number | undefined {
   if (!isCanonicalBase36Stem(stem)) {
      return undefined;
   }

   let value = 0;
   for (const character of stem.toUpperCase()) {
      const digit = BASE36_DIGITS.indexOf(character);
      if (digit < 0) {
         return undefined;
      }
      value = value * 36 + digit;
   }

   return value;
}

/**
 * Case-folded key for "is this slot taken?" tests — see {@link BASE36_STEM_REGEX}.
 * Folds to upper case so the key of an id we emit is the id itself.
 */
export function canonicalStemKey(stem: string): string {
   return stem.toUpperCase();
}

export function nextCanonicalBase36Id(
   knownCanonicalIds: Iterable<string>,
   startValue: number,
): NextCanonicalIdResult {
   const knownIdSet = new Set([...knownCanonicalIds].map(canonicalStemKey));

   let candidateValue = startValue;
   while (candidateValue <= MAX_BASE36_VALUE) {
      const candidateId = toBase36(candidateValue);
      if (!knownIdSet.has(canonicalStemKey(candidateId))) {
         return {
            id: candidateId,
            nextValue: candidateValue + 1,
         };
      }

      candidateValue += 1;
   }

   throw new RangeError("No available canonical 4-char base36 subtree IDs remain.");
}

function collectCanonicalIds(ids: Iterable<string>, sink: Set<string>): number {
   let maxValue = -1;

   for (const id of ids) {
      const canonicalValue = fromBase36Stem(id);
      if (canonicalValue === undefined) {
         continue;
      }

      sink.add(canonicalStemKey(id));
      maxValue = Math.max(maxValue, canonicalValue);
   }

   return maxValue;
}

function clampToNonNegative(value: number): number {
   return Math.max(value, 0);
}

function computeStartValueFromMax(maxCanonicalValue: number): number {
   if (maxCanonicalValue < 0) {
      return 0;
   }

   if (maxCanonicalValue >= MAX_BASE36_VALUE) {
      return MAX_BASE36_VALUE + 1;
   }

   return maxCanonicalValue + 1;
}

export function computeSubtreeIdScanState(treeIds: Iterable<string>, subtreeIds: Iterable<string>): SubtreeIdScanState {
   const knownCanonicalIds = new Set<string>();

   const maxFromTreeNames = collectCanonicalIds(treeIds, knownCanonicalIds);
   const maxFromSubtreeRefs = collectCanonicalIds(subtreeIds, knownCanonicalIds);
   const maxCanonicalValue = Math.max(maxFromTreeNames, maxFromSubtreeRefs);

   return {
      knownCanonicalIds,
      nextCanonicalValue: clampToNonNegative(computeStartValueFromMax(maxCanonicalValue)),
   };
}

export function extractSubtreeReferenceIds(content: string): string[] {
   const ids: string[] = [];
   SUBTREE_WITH_ID_REGEX.lastIndex = 0;

   let matchResult: RegExpExecArray | null;
   while ((matchResult = SUBTREE_WITH_ID_REGEX.exec(content)) !== null) {
      const id = matchResult[1].trim();
      if (id.length > 0) {
         ids.push(id);
      }
   }

   return ids;
}

export function renderSubtreeTemplate(template: string, generatedId: string): string {
   const normalizedTemplate = template.trim().length > 0 ? template : DEFAULT_SUBTREE_TEMPLATE;

   return match({
      hasIdPlaceholder: normalizedTemplate.includes("<id>"),
      hasBareSubtree: /\\subtree\s*\{/.test(normalizedTemplate),
   })
      .with({ hasIdPlaceholder: true }, () => normalizedTemplate.replaceAll("<id>", generatedId))
      .with({ hasBareSubtree: true }, () => normalizedTemplate.replace(/\\subtree\s*\{/, `\\subtree[${generatedId}]{`))
      .otherwise(() => DEFAULT_SUBTREE_TEMPLATE.replace("<id>", generatedId));
}
