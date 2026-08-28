import * as path from "path";
import * as vscode from "vscode";
import { TextDecoder } from "util";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { basename, join, relative } from "path";
import { tmpdir } from "os";

import { match } from "ts-pattern";

import { getForestConfig, getRoot } from "./utils";
import {
   ForesterMacroDefinition,
   ForesterPutAssignment,
   HoverTexSnippet,
   LatexFailure,
   buildLatexDocument,
   classifyLatexFailure,
   composeTexInputs,
   buildLatexMacroPreamble,
   buildRenderableLatexBody,
   collectDefinedStructuralPrimitives,
   extractLatexDefinedCommandNames,
   filterTopLevelPutAssignments,
   findFirstTexCommand,
   findForesterMacroCallAtOffset,
   parseForesterImports,
   parseForesterMacroDefinitions,
   parseForesterPutAssignments,
   resolveForesterPreamble,
   resolveProjectPreamble,
   substituteForesterMacroArgs,
} from "./latex-hover-core";
// ── Langium hover integration (tasks 4–7) ─────────────────────────────────────
// hover-standalone.mjs is a self-contained ESM bundle.  We load it lazily via
// dynamic import() (via `new Function` to prevent esbuild from CJS-ifying it).
// LangiumHoverSnippet is defined inline to avoid importing from the ESM-only
// language/ folder (which would pull it into the CJS root tsconfig).

interface LangiumHoverSnippet {
   kind: 'math-inline' | 'math-display' | 'tex';
   start: number;
   end: number;
   body: string;
   preamble?: string;
}

type FindHoverSnippetFn = (text: string, offset: number) => Promise<LangiumHoverSnippet | undefined>;
let _findHoverSnippetFn: FindHoverSnippetFn | undefined;

async function getLangiumHoverFinder(): Promise<FindHoverSnippetFn> {
   if (!_findHoverSnippetFn) {
      const dynamicImport = new Function('p', 'return import(p)') as
         (p: string) => Promise<{ findHoverSnippetAtOffset: FindHoverSnippetFn }>;
      const bundlePath = path.join(__dirname, 'language', 'hover-standalone.mjs');
      const mod = await dynamicImport(bundlePath);
      _findHoverSnippetFn = mod.findHoverSnippetAtOffset;
   }
   return _findHoverSnippetFn;
}

/** Convert LangiumHoverSnippet to the HoverTexSnippet shape used by the renderer. */
function toHoverTexSnippet(s: LangiumHoverSnippet): HoverTexSnippet {
   if (s.kind === 'tex') {
      return { kind: 'tex', range: { start: s.start, end: s.end }, preamble: s.preamble ?? '', body: s.body };
   }
   return { kind: s.kind, range: { start: s.start, end: s.end }, body: s.body };
}

interface LatexRenderConfig {
   documentClass: string
   documentClassOptions: string[]
   compileCommand: string[]
   dvisvgmCommand: string[]
}

interface ParsedTreeFile {
   imports: string[]
   macroDefinitions: ForesterMacroDefinition[]
   putAssignments: ForesterPutAssignment[]
}

interface MacroContextData {
   macros: Map<string, ForesterMacroDefinition>
   puts: Map<string, string>
}

interface SnippetResolution {
   snippet: HoverTexSnippet
   puts: ReadonlyMap<string, string>
}

interface ExecProcessOptions {
   cwd: string
   input?: Uint8Array
   token?: vscode.CancellationToken
   /** Prepended to the child's environment; carries TEXINPUTS for `latex`. */
   env?: NodeJS.ProcessEnv
}

const defaultLatexRenderConfig: LatexRenderConfig = {
   documentClass: "standalone",
   documentClassOptions: ["preview", "border=2pt"],
   compileCommand: ["latex", "-halt-on-error", "-interaction=nonstopmode"],
   dvisvgmCommand: [
      "dvisvgm",
      "--exact",
      "--clipjoin",
      "--font-format=woff",
      "--zoom=1.3",
      "--stdin",
      "--stdout",
   ],
};

const maxImportDepth = 16;
const latexConfigCacheTtlMs = 2000;
const renderFailureBackoffMs = 15000;
const issuesUrl = "https://github.com/KaiErikNiermann/topos-vscode-forester/issues";

function getErrorMessage(error: unknown): string {
   if (error instanceof Error) {
      return error.message;
   }
   return String(error);
}

