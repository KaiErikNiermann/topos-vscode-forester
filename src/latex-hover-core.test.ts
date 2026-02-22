import assert from "node:assert/strict";

import {
   buildLatexMacroPreamble,
   buildRenderableLatexBody,
   convertForesterMacroToLatexCommand,
   extractLatexDefinedCommandNames,
   findFirstTexCommand,
   findForesterMacroCallAtOffset,
   findHoverTexSnippetAtOffset,
   filterTopLevelPutAssignments,
   parseForesterMacroDefinitions,
   parseForesterPutAssignments,
   resolveForesterPreamble,
   substituteForesterMacroArgs,
} from "./latex-hover-core";

let testsPassed = 0;
let testsFailed = 0;

function test(name: string, fn: () => void): void {
   try {
      fn();
      testsPassed += 1;
      console.log(`PASS ${name}`);
   } catch (error) {
      testsFailed += 1;
      console.log(`FAIL ${name}`);
      console.log(`  ${error instanceof Error ? error.message : String(error)}`);
   }
}

console.log("\\n=== LaTeX Hover Core Tests ===\\n");

test("finds inline math snippet under cursor", () => {
   const source = "Equation #{x^2 + y^2} remains useful.";
   const offset = source.indexOf("y^2");

   const snippet = findHoverTexSnippetAtOffset(source, offset);
   assert.ok(snippet);
   assert.equal(snippet.kind, "math-inline");
   assert.equal(snippet.body, "x^2 + y^2");
   assert.equal(buildRenderableLatexBody(snippet), "\\(x^2 + y^2\\)");
});

test("finds display math snippet with nested braces", () => {
   const source = "Before ##{\\frac{a}{b + {c}}} after";
   const offset = source.indexOf("b +");

   const snippet = findHoverTexSnippetAtOffset(source, offset);
   assert.ok(snippet);
   assert.equal(snippet.kind, "math-display");
   assert.equal(snippet.body, "\\frac{a}{b + {c}}");
});

test("does not wrap display math that already uses align-like environments", () => {
   const source = "##{\\begin{align*}a&=b\\\\c&=d\\end{align*}}";
   const offset = source.indexOf("a&=b");

   const snippet = findHoverTexSnippetAtOffset(source, offset);
   assert.ok(snippet);
   assert.equal(snippet.kind, "math-display");
   assert.equal(
      buildRenderableLatexBody(snippet),
      "\\begin{align*}a&=b\\\\c&=d\\end{align*}",
   );
});

test("unwraps startverb/stopverb inside display math snippets before render", () => {
   const source = [
      "##{",
      "  \\startverb",
      "  \\alpha = \\beta",
      "  \\stopverb",
      "}",
   ].join("\n");
   const offset = source.indexOf("\\alpha");

   const snippet = findHoverTexSnippetAtOffset(source, offset);
   assert.ok(snippet);
   assert.equal(snippet.kind, "math-display");

   const rendered = buildRenderableLatexBody(snippet);
   assert.equal(rendered.includes("\\startverb"), false);
   assert.equal(rendered.includes("\\stopverb"), false);
   assert.equal(rendered.includes("\\alpha = \\beta"), true);
});

test("finds \\tex block and extracts both arguments", () => {
   const source = "\\tex{\\get\\base/tex-preamble}{\\begin{bnf}X\\end{bnf}}";
   const offset = source.indexOf("bnf");

   const snippet = findHoverTexSnippetAtOffset(source, offset);
   assert.ok(snippet);
   assert.equal(snippet.kind, "tex");

   if (snippet.kind !== "tex") {
      throw new Error("Expected tex snippet");
   }

   assert.equal(snippet.preamble, "\\get\\base/tex-preamble");
   assert.equal(snippet.body, "\\begin{bnf}X\\end{bnf}");
});

test("converts simple Forester macro definitions into TeX command definitions", () => {
   const content = "\\def\\cf[arg1]{#{\\texttt{\\arg1}}}";
   const definitions = parseForesterMacroDefinitions(content);

   assert.equal(definitions.length, 1);
   const latexCommand = convertForesterMacroToLatexCommand(definitions[0]);
   assert.equal(latexCommand, "\\expandafter\\def\\csname cf\\endcsname#1{\\texttt{#1}}");
});

test("builds TeX macro preamble from mixed Forester definitions", () => {
   const content = [
      "\\def\\cf[arg1]{#{\\texttt{\\arg1}}}",
      "\\def\\bad[body]{\\subtree{\\body}}",
   ].join("\\n");

   const definitions = parseForesterMacroDefinitions(content);
   const preamble = buildLatexMacroPreamble(definitions);

   assert.equal(preamble.includes("\\expandafter\\def\\csname cf\\endcsname#1{\\texttt{#1}}"), true);
   assert.equal(preamble.includes("\\expandafter\\def\\csname bad\\endcsname"), false);
});

test("resolves \\get references and symbolic macro preambles", () => {
   const macros = parseForesterMacroDefinitions("\\def\\latex-preamble/bnf{\\usepackage{bnf}}");
   const puts = parseForesterPutAssignments("\\put?\\base/tex-preamble{\\latex-preamble/bnf}");

   const macroMap = new Map(macros.map(def => [def.name, def]));
   const putMap = new Map(puts.map(entry => [entry.path, entry.value]));

   const resolved = resolveForesterPreamble("\\get\\base/tex-preamble", putMap, macroMap);
   assert.equal(resolved, "\\usepackage{bnf}");
});

