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

    if (watch) {
        await ctx.watch();
        await langiumCtx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
        await langiumCtx.rebuild();
        await langiumCtx.dispose();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