class LatexHoverLogger implements vscode.Disposable {
   private readonly channel = vscode.window.createOutputChannel("Forester TeX Hover");

   info(event: string, payload: Record<string, unknown> = {}): void {
      this.log("info", event, payload);
   }

   error(event: string, payload: Record<string, unknown> = {}): void {
      this.log("error", event, payload);
   }

   dispose(): void {
      this.channel.dispose();
   }

   private log(level: "info" | "error", event: string, payload: Record<string, unknown>): void {
      this.channel.appendLine(
         JSON.stringify({
            timestamp: new Date().toISOString(),
            level,
            event,
            ...payload,
         }),
      );
   }
}

export class ForesterLatexHoverService implements vscode.Disposable {
   private readonly textDecoder = new TextDecoder("utf-8");
   private readonly logger = new LatexHoverLogger();

   private readonly storageRoot: vscode.Uri;
   private readonly cacheRoot: vscode.Uri;
   private readonly cacheSvgDir: vscode.Uri;
   private readonly tempDir: vscode.Uri;

   private readonly svgDataUriCache = new Map<string, string>();
   private readonly renderInFlight = new Map<string, Promise<string>>();
   private readonly parsedFileCache = new Map<string, { mtime: number; parsed: ParsedTreeFile }>();
   private readonly importUriCache = new Map<string, vscode.Uri | null>();
   private treeIndex = new Map<string, vscode.Uri>();
   private treeIndexDirty = true;

   private latexConfigCache: { loadedAt: number; config: LatexRenderConfig } | null = null;

   private texInputsCache: { loadedAt: number; value: string | undefined } | null = null;

   private readonly warnedMissingCommands = new Set<string>();
   private readonly failedRenderCooldownUntil = new Map<string, number>();
   private readonly rememberedFailures = new Map<string, LatexFailure>();
   /** The command whose spawn last failed, so ENOENT can be attributed to it. */
   private lastFailedCommand: string | undefined;
   private readonly disposables: vscode.Disposable[] = [];

   constructor(private readonly context: vscode.ExtensionContext) {
      this.storageRoot = context.globalStorageUri ?? vscode.Uri.file(join(tmpdir(), "forest-keeper"));
      this.cacheRoot = vscode.Uri.joinPath(this.storageRoot, "latex-hover");
      this.cacheSvgDir = vscode.Uri.joinPath(this.cacheRoot, "svgs");
      this.tempDir = vscode.Uri.joinPath(this.cacheRoot, "tmp");

      this.disposables.push(
         vscode.workspace.onDidSaveTextDocument((document) => this.handleUriChanged(document.uri)),
         vscode.workspace.onDidCreateFiles((event) => {
            for (const file of event.files) {
               this.handleUriChanged(file);
            }
         }),
         vscode.workspace.onDidDeleteFiles((event) => {
            for (const file of event.files) {
               this.handleUriChanged(file);
            }
         }),
         vscode.workspace.onDidRenameFiles((event) => {
            for (const file of event.files) {
               this.handleUriChanged(file.oldUri);
               this.handleUriChanged(file.newUri);
            }
         }),
      );
   }

   dispose(): void {
      this.logger.dispose();
      for (const disposable of this.disposables) {
         disposable.dispose();
      }
   }