test("unwraps Forester startverb/stopverb blocks in resolved preamble", () => {
   const macros = parseForesterMacroDefinitions(
      "\\def\\latex-preamble{\\startverb\n\\usepackage{mathpartir}\n\\stopverb}",
   );
   const macroMap = new Map(macros.map(def => [def.name, def]));
   const resolved = resolveForesterPreamble("\\latex-preamble", new Map(), macroMap);

   assert.equal(resolved.includes("\\startverb"), false);
   assert.equal(resolved.includes("\\stopverb"), false);
   assert.equal(resolved.includes("\\usepackage{mathpartir}"), true);
});

test("expands macro invocation that wraps a tex block with local preamble", () => {
   const definitions = parseForesterMacroDefinitions([
      "\\def\\latex-preamble/mathpar{",
      "  \\startverb",
      "  \\usepackage{mathpartir}",
      "  \\stopverb",
      "}",
      "\\def\\infrule[~body]{",
      "  \\scope{",
      "    \\put?\\base/tex-preamble{\\latex-preamble/mathpar}",
      "    \\tex{\\get\\base/tex-preamble}{\\begin{mathpar}\\body{}\\end{mathpar}}",
      "  }",
      "}",
   ].join("\n"));

   const definitionMap = new Map(definitions.map(def => [def.name, def]));
   const call = "\\infrule{\\inferrule{A}{B}}";
   const callOffset = call.indexOf("A");
   const invocation = findForesterMacroCallAtOffset(call, callOffset, definitionMap);
   assert.ok(invocation);
   assert.equal(invocation.name, "infrule");

   const texSnippet = findFirstTexCommand(invocation.definition.body);
   assert.ok(texSnippet);

   const expandedBody = substituteForesterMacroArgs(texSnippet.body, invocation.args);
   assert.equal(expandedBody, "\\begin{mathpar}\\inferrule{A}{B}\\end{mathpar}");

   const macroPuts = parseForesterPutAssignments(invocation.definition.body);
   const putMap = new Map<string, string>();
   for (const putAssignment of macroPuts) {
      putMap.set(
         putAssignment.path,
         substituteForesterMacroArgs(putAssignment.value, invocation.args),
      );
   }

   const expandedPreambleExpression = substituteForesterMacroArgs(texSnippet.preamble, invocation.args);
   const resolvedPreamble = resolveForesterPreamble(expandedPreambleExpression, putMap, definitionMap);
   assert.equal(resolvedPreamble.includes("\\usepackage{mathpartir}"), true);
});

test("filters out put assignments that only appear inside macro definitions", () => {
   const source = [
      "\\put?\\base/tex-preamble{\\latex-preamble/align}",
      "\\def\\infrule[~body]{",
      "  \\scope{",
      "    \\put?\\base/tex-preamble{\\latex-preamble/mathpar}",
      "    \\tex{\\get\\base/tex-preamble}{\\begin{mathpar}\\body{}\\end{mathpar}}",
      "  }",
      "}",
   ].join("\n");

   const definitions = parseForesterMacroDefinitions(source);
   const puts = parseForesterPutAssignments(source);
   const topLevel = filterTopLevelPutAssignments(puts, definitions);

   assert.equal(puts.length, 2);
   assert.equal(topLevel.length, 1);
   assert.equal(topLevel[0].value, "\\latex-preamble/align");
});

test("skips generated macro commands already defined in tex preamble", () => {
   const definitions = parseForesterMacroDefinitions("\\def\\cf[arg1]{#{\\texttt{\\arg1}}}");
   const defined = extractLatexDefinedCommandNames("\\newcommand{\\cf}[1]{\\texttt{#1}}");
   const preamble = buildLatexMacroPreamble(definitions, defined);

   assert.equal(preamble.trim(), "");
});

test("finds innermost macro call when macros are nested", () => {
   const definitions = parseForesterMacroDefinitions([
      "\\def\\solution[body]{",
      "  \\scope{",
      "    \\put\\transclude/toc{false}",
      "    \\subtree{",
      "      \\taxon{Solution}",
      "      \\body",
      "    }",
      "  }",
      "}",
      "\\def\\infrule[~body]{",
      "  \\scope{",
      "    \\put?\\base/tex-preamble{\\latex-preamble/mathpar}",
      "    \\tex{\\get\\base/tex-preamble}{\\begin{mathpar}\\body{}\\end{mathpar}}",
      "  }",
      "}",
   ].join("\n"));

   const definitionMap = new Map(definitions.map(def => [def.name, def]));

   const source = "\\solution{Some text \\infrule{\\inferrule{A}{B}} more text}";
   const offsetInsideInfrule = source.indexOf("\\inferrule");

   const call = findForesterMacroCallAtOffset(source, offsetInsideInfrule, definitionMap);
   assert.ok(call);
   assert.equal(call.name, "infrule");

   const texSnippet = findFirstTexCommand(call.definition.body);
   assert.ok(texSnippet, "infrule definition should contain a \\tex command");
});

test("returns outermost macro when cursor is outside nested macro arguments", () => {
   const definitions = parseForesterMacroDefinitions([
      "\\def\\solution[body]{",
      "  \\scope{\\subtree{\\body}}",
      "}",
      "\\def\\infrule[~body]{",
      "  \\scope{\\tex{}{\\body{}}}",
      "}",
   ].join("\n"));

   const definitionMap = new Map(definitions.map(def => [def.name, def]));

   const source = "\\solution{Some text here \\infrule{content} after}";
   const offsetOnSomeText = source.indexOf("Some text");

   const call = findForesterMacroCallAtOffset(source, offsetOnSomeText, definitionMap);
   assert.ok(call);
   assert.equal(call.name, "solution");
});

console.log(`\\nTests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);

if (testsFailed > 0) {
   process.exitCode = 1;
}
