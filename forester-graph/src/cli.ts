/**
 * forester-graph CLI.
 *
 * Subcommands:
 *   extract --out=path/to/data.json [--cwd=.] [--exclude=a,b,c]
 *     Runs `forester query all` against --cwd, builds the {nodes, edges}
 *     graph, writes the result as JSON to --out. Exit 0 on success.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { buildGraph } from "./extract";
import { queryForest } from "./query";

interface ParsedFlags {
  readonly subcommand: string;
  readonly out?: string;
  readonly cwd: string;
  readonly exclude: readonly string[];
}

const parseArgs = (argv: readonly string[]): ParsedFlags => {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        flags[arg.slice(2)] = "true";
      } else {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    } else {
      positional.push(arg);
    }
  }
  return {
    subcommand: positional[0] ?? "",
    out: flags.out,
    cwd: path.resolve(flags.cwd ?? process.cwd()),
    exclude: (flags.exclude ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
};

const die = (msg: string): never => {
  process.stderr.write(`forester-graph: ${msg}\n`);
  process.exit(1);
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.subcommand !== "extract") {
    die(
      `unknown subcommand "${args.subcommand}".\n` +
        `usage: forester-graph extract --out=path/to/data.json [--cwd=.] [--exclude=a,b]`,
    );
    return;
  }
  if (!args.out) die("--out is required");

  const forest = await queryForest({ cwd: args.cwd });
  const excludedNodes = args.exclude.length > 0 ? args.exclude : ["basic-macros"];
  const graph = await buildGraph(forest, { excludedNodes });

  const outPath = path.resolve(args.out as string);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify(graph, null, 2), "utf-8");
  process.stderr.write(
    `forester-graph: wrote ${graph.nodes.length} nodes / ${graph.edges.length} edges to ${outPath}\n`,
  );
};

main().catch((err: unknown) => {
  process.stderr.write(`forester-graph: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