   async provideHover(
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken,
   ): Promise<vscode.Hover | undefined> {
      const featureEnabled = vscode.workspace
         .getConfiguration("forester")
         .get<boolean>("hover.latex.enabled", true);

      if (!featureEnabled || document.languageId !== "forester") {
         return undefined;
      }

      const text = document.getText();
      const offset = document.offsetAt(position);

      if (token.isCancellationRequested) {
         return undefined;
      }

      let cacheKey: string | undefined;
      let snippetKind: HoverTexSnippet["kind"] | undefined;
      // Kept outside the try so the catch can anchor a diagnostic hover to the span
      // the author is actually pointing at.
      let snippetRange: vscode.Range | undefined;

      try {
         const contextData = await this.buildMacroContext(document, text);
         const snippetResolution = await this.resolveSnippetAtOffset(text, offset, contextData);
         if (!snippetResolution) {
            return undefined;
         }

         const { snippet, puts } = snippetResolution;
         snippetKind = snippet.kind;
         snippetRange = new vscode.Range(
            document.positionAt(snippet.range.start),
            document.positionAt(snippet.range.end),
         );
         const latexConfig = await this.getLatexConfig();

         const snippetPreamble = this.buildSnippetPreamble(snippet, puts, contextData.macros);
         const snippetDefinedNames = extractLatexDefinedCommandNames(snippetPreamble);
         const macroPreamble = buildLatexMacroPreamble(contextData.macros.values(), snippetDefinedNames);

         const themeForeground = this.getThemeForegroundColor();
         const latexBody = buildRenderableLatexBody(
            snippet,
            collectDefinedStructuralPrimitives(contextData.macros.values()),
         );
         const latexSource = this.buildLatexSource({
            latexConfig,
            macroPreamble,
            snippetPreamble,
            body: latexBody,
            foregroundColor: themeForeground,
         });

         cacheKey = this.computeCacheKey(snippet, latexSource, latexConfig, themeForeground);
         const remembered = this.rememberedFailure(cacheKey);
         if (remembered) {
            return new vscode.Hover(this.buildFailureMarkdown(remembered), snippetRange);
         }

         const dataUri = await this.getOrRenderSvgDataUri(cacheKey, latexSource, latexConfig, token);

         if (token.isCancellationRequested) {
            return undefined;
         }

         const markdown = new vscode.MarkdownString();
         markdown.supportHtml = true;
         markdown.appendMarkdown(`<img src="${dataUri}" alt="LaTeX preview"/>`);

         return new vscode.Hover(markdown, snippetRange);
      } catch (error) {
         const message = getErrorMessage(error);
         if (token.isCancellationRequested || message.startsWith("Command cancelled:")) {
            return undefined;
         }

         this.logger.error("hover_render_failed", {
            message,
            file: document.fileName,
            snippetKind,
         });

         // A span that will not compile is the case worth explaining: the author sees
         // a preview everywhere else, so silence here reads as "hover is broken"
         // rather than "this span needs something the preview cannot see".
         const failure = classifyLatexFailure(message, this.lastFailedCommand);
         if (cacheKey) {
            this.failedRenderCooldownUntil.set(cacheKey, Date.now() + renderFailureBackoffMs);
            this.rememberedFailures.set(cacheKey, failure);
         }
         return snippetRange
            ? new vscode.Hover(this.buildFailureMarkdown(failure), snippetRange)
            : undefined;
      }
   }

   // Note: resolveSnippetAtOffset is now async (Langium parse is async).
   // The caller (provideHover) already awaits; we make it a proper async method.
   private async resolveSnippetAtOffset(
      text: string,
      offset: number,
      contextData: MacroContextData,
   ): Promise<SnippetResolution | undefined> {
      // Task 4–7: use Langium AST to find math/tex snippets
      try {
         const findSnippet = await getLangiumHoverFinder();
         const langiumSnippet = await findSnippet(text, offset);
         if (langiumSnippet) {
            return { snippet: toHoverTexSnippet(langiumSnippet), puts: contextData.puts };
         }
      } catch (err) {
         // Fall through to hand-rolled parser on Langium failure
         this.logger.info('langium_hover_failed', { message: String(err) });
      }

      const macroCall = findForesterMacroCallAtOffset(text, offset, contextData.macros);
      if (!macroCall) {
         return undefined;
      }

      const texTemplate = findFirstTexCommand(macroCall.definition.body);
      if (!texTemplate) {
         return undefined;
      }

      const localPuts = new Map<string, string>(contextData.puts);
      for (const assignment of parseForesterPutAssignments(macroCall.definition.body)) {
         const value = substituteForesterMacroArgs(assignment.value, macroCall.args);
         if (assignment.isDefault && localPuts.has(assignment.path)) {
            continue;
         }
         localPuts.set(assignment.path, value);
      }

      const snippet: HoverTexSnippet = {
         kind: "tex",
         range: macroCall.range,
         preamble: substituteForesterMacroArgs(texTemplate.preamble, macroCall.args),
         body: substituteForesterMacroArgs(texTemplate.body, macroCall.args),
      };

      return {
         snippet,
         puts: localPuts,
      };
   }

