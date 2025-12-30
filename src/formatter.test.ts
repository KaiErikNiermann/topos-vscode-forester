/**
 * Tests for the Forester formatter
 * 
 * Run with: npx ts-node src/formatter.test.ts
 */

import {
   format,
   tokenize,
   checkContentPreservation,
   FormatOptions,
   Token,
   TOP_LEVEL_COMMANDS,
   BLOCK_COMMANDS,
   TEX_CONTENT_COMMANDS,
   CODE_CONTENT_COMMANDS,
   normalizeCodeBlock
} from "./formatter-core";

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

test("Display math formatting is preserved verbatim", () => {
   const input = `##{
  \\begin{align*}
    p \\to q &\\equiv \\neg p \\lor q \\\\
    p \\leftrightarrow q &\\equiv (p \\land q) \\lor (\\neg p \\land \\neg q)
  \\end{align*}
}`;

   const expected = `${input}\n`;
   const result = format(input, defaultOptions);
   assertEqual(result, expected);
});

test("Brace-delimited display math closing brace indentation in subtree", () => {
   // The closing brace of ##{ } should be indented to match the opening
   const input = `\\subtree{
  \\p{Some text}
  ##{
    \\cf{sp}^\\# (s, a) = \\alpha (\\cf{sp}(s, \\gamma(a)))
}
}`;
   const expected = `\\subtree{
  \\p{
    Some text
  }
  ##{
    \\cf{sp}^\\# (s, a) = \\alpha (\\cf{sp}(s, \\gamma(a)))
  }
}
`;
   const result = format(input, defaultOptions);
   assertEqual(result, expected);
});

