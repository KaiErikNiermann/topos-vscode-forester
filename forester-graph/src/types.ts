/** Re-export the canonical graph data shape from the renderer package. */
export type {
  EdgeType,
  GraphData,
  GraphEdge,
  GraphNode,
} from "@forester/graph-view/types";

/**
 * Intermediate shape returned by `forester query all`. The extractor consumes
 * this to produce `GraphData`. Only the fields actually used downstream are
 * declared; forester may include more in its JSON output and that's fine.
 */
export interface ForesterTree {
  readonly title: string | null;
  readonly taxon: string | null;
  readonly tags: readonly string[];
  readonly sourcePath: string;
  readonly uri: string;
}

export type Forest = readonly ForesterTree[];
