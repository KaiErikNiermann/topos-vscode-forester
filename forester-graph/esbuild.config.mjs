import { build } from "esbuild";

const production = process.argv.includes("--production");

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
  minify: production,
  sourcemap: !production,
  logLevel: "info",
});