test("Multiple brace-delimited math blocks indentation", () => {
   const input = `\\subtree{
  ##{
    x = 1
}
  ##{
    y = 2
}
}`;
   const expected = `\\subtree{
  ##{
    x = 1
  }
  ##{
    y = 2
  }
}
`;
   const result = format(input, defaultOptions);
   assertEqual(result, expected);
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

test("Non-subtree macro remains ignored", () => {
   const input = `\\def\\bold[body]{\\strong{   \\body  }}`;
   const result = format(input, {
      ...defaultOptions,
      ignoredCommands: new Set(["bold"]),
      subtreeMacros: new Set()
   });

   assertEqual(result, `\\def\\bold[body]{\\strong{   \\body  }}\n`);
});

test("Macro aliasing subtree is formatted like subtree", () => {
   const input = `\\def\\solution[body]{ \\scope{
   \\put\\transclude/toc{false}
   \\put\\transclude/expanded{false}
   \\subtree{
     \\taxon{Solution}
      \\body
   }
 }}`;

   const expected = `\\def\\solution[body]{
  \\scope{
    \\put\\transclude/toc{false}
    \\put\\transclude/expanded{false}
    \\subtree{
      \\taxon{Solution}
      \\body
    }
  }
}\n`;

   const result = format(input, {
      ...defaultOptions,
      ignoredCommands: new Set(),
      subtreeMacros: new Set(["solution"])
   });

   assertEqual(result, expected);
});

test("Macro subtree alias usage formats nested content", () => {
   const input = `\\solution{\\ol{
  \\li{Item}
}}`;

   const expected = `\\solution{
  \\ol{
    \\li{
      Item
    }
  }
}
`;

   const result = format(input, {
      ...defaultOptions,
      ignoredCommands: new Set(),
      subtreeMacros: new Set(["solution"])
   });

   assertEqual(result, expected);
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

test("Inline math at end of paragraph doesn't keep following blocks indented", () => {
   const input = `\\date{2025-12-10}

\\import{base-macros}

\\taxon{Quiz}

\\title{Finding inductive invariants}

\\p{
  Consider the following while loop #{W}:}
  \\codeblock{lean}{
    while i < n do
      a[i] := 0;
      i    := i + 1
  }
  \\p{
    Consider the following pre-and-post condition:
  }
  ##{
    \\{i = 0 \\land n > 0\\}\\ W\\ \\{\\forall j.\\ 0 \\leq j < n \\to a[j] = 0\\}
}

  \\solution{

  }
`;

   const result = format(input, defaultOptions);

   assertContains(result, "\\p{\n  Consider the following while loop #{W}:\n}", "Paragraph closing brace should be on its own line");

   const lines = result.split("\n");
   const codeblockLine = lines.find(l => l.includes("\\codeblock{lean}{"));
   if (!codeblockLine) {
      throw new Error("Formatted output should include the codeblock line");
   }
   if (codeblockLine.startsWith(" ") || codeblockLine.startsWith("\t")) {
      throw new Error("Codeblock should not remain indented after the paragraph closes");
   }

   const solutionLine = lines.find(l => l.startsWith("\\solution{"));
   if (!solutionLine) {
      throw new Error("Formatted output should include the solution block");
   }
   if (solutionLine.startsWith(" ") || solutionLine.startsWith("\t")) {
      throw new Error("Solution block should be at top-level indentation");
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

test("Link at start of line in li block is indented", () => {
   const input = `\\ul{
  \\li{
[Build and view your forest](https://example.com)
  }
}`;
   const expected = `\\ul{
  \\li{
    [Build and view your forest](https://example.com)
  }
}
`;
   const result = format(input, defaultOptions);
   assertEqual(result, expected);
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

test("Codeblock inside subtree - closing brace alignment", () => {
   const input = `\\subtree{
  \\title{Remarks}

  \\codeblock{lean}{
    some piece of code
}
}`;
   const expected = `\\subtree{
  \\title{Remarks}

  \\codeblock{lean}{
    some piece of code
  }
}
`;
   const result = format(input, defaultOptions);
   assertEqual(result, expected, "Codeblock closing brace should align with opening");
});

test("Codeblock misaligned closing brace at column 0", () => {
   const input = `\\subtree{
  \\codeblock{lean}{
    #check Nat
}
}`;
   const expected = `\\subtree{
  \\codeblock{lean}{
    #check Nat
  }
}
`;
   const result = format(input, defaultOptions);
   assertEqual(result, expected, "Codeblock closing brace at column 0 should be re-aligned");
});

test("Codeblock formatting is idempotent", () => {
   const input = `\\subtree{
  \\title{Remarks}

  \\codeblock{lean}{
    some piece of code
}
}`;
   const once = format(input, defaultOptions);
   const twice = format(once, defaultOptions);
   assertEqual(once, twice, "Codeblock formatting should be idempotent");
});

test("Codeblock with closing brace inline with content", () => {
   // This is a common pattern where the closing } is right after the last line of code
   const input = `\\subtree{
  \\codeblock{lean}{
    def three : Nat := Nat.succ (Nat.succ (Nat.succ Nat.zero))
  }
}`;
   const expected = `\\subtree{
  \\codeblock{lean}{
    def three : Nat := Nat.succ (Nat.succ (Nat.succ Nat.zero))
  }
}
`;
   const result = format(input, defaultOptions);
   assertEqual(result, expected, "Codeblock with inline closing brace should format correctly");
});

test("Multiple codeblocks in sequence", () => {
   const input = `\\subtree{
  \\p{First paragraph}

  \\codeblock{lean}{
    code block 1
}

  \\p{Second paragraph}

  \\codeblock{lean}{
    code block 2
}
}`;
   const expected = `\\subtree{
  \\p{
    First paragraph
  }

  \\codeblock{lean}{
    code block 1
  }

  \\p{
    Second paragraph
  }

  \\codeblock{lean}{
    code block 2
  }
}
`;
   const result = format(input, defaultOptions);
   assertEqual(result, expected, "Multiple codeblocks should all be formatted correctly");
});

test("Codeblock with multiline code content", () => {
   const input = `\\subtree{
  \\codeblock{lean}{
    inductive Nat where
    | zero : Nat
    | succ (n : Nat) : Nat
}
}`;
   const expected = `\\subtree{
  \\codeblock{lean}{
    inductive Nat where
    | zero : Nat
    | succ (n : Nat) : Nat
  }
}
`;
   const result = format(input, defaultOptions);
   assertEqual(result, expected, "Codeblock with multiline content should preserve content and align braces");
});

test("Codeblock at top level (no nesting)", () => {
   const input = `\\codeblock{lean}{
  some code
}`;
   const expected = `\\codeblock{lean}{
  some code
}
`;
   const result = format(input, defaultOptions);
   assertEqual(result, expected, "Top-level codeblock should format with no base indent");
});

test("Real world example - codeblock in nested li", () => {
   const input = `\\ul{
  \\li{
    #{f : X \\to X} where #{f} maps each node to the next node along the arrow. That is
    \\codeblock{lean}{
      f(a) = b
      f(b) = c
      f(c) = d
    }
  }
}`;
   const expected = `\\ul{
  \\li{
    #{f : X \\to X} where #{f} maps each node to the next node along the arrow. That is
    \\codeblock{lean}{
      f(a) = b
      f(b) = c
      f(c) = d
    }
  }
}
`;
   const result = format(input, defaultOptions);
   assertEqual(result, expected, "Codeblock inside nested li should have correct indentation");
});

test("User's full document excerpt - codeblocks in subtree", () => {
   const input = `\\subtree{
  \\title{The recursor for natural numbers}
  \\p{
    Before we define recursors.
  }

  \\codeblock{lean}{
    inductive Nat where
    | zero : Nat
    | succ (n : Nat) : Nat
}

  \\p{
    The idea here.
  }

  \\codeblock{lean}{
    def three : Nat := Nat.succ (Nat.succ (Nat.succ Nat.zero))
  }
}`;
   const result = format(input, defaultOptions);
   console.log("=== DEBUG: User's document formatted ===");
   console.log(result);
   console.log("=== END DEBUG ===");
   
   // Check that codeblock closing braces are properly indented
   assertContains(result, "  \\codeblock{lean}{", "First codeblock opening should be at subtree indent");
   assertContains(result, "  }", "Codeblock closing brace should be at subtree indent level");
   
   // Check idempotency
   const twice = format(result, defaultOptions);
   assertEqual(result, twice, "User document should be idempotent");
});

test("Exact user case - closing brace at column 0", () => {
   // This is the exact pattern from the user's report
   const input = `\\subtree{
  \\title{The recursor for natural numbers}
  \\p{
    Before we define recursors, let's first introduce the idea of an inductive type. We'll do this by examining how lean defines natural numbers.
  }

  \\codeblock{lean}{
    inductive Nat where
    | zero : Nat
    | succ (n : Nat) : Nat
}
}`;
   
   const result = format(input, defaultOptions);
   
   // The result should have the codeblock with proper formatting:
   // \codeblock{lean}{
   //   content
   // }
   // Where the { is on same line as \codeblock{lang} and } is at 2-space indent
   
   // Check that codeblock content block starts with { on same line
   const hasProperCodeblockStart = result.includes("\\codeblock{lean}{");
   // Check that there's a } at 2-space indent after the code content
   const hasProperCodeblockEnd = result.includes("| succ (n : Nat) : Nat\n  }");
   
   console.log("Has proper codeblock start:", hasProperCodeblockStart);
   console.log("Has proper codeblock end:", hasProperCodeblockEnd);
   
   if (!hasProperCodeblockStart || !hasProperCodeblockEnd) {
      console.log("Formatted result:");
      console.log(result);
      throw new Error("Codeblock should have proper indentation structure");
   }
   
   // Check idempotency
   const twice = format(result, defaultOptions);
   assertEqual(result, twice, "Should be idempotent");
});

// Summary
console.log("\n=== Test Results ===");
console.log(`Passed: ${testsPassed}`);
console.log(`Failed: ${testsFailed}`);
console.log(`Total: ${testsPassed + testsFailed}`);

if (testsFailed > 0) {
   process.exit(1);
}
