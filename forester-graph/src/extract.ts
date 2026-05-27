/**
 * Pure graph extraction: forest → {nodes, edges}.
 *
 * Caller is responsible for sourcing the forest (running `forester query all`,
 * or whatever else they have). This function reads tree-file contents and
 * runs the edge-pattern regexes from `src/forest-graph-view.ts:139-200`.
 */
import { promises as fsp } from "node:fs";
import type { EdgeType, Forest, ForesterTree, GraphData, GraphEdge, GraphNode } from "./types";

export interface ExtractOptions {
  /** Tree URIs to exclude from the graph entirely. */
  readonly excludedNodes?: readonly string[];
}

const EDGE_PATTERNS: ReadonlyArray<{ re: RegExp; type: EdgeType }> = [
  { re: /\\transclude\{([^}]+)\}/g, type: "transclude" },
  { re: /\\import\{([^}]+)\}/g, type: "import" },
  { re: /\\export\{([^}]+)\}/g, type: "export" },
  { re: /\\ref\{([^}]+)\}/g, type: "ref" },
  // [label](addr) — Markdown-style Forester link
  { re: /\[[^\[]*\]\(([^)]+)\)/g, type: "ref" },
  // [[addr]] — double-bracket Forester link
  { re: /\[\[([^\]]+)\]\]/g, type: "ref" },
];

const readContent = async (
  tree: ForesterTree,
): Promise<{ tree: ForesterTree; content: string | null }> => {
  try {
    const content = await fsp.readFile(tree.sourcePath, "utf-8");
    return { tree, content };
  } catch {
    return { tree, content: null };
  }
};

export const buildGraph = async (forest: Forest, options: ExtractOptions = {}): Promise<GraphData> => {
  const excluded = new Set<string>(options.excludedNodes ?? ["basic-macros"]);
  const filtered = forest.filter((t) => !excluded.has(t.uri));
  const treeIds = new Set(filtered.map((t) => t.uri));

  const nodes: GraphNode[] = filtered.map((t) => ({
    id: t.uri,
    title: t.title ?? t.uri,
    taxon: t.taxon,
    tags: t.tags,
    sourcePath: t.sourcePath,
  }));

  const fileContents = await Promise.all(filtered.map(readContent));

  const edges: GraphEdge[] = [];
  for (const { tree, content } of fileContents) {
    if (!content) continue;
    for (const line of content.split("\n")) {
      if (line.trimStart().startsWith("%")) continue; // skip comments
      for (const { re, type } of EDGE_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const target = m[1];
          if (target && treeIds.has(target) && target !== tree.uri) {
            edges.push({ source: tree.uri, target, type });
          }
        }
      }
    }
  }

  return { nodes, edges };
};