   /**
    * The preamble a snippet renders against.
    *
    * A `\tex{…}{…}` carries its own — that is its first argument, and the forest
    * already decided what belongs there. A math span carries nothing, because forester
    * hands `#{…}` to KaTeX in the browser and never builds a LaTeX document for it, so
    * previewing one here means supplying the preamble that never existed. Falling back
    * to the forest's own declared preamble is what keeps a math preview in parity with
    * the packages, `.sty` shims and `\providecommand`s the forest set up.
    */
   private buildSnippetPreamble(
      snippet: HoverTexSnippet,
      puts: ReadonlyMap<string, string>,
      macros: ReadonlyMap<string, ForesterMacroDefinition>,
   ): string {
      return match(snippet)
         .with({ kind: "tex" }, ({ preamble }) => resolveForesterPreamble(preamble, puts, macros))
         .otherwise(() => this.buildProjectPreamble(puts, macros));
   }

   private buildProjectPreamble(
      puts: ReadonlyMap<string, string>,
      macros: ReadonlyMap<string, ForesterMacroDefinition>,
   ): string {
      const config = vscode.workspace.getConfiguration("forester");
      if (!config.get<boolean>("hover.latex.useProjectPreamble", true)) {
         return "";
      }

      const preferred = config.get<string>("hover.latex.preambleMacro", "").trim();
      return resolveProjectPreamble(macros, puts, preferred.length > 0 ? preferred : undefined);
   }

   /**
    * The diagnosis for a span still inside its retry backoff, if there is one.
    *
    * The backoff exists so a span that cannot compile is not recompiled on every
    * mouse-over. Re-showing the diagnosis costs nothing and keeps the explanation on
    * screen for as long as the failure is real.
    */
   private rememberedFailure(cacheKey: string): LatexFailure | undefined {
      const blockedUntil = this.failedRenderCooldownUntil.get(cacheKey);
      if (!blockedUntil) {
         return undefined;
      }

      if (blockedUntil <= Date.now()) {
         this.failedRenderCooldownUntil.delete(cacheKey);
         this.rememberedFailures.delete(cacheKey);
         return undefined;
      }

      return this.rememberedFailures.get(cacheKey);
   }

   /**
    * The hover shown in place of a preview that did not render.
    *
    * Says what went wrong, what to do about it, and — only when there is nothing
    * actionable to say — points at the issue tracker. Offering the tracker for a
    * missing package the author can install would just be noise.
    */
   private buildFailureMarkdown(failure: LatexFailure): vscode.MarkdownString {
      const markdown = new vscode.MarkdownString();
      markdown.isTrusted = true;
      markdown.appendMarkdown(`$(warning) ${failure.summary}.`);

      if (failure.hint.length > 0) {
         markdown.appendMarkdown(`\n\n${failure.hint}`);
      }

      if (failure.kind === "unknown") {
         markdown.appendMarkdown(
            `\n\nThe LaTeX log is in the **Forester LaTeX Hover** output channel.` +
            ` If the span looks like it should render, please [report it](${issuesUrl}).`,
         );
      }

      return markdown;
   }

   private handleUriChanged(uri: vscode.Uri): void {
      if (uri.scheme !== "file") {
         return;
      }

      if (uri.fsPath.endsWith(".tree")) {
         this.invalidateTreeCaches();
      }

      if (basename(uri.fsPath).endsWith(".toml")) {
         this.latexConfigCache = null;
      }

      // A newly added or removed .sty changes the search path, not the config.
      if (/\.(sty|cls)$/.test(uri.fsPath)) {
         this.texInputsCache = null;
      }
   }

   private invalidateTreeCaches(): void {
      this.parsedFileCache.clear();
      this.importUriCache.clear();
      this.treeIndex.clear();
      this.treeIndexDirty = true;
   }

   private async buildMacroContext(document: vscode.TextDocument, sourceText: string): Promise<MacroContextData> {
      const macros = new Map<string, ForesterMacroDefinition>();
      const puts = new Map<string, string>();

      const currentFile = this.parseTreeContent(sourceText);
      const visited = new Set<string>([document.uri.toString()]);

      for (const importId of currentFile.imports) {
         await this.visitImportedFile(importId, visited, macros, puts, 0);
      }

      this.applyParsedTreeFile(currentFile, macros, puts);

      return { macros, puts };
   }

   private async visitImportedFile(
      importId: string,
      visited: Set<string>,
      macros: Map<string, ForesterMacroDefinition>,
      puts: Map<string, string>,
      depth: number,
   ): Promise<void> {
      if (depth >= maxImportDepth) {
         return;
      }

      const importedUri = await this.resolveImportUri(importId);
      if (!importedUri) {
         return;
      }

      const key = importedUri.toString();
      if (visited.has(key)) {
         return;
      }
      visited.add(key);

      const parsed = await this.parseWorkspaceTreeFile(importedUri);
      for (const nestedImport of parsed.imports) {
         await this.visitImportedFile(nestedImport, visited, macros, puts, depth + 1);
      }

      this.applyParsedTreeFile(parsed, macros, puts);
   }

