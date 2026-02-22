/**
 * Tests for the Forester formatter (format-standalone bridge).
 *
 * Run with: npm run test:langium-formatter
 *
 * Uses formatDocument() from src/language/format-standalone.ts.
 * Since format-standalone.ts delegates to formatter-core.ts, these tests
 * produce identical output to formatter.test.ts and can use exact assertEqual
 * assertions.
 */

import { formatDocument } from './language/format-standalone.js';

// ─── Minimal test framework ────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
   try {
      await fn();
      passed++;
      console.log(`✓ ${name}`);
   } catch (e) {
      failed++;
      console.log(`✗ ${name}`);
      console.log(`  ${e instanceof Error ? e.message : e}`);
   }
}

function assertEqual(actual: string, expected: string, msg?: string): void {
   if (actual !== expected) {
      const label = msg ? `${msg}\n` : '';
      throw new Error(
         `${label}Expected: ${JSON.stringify(expected)}\n` +
         `Actual  : ${JSON.stringify(actual)}`,
      );
   }
}

function assertContains(actual: string, sub: string, msg?: string): void {
   if (!actual.includes(sub)) {
      throw new Error(
         `${msg ?? 'Missing substring'}\n` +
         `Expected to contain: ${JSON.stringify(sub)}\n` +
         `Actual: ${JSON.stringify(actual)}`,
      );
   }
}

// ─── Tests ────────────────────────────────────────────────────────────────

