#!/usr/bin/env node
/**
 * Build the publishable `dist/graph-view/` artifact.
 *
 * Output shape (single source of truth — notes-site graph-vendor stage
 * depends on this exact layout):
 *
 *   dist/graph-view/
 *     graph.js              IIFE bundle of the renderer (exposes window.ForesterGraphView)
 *     graph.css             Renderer stylesheet (verbatim copy)
 *     extract               Node CLI bundle (esbuild ESM)
 *     default-theme.js      Tiny ESM module exporting the default theme
 *     README.md             Contract reference for consumers
 *     manifest.json         { contentHash, commit, date, schemaVersion }
 *
 * `release:graph-view` then commits this dir and force-updates the
 * `graph-view-latest` tag.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist", "graph-view");

const SCHEMA_VERSION = 1;

const log = (msg) => process.stderr.write(`[build-graph-view] ${msg}\n`);

const run = (cmd, args, opts = {}) => {
  log(`$ ${cmd} ${args.join(" ")} (cwd=${path.relative(ROOT, opts.cwd ?? ROOT) || "."})`);
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd ?? ROOT });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
};

const sha256OfDir = async (dir) => {
  const files = [];
  const walk = async (sub) => {
    for (const ent of await fsp.readdir(sub, { withFileTypes: true })) {
      const p = path.join(sub, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile()) files.push(p);
    }
  };
  await walk(dir);
  files.sort();
  const h = createHash("sha256");
  for (const f of files) {
    const rel = path.relative(dir, f);
    h.update(rel);
    h.update("\0");
    h.update(await fsp.readFile(f));
    h.update("\0\0");
  }
  return h.digest("hex");
};

const headSha = () => {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" });
  return res.stdout.trim();
};

const main = async () => {
  await fsp.rm(DIST, { recursive: true, force: true });
  await fsp.mkdir(DIST, { recursive: true });

  // 1. Build the renderer (IIFE bundle exposing window.ForesterGraphView)
  run("node", ["esbuild.config.mjs", "--production"], {
    cwd: path.join(ROOT, "graph-view"),
  });
  await fsp.copyFile(
    path.join(ROOT, "graph-view", "dist", "graph.js"),
    path.join(DIST, "graph.js"),
  );
  await fsp.copyFile(
    path.join(ROOT, "graph-view", "src", "renderer.css"),
    path.join(DIST, "graph.css"),
  );

  // 2. Build the extract CLI (esbuild ESM with Node shebang)
  run("node", ["esbuild.config.mjs", "--production"], {
    cwd: path.join(ROOT, "forester-graph"),
  });
  const extractDest = path.join(DIST, "extract");
  await fsp.copyFile(
    path.join(ROOT, "forester-graph", "dist", "cli.js"),
    extractDest,
  );
  await fsp.chmod(extractDest, 0o755);

  // 3. Emit a tiny default-theme.js (ESM) — consumers may import for the
  //    fallback theme without re-running esbuild themselves.
  const defaultThemePath = path.join(ROOT, "graph-view", "src", "default-theme.ts");
  const themeSource = await fsp.readFile(defaultThemePath, "utf-8");
  // Strip TS type import + annotations; the module is small enough to do this
  // by regex without pulling in a TS compiler.
  const themeJs = themeSource
    .replace(/^import\s+type\s+[^;]+;\s*\n?/m, "")
    .replace(/:\s*Theme\b/g, "")
    .replace(/^export const/, "export const");
  await fsp.writeFile(path.join(DIST, "default-theme.js"), themeJs);

  // 4. README for consumers
  await fsp.writeFile(
    path.join(DIST, "README.md"),
    [
      "# @forester/graph-view artifact",
      "",
      "This directory is the publishable artifact of the forest graph view:",
      "",
      "- `graph.js` — IIFE bundle. Once loaded, `window.ForesterGraphView.mountGraph(opts)` is available.",
      "- `graph.css` — stylesheet, themed via `--graph-*` CSS variables set by the renderer.",
      "- `extract` — Node CLI: `node ./extract extract --out=path/to/data.json --cwd=/path/to/forest`.",
      "- `default-theme.js` — exports `defaultTheme: Theme`.",
      "- `manifest.json` — content hash + commit + schemaVersion (consumers should refuse unknown schemaVersion).",
      "",
      "Consumer contract — see `MountOptions` and `Theme` in the upstream",
      "`graph-view/src/types.ts`.",
      "",
      "**Versioning:** rolling tag `graph-view-latest`. No semver. Drift visible via",
      "`manifest.contentHash`.",
      "",
    ].join("\n"),
  );

  // 5. Manifest
  const contentHash = await sha256OfDir(DIST);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    contentHash,
    commit: headSha(),
    date: new Date().toISOString(),
  };
  await fsp.writeFile(
    path.join(DIST, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  log(`done. contentHash=${contentHash.slice(0, 12)} schemaVersion=${SCHEMA_VERSION}`);
};

main().catch((err) => {
  process.stderr.write(`build-graph-view: ${err.message}\n${err.stack ?? ""}\n`);
  process.exit(1);
});
