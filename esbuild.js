const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
    // ── Extension host bundle (CJS, loaded by VSCode) ────────────────────────
    const ctx = await esbuild.context({
        entryPoints: ["src/extension.ts"],
        bundle: true,
        format: "cjs",
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: "node",
        outfile: "out/extension.js",
        external: ["vscode"],
        logLevel: "info",
        plugins: [
            /* add plugins here */
        ],
    });

    // ── Langium language server bundle (CJS, spawned as a Node.js worker) ────
    // main.ts is the LSP entry point; it is started by the extension host via
    // vscode-languageclient and communicates over IPC.  vscode is marked
    // external because it is not available in the language server process.
    const serverCtx = await esbuild.context({
        entryPoints: ["src/language/main.ts"],
        bundle: true,
        format: "cjs",
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: "node",
        outfile: "out/language/main.js",
        external: ["vscode"],
        logLevel: "info",
    });

    // ── Langium formatter standalone bundle (ESM, dynamically imported) ──────
    // format-standalone.ts wraps the Langium AbstractFormatter for use outside
    // the LSP server.  It is ESM-only (langium is ESM), so it is bundled
    // separately and loaded at runtime via dynamic import() from the CJS
    // extension host.  vscode is marked external (not used in this bundle).
    const langiumCtx = await esbuild.context({
        entryPoints: ["src/language/format-standalone.ts"],
        bundle: true,
        format: "esm",
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: "node",
        outfile: "out/language/format-standalone.mjs",
        external: ["vscode"],
        logLevel: "info",
    });

    // ── Langium hover standalone bundle (ESM, dynamically imported) ───────────
    // hover-standalone.ts uses the Langium parser to locate math/tex snippets
    // at a cursor offset, replacing the hand-rolled parser in latex-hover-core.ts.
    const hoverCtx = await esbuild.context({
        entryPoints: ["src/language/hover-standalone.ts"],
        bundle: true,
        format: "esm",
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: "node",
        outfile: "out/language/hover-standalone.mjs",
        external: ["vscode"],
        logLevel: "info",
    });

    if (watch) {
        await ctx.watch();
        await serverCtx.watch();
        await langiumCtx.watch();
        await hoverCtx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
        await serverCtx.rebuild();
        await serverCtx.dispose();
        await langiumCtx.rebuild();
        await langiumCtx.dispose();
        await hoverCtx.rebuild();
        await hoverCtx.dispose();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