void (async () => {

console.log('\n=== Forester Formatter Tests (format-standalone bridge) ===\n');

// ── Basic formatting ────────────────────────────────────────────────────────

await test('Simple title and content', async () => {
   const input = `\\title{Hello World}`;
   const expected = `\\title{Hello World}\n`;
   assertEqual(await formatDocument(input), expected);
});

await test('Multiple metadata commands', async () => {
   const input = `\\date{2025-12-02}\\import{base-macros}\\taxon{Quiz}\\title{Test}`;
   const result = await formatDocument(input);
   assertContains(result, '\\date{2025-12-02}');
   assertContains(result, '\\import{base-macros}');
   assertContains(result, '\\taxon{Quiz}');
   assertContains(result, '\\title{Test}');
});

await test('Multiple metadata commands each on new line', async () => {
   const result = await formatDocument(
      '\\date{2025-12-02}\\import{base-macros}\\taxon{Quiz}\\title{Test}',
   );
   const lines = result.split('\n').filter(l => l.trim().length > 0);
   const cmdLines = lines.filter(l => l.match(/^\\(date|import|taxon|title)\{/));
   if (cmdLines.length < 4) {
      throw new Error(`Expected 4 separate command lines, got ${cmdLines.length}`);
   }
});

await test('Paragraph formatting', async () => {
   const input = `\\p{This is a paragraph.}`;
   const result = await formatDocument(input);
   assertContains(result, '\\p{');
   assertContains(result, 'This is a paragraph.');
   assertContains(result, '}');
});

await test('Inline math preservation', async () => {
   const input = `\\p{The equation #{x^2 + y^2 = z^2} is famous.}`;
   const result = await formatDocument(input);
   assertContains(result, '#{x^2 + y^2 = z^2}');
});

await test('Display math preservation', async () => {
   const input = `##{
  U = \\{a, b, c\\}
}`;
   const result = await formatDocument(input);
   assertContains(result, '##{');
   assertContains(result, 'U = \\{a, b, c\\}');
});

await test('Display math formatting is preserved verbatim', async () => {
   const input = `##{
  \\begin{align*}
    p \\to q &\\equiv \\neg p \\lor q \\\\
    p \\leftrightarrow q &\\equiv (p \\land q) \\lor (\\neg p \\land \\neg q)
  \\end{align*}
}`;
   const expected = `${input}\n`;
   assertEqual(await formatDocument(input), expected);
});

await test('Brace-delimited display math closing brace indentation in subtree', async () => {
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
   assertEqual(await formatDocument(input), expected);
});

await test('Multiple brace-delimited math blocks indentation', async () => {
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
   assertEqual(await formatDocument(input), expected);
});

// ── Nested lists ────────────────────────────────────────────────────────────

await test('Nested lists - basic', async () => {
   const input = `\\ol{
\\li{First item}
\\li{Second item}
}`;
   const result = await formatDocument(input);
   assertContains(result, '\\ol{');
   assertContains(result, '\\li{');
});

await test('Nested lists - double nesting', async () => {
   const input = `\\ol{
  \\li{Item one}
  \\li{Item two
    \\ol{
      \\li{Nested A}
      \\li{Nested B}
    }
  }
}`;
   const result = await formatDocument(input);
   assertContains(result, '\\ol{');
   assertContains(result, '\\li{');
});

await test('Complex nested structure from user example', async () => {
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
   const result = await formatDocument(input);
   assertContains(result, '\\ol{');
   assertContains(result, 'Does the interpetation');
   assertContains(result, 'Which interpretations');
});

await test('Solution block with nested content', async () => {
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
   const result = await formatDocument(input);
   assertContains(result, '\\solution{');
   assertContains(result, '\\ol{');
   assertContains(result, '\\li{');
});

// ── Macro definitions ────────────────────────────────────────────────────────

await test('Non-subtree macro remains ignored', async () => {
   const input = `\\def\\bold[body]{\\strong{   \\body  }}`;
   const result = await formatDocument(input, { ignoredCommands: new Set(['bold']) });
   assertEqual(result, `\\def\\bold[body]{\\strong{   \\body  }}\n`);
});

await test('Macro aliasing subtree is formatted like subtree', async () => {
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
   const result = await formatDocument(input, {
      ignoredCommands: new Set(),
      subtreeMacros: new Set(['solution']),
   });
   assertEqual(result, expected);
});

await test('Macro subtree alias usage formats nested content', async () => {
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
   const result = await formatDocument(input, {
      ignoredCommands: new Set(),
      subtreeMacros: new Set(['solution']),
   });
   assertEqual(result, expected);
});

// ── Verbatim blocks ─────────────────────────────────────────────────────────

await test('Preserve verbatim blocks exactly', async () => {
   const input = `\\startverb%tex
\\begin{equation}
  E = mc^2
\\end{equation}
\\stopverb`;
   const result = await formatDocument(input);
   assertContains(result, '\\begin{equation}');
   assertContains(result, 'E = mc^2');
   assertContains(result, '\\end{equation}');
});

// ── Comments ────────────────────────────────────────────────────────────────

await test('Comments are preserved', async () => {
   const input = `% This is a comment
\\title{Test}`;
   const result = await formatDocument(input);
   assertContains(result, '% This is a comment');
});

// ── Inline commands ─────────────────────────────────────────────────────────

await test('Inline formatting commands', async () => {
   const input = `\\p{This has \\em{emphasized} and \\strong{bold} text.}`;
   const result = await formatDocument(input);
   assertContains(result, '\\em{emphasized}');
   assertContains(result, '\\strong{bold}');
});

await test('Ref command inline', async () => {
   const input = `\\p{See \\ref{other-tree} for more.}`;
   const result = await formatDocument(input);
   assertContains(result, '\\ref{other-tree}');
});

await test('Transclude command', async () => {
   const input = `\\transclude{another-tree}`;
   const result = await formatDocument(input);
   assertContains(result, '\\transclude{another-tree}');
});

// ── Whitespace normalisation ─────────────────────────────────────────────────

await test('Multiple blank lines should be collapsed to one', async () => {
   const input = `\\title{Test}



\\p{Content}`;
   const result = await formatDocument(input);
   if (result.includes('\n\n\n')) {
      throw new Error('Should not have more than 2 consecutive newlines');
   }
});

await test('Empty document', async () => {
   assertEqual(await formatDocument(''), '\n');
});

await test('Only whitespace', async () => {
   assertEqual(await formatDocument('   \n\n   \t  '), '\n');
});

// ── Mixed inline and block ───────────────────────────────────────────────────

await test('Mixed inline and block content', async () => {
   const input = `\\p{This is text with \\em{emphasis} and \\strong{bold} inline.}`;
   const result = await formatDocument(input);
   assertContains(result, '\\em{emphasis}');
   assertContains(result, '\\strong{bold}');
});

await test('Math with nested braces', async () => {
   const input = `##{\\frac{a}{b} + \\frac{c}{d}}`;
   const result = await formatDocument(input);
   assertContains(result, '\\frac{a}{b}');
   assertContains(result, '\\frac{c}{d}');
});

// ── Links ────────────────────────────────────────────────────────────────────

await test('Link syntax [text](url)', async () => {
   const input = `\\p{Check out [this link](https://example.com) for more info.}`;
   const result = await formatDocument(input);
   assertContains(result, '[this link](https://example.com)');
});

await test('Link at start of line in li block is indented', async () => {
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
   assertEqual(await formatDocument(input), expected);
});

await test('Wiki-style link [[id]]', async () => {
   const input = `\\p{See [[some-tree-id]] for details.}`;
   const result = await formatDocument(input);
   assertContains(result, '[[some-tree-id]]');
});

await test('Link with special characters in URL', async () => {
   const input = `\\p{Check [this link](https://example.com/path?query=value&other=123#anchor) for details.}`;
   const result = await formatDocument(input);
   assertContains(result, 'https://example.com/path?query=value&other=123#anchor');
});

// ── Escaped characters ───────────────────────────────────────────────────────

await test('Escaped characters', async () => {
   const input = `\\p{Use \\% for percent and \\\\ for backslash.}`;
   const result = await formatDocument(input);
   assertContains(result, '\\%');
   assertContains(result, '\\\\');
});

// ── Subtree / query / XML ────────────────────────────────────────────────────

await test('Subtree with address', async () => {
   const input = `\\subtree[my-subtree-id]{
\\title{Subtree Title}
\\p{Content here.}
}`;
   const result = await formatDocument(input);
   assertContains(result, '\\subtree[my-subtree-id]');
   assertContains(result, '\\title{Subtree Title}');
});

await test('Query command', async () => {
   const input = `\\query{
\\query/tag{math}
}`;
   const result = await formatDocument(input);
   assertContains(result, '\\query{');
   assertContains(result, '\\query/tag{math}');
});

await test('XML-style command', async () => {
   const input = `\\<html:div>[class]{container}{Content inside}`;
   const result = await formatDocument(input);
   assertContains(result, '\\<html:div>');
});

await test('Multiple paragraphs', async () => {
   const result = await formatDocument(
      '\\p{First paragraph.}\\p{Second paragraph.}\\p{Third paragraph.}',
   );
   assertContains(result, 'First paragraph.');
   assertContains(result, 'Second paragraph.');
   assertContains(result, 'Third paragraph.');
});

// ── Idempotence ──────────────────────────────────────────────────────────────

await test('Idempotency - formatting twice should give same result', async () => {
   const input = `\\title{Test}
\\p{Content here.}`;
   const once = await formatDocument(input);
   const twice = await formatDocument(once);
   assertEqual(once, twice, 'Formatting should be idempotent');
});

await test('Idempotency - complex document', async () => {
   const input = `\\ol{
  \\li{First}
  \\li{Second
    \\ol{
      \\li{Nested}
    }
  }
}`;
   const once = await formatDocument(input);
   const twice = await formatDocument(once);
   assertEqual(once, twice, 'Formatting nested lists should be idempotent');
});

await test('Deeply nested lists (3 levels) - idempotent', async () => {
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
   const once = await formatDocument(input);
   const twice = await formatDocument(once);
   assertEqual(once, twice, 'Deep nesting should be idempotent');
});

await test("User's full example - idempotency", async () => {
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
   const once = await formatDocument(input);
   const twice = await formatDocument(once);
   const thrice = await formatDocument(twice);
   assertEqual(once, twice, 'User example should be idempotent (1st vs 2nd format)');
   assertEqual(twice, thrice, 'User example should be idempotent (2nd vs 3rd format)');
});

await test('Complex category theory document - idempotent', async () => {
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
   const once = await formatDocument(input);
   const twice = await formatDocument(once);
   assertEqual(once, twice, 'Complex document should be idempotent');
   assertContains(once, '\\strong{faithful}');
   assertContains(once, '\\strong{full}');
   assertContains(once, '\\strong{fully faithful}');
   assertContains(once, '\\blockquote{');
   assertContains(once, 'F_{X, Y}');
});

await test('texfig command with LaTeX content - idempotent', async () => {
   const input = `\\texfig{
  \\[\\begin{tikzcd}
    X && Y
    \\arrow["f", from=1-1, to=1-3]
  \\end{tikzcd}\\]
}`;
   const once = await formatDocument(input);
   const twice = await formatDocument(once);
   assertContains(once, '\\begin{tikzcd}');
   assertContains(once, '\\end{tikzcd}');
   assertEqual(once, twice, 'texfig should be idempotent');
});

await test('ltexfig command with URL and LaTeX content - idempotent', async () => {
   const input = `\\ltexfig{https://example.com}{
  \\[\\begin{tikzcd}
    A \\arrow[r] & B
  \\end{tikzcd}\\]
}`;
   const once = await formatDocument(input);
   const twice = await formatDocument(once);
   assertContains(once, 'https://example.com');
   assertContains(once, '\\begin{tikzcd}');
   assertEqual(once, twice, 'ltexfig should be idempotent');
});

await test('Deeply nested blockquotes and lists - idempotent', async () => {
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
   const once = await formatDocument(input);
   const twice = await formatDocument(once);
   assertEqual(once, twice, 'Deeply nested content should be idempotent');
});

// ── Ignored commands ─────────────────────────────────────────────────────────

await test('Ignored command preserves content exactly', async () => {
   const input = `\\title{Test}

\\texfig[~body]{
  \\begin{tikzcd}
    A \\arrow[r] & B
  \\end{tikzcd}
}`;
   const result = await formatDocument(input, { ignoredCommands: new Set(['texfig']) });
   assertContains(result, '\\texfig[~body]{');
   assertContains(result, '\\begin{tikzcd}');
   assertContains(result, 'A \\arrow[r] & B');
});

await test('Ignored command with multiple arguments', async () => {
   const input = `\\ltexfig[https://example.com][~body]{
  \\begin{tikzcd}
    X \\to Y
  \\end{tikzcd}
}`;
   const result = await formatDocument(input, { ignoredCommands: new Set(['ltexfig']) });
   assertContains(result, '\\ltexfig[https://example.com][~body]{');
   assertContains(result, 'X \\to Y');
});

await test('Ignored command preserves internal whitespace', async () => {
   const input = `\\def\\myMacro[arg1]{
  Some content
    with weird   spacing
      that should be preserved
}`;
   const result = await formatDocument(input, { ignoredCommands: new Set(['def']) });
   assertContains(result, '\\def\\myMacro[arg1]{');
   assertContains(result, 'with weird   spacing');
});

await test('Multiple ignored commands in document', async () => {
   const input = `\\title{Test}

\\texfig[~body]{Content A}

\\p{Regular paragraph}

\\texfig[~body]{Content B}`;
   const result = await formatDocument(input, { ignoredCommands: new Set(['texfig']) });
   assertContains(result, '\\texfig[~body]{Content A}');
   assertContains(result, '\\texfig[~body]{Content B}');
   assertContains(result, '\\p{');
});

await test('Ignored command idempotency', async () => {
   const input = `\\texfig[~body]{
  \\begin{tikzcd}[row sep=small]
    A \\arrow[r] & B \\arrow[d] \\\\
    C \\arrow[u] & D \\arrow[l]
  \\end{tikzcd}
}`;
   const opts = { ignoredCommands: new Set(['texfig']) };
   const once = await formatDocument(input, opts);
   const twice = await formatDocument(once, opts);
   assertEqual(once, twice, 'Ignored command formatting should be idempotent');
});

await test('Mixed ignored and non-ignored commands', async () => {
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
   const result = await formatDocument(input, { ignoredCommands: new Set(['texfig']) });
   assertContains(result, '\\texfig[~body]{');
   const pBlocks = result.match(/\\p\{[\s\S]*?\}/g);
   if (!pBlocks || pBlocks.length < 2) {
      throw new Error('Expected at least 2 paragraph blocks');
   }
});

await test('Ignored command with nested braces', async () => {
   const input = `\\def\\FV[arg1]{#{\\operatorname{FV}(\\arg1)}}`;
   const result = await formatDocument(input, { ignoredCommands: new Set(['def']) });
   assertContains(result, '\\def\\FV[arg1]{#{\\operatorname{FV}(\\arg1)}}');
});

await test('User macro definitions preserved', async () => {
   const input = `\\def\\prn[x]{#{{{\\mathopen{}\\left(\\x\\right)\\mathclose{}}}}}
\\def\\brc[x]{#{{{\\mathopen{}\\left\\{\\x\\right\\}\\mathclose{}}}}}`;
   const result = await formatDocument(input, { ignoredCommands: new Set(['def']) });
   assertContains(result, '\\def\\prn[x]{');
   assertContains(result, '\\def\\brc[x]{');
});

// ── Scope blocks ─────────────────────────────────────────────────────────────

await test('Nested scope blocks properly indented', async () => {
   const input = `\\def\\grammar[body]{
  \\scope{
    \\put?\\base/tex-preamble{
      \\latex-preamble/bnf
}
    \\tex{\\get\\base/tex-preamble}{\\begin{bnf}\\body\\end{bnf}}
}
}`;
   const result = await formatDocument(input);
   const lines = result.split('\n');
   const closingBraceLines = lines.filter(l => l.trim() === '}');
   const indentLevels = new Set(closingBraceLines.map(l => l.match(/^\s*/)?.[0]?.length ?? 0));
   if (indentLevels.size < 2) {
      throw new Error('Expected closing braces at different indentation levels');
   }
});

await test('Scope block formatting idempotent', async () => {
   const input = `\\def\\proof[body]{
 \\scope{
   \\put\\transclude/toc{false}
   \\subtree{
     \\taxon{Proof}
     \\body
   }
 }
}`;
   const once = await formatDocument(input);
   const twice = await formatDocument(once);
   assertEqual(once, twice, 'Scope block formatting should be idempotent');
});

// ── Tex content preservation ──────────────────────────────────────────────────

await test('Tex command content preserved exactly', async () => {
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
   const result = await formatDocument(input);
   assertContains(result, 'colspec = {llcll}');
   assertContains(result, 'column{1} = {font = \\sffamily}');
   assertContains(result, '\\tex{\\get\\base/tex-preamble}{');
   assertContains(result, '\\begin{bnf}[');
   assertContains(result, '\\end{bnf}');
});

await test('Tex command idempotent', async () => {
   const input = `\\tex{\\get\\base/tex-preamble}{
  \\begin{bnf}[
    colspec = {llcll},
    column{1} = {font = \\sffamily}
]
  \\body
  \\end{bnf}
}`;
   const once = await formatDocument(input);
   const twice = await formatDocument(once);
   assertEqual(once, twice, 'Tex command formatting should be idempotent');
});

// ── Codeblock formatting ──────────────────────────────────────────────────────

await test('Codeblock inside subtree - closing brace alignment', async () => {
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
   assertEqual(await formatDocument(input), expected, 'Codeblock closing brace should align with opening');
});

await test('Codeblock misaligned closing brace at column 0', async () => {
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
   assertEqual(await formatDocument(input), expected, 'Codeblock closing brace at column 0 should be re-aligned');
});

await test('Codeblock formatting is idempotent', async () => {
   const input = `\\subtree{
  \\title{Remarks}

  \\codeblock{lean}{
    some piece of code
}
}`;
   const once = await formatDocument(input);
   const twice = await formatDocument(once);
   assertEqual(once, twice, 'Codeblock formatting should be idempotent');
});

await test('Codeblock with closing brace inline with content', async () => {
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
   assertEqual(await formatDocument(input), expected, 'Codeblock with inline closing brace should format correctly');
});

await test('Multiple codeblocks in sequence', async () => {
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
   assertEqual(await formatDocument(input), expected, 'Multiple codeblocks should all be formatted correctly');
});

await test('Codeblock with multiline code content', async () => {
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
   assertEqual(await formatDocument(input), expected, 'Codeblock with multiline content should preserve content and align braces');
});

await test('Codeblock at top level (no nesting)', async () => {
   const input = `\\codeblock{lean}{
  some code
}`;
   const expected = `\\codeblock{lean}{
  some code
}
`;
   assertEqual(await formatDocument(input), expected, 'Top-level codeblock should format with no base indent');
});

await test('Real world example - codeblock in nested li', async () => {
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
   assertEqual(await formatDocument(input), expected, 'Codeblock inside nested li should have correct indentation');
});

await test("User's full document excerpt - codeblocks in subtree", async () => {
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
   const result = await formatDocument(input);
   assertContains(result, '  \\codeblock{lean}{', 'First codeblock opening should be at subtree indent');
   assertContains(result, '  }', 'Codeblock closing brace should be at subtree indent level');
   const twice = await formatDocument(result);
   assertEqual(result, twice, 'User document should be idempotent');
});

await test('Exact user case - closing brace at column 0', async () => {
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
   const result = await formatDocument(input);
   const hasProperCodeblockStart = result.includes('\\codeblock{lean}{');
   const hasProperCodeblockEnd = result.includes('| succ (n : Nat) : Nat\n  }');
   if (!hasProperCodeblockStart || !hasProperCodeblockEnd) {
      throw new Error('Codeblock should have proper indentation structure');
   }
   const twice = await formatDocument(result);
   assertEqual(result, twice, 'Should be idempotent');
});

await test("User's exact edge case - subtree with title containing link and codeblock", async () => {
   const input = `\\subtree{
  \\title{[Lean representation](https://github.com/leanprover-community/mathlib4/blob/0fecc98248f62972b3fc32f83e1966c657fbb658/Mathlib/Combinatorics/Quiver/Basic.lean#L35-L47)}
    \\p{
      The lean representation of this construct is given as follows:
    }
    \\codeblock{lean}{
      universe v v₁ v₂ u u₁ u₂

      class Quiver (V : Type u) where
        Hom : V → V → Sort v
    }
  }`;
   const result = await formatDocument(input);
   const realLines = result.split('\n');
   const lastNonEmpty = realLines.filter(l => l.trim() !== '').pop() ?? '';
   if (lastNonEmpty !== '}') {
      throw new Error(`Subtree closing brace should be at column 0, got: ${JSON.stringify(lastNonEmpty)}`);
   }
   const twice = await formatDocument(result);
   assertEqual(result, twice, 'Should be idempotent');
});

// ── Full document ─────────────────────────────────────────────────────────────

await test('Full document from user', async () => {
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
   const result = await formatDocument(input);
   assertContains(result, '\\date{2025-12-02}');
   assertContains(result, '\\import{base-macros}');
   assertContains(result, '\\taxon{Quiz}');
   assertContains(result, '\\title{Function & Predicate congruence}');
   assertContains(result, 'U = \\{a, b, c\\}');
   assertContains(result, 'I(=) \\triangleq');
   assertContains(result, '\\ol{');
   assertContains(result, '\\li{');
   assertContains(result, '\\solution{');
});

// ─── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
   process.exit(1);
}

})();