   private parseTreeContent(content: string): ParsedTreeFile {
      const macroDefinitions = parseForesterMacroDefinitions(content);
      const allPutAssignments = parseForesterPutAssignments(content);
      return {
         imports: parseForesterImports(content),
         macroDefinitions,
         putAssignments: filterTopLevelPutAssignments(allPutAssignments, macroDefinitions),
      };
   }

   private applyParsedTreeFile(
      parsed: ParsedTreeFile,
      macros: Map<string, ForesterMacroDefinition>,
      puts: Map<string, string>,
   ): void {
      for (const macro of parsed.macroDefinitions) {
         macros.set(macro.name, macro);
      }

      for (const assignment of parsed.putAssignments) {
         if (assignment.isDefault && puts.has(assignment.path)) {
            continue;
         }
         puts.set(assignment.path, assignment.value);
      }
   }

   private async resolveImportUri(importId: string): Promise<vscode.Uri | undefined> {
      const cached = this.importUriCache.get(importId);
      if (cached !== undefined) {
         return cached ?? undefined;
      }

      const directPath = vscode.Uri.joinPath(getRoot(), `${importId}.tree`);
      if (await this.fileExists(directPath)) {
         this.importUriCache.set(importId, directPath);
         return directPath;
      }

      await this.ensureTreeIndex();
      const indexed = this.treeIndex.get(importId);
      if (indexed) {
         this.importUriCache.set(importId, indexed);
         return indexed;
      }

      const fallback = await vscode.workspace.findFiles(`**/${importId}.tree`, "**/node_modules/**", 1);
      const resolved = fallback[0];
      this.importUriCache.set(importId, resolved ?? null);

      return resolved;
   }

   private async ensureTreeIndex(): Promise<void> {
      if (!this.treeIndexDirty) {
         return;
      }

      this.treeIndex.clear();

      const root = getRoot();
      const treeFiles = await vscode.workspace.findFiles("**/*.tree", "**/node_modules/**");

      for (const file of treeFiles) {
         const fileBase = basename(file.fsPath, ".tree");
         if (!this.treeIndex.has(fileBase)) {
            this.treeIndex.set(fileBase, file);
         }

         const relPath = relative(root.fsPath, file.fsPath).replace(/\\/g, "/");
         if (relPath.endsWith(".tree")) {
            const withoutExtension = relPath.slice(0, -5);
            if (!this.treeIndex.has(withoutExtension)) {
               this.treeIndex.set(withoutExtension, file);
            }

            const slashIndex = withoutExtension.indexOf("/");
            if (slashIndex > 0) {
               const withoutTopDir = withoutExtension.slice(slashIndex + 1);
               if (!this.treeIndex.has(withoutTopDir)) {
                  this.treeIndex.set(withoutTopDir, file);
               }
            }
         }
      }

      this.treeIndexDirty = false;
   }

   private async parseWorkspaceTreeFile(uri: vscode.Uri): Promise<ParsedTreeFile> {
      const key = uri.toString();

      try {
         const stat = await vscode.workspace.fs.stat(uri);
         const cached = this.parsedFileCache.get(key);
         if (cached && cached.mtime === stat.mtime) {
            return cached.parsed;
         }

         const raw = await vscode.workspace.fs.readFile(uri);
         const content = this.textDecoder.decode(raw);
         const parsed = this.parseTreeContent(content);

         this.parsedFileCache.set(key, {
            mtime: stat.mtime,
            parsed,
         });

         return parsed;
      } catch (error) {
         this.logger.info("parse_tree_file_failed", {
            file: uri.fsPath,
            message: getErrorMessage(error),
         });

         return {
            imports: [],
            macroDefinitions: [],
            putAssignments: [],
         };
      }
   }

   private async fileExists(uri: vscode.Uri): Promise<boolean> {
      try {
         await vscode.workspace.fs.stat(uri);
         return true;
      } catch {
         return false;
      }
   }

