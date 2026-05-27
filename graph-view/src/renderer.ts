/**
 * Forest graph renderer.
 *
 * Pure D3 force-directed visualization. No VS Code dependencies, no global
 * state, no DOM assumptions beyond a single mount container. Callers pass a
 * `Theme` (or omit for the default) and an `onNodeClick` handler; everything
 * else is plumbed internally.
 *
 * Extracted (with light parameterisation) from the original inline script in
 * `src/forest-graph-view.ts` lines 381-906.
 */
import * as d3 from "d3";
import { defaultTheme } from "./default-theme";
import type {
  EdgeType,
  GraphData,
  GraphEdge,
  GraphNode,
  MountHandle,
  MountOptions,
  Theme,
} from "./types";

interface SimNode extends GraphNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

interface SimEdge {
  source: SimNode | string;
  target: SimNode | string;
  type: EdgeType;
  _cross?: boolean;
}

/** Deterministic palette for taxa not explicitly themed. */
const FALLBACK_PALETTE = d3.schemeTableau10 as readonly string[];

const stableHash = (s: string): number => {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

const colorForTaxon = (theme: Theme, taxon: string): string => {
  const explicit = theme.palette.taxa[taxon];
  if (explicit !== undefined) return explicit;
  const idx = stableHash(taxon) % FALLBACK_PALETTE.length;
  return FALLBACK_PALETTE[idx] ?? theme.palette.foreground;
};

const applyThemeVars = (el: HTMLElement, theme: Theme): void => {
  const s = el.style;
  s.setProperty("--graph-bg", theme.palette.background);
  s.setProperty("--graph-fg", theme.palette.foreground);
  s.setProperty("--graph-muted", theme.palette.muted);
  s.setProperty("--graph-edge-transclude", theme.palette.edges.transclude);
  s.setProperty("--graph-edge-import", theme.palette.edges.import);
  s.setProperty("--graph-edge-export", theme.palette.edges.export);
  s.setProperty("--graph-edge-ref", theme.palette.edges.ref);
  s.setProperty("--graph-highlight", theme.palette.highlight);
  s.setProperty("--graph-hover", theme.palette.hover);
  s.setProperty("--graph-font", theme.typography.fontFamily);
  s.setProperty("--graph-font-size", `${theme.typography.fontSize}px`);
};

const buildScaffold = (container: HTMLElement): {
  svg: SVGSVGElement;
  controlsHost: HTMLDivElement;
  tooltip: HTMLDivElement;
  stats: HTMLDivElement;
} => {
  container.classList.add("forester-graph-view");
  container.innerHTML = `
    <svg class="fgv-svg">
      <defs>
        <marker id="fgv-arr-transclude" markerWidth="6" markerHeight="6" refX="9" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 Z" fill="var(--graph-edge-transclude)" opacity="0.7"/>
        </marker>
        <marker id="fgv-arr-import" markerWidth="6" markerHeight="6" refX="9" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 Z" fill="var(--graph-edge-import)" opacity="0.7"/>
        </marker>
        <marker id="fgv-arr-export" markerWidth="6" markerHeight="6" refX="9" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 Z" fill="var(--graph-edge-export)" opacity="0.7"/>
        </marker>
        <marker id="fgv-arr-ref" markerWidth="6" markerHeight="6" refX="9" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 Z" fill="var(--graph-edge-ref)" opacity="0.7"/>
        </marker>
      </defs>
    </svg>
    <div class="fgv-controls">
      <h3>Forest Graph</h3>
      <input class="fgv-search" type="text" placeholder="Search trees…" />
      <div class="fgv-row">
        <span class="fgv-label">Cluster</span>
        <select class="fgv-cluster-method">
          <option value="taxon" selected>By taxon</option>
          <option value="community">By community</option>
          <option value="none">None</option>
        </select>
      </div>
      <div class="fgv-taxon-legend"></div>
      <hr>
      <div class="fgv-edge-legend"></div>
      <button class="fgv-reset-btn" type="button">Reset zoom</button>
    </div>
    <div class="fgv-tooltip"></div>
    <div class="fgv-stats"></div>
  `;
  const svg = container.querySelector(".fgv-svg") as SVGSVGElement;
  const controlsHost = container.querySelector(".fgv-controls") as HTMLDivElement;
  const tooltip = container.querySelector(".fgv-tooltip") as HTMLDivElement;
  const stats = container.querySelector(".fgv-stats") as HTMLDivElement;
  return { svg, controlsHost, tooltip, stats };
};

export const mountGraph = (opts: MountOptions): MountHandle => {
  const { container } = opts;
  let theme: Theme = opts.theme ?? defaultTheme;
  let data: GraphData = opts.data;
  let onNodeClick = opts.onNodeClick;

  applyThemeVars(container, theme);
  const { svg: svgEl, controlsHost, tooltip, stats } = buildScaffold(container);

  const W = (): number => container.clientWidth || window.innerWidth;
  const H = (): number => container.clientHeight || window.innerHeight;

  const svg = d3.select(svgEl);
  const g = svg.append("g");
  let currentZoom = d3.zoomIdentity;
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.03, 10])
    .on("zoom", (ev) => {
      g.attr("transform", ev.transform.toString());
      currentZoom = ev.transform;
    });
  svg.call(zoom);

  const linkG = g.append("g").attr("class", "fgv-links");
  const nodeG = g.append("g").attr("class", "fgv-nodes");

  // Mutable simulation state. Reset per renderGraph call.
  let inDegree: Record<string, number> = Object.create(null) as Record<string, number>;
  const adj = new Map<string, Set<string>>();
  let clusterByNode = new Map<string, string | number>();
  let clusterCenters = new Map<string | number, { x: number; y: number }>();
  let clusterKeys: Array<string | number> = [];
  const hiddenTaxons = new Set<string>();
  let searchQuery = "";
  let focusHighlight: string | null = opts.focus ?? null;
  let currentHighlight: string | null = opts.focus ?? null;
  let sim: d3.Simulation<SimNode, SimEdge> | null = null;
  let linkSel: d3.Selection<SVGLineElement, SimEdge, SVGGElement, unknown> | null = null;
  let nodeSel: d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null = null;
  let currentTaxonSet: string[] = [];

  const knownTaxons: string[] = [];
  const updateColorDomain = (taxonSet: readonly string[]): void => {
    for (const t of taxonSet) if (!knownTaxons.includes(t)) knownTaxons.push(t);
    knownTaxons.sort();
  };

  const nodeRadius = (d: SimNode): number => {
    const [min, max] = theme.dimensions.nodeRadiusRange;
    const raw = min + Math.sqrt(inDegree[d.id] ?? 0) * 1.8;
    return Math.min(raw, max);
  };

  const detectCommunities = (): Map<string, number> => {
    const labels = new Map<string, string>(data.nodes.map((n) => [n.id, n.id]));
    for (let iter = 0; iter < 20; iter += 1) {
      let changed = false;
      const order = [...data.nodes].sort(() => Math.random() - 0.5);
      for (const node of order) {
        const nbrs = [...(adj.get(node.id) ?? [])];
        if (nbrs.length === 0) continue;
        const freq = new Map<string, number>();
        for (const nbr of nbrs) {
          const lbl = labels.get(nbr);
          if (lbl === undefined) continue;
          freq.set(lbl, (freq.get(lbl) ?? 0) + 1);
        }
        let best = labels.get(node.id) ?? node.id;
        let bestN = 0;
        for (const [lbl, n] of freq) {
          if (n > bestN) {
            best = lbl;
            bestN = n;
          }
        }
        if (best !== labels.get(node.id)) {
          labels.set(node.id, best);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const uniq = [...new Set(labels.values())].sort();
    const norm = new Map(uniq.map((l, i) => [l, i]));
    return new Map([...labels].map(([k, v]) => [k, norm.get(v) ?? 0]));
  };

  const computeClusterCenters = (): void => {
    clusterKeys = [...new Set(clusterByNode.values())].sort((a, b) =>
      String(a).localeCompare(String(b)),
    );
    clusterCenters.clear();
    clusterKeys.forEach((key, i) => {
      const angle = (2 * Math.PI * i) / Math.max(clusterKeys.length, 1) - Math.PI / 2;
      const r = clusterKeys.length < 2 ? 0 : Math.min(W(), H()) * 0.32;
      clusterCenters.set(key, {
        x: W() / 2 + r * Math.cos(angle),
        y: H() / 2 + r * Math.sin(angle),
      });
    });
  };

  const tagEdges = (): void => {
    const taxonById = new Map(data.nodes.map((n) => [n.id, n.taxon ?? "(untaxoned)"]));
    for (const e of data.edges as readonly SimEdge[]) {
      const src = typeof e.source === "object" ? e.source.id : e.source;
      const tgt = typeof e.target === "object" ? e.target.id : e.target;
      e._cross = taxonById.get(src) !== taxonById.get(tgt);
    }
  };

  const forceCluster = (alpha: number): void => {
    if (clusterKeys.length < 2) return;
    const str = alpha * 0.26;
    for (const d of data.nodes as readonly SimNode[]) {
      const c = clusterCenters.get(clusterByNode.get(d.id) ?? "");
      if (!c || d.x === undefined || d.y === undefined) continue;
      d.vx = (d.vx ?? 0) - (d.x - c.x) * str;
      d.vy = (d.vy ?? 0) - (d.y - c.y) * str;
    }
  };

  const drag = d3
    .drag<SVGGElement, SimNode>()
    .on("start", (ev, d) => {
      if (!ev.active && sim) sim.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on("drag", (ev, d) => {
      d.fx = ev.x;
      d.fy = ev.y;
    })
    .on("end", (ev, d) => {
      if (!ev.active && sim) sim.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });

  const showTooltip = (ev: MouseEvent, d: SimNode): void => {
    const taxonHtml = d.taxon ? `<b>${d.taxon}</b><br>` : "";
    const tagsHtml =
      d.tags.length > 0
        ? `<span class="fgv-tooltip-tags">${d.tags.join(", ")}</span><br>`
        : "";
    const links = inDegree[d.id] ?? 0;
    tooltip.innerHTML =
      `${taxonHtml}${d.title}<br><code>${d.id}</code><br>${tagsHtml}` +
      `${links} incoming link${links === 1 ? "" : "s"}`;
    tooltip.style.display = "block";
    moveTooltip(ev);
  };

  const moveTooltip = (ev: MouseEvent): void => {
    const x = ev.clientX + 14;
    const y = ev.clientY - 10;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    tooltip.style.left = `${Math.min(x, W() - tw - 4)}px`;
    tooltip.style.top = `${Math.max(4, Math.min(y, H() - th - 4))}px`;
  };

  const hideTooltip = (): void => {
    tooltip.style.display = "none";
  };

  const resolveId = (ref: string | SimNode): string =>
    typeof ref === "object" ? ref.id : ref;

  const getNeighbourhood = (treeId: string): Set<string> => {
    const hood = new Set<string>([treeId]);
    const nbrs = adj.get(treeId);
    if (nbrs) for (const n of nbrs) hood.add(n);
    return hood;
  };

  const nodeVisible = (d: SimNode): boolean => {
    if (hiddenTaxons.has(d.taxon ?? "(untaxoned)")) return false;
    if (!searchQuery) return true;
    return (
      d.id.toLowerCase().includes(searchQuery) ||
      d.title.toLowerCase().includes(searchQuery) ||
      (d.taxon ?? "").toLowerCase().includes(searchQuery)
    );
  };

  const applyVisibility = (): void => {
    if (!nodeSel || !linkSel) return;
    let visible: Set<string>;
    if (currentHighlight) {
      visible = getNeighbourhood(currentHighlight);
    } else {
      visible = new Set((data.nodes as readonly SimNode[]).filter(nodeVisible).map((n) => n.id));
    }
    nodeSel.classed("fgv-dimmed", (d) => !visible.has(d.id));
    linkSel.classed("fgv-dimmed", (d) => {
      const src = resolveId(d.source);
      const tgt = resolveId(d.target);
      return !(visible.has(src) && visible.has(tgt));
    });
    linkSel.classed("fgv-link-active", (d) => {
      if (!d._cross || !currentHighlight) return false;
      return visible.has(resolveId(d.source)) && visible.has(resolveId(d.target));
    });
  };

  const rebuildTaxonLegend = (): void => {
    const legendEl = controlsHost.querySelector(".fgv-taxon-legend") as HTMLDivElement;
    legendEl.textContent = "";
    const taxonCounts: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const n of data.nodes) {
      const t = n.taxon ?? "(untaxoned)";
      taxonCounts[t] = (taxonCounts[t] ?? 0) + 1;
    }
    for (const taxon of currentTaxonSet) {
      const item = document.createElement("div");
      item.className = "fgv-legend-item" + (hiddenTaxons.has(taxon) ? " fgv-hidden" : "");
      const swatch = document.createElement("div");
      swatch.className = "fgv-swatch";
      swatch.style.background = colorForTaxon(theme, taxon);
      const label = document.createElement("span");
      label.className = "fgv-legend-label";
      label.textContent = taxon;
      const count = document.createElement("span");
      count.className = "fgv-legend-count";
      count.textContent = String(taxonCounts[taxon] ?? 0);
      item.append(swatch, label, count);
      item.addEventListener("click", () => {
        if (hiddenTaxons.has(taxon)) {
          hiddenTaxons.delete(taxon);
          item.classList.remove("fgv-hidden");
        } else {
          hiddenTaxons.add(taxon);
          item.classList.add("fgv-hidden");
        }
        applyVisibility();
      });
      legendEl.appendChild(item);
    }
  };

  // Edge legend is static — built once.
  const edgeLegendEl = controlsHost.querySelector(".fgv-edge-legend") as HTMLDivElement;
  const EDGE_ENTRIES: ReadonlyArray<{ key: EdgeType; label: string }> = [
    { key: "transclude", label: "transclude" },
    { key: "import", label: "import" },
    { key: "export", label: "export" },
    { key: "ref", label: "ref" },
  ];
  const buildEdgeLegend = (): void => {
    edgeLegendEl.textContent = "";
    for (const { key, label } of EDGE_ENTRIES) {
      const item = document.createElement("div");
      item.className = "fgv-edge-item";
      const line = document.createElement("div");
      line.className = "fgv-edge-line";
      line.style.background = theme.palette.edges[key];
      const lbl = document.createElement("span");
      lbl.textContent = label;
      item.append(line, lbl);
      edgeLegendEl.appendChild(item);
    }
    const crossItem = document.createElement("div");
    crossItem.className = "fgv-edge-item fgv-edge-cross";
    const crossLine = document.createElement("div");
    crossLine.className = "fgv-edge-line";
    crossLine.style.background =
      "repeating-linear-gradient(90deg,#888 0,#888 4px,transparent 4px,transparent 8px)";
    const crossLbl = document.createElement("span");
    crossLbl.style.fontStyle = "italic";
    crossLbl.textContent = "cross-cluster";
    crossItem.append(crossLine, crossLbl);
    edgeLegendEl.appendChild(crossItem);
  };
  buildEdgeLegend();

  const renderGraph = (newData: GraphData, preserve: boolean): void => {
    const oldPos = new Map<string, { x: number; y: number }>();
    if (preserve) {
      for (const n of data.nodes as readonly SimNode[]) {
        if (n.x !== undefined && n.y !== undefined) oldPos.set(n.id, { x: n.x, y: n.y });
      }
    }
    if (sim) sim.stop();
    data = newData;

    inDegree = Object.create(null) as Record<string, number>;
    for (const e of data.edges) inDegree[e.target] = (inDegree[e.target] ?? 0) + 1;

    adj.clear();
    for (const n of data.nodes) adj.set(n.id, new Set<string>());
    for (const e of data.edges) {
      adj.get(e.source)?.add(e.target);
      adj.get(e.target)?.add(e.source);
    }

    currentTaxonSet = [...new Set(data.nodes.map((n) => n.taxon ?? "(untaxoned)"))].sort();
    updateColorDomain(currentTaxonSet);

    const methodEl = controlsHost.querySelector(".fgv-cluster-method") as HTMLSelectElement;
    const method = methodEl.value;
    if (method === "taxon") {
      clusterByNode = new Map(data.nodes.map((n) => [n.id, n.taxon ?? "(untaxoned)"]));
    } else if (method === "community") {
      clusterByNode = new Map([...detectCommunities()].map(([k, v]) => [k, v]));
    } else {
      clusterByNode = new Map(data.nodes.map((n) => [n.id, 0]));
    }
    computeClusterCenters();
    tagEdges();

    for (const d of data.nodes as readonly SimNode[]) {
      const old = oldPos.get(d.id);
      if (old) {
        d.x = old.x;
        d.y = old.y;
      } else {
        const c = clusterCenters.get(clusterByNode.get(d.id) ?? "");
        d.x = (c ? c.x : W() / 2) + (Math.random() - 0.5) * 50;
        d.y = (c ? c.y : H() / 2) + (Math.random() - 0.5) * 50;
      }
      d.vx = 0;
      d.vy = 0;
    }

    linkG.selectAll("*").remove();
    nodeG.selectAll("*").remove();

    const sortedEdges = [...(data.edges as readonly SimEdge[])].sort(
      (a, b) => (b._cross ? 0 : 1) - (a._cross ? 0 : 1),
    );

    linkSel = linkG
      .selectAll<SVGLineElement, SimEdge>("line")
      .data(sortedEdges)
      .join("line")
      .attr("class", (d) => `fgv-link fgv-${d.type}${d._cross ? " fgv-cross-cluster" : ""}`)
      .attr("stroke-width", (d) => (d._cross ? 0.7 : theme.dimensions.edgeStrokeWidth))
      .attr("marker-end", (d) => (d._cross ? null : `url(#fgv-arr-${d.type})`));

    nodeSel = nodeG
      .selectAll<SVGGElement, SimNode>("g.fgv-node")
      .data(data.nodes as readonly SimNode[])
      .join("g")
      .attr("class", "fgv-node")
      .call(drag);

    nodeSel
      .append("circle")
      .attr("r", (d) => nodeRadius(d))
      .attr("fill", (d) => colorForTaxon(theme, d.taxon ?? "(untaxoned)"))
      .on("click", (ev: MouseEvent, d) => {
        ev.stopPropagation();
        onNodeClick?.(d);
      })
      .on("mouseover", (ev: MouseEvent, d) => {
        currentHighlight = d.id;
        applyVisibility();
        showTooltip(ev, d);
      })
      .on("mousemove", moveTooltip as (this: SVGCircleElement, event: MouseEvent, d: SimNode) => void)
      .on("mouseout", () => {
        currentHighlight = focusHighlight;
        applyVisibility();
        hideTooltip();
      });

    nodeSel
      .append("text")
      .attr("dx", (d) => nodeRadius(d) + 3)
      .attr("dy", "0.35em")
      .style("font-size", `${theme.typography.fontSize * theme.typography.labelScale}px`)
      .text((d) => (d.title.length > 26 ? `${d.title.slice(0, 24)}…` : d.title));

    sim = d3
      .forceSimulation<SimNode>(data.nodes as SimNode[])
      .force(
        "link",
        d3
          .forceLink<SimNode, SimEdge>(data.edges as SimEdge[])
          .id((d) => d.id)
          .distance((e) => (e._cross ? 280 : 55))
          .strength((e) => (e._cross ? 0.05 : 0.6)),
      )
      .force(
        "charge",
        d3
          .forceManyBody<SimNode>()
          .strength((d) => -300 - (inDegree[d.id] ?? 0) * 20)
          .theta(1.2),
      )
      .force("center", d3.forceCenter<SimNode>(W() / 2, H() / 2).strength(0.04))
      .force("collide", d3.forceCollide<SimNode>((d) => nodeRadius(d) + 14))
      .force("cluster", forceCluster);

    let tickScheduled = false;
    sim.on("tick", () => {
      if (tickScheduled) return;
      tickScheduled = true;
      requestAnimationFrame(() => {
        tickScheduled = false;
        linkSel
          ?.attr("x1", (d) => (typeof d.source === "object" ? (d.source.x ?? 0) : 0))
          .attr("y1", (d) => (typeof d.source === "object" ? (d.source.y ?? 0) : 0))
          .attr("x2", (d) => (typeof d.target === "object" ? (d.target.x ?? 0) : 0))
          .attr("y2", (d) => (typeof d.target === "object" ? (d.target.y ?? 0) : 0));
        nodeSel?.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });
    });

    sim.alpha(preserve ? 0.3 : 1).restart();

    rebuildTaxonLegend();

    stats.textContent = `${data.nodes.length} nodes · ${data.edges.length} edges`;

    if (preserve && currentZoom !== d3.zoomIdentity) {
      svg.call(zoom.transform, currentZoom);
    }

    if (focusHighlight) {
      applyVisibility();
    }
  };

  const applyClustering = (method: string): void => {
    if (method === "taxon") {
      clusterByNode = new Map(data.nodes.map((n) => [n.id, n.taxon ?? "(untaxoned)"]));
    } else if (method === "community") {
      const comm = detectCommunities();
      clusterByNode = new Map([...comm].map(([k, v]) => [k, v]));
    } else {
      clusterByNode = new Map(data.nodes.map((n) => [n.id, 0]));
    }
    computeClusterCenters();
    tagEdges();
    if (sim) {
      const linkForce = sim.force("link") as d3.ForceLink<SimNode, SimEdge> | null;
      linkForce?.distance((e) => (e._cross ? 280 : 55)).strength((e) => (e._cross ? 0.05 : 0.6));
    }
    if (linkSel) {
      linkSel
        .attr("class", (d) => `fgv-link fgv-${d.type}${d._cross ? " fgv-cross-cluster" : ""}`)
        .attr("stroke-width", (d) => (d._cross ? 0.7 : theme.dimensions.edgeStrokeWidth))
        .attr("marker-end", (d) => (d._cross ? null : `url(#fgv-arr-${d.type})`));
    }
    if (sim) sim.alpha(0.9).restart();
  };

  // Controls wiring
  const clusterMethodEl = controlsHost.querySelector(".fgv-cluster-method") as HTMLSelectElement;
  clusterMethodEl.addEventListener("change", (ev) => {
    const target = ev.target as HTMLSelectElement;
    applyClustering(target.value);
  });

  const searchEl = controlsHost.querySelector(".fgv-search") as HTMLInputElement;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  searchEl.addEventListener("input", (ev) => {
    const target = ev.target as HTMLInputElement;
    const val = target.value.toLowerCase().trim();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = val;
      focusHighlight = null;
      currentHighlight = null;
      applyVisibility();
    }, 120);
  });

  const resetBtn = controlsHost.querySelector(".fgv-reset-btn") as HTMLButtonElement;
  resetBtn.addEventListener("click", () => {
    svg
      .transition()
      .duration(400)
      .call(
        zoom.transform,
        d3.zoomIdentity
          .translate(W() / 2, H() / 2)
          .scale(1)
          .translate(-W() / 2, -H() / 2),
      );
  });

  svg.on("click", () => {
    focusHighlight = null;
    currentHighlight = null;
    applyVisibility();
  });

  const onResize = (): void => {
    computeClusterCenters();
    if (sim) {
      sim.force("center", d3.forceCenter<SimNode>(W() / 2, H() / 2).strength(0.04));
      sim.alpha(0.15).restart();
    }
  };
  window.addEventListener("resize", onResize);

  // Initial render
  if (data.nodes.length > 0) renderGraph(data, false);

  return {
    update: (newData) => renderGraph(newData, true),
    setTheme: (newTheme) => {
      theme = newTheme;
      applyThemeVars(container, theme);
      buildEdgeLegend();
      // Re-color nodes / labels without re-running the simulation.
      nodeSel?.select("circle").attr("fill", (d) => colorForTaxon(theme, d.taxon ?? "(untaxoned)"));
      nodeSel
        ?.select("text")
        .style("font-size", `${theme.typography.fontSize * theme.typography.labelScale}px`);
      rebuildTaxonLegend();
    },
    setFocus: (id) => {
      focusHighlight = id;
      currentHighlight = id;
      applyVisibility();
    },
    destroy: () => {
      window.removeEventListener("resize", onResize);
      sim?.stop();
      container.innerHTML = "";
      container.classList.remove("forester-graph-view");
    },
  };
};

// Convenience re-exports so consumers can do `import { mountGraph, defaultTheme } from "@forester/graph-view"`.
export { defaultTheme } from "./default-theme";
export type {
  EdgeType,
  GraphData,
  GraphEdge,
  GraphNode,
  MountHandle,
  MountOptions,
  Theme,
} from "./types";
