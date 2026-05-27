/**
 * Public contract types for the forest graph view artifact.
 *
 * - `GraphData` is what the extractor produces and what the renderer consumes.
 *   Both halves of the artifact (renderer + extract CLI) must agree on this
 *   shape; a breaking change bumps the artifact's `schemaVersion`.
 *
 * - `Theme` is the customization surface. It is intentionally closed: callers
 *   may not pass arbitrary functions or layout overrides. New options grow it
 *   only when motivated by a real, principled constraint.
 */

export type EdgeType = "transclude" | "import" | "export" | "ref";

export interface GraphNode {
  readonly id: string;
  readonly title: string;
  readonly taxon: string | null;
  readonly tags: readonly string[];
  readonly sourcePath: string;
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly type: EdgeType;
}

export interface GraphData {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface Theme {
  readonly palette: {
    readonly background: string;
    readonly foreground: string;
    readonly muted: string;
    /**
     * Per-taxon node colors. The renderer falls back to a deterministic
     * `hash(taxon) % palette.length` mapping for any taxon not listed here.
     */
    readonly taxa: Readonly<Record<string, string>>;
    /** Per-edge-type stroke colors. The renderer uses exactly these four keys. */
    readonly edges: Readonly<Record<EdgeType, string>>;
    /** Overlay color when a node's 1-hop neighbourhood is the active highlight. */
    readonly highlight: string;
    /** Overlay color on hover. */
    readonly hover: string;
  };
  readonly typography: {
    readonly fontFamily: string;
    /** Pixels. */
    readonly fontSize: number;
    /** Multiplier applied to node labels. */
    readonly labelScale: number;
  };
  readonly dimensions: {
    /** `[min, max]` radius, in-degree scales between. */
    readonly nodeRadiusRange: readonly [number, number];
    readonly edgeStrokeWidth: number;
    readonly arrowSize: number;
  };
}

export interface MountOptions {
  readonly container: HTMLElement;
  readonly data: GraphData;
  /** If omitted, the bundled `defaultTheme` is used. */
  readonly theme?: Theme;
  /** Tree id to center on + highlight on initial mount. */
  readonly focus?: string;
  /** Called when a node is clicked (left-click). */
  readonly onNodeClick?: (node: GraphNode) => void;
}

export interface MountHandle {
  /** Replace the graph data and re-render, preserving zoom + node positions. */
  update: (data: GraphData) => void;
  /** Replace the theme without re-running the simulation. */
  setTheme: (theme: Theme) => void;
  /** Programmatically focus on a node (or clear with `null`). */
  setFocus: (id: string | null) => void;
  /** Tear down the SVG and release event listeners. */
  destroy: () => void;
}