   private async getLatexConfig(): Promise<LatexRenderConfig> {
      const now = Date.now();
      if (this.latexConfigCache && now - this.latexConfigCache.loadedAt <= latexConfigCacheTtlMs) {
         return this.latexConfigCache.config;
      }

      const fallback: LatexRenderConfig = {
         documentClass: defaultLatexRenderConfig.documentClass,
         documentClassOptions: [...defaultLatexRenderConfig.documentClassOptions],
         compileCommand: [...defaultLatexRenderConfig.compileCommand],
         dvisvgmCommand: [...defaultLatexRenderConfig.dvisvgmCommand],
      };

      try {
         const forestConfig = await getForestConfig();
         const latexConfig = forestConfig?.forest?.latex;

         const resolved: LatexRenderConfig = {
            documentClass:
               typeof latexConfig?.document_class === "string" && latexConfig.document_class.trim().length > 0
                  ? latexConfig.document_class
                  : fallback.documentClass,
            documentClassOptions: this.resolveStringArray(
               latexConfig?.document_class_options,
               fallback.documentClassOptions,
            ),
            compileCommand: this.resolveStringArray(
               latexConfig?.compile_command,
               fallback.compileCommand,
            ),
            dvisvgmCommand: this.resolveStringArray(
               latexConfig?.dvisvgm_command,
               fallback.dvisvgmCommand,
            ),
         };

         this.latexConfigCache = {
            loadedAt: now,
            config: resolved,
         };

         return resolved;
      } catch (error) {
         this.logger.info("forest_config_parse_failed", {
            message: getErrorMessage(error),
         });

         this.latexConfigCache = {
            loadedAt: now,
            config: fallback,
         };

         return fallback;
      }
   }

   private resolveStringArray(value: unknown, fallback: string[]): string[] {
      if (Array.isArray(value)) {
         const values = value.filter((entry): entry is string => {
            return typeof entry === "string" && entry.trim().length > 0;
         });

         if (values.length > 0) {
            return values;
         }
      }

      return [...fallback];
   }

   /**
    * Directories to put on the TeX search path, in precedence order: whatever the user
    * configured, then any directory in the forest that actually holds a `.sty` or
    * `.cls`.
    *
    * Discovery is shallow on purpose — one level of the workspace root, which is where
    * forests keep `tex/` and `theme/` — because kpathsea recurses into each entry
    * anyway, and a deep walk of a forest with a `build/` tree of thousands of
    * generated files would cost more than the render it is trying to enable.
    */
   private async resolveTexInputs(): Promise<string | undefined> {
      const now = Date.now();
      if (this.texInputsCache && now - this.texInputsCache.loadedAt <= latexConfigCacheTtlMs) {
         return this.texInputsCache.value;
      }

      const directories: string[] = [];
      try {
         const root = getRoot();
         const configured = vscode.workspace
            .getConfiguration("forester")
            .get<string[]>("hover.latex.texInputs", []);

         for (const entry of configured) {
            if (typeof entry !== "string" || entry.trim().length === 0) { continue; }
            directories.push(
               path.isAbsolute(entry) ? entry : join(root.fsPath, entry),
            );
         }

         for (const dir of await this.discoverStyleDirectories(root)) {
            directories.push(dir);
         }
      } catch {
         // No workspace folder — nothing to add, and the fallback is the system path.
      }

      const value = composeTexInputs(directories, process.env.TEXINPUTS);
      this.texInputsCache = { loadedAt: now, value };
      if (value) {
         this.logger.info("texinputs_resolved", { value });
      }
      return value;
   }

   private async discoverStyleDirectories(root: vscode.Uri): Promise<string[]> {
      const skipped = new Set(["node_modules", ".git", "build", "output", "_tmp", "out", "dist"]);
      const found: string[] = [];

      let entries: [string, vscode.FileType][];
      try {
         entries = await vscode.workspace.fs.readDirectory(root);
      } catch {
         return found;
      }

      for (const [name, type] of entries) {
         if (type !== vscode.FileType.Directory || skipped.has(name) || name.startsWith(".")) {
            continue;
         }
         const child = vscode.Uri.joinPath(root, name);
         try {
            const contents = await vscode.workspace.fs.readDirectory(child);
            if (contents.some(([file]) => file.endsWith(".sty") || file.endsWith(".cls"))) {
               found.push(child.fsPath);
            }
         } catch {
            // Unreadable directory — skip it rather than failing the whole render.
         }
      }

      return found;
   }

