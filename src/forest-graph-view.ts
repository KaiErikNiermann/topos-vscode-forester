/**
 * Forest graph view — interactive D3.js force-directed graph panel.
 *
 * Command: forester.showGraphView
 * Panel:   "Forest Graph" — a WebviewPanel (tab) opened beside the active editor.
 *
 * Features:
 *   • Nodes = trees, sized by in-degree, coloured by taxon
 *   • Edges = transclude / import / export / ref cross-file relations
 *   • Force-directed layout with drag, zoom, pan
 *   • Click node → open .tree file in the editor
 *   • Hover → tooltip with title + taxon + in-degree
 *   • Taxon legend → click to toggle taxon visibility
 *   • Search box → fade non-matching nodes
 *   • Active-editor sync → highlight current file's 1-hop neighbourhood
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getForest, onForestChange } from './get-forest';

// ── Data types ────────────────────────────────────────────────────────────────

interface GraphNode {
    id: string;
    title: string;
    taxon: string | null;
    tags: string[];
    sourcePath: string;
}

interface GraphEdge {
    source: string;
    target: string;
    type: 'transclude' | 'import' | 'export' | 'ref';
}

// ── Panel class ───────────────────────────────────────────────────────────────

export class ForestGraphView {
    public static readonly viewType = 'forester.forestGraph';
    private static currentPanel: ForestGraphView | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _disposables: vscode.Disposable[] = [];

    // ── Public API ────────────────────────────────────────────────────────────

    /** Open or reveal the forest graph panel. */
    public static createOrShow(extensionUri: vscode.Uri): void {
        const column = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;

        if (ForestGraphView.currentPanel) {
            ForestGraphView.currentPanel._panel.reveal(column);
            void ForestGraphView.currentPanel._update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ForestGraphView.viewType,
            'Forest Graph',
            column,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            },
        );

        ForestGraphView.currentPanel = new ForestGraphView(panel, extensionUri);
    }

    public dispose(): void {
        ForestGraphView.currentPanel = undefined;
        this._panel.dispose();
        for (const d of this._disposables) d.dispose();
        this._disposables.length = 0;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        void this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            (msg: { type: string; sourcePath?: string }) => {
                if (msg.type === 'openFile' && msg.sourcePath) {
                    void vscode.commands.executeCommand(
                        'vscode.open',
                        vscode.Uri.file(msg.sourcePath),
                    );
                }
            },
            null,
            this._disposables,
        );

        this._disposables.push(
            onForestChange(() => void this._update()),
            vscode.window.onDidChangeActiveTextEditor(() => this._sendHighlight()),
        );
    }

    private _sendHighlight(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor?.document.fileName.endsWith('.tree')) return;
        const treeId = path.basename(editor.document.fileName, '.tree');
        this._panel.webview.postMessage({ type: 'highlight', treeId });
    }

    private async _update(): Promise<void> {
        const data = await this._buildGraphData();
        this._panel.webview.html = this._getHtml(data);
        // Give the WebView a moment to load before sending the initial highlight.
        setTimeout(() => this._sendHighlight(), 300);
    }

    // ── Graph data ────────────────────────────────────────────────────────────

    private async _buildGraphData(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
        const forest = await getForest({ fastReturnStale: true });

        const excluded = new Set<string>(
            vscode.workspace
                .getConfiguration('forester')
                .get<string[]>('graphView.excludedNodes', ['basic-macros']),
        );

        const filteredForest = forest.filter(t => !excluded.has(t.uri));
        const treeIds = new Set(filteredForest.map(t => t.uri));

        const nodes: GraphNode[] = filteredForest.map(t => ({
            id: t.uri,
            title: t.title ?? t.uri,
            taxon: t.taxon,
            tags: t.tags,
            sourcePath: t.sourcePath,
        }));

        const EDGE_PATTERNS: ReadonlyArray<{ re: RegExp; type: GraphEdge['type'] }> = [
            { re: /\\transclude\{([^}]+)\}/g,  type: 'transclude' },
            { re: /\\import\{([^}]+)\}/g,      type: 'import' },
            { re: /\\export\{([^}]+)\}/g,      type: 'export' },
            { re: /\\ref\{([^}]+)\}/g,         type: 'ref' },
            // [label](addr) — Markdown-style Forester link; text in non-capturing group
            { re: /\[[^\[]*\]\(([^)]+)\)/g,   type: 'ref' },
            // [[addr]] — double-bracket Forester link
            { re: /\[\[([^\]]+)\]\]/g,         type: 'ref' },
        ];

        const edges: GraphEdge[] = [];
        for (const tree of filteredForest) {
            let content: string;
            try {
                content = fs.readFileSync(tree.sourcePath, 'utf-8');
            } catch {
                continue;
            }
            for (const line of content.split('\n')) {
                if (line.trimStart().startsWith('%')) continue; // skip comments
                for (const { re, type } of EDGE_PATTERNS) {
                    re.lastIndex = 0;
                    let m: RegExpExecArray | null;
                    while ((m = re.exec(line)) !== null) {
                        const target = m[1];
                        if (treeIds.has(target) && target !== tree.uri) {
                            edges.push({ source: tree.uri, target, type });
                        }
                    }
                }
            }
        }

        return { nodes, edges };
    }

    // ── HTML ──────────────────────────────────────────────────────────────────

    private _getHtml(data: { nodes: GraphNode[]; edges: GraphEdge[] }): string {
        const nonce = getNonce();
        // Replace '</' to prevent early </script> tag termination.
        const graphJson = JSON.stringify(data).replace(/<\//g, '<\\/');

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src https://cdn.jsdelivr.net 'nonce-${nonce}';
                 style-src 'nonce-${nonce}' 'unsafe-inline';">
  <title>Forest Graph</title>
  <style nonce="${nonce}">
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    body {
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-foreground, #cccccc);
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: 12px;
    }
    svg { width: 100%; height: 100%; display: block; }

    /* Edges — intra-cluster links are prominent; cross-cluster are subdued */
    .link { stroke-opacity: 0.65; fill: none; }
    .link.cross-cluster { stroke-opacity: 0.13; stroke-dasharray: 5 4; }
    .link.cross-cluster.link-active { stroke-opacity: 0.55; }
    .link.transclude { stroke: #4fc3f7; }
    .link.import     { stroke: #81c784; }
    .link.export     { stroke: #ffb74d; }
    .link.ref        { stroke: #ce93d8; }

    /* Nodes */
    .node circle {
      cursor: pointer;
      stroke: var(--vscode-editor-background, #1e1e1e);
      stroke-width: 1.5;
    }
    .node circle:hover { stroke: #ffffff; stroke-width: 2.5; }
    .node text {
      pointer-events: none;
      font-size: 10px;
      fill: var(--vscode-foreground, #cccccc);
      paint-order: stroke;
      stroke: var(--vscode-editor-background, #1e1e1e);
      stroke-width: 3px;
      stroke-linejoin: round;
    }
    .node.dimmed { opacity: 0.06; }
    .link.dimmed  { opacity: 0.04; }

    /* Controls panel */
    #controls {
      position: absolute; top: 8px; right: 8px;
      background: var(--vscode-sideBar-background, #252526);
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 4px; padding: 10px; width: 190px;
      max-height: calc(100vh - 40px); overflow-y: auto;
    }
    #controls h3 {
      font-size: 11px; font-weight: 600; margin-bottom: 8px;
      letter-spacing: 0.05em; text-transform: uppercase;
    }
    #search {
      width: 100%; padding: 4px 6px; margin-bottom: 8px;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 3px; font-size: 11px; outline: none;
    }
    #search:focus { border-color: var(--vscode-focusBorder, #007acc); }

    /* Cluster method row */
    .ctrl-row {
      display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
    }
    .ctrl-label {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground, #888); flex-shrink: 0;
    }
    .ctrl-select {
      flex: 1; padding: 3px 5px; font-size: 11px;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 3px; outline: none; cursor: pointer;
    }
    .ctrl-select:focus { border-color: var(--vscode-focusBorder, #007acc); }

    /* Taxon legend */
    .legend-item {
      display: flex; align-items: center; gap: 5px;
      padding: 2px 3px; border-radius: 3px;
      cursor: pointer; user-select: none;
    }
    .legend-item:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .legend-item.hidden { opacity: 0.35; text-decoration: line-through; }
    .swatch { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .legend-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .legend-count { color: var(--vscode-descriptionForeground, #888); font-size: 10px; }

    /* Edge legend */
    hr { border: none; border-top: 1px solid var(--vscode-panel-border, #333); margin: 8px 0; }
    .edge-legend { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
    .edge-item { display: flex; align-items: center; gap: 6px; font-size: 11px; }
    .edge-line { width: 18px; height: 2px; border-radius: 1px; flex-shrink: 0; }

    /* Reset button */
    #reset-btn {
      width: 100%; padding: 4px 0; margin-top: 8px;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 3px; cursor: pointer; font-size: 11px;
    }
    #reset-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }

    /* Tooltip */
    #tooltip {
      position: absolute; pointer-events: none; display: none;
      background: var(--vscode-editorHoverWidget-background, #252526);
      border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
      border-radius: 3px; padding: 6px 8px; font-size: 11px;
      max-width: 240px; z-index: 200; line-height: 1.6;
      word-break: break-word;
    }
    #tooltip code { font-size: 10px; opacity: 0.8; }

    /* Stats bar */
    #stats {
      position: absolute; bottom: 6px; left: 8px;
      color: var(--vscode-descriptionForeground, #888); font-size: 10px;
    }
  </style>
</head>
<body>
  <svg id="graph">
    <defs>
      <marker id="arr-transclude" markerWidth="6" markerHeight="6" refX="9" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 Z" fill="#4fc3f7" opacity="0.7"/>
      </marker>
      <marker id="arr-import" markerWidth="6" markerHeight="6" refX="9" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 Z" fill="#81c784" opacity="0.7"/>
      </marker>
      <marker id="arr-export" markerWidth="6" markerHeight="6" refX="9" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 Z" fill="#ffb74d" opacity="0.7"/>
      </marker>
      <marker id="arr-ref" markerWidth="6" markerHeight="6" refX="9" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 Z" fill="#ce93d8" opacity="0.7"/>
      </marker>
    </defs>
  </svg>

  <div id="controls">
    <h3>Forest Graph</h3>
    <input id="search" type="text" placeholder="Search trees\u2026" />
    <div class="ctrl-row">
      <span class="ctrl-label">Cluster</span>
      <select id="cluster-method" class="ctrl-select">
        <option value="taxon" selected>By taxon</option>
        <option value="community">By community</option>
        <option value="none">None</option>
      </select>
    </div>
    <div id="taxon-legend"></div>
    <hr>
    <div class="edge-legend" id="edge-legend"></div>
    <button id="reset-btn">Reset zoom</button>
  </div>

  <div id="tooltip"></div>
  <div id="stats"></div>

  <script nonce="${nonce}"
          src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script nonce="${nonce}">
  (function () {
    'use strict';
    const vscode = acquireVsCodeApi();
    const data = ${graphJson};

    // ── Pre-compute in-degree (before D3 resolves edge references) ───────────
    const inDegree = Object.create(null);
    for (const e of data.edges) {
      inDegree[e.target] = (inDegree[e.target] || 0) + 1;
    }

    // ── Dimensions ───────────────────────────────────────────────────────────
    const W = () => window.innerWidth;
    const H = () => window.innerHeight;

    // ── SVG + zoom container ─────────────────────────────────────────────────
    const svg = d3.select('#graph');
    const g   = svg.append('g');

    const zoom = d3.zoom()
      .scaleExtent([0.03, 10])
      .on('zoom', ev => g.attr('transform', ev.transform));
    svg.call(zoom);

    document.getElementById('reset-btn').addEventListener('click', () => {
      svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity
        .translate(W() / 2, H() / 2)
        .scale(1)
        .translate(-W() / 2, -H() / 2));
    });

    // ── Colour scale (taxon → colour, stable across all cluster modes) ────────
    const taxonSet = [...new Set(data.nodes.map(n => n.taxon || '(untaxoned)'))].sort();
    const colorOf  = d3.scaleOrdinal(d3.schemeTableau10).domain(taxonSet);

    // ── Undirected adjacency list (all edge types, built before sim mutates edges)
    const adj = new Map(data.nodes.map(n => [n.id, new Set()]));
    for (const e of data.edges) {
      adj.get(e.source)?.add(e.target);
      adj.get(e.target)?.add(e.source);
    }

    // ── Community detection via label propagation (20 iterations) ────────────
    function detectCommunities() {
      const labels = new Map(data.nodes.map(n => [n.id, n.id]));
      for (let iter = 0; iter < 20; iter++) {
        let changed = false;
        const order = [...data.nodes].sort(() => Math.random() - 0.5);
        for (const node of order) {
          const nbrs = [...(adj.get(node.id) || [])];
          if (nbrs.length === 0) continue;
          const freq = new Map();
          for (const nbr of nbrs) {
            const lbl = labels.get(nbr);
            freq.set(lbl, (freq.get(lbl) || 0) + 1);
          }
          let best = labels.get(node.id), bestN = 0;
          for (const [lbl, n] of freq) { if (n > bestN) { best = lbl; bestN = n; } }
          if (best !== labels.get(node.id)) { labels.set(node.id, best); changed = true; }
        }
        if (!changed) break;
      }
      const uniq = [...new Set(labels.values())].sort();
      const norm = new Map(uniq.map((l, i) => [l, i]));
      return new Map([...labels].map(([k, v]) => [k, norm.get(v)]));
    }

    // ── Mutable cluster state ─────────────────────────────────────────────────
    let clusterByNode = new Map();
    let clusterCenters = new Map();
    let clusterKeys = [];

    function computeClusterCenters() {
      clusterKeys = [...new Set(clusterByNode.values())].sort((a, b) =>
        String(a).localeCompare(String(b)));
      clusterCenters.clear();
      clusterKeys.forEach((key, i) => {
        const angle = (2 * Math.PI * i) / Math.max(clusterKeys.length, 1) - Math.PI / 2;
        const r = clusterKeys.length < 2 ? 0 : Math.min(W(), H()) * 0.32;
        clusterCenters.set(key, {
          x: W() / 2 + r * Math.cos(angle),
          y: H() / 2 + r * Math.sin(angle),
        });
      });
    }

    function tagEdges() {
      for (const e of data.edges) {
        const src = typeof e.source === 'object' ? e.source.id : e.source;
        const tgt = typeof e.target === 'object' ? e.target.id : e.target;
        e._cross = clusterByNode.get(src) !== clusterByNode.get(tgt);
      }
    }

    function seedNodes() {
      for (const d of data.nodes) {
        const c = clusterCenters.get(clusterByNode.get(d.id));
        if (c) {
          d.x = c.x + (Math.random() - 0.5) * 50;
          d.y = c.y + (Math.random() - 0.5) * 50;
          d.vx = 0; d.vy = 0;
        }
      }
    }

    // Custom force: pull every node toward its cluster centre
    function forceCluster(alpha) {
      if (clusterKeys.length < 2) return; // single cluster or no clustering — skip
      const str = alpha * 0.26;
      for (const d of data.nodes) {
        const c = clusterCenters.get(clusterByNode.get(d.id));
        if (!c) continue;
        d.vx -= (d.x - c.x) * str;
        d.vy -= (d.y - c.y) * str;
      }
    }

    // Initialise with taxon clustering (before sim creation so edges are still strings)
    clusterByNode = new Map(data.nodes.map(n => [n.id, n.taxon || '(untaxoned)']));
    computeClusterCenters();
    tagEdges();
    seedNodes();

    // ── Node radius ───────────────────────────────────────────────────────────
    function nodeRadius(d) {
      return 5 + Math.sqrt(inDegree[d.id] || 0) * 1.8;
    }

    // ── Force simulation ─────────────────────────────────────────────────────
    const sim = d3.forceSimulation(data.nodes)
      .force('link', d3.forceLink(data.edges)
        .id(d => d.id)
        .distance(e => e._cross ? 280 : 55)
        .strength(e => e._cross ? 0.05 : 0.6))
      .force('charge', d3.forceManyBody()
        .strength(d => -300 - (inDegree[d.id] || 0) * 20))
      .force('center', d3.forceCenter(W() / 2, H() / 2).strength(0.04))
      .force('collide', d3.forceCollide(d => nodeRadius(d) + 14))
      .force('cluster', forceCluster);

    // ── Drag behaviour ───────────────────────────────────────────────────────
    const drag = d3.drag()
      .on('start', (ev, d) => {
        if (!ev.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end',  (ev, d) => {
        if (!ev.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      });

    // ── Draw edges (cross-cluster first so they render behind intra-cluster) ──
    const linkG = g.append('g').attr('class', 'links');
    const linkSel = linkG.selectAll('line')
      .data([...data.edges].sort((a, b) => (b._cross ? 0 : 1) - (a._cross ? 0 : 1)))
      .join('line')
        .attr('class', d => 'link ' + d.type + (d._cross ? ' cross-cluster' : ''))
        .attr('stroke-width', d => d._cross ? 0.7 : 1.5)
        .attr('marker-end', d => d._cross ? null : 'url(#arr-' + d.type + ')');

    // ── Draw nodes ───────────────────────────────────────────────────────────
    const nodeG = g.append('g').attr('class', 'nodes');
    const nodeSel = nodeG.selectAll('g.node')
      .data(data.nodes)
      .join('g')
        .attr('class', 'node')
        .call(drag);

    nodeSel.append('circle')
      .attr('r',    d => nodeRadius(d))
      .attr('fill', d => colorOf(d.taxon || '(untaxoned)'))
      .on('click',     (ev, d) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'openFile', sourcePath: d.sourcePath });
      })
      .on('mouseover', (ev, d) => {
        currentHighlight = d.id;
        applyVisibility();
        showTooltip(ev, d);
      })
      .on('mousemove', moveTooltip)
      .on('mouseout',  () => {
        currentHighlight = editorHighlight;
        applyVisibility();
        hideTooltip();
      });

    nodeSel.append('text')
      .attr('dx', d => nodeRadius(d) + 3)
      .attr('dy', '0.35em')
      .text(d => d.title.length > 26 ? d.title.slice(0, 24) + '\u2026' : d.title);

    // ── Tick ─────────────────────────────────────────────────────────────────
    sim.on('tick', () => {
      linkSel
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
      nodeSel.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
    });

    // ── Stats ────────────────────────────────────────────────────────────────
    document.getElementById('stats').textContent =
      data.nodes.length + ' nodes \u00b7 ' + data.edges.length + ' edges';

    // ── Apply clustering (called on dropdown change; linkSel/sim already exist) ─
    function applyClustering(method) {
      if (method === 'taxon') {
        clusterByNode = new Map(data.nodes.map(n => [n.id, n.taxon || '(untaxoned)']));
      } else if (method === 'community') {
        const comm = detectCommunities();
        clusterByNode = new Map([...comm].map(([k, v]) => [k, v]));
      } else {
        // 'none': single cluster — forceCluster is disabled when clusterKeys.length < 2
        clusterByNode = new Map(data.nodes.map(n => [n.id, 0]));
      }
      computeClusterCenters();
      tagEdges(); // edges are D3 node objects at this point
      seedNodes();
      sim.force('link')
        .distance(e => e._cross ? 280 : 55)
        .strength(e => e._cross ? 0.05 : 0.6);
      // Refresh link visual classes
      linkSel
        .attr('class', d => 'link ' + d.type + (d._cross ? ' cross-cluster' : ''))
        .attr('stroke-width', d => d._cross ? 0.7 : 1.5)
        .attr('marker-end', d => d._cross ? null : 'url(#arr-' + d.type + ')');
      sim.alpha(0.9).restart();
    }

    document.getElementById('cluster-method').addEventListener('change', ev => {
      applyClustering(ev.target.value);
    });

    // ── Taxon legend (DOM API — avoids CSP blocking of innerHTML inline styles)
    const hiddenTaxons = new Set();
    const legendEl = document.getElementById('taxon-legend');

    const taxonCounts = Object.create(null);
    for (const n of data.nodes) {
      const t = n.taxon || '(untaxoned)';
      taxonCounts[t] = (taxonCounts[t] || 0) + 1;
    }

    for (const taxon of taxonSet) {
      const item = document.createElement('div');
      item.className = 'legend-item';

      const swatch = document.createElement('div');
      swatch.className = 'swatch';
      swatch.style.background = colorOf(taxon); // set via JS — not blocked by style-src CSP

      const label = document.createElement('span');
      label.className = 'legend-label';
      label.textContent = taxon;

      const count = document.createElement('span');
      count.className = 'legend-count';
      count.textContent = String(taxonCounts[taxon] || 0);

      item.appendChild(swatch);
      item.appendChild(label);
      item.appendChild(count);

      item.addEventListener('click', () => {
        if (hiddenTaxons.has(taxon)) {
          hiddenTaxons.delete(taxon);
          item.classList.remove('hidden');
        } else {
          hiddenTaxons.add(taxon);
          item.classList.add('hidden');
        }
        applyVisibility();
      });
      legendEl.appendChild(item);
    }

    // ── Edge legend (DOM API for consistency) ─────────────────────────────────
    const EDGE_ENTRIES = [
      { color: '#4fc3f7', label: 'transclude' },
      { color: '#81c784', label: 'import' },
      { color: '#ffb74d', label: 'export' },
      { color: '#ce93d8', label: 'ref' },
    ];
    const edgeLegendEl = document.getElementById('edge-legend');
    for (const { color, label } of EDGE_ENTRIES) {
      const item = document.createElement('div');
      item.className = 'edge-item';
      const line = document.createElement('div');
      line.className = 'edge-line';
      line.style.background = color;
      const lbl = document.createElement('span');
      lbl.textContent = label;
      item.appendChild(line);
      item.appendChild(lbl);
      edgeLegendEl.appendChild(item);
    }
    // Cross-cluster indicator
    const crossItem = document.createElement('div');
    crossItem.className = 'edge-item';
    crossItem.style.opacity = '0.45';
    crossItem.style.marginTop = '3px';
    const crossLine = document.createElement('div');
    crossLine.className = 'edge-line';
    crossLine.style.background = 'repeating-linear-gradient(90deg,#888 0,#888 4px,transparent 4px,transparent 8px)';
    const crossLbl = document.createElement('span');
    crossLbl.style.fontStyle = 'italic';
    crossLbl.textContent = 'cross-cluster';
    crossItem.appendChild(crossLine);
    crossItem.appendChild(crossLbl);
    edgeLegendEl.appendChild(crossItem);

    // ── Search ────────────────────────────────────────────────────────────────
    let searchQuery = '';
    document.getElementById('search').addEventListener('input', ev => {
      searchQuery = ev.target.value.toLowerCase().trim();
      editorHighlight = null;
      currentHighlight = null;
      applyVisibility();
    });

    // ── Visibility / highlight ────────────────────────────────────────────────
    // editorHighlight: set by active-editor sync, persists between hovers
    // currentHighlight: editorHighlight OR the node currently under the cursor
    let editorHighlight = null;
    let currentHighlight = null;

    function resolveId(ref) {
      return typeof ref === 'object' ? ref.id : ref;
    }

    function getNeighbourhood(treeId) {
      const hood = new Set([treeId]);
      for (const e of data.edges) {
        const src = resolveId(e.source);
        const tgt = resolveId(e.target);
        if (src === treeId) hood.add(tgt);
        if (tgt === treeId) hood.add(src);
      }
      return hood;
    }

    function nodeVisible(d) {
      if (hiddenTaxons.has(d.taxon || '(untaxoned)')) return false;
      if (!searchQuery) return true;
      return d.id.toLowerCase().includes(searchQuery) ||
             d.title.toLowerCase().includes(searchQuery) ||
             (d.taxon || '').toLowerCase().includes(searchQuery);
    }

    function applyVisibility() {
      let visible;
      if (currentHighlight) {
        visible = getNeighbourhood(currentHighlight);
      } else {
        visible = new Set(data.nodes.filter(nodeVisible).map(n => n.id));
      }

      nodeSel.classed('dimmed', d => !visible.has(d.id));
      linkSel.classed('dimmed', d => {
        const src = resolveId(d.source);
        const tgt = resolveId(d.target);
        return !(visible.has(src) && visible.has(tgt));
      });
      // Promote visible cross-cluster links to full opacity while a node is highlighted
      linkSel.classed('link-active', d => {
        if (!d._cross || !currentHighlight) return false;
        return visible.has(resolveId(d.source)) && visible.has(resolveId(d.target));
      });
    }

    // ── Tooltip ───────────────────────────────────────────────────────────────
    const tooltip = document.getElementById('tooltip');

    function showTooltip(ev, d) {
      const taxonHtml = d.taxon ? '<b>' + d.taxon + '</b><br>' : '';
      const tagsHtml = d.tags.length > 0
        ? '<span style="color:var(--vscode-descriptionForeground,#888)">' +
          d.tags.join(', ') + '</span><br>'
        : '';
      const links = (inDegree[d.id] || 0);
      tooltip.innerHTML =
        taxonHtml + d.title + '<br><code>' + d.id + '</code><br>' +
        tagsHtml +
        links + ' incoming link' + (links === 1 ? '' : 's');
      tooltip.style.display = 'block';
      moveTooltip(ev);
    }

    function moveTooltip(ev) {
      const x = ev.clientX + 14;
      const y = ev.clientY - 10;
      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;
      tooltip.style.left = Math.min(x, W() - tw - 4) + 'px';
      tooltip.style.top  = Math.max(4, Math.min(y, H() - th - 4)) + 'px';
    }

    function hideTooltip() { tooltip.style.display = 'none'; }

    // Clear persistent highlight when clicking on empty canvas
    svg.on('click', () => {
      editorHighlight = null;
      currentHighlight = null;
      applyVisibility();
    });

    // ── Messages from extension ───────────────────────────────────────────────
    window.addEventListener('message', ev => {
      const msg = ev.data;
      if (msg.type === 'highlight') {
        editorHighlight = msg.treeId;
        currentHighlight = msg.treeId;
        applyVisibility();
      }
    });

    // ── Resize ────────────────────────────────────────────────────────────────
    window.addEventListener('resize', () => {
      computeClusterCenters();
      sim.force('center', d3.forceCenter(W() / 2, H() / 2).strength(0.04));
      sim.alpha(0.15).restart();
    });

  }());
  </script>
</body>
</html>`;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from(
        { length: 32 },
        () => chars[Math.floor(Math.random() * chars.length)],
    ).join('');
}
