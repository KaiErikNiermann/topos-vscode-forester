#!/usr/bin/env node
/**
 * Build the artifact, commit `dist/graph-view/`, and force-update the rolling
 * `graph-view-latest` tag. Notes-site `graph-vendor` stage fetches via
 * `git archive --remote=<this-repo> graph-view-latest dist/graph-view`.
 */
import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const log = (msg) => process.stderr.write(`[release-graph-view] ${msg}\n`);
const run = (cmd, args, opts = {}) => {
  log(`$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd ?? ROOT });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

run("node", ["scripts/build-graph-view.mjs"]);

const manifest = JSON.parse(
  await fsp.readFile(path.join(ROOT, "dist", "graph-view", "manifest.json"), "utf-8"),
);
const shortHash = manifest.contentHash.slice(0, 12);

run("git", ["add", "-f", "dist/graph-view"]);
run("git", ["commit", "-m", `chore(graph-view): release ${shortHash}`]);
run("git", ["tag", "-f", "graph-view-latest"]);

log(`released ${shortHash}. Push the tag with: git push origin graph-view-latest --force`);