   private getThemeForegroundColor(): "black" | "white" {
      return match(vscode.window.activeColorTheme.kind)
         .with(vscode.ColorThemeKind.Dark, vscode.ColorThemeKind.HighContrast, () => "white" as const)
         .otherwise(() => "black" as const);
   }

   private buildLatexSource(params: {
      latexConfig: LatexRenderConfig
      macroPreamble: string
      snippetPreamble: string
      body: string
      foregroundColor: "black" | "white"
   }): string {
      const { latexConfig, ...rest } = params;
      return buildLatexDocument({
         documentClass: latexConfig.documentClass,
         documentClassOptions: latexConfig.documentClassOptions,
         ...rest,
      });
   }

   private computeCacheKey(
      snippet: HoverTexSnippet,
      latexSource: string,
      latexConfig: LatexRenderConfig,
      foregroundColor: "black" | "white",
   ): string {
      const hasher = createHash("sha256");
      hasher.update(JSON.stringify(snippet.kind));
      hasher.update("\n");
      hasher.update(foregroundColor);
      hasher.update("\n");
      hasher.update(latexConfig.compileCommand.join("\u0000"));
      hasher.update("\n");
      hasher.update(latexConfig.dvisvgmCommand.join("\u0000"));
      hasher.update("\n");
      hasher.update(latexSource);
      return hasher.digest("hex");
   }

   private async getOrRenderSvgDataUri(
      cacheKey: string,
      latexSource: string,
      latexConfig: LatexRenderConfig,
      token: vscode.CancellationToken,
   ): Promise<string> {
      const inMemory = this.svgDataUriCache.get(cacheKey);
      if (inMemory) {
         return inMemory;
      }

      const inFlight = this.renderInFlight.get(cacheKey);
      if (inFlight) {
         return inFlight;
      }

      const task = this.renderSvgDataUri(cacheKey, latexSource, latexConfig, token);
      this.renderInFlight.set(cacheKey, task);

      try {
         return await task;
      } finally {
         this.renderInFlight.delete(cacheKey);
      }
   }

   private async renderSvgDataUri(
      cacheKey: string,
      latexSource: string,
      latexConfig: LatexRenderConfig,
      token: vscode.CancellationToken,
   ): Promise<string> {
      await this.ensureCacheDirectories();

      const svgFile = vscode.Uri.joinPath(this.cacheSvgDir, `${cacheKey}.svg`);
      if (await this.fileExists(svgFile)) {
         const existing = await vscode.workspace.fs.readFile(svgFile);
         const dataUri = this.toSvgDataUri(this.textDecoder.decode(existing));
         this.svgDataUriCache.set(cacheKey, dataUri);
         return dataUri;
      }

      const svgText = await this.compileLatexToSvg(cacheKey, latexSource, latexConfig, token);
      await vscode.workspace.fs.writeFile(svgFile, Buffer.from(svgText, "utf-8"));

      const dataUri = this.toSvgDataUri(svgText);
      this.svgDataUriCache.set(cacheKey, dataUri);
      return dataUri;
   }

   private async ensureCacheDirectories(): Promise<void> {
      await vscode.workspace.fs.createDirectory(this.cacheSvgDir);
      await vscode.workspace.fs.createDirectory(this.tempDir);
   }

   private toSvgDataUri(svgText: string): string {
      return `data:image/svg+xml;base64,${Buffer.from(svgText, "utf-8").toString("base64")}`;
   }

   private async compileLatexToSvg(
      cacheKey: string,
      latexSource: string,
      latexConfig: LatexRenderConfig,
      token: vscode.CancellationToken,
   ): Promise<string> {
      const workDir = join(this.tempDir.fsPath, cacheKey);
      await fs.mkdir(workDir, { recursive: true });

      try {
         await fs.writeFile(join(workDir, "job.tex"), latexSource, "utf-8");

         await this.runLatexCompile(workDir, latexConfig, token);

         const dviPath = join(workDir, "job.dvi");
         const dviContent = await fs.readFile(dviPath);
         return await this.runDvisvgm(workDir, dviContent, latexConfig, token);
      } finally {
         await fs.rm(workDir, { recursive: true, force: true });
      }
   }

