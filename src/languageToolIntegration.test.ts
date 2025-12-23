import { strict as assert } from "assert";

/**
 * Tests for the LanguageTool integration filtering logic.
 * 
 * Run with: npx tsx src/languageToolIntegration.test.ts
 * 
 * These tests verify that:
 * 1. Forester commands (\li, \ul, \ol, etc.) are ignored by spell check
 * 2. Math blocks #{...} and ##{...} are ignored
 * 3. Whitespace rules are filtered out
 * 4. Real spelling mistakes in actual text are detected
 */

// ============================================================================
// Re-implement core filtering logic for testing (without vscode dependency)
// ============================================================================

type RangeLike = { start: number; end: number };

function buildIgnoreRanges(text: string): RangeLike[] {
   const ranges: RangeLike[] = [];
   const regexes = [
      /#\{[\s\S]*?\}/g,  // custom inline latex
      /##\{[\s\S]*?\}/g, // custom inline latex block
      /\\\(.+?\\\)/gs,
      /\\\[.+?\\\]/gs,
      /\$[^$]+\$/gs,
      /\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}/g,
      /\\[A-Za-z]+(?:\[[^\]]*\])?\{[^}]*\}/g,
      /\{[^}]*\}/g, // generic braces content (reduces macro args)
   ];

   for (const re of regexes) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
         ranges.push({ start: m.index, end: m.index + m[0].length });
      }
   }

   return ranges;
}

function buildCommandRanges(text: string): RangeLike[] {
   const ranges: RangeLike[] = [];
   const re = /\\[A-Za-z]+(?:\[[^\]]*\])?(?:\{[^}]*\})*/g;
   let m: RegExpExecArray | null;
   while ((m = re.exec(text)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
   }
   return ranges;
}

interface MockDiagnostic {
   startOffset: number;
   endOffset: number;
   message: string;
   source?: string;
}

