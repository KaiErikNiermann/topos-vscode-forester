import assert from "node:assert/strict";

import {
   buildLatexDocument,
   classifyLatexFailure,
   aliasStructuralPrimitiveCalls,
   collectDefinedStructuralPrimitives,
   composeTexInputs,
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
   resolveProjectPreamble,
   selectProjectPreambleMacro,
   substituteForesterMacroArgs,
   type ForesterMacroDefinition,
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

test("renders no blank lines inside math (verbatim heralds on their own lines)", () => {
   // Regression: \startverb / \stopverb sitting on their own indented lines left
   // a whitespace-only line behind after unwrapping. TeX reads a blank line as
   // \par, which is illegal in math mode and aborts with "Missing $ inserted".
   const source = [
      "##{",
      "  \\startverb",
      "  \\alpha = \\begin{cases} a & b \\\\ \\top & d \\end{cases}",
      "  \\stopverb",
      "}",
   ].join("\n");
   const offset = source.indexOf("\\alpha");

   const snippet = findHoverTexSnippetAtOffset(source, offset);
   assert.ok(snippet);

   const rendered = buildRenderableLatexBody(snippet);
   const hasBlankLine = rendered.split("\n").some(line => line.trim().length === 0);
   assert.equal(hasBlankLine, false, `rendered math must not contain a blank line:\n${rendered}`);
   assert.equal(rendered.startsWith("\\["), true);
   assert.equal(rendered.includes("\\begin{cases}"), true);
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

// ── Brace-less single arguments ──────────────────────────────────────────────
//
// \norm v == \norm{v}. This module is the only place in the extension that has
// both a hand-rolled parser and real arity (from \def), so it is the only one
// that can resolve the brace-less form -- everywhere else it stays a sibling
// text node. Without this the LaTeX preview silently vanishes on every bare
// call.

const braceLessDefs = new Map(
   parseForesterMacroDefinitions([
      "\\def\\norm[x]{\\tex{}{\\lVert \\x \\rVert}}",
      "\\def\\vecd[x]{\\tex{}{\\vec{\\x}}}",
      "\\def\\pair[a][b]{\\tex{}{(\\a,\\b)}}",
   ].join("\n")).map(def => [def.name, def]),
);

function callAt(source: string, needle: string) {
   return findForesterMacroCallAtOffset(source, source.indexOf(needle), braceLessDefs);
}

test("a bare word is the argument", () => {
   const call = callAt("\\norm v", "v");
   assert.ok(call);
   assert.equal(call.args.get("x"), "v");
});

test("a bare argument works mid-prose", () => {
   const call = callAt("text \\norm v more", "\\norm");
   assert.ok(call);
   assert.equal(call.args.get("x"), "v");
});

// The argument is the whole TEXT token, so trailing punctuation rides along --
// matching what the compiler captures.
test("a bare argument keeps trailing punctuation", () => {
   const call = callAt("\\norm word, rest", "\\norm");
   assert.ok(call);
   assert.equal(call.args.get("x"), "word,");
});

// In math the lexer produces x^2 as one token, so the whole-word rule would
// read \norm{x^2}. Stopping at the first non-alphanumeric gives TeX's answer.
test("a bare argument in math stops at a superscript", () => {
   const source = "#{\\norm x^2}";
   const call = findForesterMacroCallAtOffset(source, source.indexOf("\\norm"), braceLessDefs);
   assert.ok(call);
   assert.equal(call.args.get("x"), "x");
   assert.equal(source[call.range.end], "^", "the call must end before the superscript");
});

test("a bare control sequence in math is an argument", () => {
   const source = "#{\\vecd\\alpha}";
   const call = findForesterMacroCallAtOffset(source, source.indexOf("\\vecd"), braceLessDefs);
   assert.ok(call);
   assert.equal(call.args.get("x"), "\\alpha");
});

test("math with no leading alphanumeric run takes no bare argument", () => {
   const source = "#{\\norm ^2}";
   assert.equal(findForesterMacroCallAtOffset(source, source.indexOf("\\norm"), braceLessDefs), undefined);
});

test("bare and braced arguments mix", () => {
   const call = callAt("\\pair a{b}", "\\pair");
   assert.ok(call);
   assert.equal(call.args.get("a"), "a");
   assert.equal(call.args.get("b"), "b");
});

test("whitespace and a single newline before a brace still bind", () => {
   for (const source of ["\\norm {v}", "\\norm\n{v}"]) {
      const call = findForesterMacroCallAtOffset(source, 1, braceLessDefs);
      assert.ok(call, `expected a call for ${JSON.stringify(source)}`);
      assert.equal(call.args.get("x"), "v");
   }
});

// LaTeX's \par rule: a blank line ends argument scanning. This one CHANGES
// existing behaviour -- the call used to bind across the break.
test("a paragraph break stops argument scanning", () => {
   assert.equal(findForesterMacroCallAtOffset("\\norm\n\n{v}", 1, braceLessDefs), undefined);
});

// A definition site is not a call: '[' is outside the bare-argument class, so
// it fails to parse exactly as it did before.
test("a definition site is still not a macro call", () => {
   const source = "\\def\\norm[x]{\\tex{}{\\lVert \\x \\rVert}}";
   assert.equal(findForesterMacroCallAtOffset(source, source.indexOf("[x]"), braceLessDefs), undefined);
});

// ── buildLatexDocument ────────────────────────────────────────────────────────

test("emits the class options as a comma list", () => {
   const source = buildLatexDocument({
      documentClass: "standalone",
      documentClassOptions: ["preview", "border=2pt"],
      macroPreamble: "",
      snippetPreamble: "",
      body: "\\(x\\)",
      foregroundColor: "black",
   });

   assert.ok(source.startsWith("\\documentclass[preview,border=2pt]{standalone}"));
});

test("omits the bracket group when there are no class options", () => {
   const source = buildLatexDocument({
      documentClass: "article",
      documentClassOptions: [],
      macroPreamble: "",
      snippetPreamble: "",
      body: "\\(x\\)",
      foregroundColor: "black",
   });

   assert.ok(source.startsWith("\\documentclass{article}"));
});

test("orders the user preamble before the compatibility shims", () => {
   const source = buildLatexDocument({
      documentClass: "standalone",
      documentClassOptions: [],
      macroPreamble: "\\newcommand{\\N}{\\mathbb{N}}",
      snippetPreamble: "\\usepackage{stmaryrd}",
      body: "\\(\\N\\)",
      foregroundColor: "black",
   });

   // stmaryrd owns \llbracket; the shim must not pre-empt it.
   assert.ok(source.indexOf("\\usepackage{stmaryrd}") < source.indexOf("\\providecommand{\\llbracket}"));
   assert.ok(source.indexOf("\\newcommand{\\N}") < source.indexOf("\\begin{document}"));
});

test("loads quiver only for diagram bodies", () => {
   const base = {
      documentClass: "standalone",
      documentClassOptions: [],
      macroPreamble: "",
      snippetPreamble: "",
      foregroundColor: "black" as const,
   };

   assert.ok(!buildLatexDocument({ ...base, body: "\\(x\\)" }).includes("quiver.sty"));
   assert.ok(buildLatexDocument({ ...base, body: "\\begin{tikzcd} A \\end{tikzcd}" }).includes("quiver.sty"));
});

test("colours the body for the active theme", () => {
   const dark = buildLatexDocument({
      documentClass: "standalone",
      documentClassOptions: [],
      macroPreamble: "",
      snippetPreamble: "",
      body: "\\(x\\)",
      foregroundColor: "white",
   });

   assert.ok(dark.includes("\\color{white}"));
});



// ── Structural TeX primitives ─────────────────────────────────────────────────

test("defines a structural TeX primitive under a private alias", () => {
   // \span is what \halign uses to read an alignment preamble, so the forest's
   // definition must not take the name — but it must not be lost either.
   const [span] = parseForesterMacroDefinitions("\\def\\span{\\operatorname{span}}");
   const converted = convertForesterMacroToLatexCommand(span);
   assert.ok(converted?.includes("csname foresterprimspan"));
   assert.ok(!converted?.includes("csname span"));
});

test("rewrites a redefined primitive's math call sites to the alias", () => {
   const defined = collectDefinedStructuralPrimitives(
      parseForesterMacroDefinitions("\\def\\span{\\operatorname{span}}"),
   );
   assert.deepEqual([...defined], ["span"]);

   const body = buildRenderableLatexBody(
      { kind: "math-inline", range: { start: 0, end: 0 }, body: "\\span(v_1, v_2)" },
      defined,
   );
   assert.equal(body, "\\(\\foresterprimspan(v_1, v_2)\\)");
});

test("a tex body keeps the primitive — a raw group expands nothing", () => {
   const defined = collectDefinedStructuralPrimitives(
      parseForesterMacroDefinitions("\\def\\span{\\operatorname{span}}"),
   );
   const body = buildRenderableLatexBody(
      { kind: "tex", range: { start: 0, end: 0 }, preamble: "", body: "a &\\span b" },
      defined,
   );
   assert.ok(body.includes("\\span"));
   assert.ok(!body.includes("foresterprimspan"));
});

test("aliasing matches whole command names only", () => {
   const defined = new Set(["span"]);
   assert.equal(aliasStructuralPrimitiveCalls("\\spanning \\span", defined), "\\spanning \\foresterprimspan");
});

test("a primitive the forest does not define is left alone", () => {
   assert.equal(aliasStructuralPrimitiveCalls("\\span x", new Set()), "\\span x");
});

test("still redefines symbol-like kernel names", () => {
   // \Im is amsmath's, but overriding it costs one symbol, not the document.
   const [im] = parseForesterMacroDefinitions("\\def\\Im{\\operatorname{im}}");
   assert.ok(convertForesterMacroToLatexCommand(im)?.includes("csname Im"));
});

test("the assembled preamble never takes the primitive's own name", () => {
   const definitions = parseForesterMacroDefinitions(
      "\\def\\span{\\operatorname{span}}\n\\def\\Set{\\mathbf{Set}}",
   );
   const preamble = buildLatexMacroPreamble(definitions);
   assert.ok(!preamble.includes("csname span\\endcsname"));
   assert.ok(preamble.includes("csname foresterprimspan"));
   assert.ok(preamble.includes("csname Set"));
});

test("shims KaTeX's \\htmlData so \\notation-wrapped symbols render", () => {
   const source = buildLatexDocument({
      documentClass: "standalone",
      documentClassOptions: [],
      macroPreamble: "",
      snippetPreamble: "",
      body: "\\(\\htmlData{notation=009A}{\\mathbb{N}}\\)",
      foregroundColor: "black",
   });

   assert.ok(source.includes("\\providecommand{\\htmlData}[2]{#2}"));
});


// ── Project preamble discovery ────────────────────────────────────────────────

function macroMap(source: string): Map<string, ForesterMacroDefinition> {
   return new Map(parseForesterMacroDefinitions(source).map(d => [d.name, d]));
}

test("discovers the forest's preamble macro by name and shape", () => {
   const macros = macroMap(
      "\\def\\latex-preamble{\\startverb\\usepackage{stmaryrd}\\stopverb}\n" +
      "\\def\\N{\\mathbb{N}}",
   );
   assert.equal(selectProjectPreambleMacro(macros)?.name, "latex-preamble");
});

test("prefers the base preamble over a variant", () => {
   const macros = macroMap(
      "\\def\\latex-preamble/mathpar{\\startverb\\usepackage{mathpartir}\\stopverb}\n" +
      "\\def\\latex-preamble{\\startverb\\usepackage{stmaryrd}\\stopverb}",
   );
   assert.equal(selectProjectPreambleMacro(macros)?.name, "latex-preamble");
});

test("an explicitly named macro always wins", () => {
   const macros = macroMap(
      "\\def\\latex-preamble{\\startverb\\usepackage{stmaryrd}\\stopverb}\n" +
      "\\def\\latex-preamble/bnf{\\startverb\\usepackage{simplebnf}\\stopverb}",
   );
   assert.equal(selectProjectPreambleMacro(macros, "latex-preamble/bnf")?.name, "latex-preamble/bnf");
   // A leading backslash is how a user would write it in settings.
   assert.equal(selectProjectPreambleMacro(macros, "\\latex-preamble/bnf")?.name, "latex-preamble/bnf");
});

test("a macro that only typesets is not a preamble", () => {
   // Named like one, but declares nothing — a placeholder, not the environment.
   const macros = macroMap("\\def\\my-preamble{\\mathbb{N}}");
   assert.equal(selectProjectPreambleMacro(macros), undefined);
});

test("a preamble taking arguments is a template, not the environment", () => {
   const macros = macroMap("\\def\\preamble[opts]{\\startverb\\usepackage{\\opts}\\stopverb}");
   assert.equal(selectProjectPreambleMacro(macros), undefined);
});

test("a forest with no preamble macro resolves to nothing", () => {
   assert.equal(resolveProjectPreamble(macroMap("\\def\\N{\\mathbb{N}}"), new Map()), "");
});

test("resolves a preamble assembled from other macros", () => {
   const macros = macroMap(
      "\\def\\latex-preamble/shims{\\startverb\\providecommand{\\htmlData}[2]{#2}\\stopverb}\n" +
      "\\def\\latex-preamble{\\latex-preamble/shims\\startverb\\usepackage{stmaryrd}\\stopverb}",
   );
   const resolved = resolveProjectPreamble(macros, new Map());
   assert.ok(resolved.includes("\\usepackage{stmaryrd}"));
   assert.ok(resolved.includes("\\providecommand{\\htmlData}"));
});

// ── TEXINPUTS ─────────────────────────────────────────────────────────────────

test("composes a recursive, system-preserving TEXINPUTS", () => {
   const value = composeTexInputs(["/forest/tex", "/forest/theme"]);
   // `//` recurses; the trailing separator appends the system tree rather than
   // replacing it, so ordinary packages keep resolving.
   assert.equal(value, "/forest/tex//:/forest/theme//:");
});

test("keeps an inherited TEXINPUTS after the forest's own directories", () => {
   const value = composeTexInputs(["/forest/tex"], "/opt/texmf//:");
   assert.equal(value, "/forest/tex//:/opt/texmf//:");
});

test("leaves the environment alone when there is nothing to add", () => {
   assert.equal(composeTexInputs([]), undefined);
   assert.equal(composeTexInputs(["", "  "]), undefined);
});

test("does not repeat a directory listed twice", () => {
   assert.equal(composeTexInputs(["/forest/tex", "/forest/tex"]), "/forest/tex//:");
});


// ── Failure diagnosis ─────────────────────────────────────────────────────────

test("names the .sty a preview cannot see", () => {
   const failure = classifyLatexFailure(
      "! LaTeX Error: File `polydiv.sty' not found.\n\nType X to quit",
   );
   assert.equal(failure.kind, "missing-package");
   assert.equal(failure.subject, "polydiv.sty");
   assert.ok(failure.hint.includes("texInputs"));
});

test("names an undefined command", () => {
   const failure = classifyLatexFailure(
      "! Undefined control sequence.\nl.42 \\(\\htmlData",
   );
   assert.equal(failure.kind, "undefined-command");
   assert.equal(failure.subject, "\\htmlData");
});

test("explains a structural primitive rather than calling it undefined", () => {
   const failure = classifyLatexFailure("! Undefined control sequence.\nl.7 x \\noalign");
   assert.equal(failure.kind, "structural-primitive");
   assert.ok(failure.summary.includes("TeX primitive"));
});

test("names an undefined environment", () => {
   const failure = classifyLatexFailure("! LaTeX Error: Environment polydivision undefined.");
   assert.equal(failure.kind, "undefined-environment");
   assert.equal(failure.subject, "polydivision");
});

test("attributes a missing binary to the command that failed", () => {
   const failure = classifyLatexFailure("spawn dvisvgm ENOENT", "dvisvgm");
   assert.equal(failure.kind, "missing-tool");
   assert.equal(failure.subject, "dvisvgm");
});

test("a log it cannot read stays unknown rather than guessing", () => {
   const failure = classifyLatexFailure("! Emergency stop.\n! ==> Fatal error occurred");
   assert.equal(failure.kind, "unknown");
   assert.equal(failure.hint, "");
});

console.log(`\\nTests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);

if (testsFailed > 0) {
   process.exitCode = 1;
}
