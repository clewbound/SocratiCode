/* SocratiCode interactive graph viewer — app logic
 * Loaded after Cytoscape + Dagre + cytoscape-dagre are on window.
 * Reads embedded graph data from window.__SOCRATICODE_DATA__.
 *
 * All DOM rendering uses createElement + textContent for XSS safety — no
 * innerHTML is used anywhere, so data fields with HTML-looking content
 * (rare but possible in symbol names) cannot escape into markup.
 */
(function () {
  "use strict";

  const DATA = window.__SOCRATICODE_DATA__;
  if (!DATA) throw new Error("Missing __SOCRATICODE_DATA__");

  // Language → colour palette (kept in sync with Mermaid generator)
  const LANG_COLORS = {
    typescript: "#3178C6", javascript: "#F7DF1E", python: "#3776AB",
    java: "#ED8B00", kotlin: "#7F52FF", go: "#00ADD8",
    rust: "#CE422B", ruby: "#CC342D", php: "#777BB4",
    swift: "#FA7343", c: "#A8B9CC", cpp: "#00599C",
    csharp: "#239120", scala: "#DC322F", dart: "#0175C2",
    lua: "#2C2D72", shell: "#4EAA25", html: "#E34F26",
    css: "#1572B6", json: "#808080",
  };
  const FALLBACK_COLOR = "#607D8B";
  const colourFor = (lang) => LANG_COLORS[lang] || FALLBACK_COLOR;

  // Symbol-kind → colour
  const KIND_COLORS = {
    function: "#3b82f6", class: "#a855f7", method: "#06b6d4",
    constructor: "#0891b2", interface: "#f59e0b", trait: "#f59e0b",
    enum: "#ec4899", module: "#6b7280", struct: "#a855f7", variable: "#84cc16",
  };

  // ── Tiny DOM builder (XSS-safe — all text via textContent) ───────
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "style") el.setAttribute("style", v);
        else if (k.startsWith("data-")) el.setAttribute(k, String(v));
        else if (k === "title") el.title = String(v);
        else if (k === "disabled") el.disabled = true;
        else el[k] = v;
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  // ── Register layouts ──────────────────────────────────────────────
  if (window.cytoscapeDagre) window.cytoscapeDagre(cytoscape);

  // ── Build Cytoscape elements from data ───────────────────────────
  const FILE_NODES = DATA.files.map((f) => ({
    group: "nodes",
    data: {
      id: `f::${f.id}`,
      label: f.label,
      nodeType: "file",
      file: f.id,
      language: f.language,
      deps: f.deps,
      dependents: f.dependents,
      symbolCount: f.symbolCount || 0,
    },
  }));
  const FILE_EDGES = DATA.fileEdges.map((e, i) => ({
    group: "edges",
    data: {
      id: `fe${i}`,
      source: `f::${e.source}`,
      target: `f::${e.target}`,
      edgeType: e.type,
      cyclic: e.cyclic,
      scope: "file",
    },
    classes: `${e.cyclic ? "cyclic" : ""} ${e.type === "dynamic-import" ? "dynamic" : ""}`.trim(),
  }));

  const SYMBOL_NODES = (DATA.symbols || []).map((s) => ({
    group: "nodes",
    data: {
      id: `s::${s.id}`,
      label: s.name,
      nodeType: "symbol",
      qualifiedName: s.qualifiedName,
      kind: s.kind,
      file: s.file,
      line: s.line,
    },
  }));
  const SYMBOL_EDGES = (DATA.symbolEdges || []).map((e, i) => ({
    group: "edges",
    data: {
      id: `se${i}`,
      source: `s::${e.source}`,
      target: `s::${e.target}`,
      confidence: e.confidence,
      scope: "symbol",
    },
    classes: `conf-${e.confidence}`,
  }));

  // ── Cytoscape style ──────────────────────────────────────────────
  const STYLE = [
    {
      selector: 'node[nodeType = "file"]',
      style: {
        "background-color": (ele) => colourFor(ele.data("language")),
        "label": "data(label)",
        "font-size": 10, "color": "#1f2937", "text-valign": "bottom",
        "text-margin-y": 4, "text-background-color": "#fff",
        "text-background-opacity": 0.8, "text-background-padding": 2,
        "width": (ele) => 14 + Math.min(30, (ele.data("dependents") || 0) * 2),
        "height": (ele) => 14 + Math.min(30, (ele.data("dependents") || 0) * 2),
        "border-width": 1, "border-color": "#0f172a",
      },
    },
    {
      selector: 'node[nodeType = "symbol"]',
      style: {
        "background-color": (ele) => KIND_COLORS[ele.data("kind")] || "#64748b",
        "label": "data(label)",
        "font-size": 10, "color": "#1f2937", "text-valign": "bottom",
        "text-margin-y": 4, "shape": "round-rectangle",
        "width": 40, "height": 18,
        "border-width": 1, "border-color": "#0f172a",
      },
    },
    {
      selector: "edge",
      style: {
        "width": 1.5, "line-color": "#cbd5e1",
        "target-arrow-color": "#cbd5e1", "target-arrow-shape": "triangle",
        "curve-style": "bezier", "arrow-scale": 0.8,
      },
    },
    { selector: "edge.dynamic", style: { "line-style": "dashed" } },
    { selector: "edge.cyclic", style: { "line-color": "#dc2626", "target-arrow-color": "#dc2626", "width": 2.5, "line-style": "dashed" } },
    { selector: "edge.conf-multiple-candidates", style: { "line-style": "dashed", "line-color": "#a78bfa", "target-arrow-color": "#a78bfa" } },
    { selector: "edge.conf-unresolved", style: { "line-style": "dotted", "line-color": "#94a3b8", "target-arrow-color": "#94a3b8" } },
    { selector: ".faded", style: { "opacity": 0.15, "text-opacity": 0.1 } },
    {
      selector: ".highlight",
      style: {
        "background-color": "#ef4444", "border-color": "#991b1b",
        "border-width": 2, "z-index": 999,
      },
    },
    {
      selector: ".highlight-flow",
      style: {
        "background-color": "#3b82f6", "border-color": "#1e40af",
        "border-width": 2, "z-index": 999,
      },
    },
    { selector: "edge.highlight-edge", style: { "line-color": "#ef4444", "target-arrow-color": "#ef4444", "width": 3, "z-index": 999 } },
    { selector: "edge.highlight-flow-edge", style: { "line-color": "#3b82f6", "target-arrow-color": "#3b82f6", "width": 3, "z-index": 999 } },
  ];

  // ── Instantiate Cytoscape ────────────────────────────────────────
  const cy = cytoscape({
    container: document.getElementById("cy"),
    elements: [...FILE_NODES, ...FILE_EDGES],
    style: STYLE,
    wheelSensitivity: 0.2,
    minZoom: 0.1,
    maxZoom: 3,
  });

  // ── Layout runner ────────────────────────────────────────────────
  let currentView = "files";
  let currentLayout = DATA.files.length > 200 ? "dagre" : "cose";

  function runLayout(name) {
    currentLayout = name;
    const opts = { name, animate: true, animationDuration: 300, fit: true, padding: 30 };
    if (name === "dagre") { opts.rankDir = "LR"; opts.nodeSep = 20; opts.rankSep = 60; }
    if (name === "cose") { opts.nodeRepulsion = 8000; opts.idealEdgeLength = 80; }
    cy.layout(opts).run();
  }

  // ── View toggle ──────────────────────────────────────────────────
  function switchView(next) {
    if (next === currentView) return;
    currentView = next;
    clearHighlights();
    closeSidebar();

    cy.elements().remove();
    if (next === "files") cy.add([...FILE_NODES, ...FILE_EDGES]);
    else cy.add([...SYMBOL_NODES, ...SYMBOL_EDGES]);

    document.querySelectorAll(".view-toggle button").forEach((b) => b.classList.toggle("active", b.dataset.view === next));
    runLayout(currentLayout);
  }

  // ── Highlighting ─────────────────────────────────────────────────
  function clearHighlights() { cy.elements().removeClass("faded highlight highlight-flow highlight-edge highlight-flow-edge"); }

  function bfsHighlight(rootId, direction) {
    clearHighlights();
    const root = cy.getElementById(rootId);
    if (root.empty()) return;
    const visited = new Set([rootId]);
    const queue = [rootId];
    const edges = [];
    while (queue.length) {
      const id = queue.shift();
      const neighbours = direction === "reverse" ? cy.getElementById(id).incomers() : cy.getElementById(id).outgoers();
      neighbours.edges().forEach((e) => edges.push(e.id()));
      neighbours.nodes().forEach((n) => { if (!visited.has(n.id())) { visited.add(n.id()); queue.push(n.id()); } });
    }
    cy.elements().addClass("faded");
    const nodeClass = direction === "reverse" ? "highlight" : "highlight-flow";
    const edgeClass = direction === "reverse" ? "highlight-edge" : "highlight-flow-edge";
    visited.forEach((id) => cy.getElementById(id).removeClass("faded").addClass(nodeClass));
    edges.forEach((id) => cy.getElementById(id).removeClass("faded").addClass(edgeClass));
  }
  const highlightImpact = (id) => bfsHighlight(id, "reverse");
  const highlightFlow = (id) => bfsHighlight(id, "forward");

  // ── Sidebar (safe DOM builders — no innerHTML) ───────────────────
  const sidebar = document.getElementById("sidebar");

  function clearSidebar() { while (sidebar.firstChild) sidebar.removeChild(sidebar.firstChild); }

  function closeSidebar() {
    clearSidebar();
    sidebar.className = "empty";
    sidebar.appendChild(document.createTextNode("Click a node to see details"));
  }

  function actionBar(nodeId) {
    return h("div", { class: "actions" },
      h("button", { "data-action": "impact", "data-id": nodeId }, "Blast radius"),
      h("button", { class: "flow", "data-action": "flow", "data-id": nodeId }, "Call flow"),
      h("button", { class: "reset", "data-action": "reset" }, "Clear"),
    );
  }

  function metaRow(label, value) {
    return h("div", { class: "meta" }, h("strong", null, `${label}: `), String(value));
  }

  function openFile(id) {
    const file = DATA.files.find((f) => f.id === id);
    if (!file) return closeSidebar();
    const color = colourFor(file.language);
    const syms = (DATA.symbolsByFile && DATA.symbolsByFile[id]) || [];
    const preview = syms.slice(0, 30);

    clearSidebar();
    sidebar.className = "";
    sidebar.appendChild(h("h2", null, file.label));
    sidebar.appendChild(h("div", { style: "font-size:11px;color:#6b7280;margin-bottom:8px;word-break:break-all;" }, file.id));
    sidebar.appendChild(h("span", { class: "lang-badge", style: `background:${color}` }, file.language));

    const connections = h("div", { class: "section" },
      h("h3", null, "Connections"),
      h("div", { class: "meta" },
        "imports: ", h("strong", null, String(file.deps)),
        " · imported by: ", h("strong", null, String(file.dependents)),
        " · symbols: ", h("strong", null, String(file.symbolCount || 0)),
      ),
    );
    sidebar.appendChild(connections);

    if (syms.length > 0) {
      const section = h("div", { class: "section" },
        h("h3", null, `Symbols (${syms.length})`),
      );
      const ul = h("ul", null);
      for (const s of preview) {
        const li = h("li", { "data-symbol-id": s.id, title: `${s.qualifiedName}:${s.line}` },
          h("span", { style: `color:${KIND_COLORS[s.kind] || "#64748b"};font-weight:600;` }, s.kind),
          " ",
          s.name,
          h("span", { style: "color:#94a3b8" }, `:${s.line}`),
        );
        ul.appendChild(li);
      }
      section.appendChild(ul);
      if (syms.length > preview.length) {
        section.appendChild(h("div", { style: "color:#9ca3af;font-size:11px;margin-top:4px" },
          `+ ${syms.length - preview.length} more — use codebase_symbols to list all`));
      }
      sidebar.appendChild(section);
    }

    sidebar.appendChild(actionBar(`f::${file.id}`));
  }

  function openSymbol(id) {
    const sym = (DATA.symbols || []).find((s) => s.id === id);
    if (!sym) return closeSidebar();
    clearSidebar();
    sidebar.className = "";
    sidebar.appendChild(h("h2", null, sym.name));
    sidebar.appendChild(h("span", { class: "kind-badge" }, sym.kind));
    sidebar.appendChild(metaRow("Qualified", sym.qualifiedName));
    sidebar.appendChild(h("div", { class: "meta" }, h("strong", null, "File: "), h("code", null, sym.file)));
    sidebar.appendChild(metaRow("Line", sym.line));
    sidebar.appendChild(actionBar(`s::${sym.id}`));
  }

  // ── Event wiring ─────────────────────────────────────────────────
  cy.on("tap", "node", (evt) => {
    const n = evt.target;
    if (n.data("nodeType") === "file") openFile(n.data("file"));
    else openSymbol(n.id().slice(3));
  });
  cy.on("tap", (evt) => { if (evt.target === cy) { closeSidebar(); clearHighlights(); } });

  sidebar.addEventListener("click", (evt) => {
    const btn = evt.target.closest("button[data-action]");
    if (btn) {
      const action = btn.dataset.action;
      if (action === "impact") highlightImpact(btn.dataset.id);
      else if (action === "flow") highlightFlow(btn.dataset.id);
      else if (action === "reset") clearHighlights();
      return;
    }
    const li = evt.target.closest("li[data-symbol-id]");
    if (li && currentView === "symbols") {
      const cyNode = cy.getElementById(`s::${li.dataset.symbolId}`);
      if (!cyNode.empty()) cy.animate({ center: { eles: cyNode }, zoom: 1.3 }, { duration: 300 });
    }
  });

  // ── Toolbar wiring ───────────────────────────────────────────────
  document.getElementById("layout").addEventListener("change", (e) => runLayout(e.target.value));
  document.querySelectorAll(".view-toggle button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  document.getElementById("fit").addEventListener("click", () => cy.fit(undefined, 30));
  document.getElementById("reset").addEventListener("click", () => { clearHighlights(); closeSidebar(); cy.fit(undefined, 30); });
  document.getElementById("export").addEventListener("click", () => {
    const png = cy.png({ full: true, scale: 2, bg: "#f8fafc" });
    const a = document.createElement("a");
    // Sanitise the project name for cross-platform filesystem safety:
    // strip characters forbidden on Windows (<>:"/\\|?*), control chars,
    // collapse whitespace, cap length, and fall back to "graph" if empty.
    const rawName = String(DATA.project.name || "graph");
    const safeName = rawName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 120) || "graph";
    a.href = png; a.download = `${safeName}.png`; a.click();
  });

  // ── Live search ──────────────────────────────────────────────────
  document.getElementById("search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    clearHighlights();
    if (!q) return;
    const matches = cy.nodes().filter((n) => {
      const label = (n.data("label") || "").toLowerCase();
      const file = (n.data("file") || "").toLowerCase();
      const qn = (n.data("qualifiedName") || "").toLowerCase();
      return label.includes(q) || file.includes(q) || qn.includes(q);
    });
    if (matches.length === 0) return;
    cy.elements().addClass("faded");
    matches.removeClass("faded").addClass("highlight");
    if (matches.length <= 20) cy.animate({ fit: { eles: matches, padding: 80 } }, { duration: 300 });
  });

  // ── Tooltip on hover ─────────────────────────────────────────────
  const tooltip = document.getElementById("tooltip");
  cy.on("mouseover", "node", (evt) => {
    const n = evt.target;
    const pos = evt.renderedPosition || n.renderedPosition();
    tooltip.textContent = n.data("nodeType") === "file"
      ? `${n.data("file")} — ${n.data("language")}`
      : `${n.data("qualifiedName")} — ${n.data("kind")} @ ${n.data("file")}:${n.data("line")}`;
    tooltip.style.left = `${pos.x + 14}px`;
    tooltip.style.top = `${pos.y + 14}px`;
    tooltip.style.opacity = "1";
  });
  cy.on("mouseout", "node", () => { tooltip.style.opacity = "0"; });

  // Right-click node → blast radius
  cy.on("cxttap", "node", (evt) => highlightImpact(evt.target.id()));

  // ── Symbols-unavailable banner ───────────────────────────────────
  const banner = document.getElementById("banner");
  if (DATA.symbolMode !== "full") {
    banner.classList.add("visible");
    banner.textContent = DATA.symbolMode === "omitted"
      ? `Symbol view disabled: ${DATA.symbolOmitReason || "no symbol graph available"}. Run codebase_graph_build first.`
      : `Symbol view partial (${DATA.symbolOmitReason}). Use codebase_symbols / codebase_impact for full detail.`;
    if (DATA.symbolMode === "omitted") {
      document.querySelectorAll('.view-toggle button[data-view="symbols"]').forEach((b) => { b.disabled = true; b.title = "No symbol graph available"; });
    }
  }

  // ── Initial layout + sidebar ─────────────────────────────────────
  runLayout(currentLayout);
  closeSidebar();
})();