function shouldIgnoreDiagnostic(
   content: string,
   ignored: RangeLike[],
   commands: RangeLike[],
   diag: MockDiagnostic
): boolean {
   const text = content.slice(diag.startOffset, diag.endOffset);
   if (!text.trim()) return true;
   if (!/[A-Za-z]/.test(text)) return true; // skip non-words

   // Ignore obvious macro-ish tokens
   if (/^\\/.test(text)) return true;
   if (/[\\{}$#]/.test(text)) return true;
   if (/^\\?[A-Za-z]{1,3}$/.test(text)) return true; // very short tokens likely macro names
   if (/^\\?(ul|li|p|ol|em|strong|taxon)$/i.test(text)) return true;
   if (/^\\?(ul|li|ol|p)[{\\]/i.test(text)) return true;
   if (/^\\?(ul|li|ol|p)\b/i.test(text)) return true;

   const startOffset = diag.startOffset;
   const endOffset = diag.endOffset;

   if (ignored.some(r => endOffset > r.start && startOffset < r.end)) {
      return true;
   }
   if (commands.some(r => endOffset > r.start && startOffset < r.end)) {
      return true;
   }

   // If immediately preceded by a backslash, it's likely a macro name.
   const prefix = content.slice(Math.max(0, startOffset - 1), startOffset);
   if (prefix.includes("\\")) return true;

   // If inside a command name - check if there's a backslash before us on the same "word"
   // Look back up to 20 characters for a backslash followed by only letters
   const lookback = content.slice(Math.max(0, startOffset - 20), startOffset);
   if (/\\[A-Za-z]*$/.test(lookback)) return true;

   // Ignore LaTeX-ish command names without letters (e.g., \_, \%)
   if (/^\\[^A-Za-z]*$/.test(text)) return true;

   // Ignore very short tokens that are often macro fragments.
   if (text.length <= 2) return true;

   return false;
}

function shouldIgnoreRule(diag: MockDiagnostic): boolean {
   const src = diag.source || "";
   const msg = diag.message.toLowerCase();

   // Common whitespace rule id/message from LT
   if (src.toLowerCase().includes("whitespace") || msg.includes("whitespace")) {
      return true;
   }
   if (msg.includes("before the closing parenthesis") || msg.includes("before comma") || msg.includes("before ,") || msg.includes("before )")) {
      return true;
   }
   return false;
}

// ============================================================================
// Test Helpers
// ============================================================================

function diagFromText(content: string, text: string, message: string, source?: string, occurrence = 0): MockDiagnostic {
   let index = -1;
   for (let i = 0; i <= occurrence; i++) {
      index = content.indexOf(text, index + 1);
      if (index === -1) break;
   }
   if (index === -1) {
      throw new Error(`Text "${text}" not found in document (occurrence ${occurrence})`);
   }
   return {
      startOffset: index,
      endOffset: index + text.length,
      message,
      source
   };
}

function expectIgnored(content: string, text: string, message = "Spelling", source?: string, occurrence = 0): void {
   const ignored = buildIgnoreRanges(content);
   const cmds = buildCommandRanges(content);
   const diag = diagFromText(content, text, message, source, occurrence);
   const result = shouldIgnoreDiagnostic(content, ignored, cmds, diag);
   assert.ok(result, `Expected "${text}" to be ignored, but it was not`);
}

function expectKept(content: string, text: string, message = "Spelling", source?: string, occurrence = 0): void {
   const ignored = buildIgnoreRanges(content);
   const cmds = buildCommandRanges(content);
   const diag = diagFromText(content, text, message, source, occurrence);
   const result = shouldIgnoreDiagnostic(content, ignored, cmds, diag);
   assert.ok(!result, `Expected "${text}" to be kept (not ignored), but it was ignored`);
}

// ============================================================================
// Test Runner
// ============================================================================

interface TestCase {
   name: string;
   fn: () => void;
}

const tests: TestCase[] = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
   tests.push({ name, fn });
}

function runTests(): void {
   console.log("\n=== LanguageTool Integration Tests ===\n");

   for (const t of tests) {
      try {
         t.fn();
         console.log(`✓ ${t.name}`);
         passed++;
      } catch (error) {
         console.log(`✗ ${t.name}`);
         console.log(`  Error: ${error instanceof Error ? error.message : String(error)}`);
         failed++;
      }
   }

   console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

   if (failed > 0) {
      process.exit(1);
   }
}

// ============================================================================
// Tests: Forester Commands Should Be Ignored
// ============================================================================

test("Should ignore \\li command name", () => {
   expectIgnored("\\li{Hello world}", "li");
});

test("Should ignore \\ul command name", () => {
   expectIgnored("\\ul{content}", "ul");
});

test("Should ignore \\ol command name", () => {
   expectIgnored("\\ol{content}", "ol");
});

test("Should ignore \\p command name", () => {
   expectIgnored("\\p{This is a paragraph.}", "p");
});

test("Should ignore \\em command name", () => {
   expectIgnored("\\em{emphasized text}", "em");
});

test("Should ignore \\strong command name", () => {
   expectIgnored("\\strong{bold text}", "strong");
});

test("Should ignore \\taxon command name", () => {
   expectIgnored("\\taxon{Definition}", "taxon");
});

test("Should ignore \\title command name", () => {
   expectIgnored("\\title{My Title}", "title");
});

test("Should ignore \\date command name", () => {
   expectIgnored("\\date{2025-01-01}", "date");
});

test("Should ignore \\import command name", () => {
   expectIgnored("\\import{base-macros}", "import");
});

test("Should ignore \\transclude command name", () => {
   expectIgnored("\\transclude{other-tree}", "transclude");
});

test("Should ignore \\ref command name", () => {
   expectIgnored("See \\ref{other-tree} for more.", "ref");
});

test("Should ignore \\subtree command name", () => {
   expectIgnored("\\subtree{\\title{Nested}}", "subtree");
});

test("Should ignore \\solution command name", () => {
   expectIgnored("\\solution{The answer is...}", "solution");
});

test("Should ignore \\figure command name", () => {
   expectIgnored("\\figure{\\img{path}}", "figure");
});

test("Should ignore \\scope command name", () => {
   expectIgnored("\\scope{\\put{x}{1}}", "scope");
});

test("Should ignore \\def command name", () => {
   expectIgnored("\\def\\mymacro{content}", "def");
});

// ============================================================================
// Tests: Math Blocks Should Be Ignored
// ============================================================================

test("Should ignore inline math content #{...}", () => {
   const content = "The formula #{x^2 + y^2} is important.";
   // The entire math block should be in ignore ranges
   const ignored = buildIgnoreRanges(content);
   const mathStart = content.indexOf("#{");
   const mathEnd = content.indexOf("}") + 1;
   assert.ok(
      ignored.some(r => r.start <= mathStart && r.end >= mathEnd),
      "Math block should be in ignore ranges"
   );
});

test("Should ignore display math content ##{...}", () => {
   const content = "Consider:\n##{\\sum_{i=0}^n i}";
   const ignored = buildIgnoreRanges(content);
   const mathStart = content.indexOf("##{");
   assert.ok(
      ignored.some(r => r.start <= mathStart),
      "Display math block should be in ignore ranges"
   );
});

test("Should ignore LaTeX commands inside math", () => {
   expectIgnored("#{\\neg p \\land q}", "neg");
   expectIgnored("#{\\neg p \\land q}", "land");
});

test("Should ignore math with nested braces", () => {
   expectIgnored("#{(p \\to (q \\to r))}", "to", "Spelling", undefined, 0);
});

// ============================================================================
// Tests: Command Arguments Should Be Handled Properly
// ============================================================================

test("Should ignore bracket arguments like [~body]", () => {
   expectIgnored("\\texfig[~body]{content}", "body");
});

test("Should ignore tree addresses in commands", () => {
   expectIgnored("\\transclude{jms-0001}", "jms-0001");
});

test("Should ignore content in braces after commands", () => {
   expectIgnored("\\taxon{Quiz}", "Quiz");
});

// ============================================================================
// Tests: Whitespace Rules Should Be Filtered
// ============================================================================

test("Should filter WHITESPACE rule by source", () => {
   const diag: MockDiagnostic = {
      startOffset: 5,
      endOffset: 13,
      message: "Don't put a space before the closing parenthesis",
      source: "WHITESPACE_RULE"
   };
   assert.ok(shouldIgnoreRule(diag), "Should filter whitespace rule by source");
});

test("Should filter whitespace rule by message - closing parenthesis", () => {
   const diag: MockDiagnostic = {
      startOffset: 0,
      endOffset: 4,
      message: "Don't put a space before the closing parenthesis"
   };
   assert.ok(shouldIgnoreRule(diag), "Should filter by message about closing parenthesis");
});

test("Should filter whitespace rule by message - before comma", () => {
   const diag: MockDiagnostic = {
      startOffset: 0,
      endOffset: 4,
      message: "Don't put a space before comma"
   };
   assert.ok(shouldIgnoreRule(diag), "Should filter by message about comma");
});

test("Should filter whitespace rule by source containing 'whitespace'", () => {
   const diag: MockDiagnostic = {
      startOffset: 0,
      endOffset: 4,
      message: "Some error",
      source: "WHITESPACE"
   };
   assert.ok(shouldIgnoreRule(diag), "Should filter by source containing whitespace");
});

test("Should filter whitespace message case-insensitive", () => {
   const diag: MockDiagnostic = {
      startOffset: 0,
      endOffset: 4,
      message: "Whitespace issue detected"
   };
   assert.ok(shouldIgnoreRule(diag), "Should filter whitespace message case-insensitively");
});

// ============================================================================
// Tests: Real Spelling Mistakes Should Be Kept
// ============================================================================

test("Should keep real spelling mistake in plain text", () => {
   expectKept("This is a sentense with an errror.", "sentense");
   expectKept("This is a sentense with an errror.", "errror");
});

test("Should keep spelling mistake outside of commands", () => {
   expectKept("\\title{Good Title}\n\nThis has a mistke in it.", "mistke");
});

test("Should keep misspelled words after commands", () => {
   expectKept("\\title{Test}\n\nHere is some baad text.", "baad");
});

test("Should keep long misspelled words", () => {
   expectKept("The accidantal mistake is here.", "accidantal");
});

// ============================================================================
// Tests: Short Tokens and Special Characters
// ============================================================================

test("Should ignore very short tokens (2 chars or less)", () => {
   const content = "a b c";
   const diag: MockDiagnostic = { startOffset: 0, endOffset: 1, message: "Spelling" };
   const ignored = buildIgnoreRanges(content);
   const cmds = buildCommandRanges(content);
   const result = shouldIgnoreDiagnostic(content, ignored, cmds, diag);
   assert.ok(result, "Very short tokens should be ignored");
});

test("Should ignore tokens starting with backslash", () => {
   expectIgnored("\\customcmd", "\\customcmd");
});

test("Should ignore tokens containing special characters", () => {
   expectIgnored("test$var more", "test$var");
});

test("Should ignore tokens containing braces", () => {
   expectIgnored("{content} text", "{content}");
});

test("Should ignore empty/whitespace-only diagnostics", () => {
   const content = "text   more";
   const diag: MockDiagnostic = { startOffset: 4, endOffset: 7, message: "Spacing issue" };
   const ignored = buildIgnoreRanges(content);
   const cmds = buildCommandRanges(content);
   const result = shouldIgnoreDiagnostic(content, ignored, cmds, diag);
   assert.ok(result, "Whitespace-only content should be ignored");
});

// ============================================================================
// Tests: Complex Document Scenarios
// ============================================================================

test("Should handle nested commands correctly", () => {
   const content = `\\ul{
  \\li{First item}
  \\li{Second item}
}`;
   expectIgnored(content, "ul");
   expectIgnored(content, "li", "Spelling", undefined, 0);
   expectIgnored(content, "li", "Spelling", undefined, 1);
});

test("Should handle mixed content document", () => {
   const content = `\\title{Test Document}

\\p{This is a paragraf with a mistke.}

\\ol{
  \\li{#{x^2} is a formula}
  \\li{Another item}
}

Some loose text with an errror here.`;

   // Commands should be ignored
   expectIgnored(content, "title");
   expectIgnored(content, "ol");
   expectIgnored(content, "li", "Spelling", undefined, 0);
   expectIgnored(content, "li", "Spelling", undefined, 1);

   // Real errors should be kept
   expectKept(content, "errror");
});

test("Should handle solution block with nested content", () => {
   const content = `\\solution{
  \\ul{
    \\li{A formula is \\strong{satisfiable} if...}
    \\li{A formula is \\strong{unsatisfiable} if...}
  }
}`;

   expectIgnored(content, "solution");
   expectIgnored(content, "ul");
   expectIgnored(content, "li", "Spelling", undefined, 0);
   expectIgnored(content, "li", "Spelling", undefined, 1);
   expectIgnored(content, "strong", "Spelling", undefined, 0);
   expectIgnored(content, "strong", "Spelling", undefined, 1);
});

test("Should handle document with inline math in list items", () => {
   const content = `\\ol{
  \\li{#{(p\\land q) \\to \\neg p}}
  \\li{#{(p \\land q) \\to (p \\lor \\neg q)}}
}`;

   expectIgnored(content, "ol");
   expectIgnored(content, "li", "Spelling", undefined, 0);
   expectIgnored(content, "li", "Spelling", undefined, 1);
   expectIgnored(content, "land", "Spelling", undefined, 0);
   expectIgnored(content, "neg", "Spelling", undefined, 0);
   expectIgnored(content, "lor");
});

// ============================================================================
// Tests: Edge Cases
// ============================================================================

test("Should handle empty document", () => {
   const content = "";
   const ignored = buildIgnoreRanges(content);
   const cmds = buildCommandRanges(content);
   assert.deepEqual(ignored, [], "Empty doc should have no ignore ranges");
   assert.deepEqual(cmds, [], "Empty doc should have no command ranges");
});

test("Should handle document with only commands", () => {
   const content = "\\title{Test}\\date{2025-01-01}\\taxon{Note}";
   const cmds = buildCommandRanges(content);
   assert.ok(cmds.length >= 3, "Should find at least 3 commands");
});

test("Should handle consecutive math blocks", () => {
   const content = "#{a} #{b} #{c}";
   const ignored = buildIgnoreRanges(content);
   // Each #{...} should create an ignore range
   assert.ok(ignored.length >= 3, "Should find ignore ranges for each math block");
});

test("Should handle multiline math blocks", () => {
   const content = `##{
  \\sum_{i=0}^{n} i = \\frac{n(n+1)}{2}
}`;
   expectIgnored(content, "sum");
   expectIgnored(content, "frac");
});

test("Should not flag command names that look like words", () => {
   // Commands like \import, \export, \figure could be English words
   const content = "\\import{base}\\export{other}\\figure{img}";
   expectIgnored(content, "import");
   expectIgnored(content, "export");
   expectIgnored(content, "figure");
});

// ============================================================================
// Tests: buildIgnoreRanges function
// ============================================================================

test("buildIgnoreRanges should find inline math", () => {
   const text = "Text #{math} more text";
   const ranges = buildIgnoreRanges(text);
   const mathRange = ranges.find(r => text.slice(r.start, r.end).includes("math"));
   assert.ok(mathRange, "Should find inline math range");
});

test("buildIgnoreRanges should find display math", () => {
   const text = "Text ##{display math} more";
   const ranges = buildIgnoreRanges(text);
   const mathRange = ranges.find(r => text.slice(r.start, r.end).includes("display"));
   assert.ok(mathRange, "Should find display math range");
});

test("buildIgnoreRanges should find commands with braces", () => {
   const text = "\\command{argument}";
   const ranges = buildIgnoreRanges(text);
   assert.ok(ranges.length > 0, "Should find command ranges");
});

// ============================================================================
// Tests: buildCommandRanges function
// ============================================================================

test("buildCommandRanges should find simple commands", () => {
   const text = "\\title{Test}";
   const ranges = buildCommandRanges(text);
   assert.ok(ranges.length > 0, "Should find command");
   assert.ok(ranges.some(r => text.slice(r.start, r.end).includes("\\title")), "Should include \\title");
});

test("buildCommandRanges should find commands with brackets", () => {
   const text = "\\texfig[opt]{content}";
   const ranges = buildCommandRanges(text);
   assert.ok(ranges.length > 0, "Should find command with brackets");
});

test("buildCommandRanges should find multiple commands", () => {
   const text = "\\ul{\\li{one}\\li{two}}";
   const ranges = buildCommandRanges(text);
   // Due to regex matching, the nested braces may merge some commands
   // The important thing is that all command names are covered
   assert.ok(ranges.length >= 2, "Should find command ranges");
   // Verify that \ul is covered
   assert.ok(ranges.some(r => text.slice(r.start, r.start + 3) === "\\ul"), "Should cover \\ul");
});

// ============================================================================
// Tests: shouldIgnoreRule function
// ============================================================================

test("shouldIgnoreRule should return false for non-whitespace rules", () => {
   const diag: MockDiagnostic = {
      startOffset: 0,
      endOffset: 4,
      message: "Possible spelling mistake",
      source: "SPELLING"
   };
   assert.ok(!shouldIgnoreRule(diag), "Should not ignore spelling rules");
});

test("shouldIgnoreRule should return false for grammar rules", () => {
   const diag: MockDiagnostic = {
      startOffset: 0,
      endOffset: 4,
      message: "Subject-verb agreement",
      source: "GRAMMAR"
   };
   assert.ok(!shouldIgnoreRule(diag), "Should not ignore grammar rules");
});

// ============================================================================
// Tests: Full User Document Example
// ============================================================================

test("Should correctly handle user's quiz document", () => {
   const content = `\\date{2025-11-22}

\\import{base-macros}

\\taxon{Quiz} 

\\title{Evaluating sat/unsat/valid}

\\strong{Are the following formulas sat., unsat., or valid?}

\\ol{
  \\li{
    #{(p\\land q) \\to \\neg p}
  }
  \\li{
    #{(p \\land q) \\to (p \\lor \\neg q)}
  }
}

\\solution{
  As a reminder lets recap the definitions:
  \\ul{
    \\li{A formula is \\strong{satisfiable} if there exists at least one combination.}
    \\li{A formula is \\strong{unsatisfiable} if there is no combination.}
  }
}`;

   // All commands should be ignored
   expectIgnored(content, "date");
   expectIgnored(content, "import");
   expectIgnored(content, "taxon");
   expectIgnored(content, "title");
   expectIgnored(content, "strong", "Spelling", undefined, 0);
   expectIgnored(content, "ol");
   expectIgnored(content, "li", "Spelling", undefined, 0);
   expectIgnored(content, "solution");
   expectIgnored(content, "ul");
   
   // Math content should be ignored
   expectIgnored(content, "land", "Spelling", undefined, 0);
   expectIgnored(content, "neg", "Spelling", undefined, 0);
   expectIgnored(content, "lor");
});

// ============================================================================
// Run all tests
// ============================================================================

runTests();
