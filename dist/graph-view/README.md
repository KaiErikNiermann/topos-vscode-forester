# @forester/graph-view artifact

This directory is the publishable artifact of the forest graph view:

- `graph.js` — IIFE bundle. Once loaded, `window.ForesterGraphView.mountGraph(opts)` is available.
- `graph.css` — stylesheet, themed via `--graph-*` CSS variables set by the renderer.
- `extract` — Node CLI: `node ./extract extract --out=path/to/data.json --cwd=/path/to/forest`.
- `default-theme.js` — exports `defaultTheme: Theme`.
- `manifest.json` — content hash + commit + schemaVersion (consumers should refuse unknown schemaVersion).

Consumer contract — see `MountOptions` and `Theme` in the upstream
`graph-view/src/types.ts`.

**Versioning:** rolling tag `graph-view-latest`. No semver. Drift visible via
`manifest.contentHash`.