   private async runLatexCompile(
      workDir: string,
      latexConfig: LatexRenderConfig,
      token: vscode.CancellationToken,
   ): Promise<void> {
      const [command, ...rawArgs] = latexConfig.compileCommand;
      if (!command) {
         throw new Error("Missing latex compile command");
      }

      const hasInputFile = rawArgs.some(arg => arg.endsWith(".tex"));
      const args = hasInputFile ? rawArgs : [...rawArgs, "job.tex"];

      const texInputs = await this.resolveTexInputs();

      try {
         await this.executeProcess(command, args, {
            cwd: workDir,
            token,
            ...(texInputs ? { env: { TEXINPUTS: texInputs } } : {}),
         });
      } catch (error) {
         const logPath = join(workDir, "job.log");
         let logTail = "";
         try {
            const logContent = await fs.readFile(logPath, "utf-8");
            const lines = logContent.split(/\r?\n/);
            logTail = lines.slice(-40).join("\n").trim();
         } catch {
            // No log file available, keep original failure details.
         }

         if (logTail.length === 0) {
            throw error;
         }

         throw new Error(
            `${getErrorMessage(error)}\nLaTeX log tail:\n${logTail}`,
         );
      }
   }

   private async runDvisvgm(
      workDir: string,
      dviContent: Uint8Array,
      latexConfig: LatexRenderConfig,
      token: vscode.CancellationToken,
   ): Promise<string> {
      const [command, ...rawArgs] = latexConfig.dvisvgmCommand;
      if (!command) {
         throw new Error("Missing dvisvgm command");
      }

      const args = [...rawArgs];
      const usesStdin = args.includes("--stdin");
      const hasInputFile = args.some(arg => arg.endsWith(".dvi"));

      if (!usesStdin && !hasInputFile) {
         args.push("job.dvi");
      }

      const execution = await this.executeProcess(command, args, {
         cwd: workDir,
         token,
         input: usesStdin ? dviContent : undefined,
      });

      const stdout = execution.stdout.toString("utf-8").trim();
      if (stdout.length > 0) {
         return stdout;
      }

      const standardSvgPath = join(workDir, "job.svg");
      try {
         return await fs.readFile(standardSvgPath, "utf-8");
      } catch {
         const files = await fs.readdir(workDir);
         const fallbackSvg = files.find(name => name.endsWith(".svg"));
         if (fallbackSvg) {
            return await fs.readFile(join(workDir, fallbackSvg), "utf-8");
         }
      }

      throw new Error("dvisvgm did not produce SVG output");
   }

   private executeProcess(
      command: string,
      args: string[],
      options: ExecProcessOptions,
   ): Promise<{ stdout: Buffer; stderr: string }> {
      return new Promise((resolve, reject) => {
         const child = spawn(command, args, {
            cwd: options.cwd,
            stdio: "pipe",
            env: options.env ? { ...process.env, ...options.env } : undefined,
         });

         const stdoutChunks: Buffer[] = [];
         const stderrChunks: Buffer[] = [];

         child.stdout.on("data", (chunk: Buffer) => {
            stdoutChunks.push(chunk);
         });

         child.stderr.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk);
         });

         let cancelled = false;
         const cancellation = options.token?.onCancellationRequested(() => {
            cancelled = true;
            child.kill();
         });

         child.on("error", (error) => {
            cancellation?.dispose();
            this.lastFailedCommand = command;
            this.maybeWarnMissingCommand(command, error);
            reject(error);
         });

         child.on("close", (code) => {
            cancellation?.dispose();

            if (cancelled) {
               reject(new Error(`Command cancelled: ${command}`));
               return;
            }

            const stderr = Buffer.concat(stderrChunks).toString("utf-8");
            if (code === 0) {
               resolve({
                  stdout: Buffer.concat(stdoutChunks),
                  stderr,
               });
               return;
            }

            reject(
               new Error(
                  [
                     `Command failed (${code}): ${command} ${args.join(" ")}`,
                     Buffer.concat(stdoutChunks).toString("utf-8"),
                     stderr,
                  ]
                     .filter(part => part.trim().length > 0)
                     .join("\n"),
               ),
            );
         });

         if (options.input) {
            child.stdin.write(options.input);
         }
         child.stdin.end();
      });
   }

   private maybeWarnMissingCommand(command: string, error: unknown): void {
      const message = getErrorMessage(error);
      const missing = /ENOENT|not found/i.test(message);
      if (!missing || this.warnedMissingCommands.has(command)) {
         return;
      }

      this.warnedMissingCommands.add(command);
      vscode.window.showWarningMessage(
         `Forester LaTeX hover could not run '${command}'. Install it or update [forest.latex] commands.`,
      );
   }
}
