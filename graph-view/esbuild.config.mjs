import { build } from "esbuild";

const production = process.argv.includes("--production");

await build({
  entryPoints: ["src/renderer.ts"],
  bundle: true,
  format: "iife",
  globalName: "ForesterGraphView",
  platform: "browser",
  target: "es2020",
  outfile: "dist/graph.js",
  minify: production,
  sourcemap: !production,
  logLevel: "info",
});
