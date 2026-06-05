/**
 * The default "modern dark" theme. Mirrors the look the VS Code webview
 * has shipped with for a while, so the artifact looks the same out of the
 * box as when hosted inside the extension.
 */
export const defaultTheme = {
  palette: {
    background: "#1e1e1e",
    foreground: "#cccccc",
    muted: "#888888",
    taxa: {
      // Empty — renderer falls through to the deterministic palette mapping.
    },
    edges: {
      transclude: "#4fc3f7",
      import: "#81c784",
      export: "#ffb74d",
      ref: "#ce93d8",
    },
    highlight: "rgba(255, 255, 255, 0.10)",
    hover: "rgba(255, 255, 255, 0.04)",
  },
  typography: {
    fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
    fontSize: 12,
    labelScale: 1,
  },
  dimensions: {
    nodeRadiusRange: [5, 24],
    edgeStrokeWidth: 1.5,
    arrowSize: 6,
  },
};
