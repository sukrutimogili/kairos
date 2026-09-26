import * as vscode from 'vscode';
import { ImpactResponse, ImpactErrorResponse, isImpactError, ImpactResult } from '../types';

export class ImpactPanel {
  public static currentPanel: ImpactPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === 'openFile' && typeof msg.path === 'string') {
          openRepoFile(msg.path);
        }
      },
      null,
      this.disposables
    );
  }

  public static show(result: ImpactResult) {
    const column = vscode.window.activeTextEditor?.viewColumn;
    if (ImpactPanel.currentPanel) {
      ImpactPanel.currentPanel.panel.reveal(column);
      ImpactPanel.currentPanel.update(result);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'kairosImpact', 'Code Impact', column ?? vscode.ViewColumn.Beside, { enableScripts: true }
    );
    ImpactPanel.currentPanel = new ImpactPanel(panel);
    ImpactPanel.currentPanel.update(result);
  }

  private update(result: ImpactResult) {
    this.panel.webview.html = isImpactError(result) ? renderError(result) : renderImpact(result);
  }

  private dispose() {
    ImpactPanel.currentPanel = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';";

const STYLES = `
  :root {
    --bg: #0d0d0e;
    --fg: #f5f5f7;
    --fg-muted: #8e8e93;
    --accent: #2558ff;
    --accent-glow: rgba(37, 88, 255, 0.25);
    --border: #26262b;
    --panel: #121216;
    --node: #19191e;
    --node-hover: #22222a;
    --node-stroke: #42424e;
    --edge: #33333d;
    --rel-dependency: #3ddc84;
    --rel-dependent: #ff9f43;
    --rel-historical: #9b6bff;
    --font-mono: 'Space Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, 'SF Mono', Menlo, Consolas, 'Courier New', monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { background: var(--bg); }

  body {
    background-color: var(--bg);
    color: var(--fg);
    font-family: var(--font-mono);
    min-height: 100vh;
    overflow-x: hidden;
    position: relative;
    padding: 2rem 2.5rem 6rem 2.5rem;
  }

  .hero-title {
    font-size: clamp(3.65rem, 6.3vw, 4.45rem);
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.05em;
    line-height: 0.9;
    user-select: none;
    margin-bottom: 0.35rem;
  }

  .sub-tag {
    font-size: 0.84rem;
    font-weight: 700;
    color: var(--fg-muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 2rem;
    overflow-wrap: anywhere;
  }

  .watermark-bottom {
    position: fixed;
    bottom: -1.5rem;
    right: -1rem;
    font-size: clamp(4.2rem, 10.5vw, 9.45rem);
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.05em;
    line-height: 1;
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
    z-index: 0;
    opacity: 0.18;
  }

  .content-wrapper { position: relative; z-index: 2; max-width: 1050px; }

  .section-label {
    font-size: 0.82rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--fg-muted);
    margin-bottom: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .section-label::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    background-color: var(--accent);
  }

  .section-container { margin-bottom: 2.2rem; }

  .summary-cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 1.75rem;
    border-top: 1px solid var(--border);
    padding-top: 1rem;
    margin-bottom: 2rem;
  }
  .summary-cols.single { grid-template-columns: minmax(0, 1fr); }

  .item-list { list-style: none; }
  .item-list li { font-size: 0.92rem; padding: 0.3rem 0; display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
  .item-list li.empty { color: var(--fg-muted); font-style: italic; }
  .item-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bullet-accent { color: var(--accent); font-weight: 700; }

  .impact-grid {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 1.4fr) minmax(0, 1.1fr);
    border-top: 1px solid var(--border);
    padding-top: 0.85rem;
  }

  .col-header {
    font-size: 0.79rem;
    font-weight: 700;
    color: var(--fg-muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding-bottom: 0.75rem;
  }
  .col-header.align-right { text-align: right; }

  .data-row { display: contents; }

  .cell {
    padding: 0.5rem 0;
    font-size: 0.92rem;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 0.15s ease;
  }
  .cell-file { display: flex; gap: 0.85rem; align-items: center; min-width: 0; }
  .cell.align-right { text-align: right; }
  .index-num { color: var(--fg-muted); min-width: 1.7rem; font-size: 0.84rem; }

  .filename { min-width: 0; overflow: hidden; text-overflow: ellipsis; padding: 1px 4px; margin-left: -4px; }
  .data-row:hover .filename { color: #fff; background: var(--accent); }
  .data-row:hover .cell { color: var(--fg); }

  .impact-grid .empty-row { grid-column: 1 / -1; padding: 0.6rem 0; font-size: 0.92rem; color: var(--fg-muted); font-style: italic; }
  .disclaimer-note { font-size: 0.82rem; color: var(--fg-muted); margin-top: 0.85rem; font-style: italic; }
  .error-message { font-size: 1rem; line-height: 1.5; max-width: 70ch; overflow-wrap: anywhere; }

  .graph-card { margin-top: 1.25rem; border: 1px solid var(--border); background-color: var(--panel); overflow: hidden; }
  .graph-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .graph-header .root-key { color: var(--accent); white-space: nowrap; }
  .graph-header .legend { display: flex; gap: 0.9rem; font-weight: 400; text-transform: none; letter-spacing: 0; }
  .graph-header .legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .legend-dot.dependency { background: var(--rel-dependency); }
  .legend-dot.dependent { background: var(--rel-dependent); }
  .legend-dot.historical { background: var(--rel-historical); }
  .graph-scroll { overflow-x: auto; }
  .graph-canvas { display: block; margin: 0 auto; }
  .graph-truncated-note { padding: 0.6rem 1.25rem; font-size: 0.8rem; color: var(--fg-muted); font-style: italic; border-top: 1px solid var(--border); }

  .graph-edge { stroke: var(--edge); stroke-width: 2; stroke-dasharray: 4; fill: none; }
  .graph-edge.active { stroke: var(--accent); stroke-dasharray: none; }
  .graph-edge-import { stroke: var(--edge); }
  .graph-edge-same-package-reference { stroke: #5a5a68; stroke-dasharray: 2 3; }
  .graph-edge-historical { stroke: var(--rel-historical); stroke-dasharray: 6 3; }
  .arrow-head { fill: var(--node-stroke); }
  .arrow-head.active { fill: var(--accent); }

  .col-caption {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    fill: var(--fg-muted);
    text-anchor: middle;
    user-select: none;
  }

  .node-circle { fill: var(--node); stroke: var(--node-stroke); stroke-width: 2; transition: all 0.2s ease; }
  .node-group.root .node-circle { fill: var(--accent); stroke: #fff; }
  .node-group:hover .node-circle { stroke: var(--accent); fill: var(--node-hover); filter: drop-shadow(0 0 8px var(--accent-glow)); }
  .node-group.root:hover .node-circle { fill: var(--accent); }
  .node-group.rel-dependency .node-circle { stroke: var(--rel-dependency); }
  .node-group.rel-dependent .node-circle { stroke: var(--rel-dependent); }
  .node-group.rel-historical .node-circle { stroke: var(--rel-historical); }
  .node-group.cluster .node-circle { fill: var(--panel); stroke: var(--fg-muted); stroke-dasharray: 3 3; }
  .node-group.cluster .node-label { fill: var(--fg-muted); }
  .node-group.cluster:hover .node-circle { filter: none; stroke: var(--fg-muted); fill: var(--panel); }

  .node-label {
    font-family: var(--font-mono);
    font-size: 11.5px;
    fill: var(--fg);
    text-anchor: middle;
    user-select: none;
    pointer-events: none;
  }
  .node-group.root .node-label, .node-group:hover .node-label { fill: #fff; font-weight: 700; }

  @media (max-width: 720px) {
    body { padding: 1.5rem 1rem 5rem 1rem; }
    .summary-cols { grid-template-columns: minmax(0, 1fr); gap: 1.25rem; }
    .cell { font-size: 0.89rem; }
    .cell-file { gap: 0.5rem; }
    .graph-header { flex-direction: column; align-items: flex-start; gap: 0.5rem; }
  }
`;

function page(title: string, body: string, watermark: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${CSP}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Kairos ${escapeHtml(title)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="content-wrapper">${body}</div>
  <div class="watermark-bottom" aria-hidden="true">_${escapeHtml(watermark)}</div>
  <script>
    const vscode = acquireVsCodeApi();
    function openNode(id) { vscode.postMessage({ type: 'openFile', path: id }); }
  </script>
</body>
</html>`;
}

const ERROR_HINTS: Record<string, string> = {
  FILE_NOT_FOUND: 'Make sure the active file is inside the opened workspace folder, and that it was picked up by the analyzer.',
  UNSUPPORTED_LANGUAGE: 'Kairos doesn\u2019t support this file type yet. Select a supported source file and try again.',
  ANALYSIS_FAILED: 'Something went wrong while analyzing the repository. Check the file path and try again.',
};

export function renderError(result: ImpactErrorResponse): string {
  const hint = ERROR_HINTS[result.error.code];
  const body = `
    <div class="hero-title">kairos-</div>
    <div class="sub-tag">impact :: could not analyze</div>
    <div class="summary-cols single">
      <div>
        <div class="section-label">${escapeHtml(result.error.code)}</div>
        <p class="error-message">${escapeHtml(result.error.message)}</p>
        ${hint ? `<p class="disclaimer-note">${escapeHtml(hint)}</p>` : ''}
      </div>
    </div>`;
  return page('error', body, 'error');
}

export function renderImpact(result: ImpactResponse): string {
  const { requestedFile, impact } = result;

  const fileList = (items: string[]) =>
    items.length
      ? `<ul class="item-list">${items
          .map(
            (i) =>
              `<li title="${escapeHtml(i)}"><span class="bullet-accent">&#8627;</span><span class="item-name">${escapeHtml(shortName(i))}</span></li>`
          )
          .join('')}</ul>`
      : `<ul class="item-list"><li class="empty">None found</li></ul>`;

  const rows = impact.affected
    .map(
      (a, i) => `
        <div class="data-row" role="row">
          <div class="cell cell-file" role="cell" title="${escapeHtml(a.id)}"><span class="index-num">${pad2(i + 1)}.</span><span class="filename">${escapeHtml(shortName(a.id))}</span></div>
          <div class="cell align-right" role="cell">${escapeHtml(a.relation)}</div>
          <div class="cell align-right" role="cell">depth: ${pad2(a.distance)}</div>
        </div>`
    )
    .join('');

  const body = `
    <div class="hero-title">kairos-</div>
    <div class="sub-tag" title="${escapeHtml(requestedFile)}">impact :: ${escapeHtml(shortName(requestedFile))}</div>

    <div class="summary-cols">
      <div>
        <div class="section-label">Depends on (${impact.dependsOn.length})</div>
        ${fileList(impact.dependsOn)}
      </div>
      <div>
        <div class="section-label">Dependents (${impact.dependents.length})</div>
        ${fileList(impact.dependents)}
      </div>
    </div>

    <div class="section-container">
      <div class="section-label">Potentially Affected (Blast Radius)</div>
      <div class="impact-grid" role="table">
        <div class="data-row" role="row">
          <div class="col-header" role="columnheader">Component / Target</div>
          <div class="col-header align-right" role="columnheader">Relation</div>
          <div class="col-header align-right" role="columnheader">Distance</div>
        </div>${rows || '<div class="empty-row">None found</div>'}
      </div>
      <div class="disclaimer-note">These are areas to review &#8212; this does not mean the change is safe.</div>
    </div>

    <div class="section-container">
      <div class="section-label">Dependency Graph</div>
      ${renderGraph(result)}
    </div>`;
  return page('impact', body, 'impact');
}

// Layered layout: the target sits in the middle column; files that depend on it
// are laid out to its left (by distance), files it depends on to its right.
// Only the target's impact neighbourhood is drawn. graph.nodes / graph.edges
// describe the whole analyzed repository, so anything outside `affected` is
// deliberately left off the canvas (the table above still lists every affected file).
const MAX_PER_COLUMN = 6;

export function renderGraph(result: ImpactResponse): string {
  const { graph, impact, requestedFile } = result;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const relationById = new Map(impact.affected.map((a) => [a.id, a.relation]));

  const layerOf = new Map<string, number>([[requestedFile, 0]]);
  for (const a of impact.affected) {
    if (a.id === requestedFile) continue;
    layerOf.set(a.id, a.relation === 'dependent' ? -a.distance : a.distance);
  }

  const columns = new Map<number, string[]>();
  for (const [id, layer] of layerOf) {
    const col = columns.get(layer);
    if (col) col.push(id);
    else columns.set(layer, [id]);
  }

  const clusterCounts = new Map<string, number>();
  for (const [layer, ids] of columns) {
    if (ids.length > MAX_PER_COLUMN) {
      const keep = ids.slice(0, MAX_PER_COLUMN - 1);
      const clusterId = `__cluster__${layer}`;
      clusterCounts.set(clusterId, ids.length - keep.length);
      keep.push(clusterId);
      columns.set(layer, keep);
    }
  }

  const layers = [...columns.keys()].sort((a, b) => a - b);

  const COL_W = 240;
  const ROW_H = 72;
  const PAD_X = 110;
  const PAD_Y = 44;
  const maxRows = Math.max(...layers.map((l) => columns.get(l)!.length));
  const width = Math.max(420, PAD_X * 2 + (layers.length - 1) * COL_W);
  const height = Math.max(260, PAD_Y * 2 + maxRows * ROW_H);
  const x0 = (width - (layers.length - 1) * COL_W) / 2;

  interface Placed { x: number; y: number; r: number }
  const placed = new Map<string, Placed>();
  layers.forEach((layer, ci) => {
    const ids = columns.get(layer)!;
    ids.forEach((id, ri) => {
      placed.set(id, {
        x: x0 + ci * COL_W,
        y: height / 2 + (ri - (ids.length - 1) / 2) * ROW_H,
        r: layer === 0 ? 16 : Math.max(9, 15 - Math.abs(layer)),
      });
    });
  });

  const GAP_START = 4;
  const GAP_END = 6;
  const edgeLines = graph.edges.flatMap((e) => {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (!a || !b) return [];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= a.r + b.r + GAP_START + GAP_END) return [];
    const ux = dx / len;
    const uy = dy / len;
    const active = e.from === requestedFile || e.to === requestedFile;
    const kindClass = `graph-edge-${e.kind.replace(/[^a-z0-9-]/gi, '-')}`;
    return [
      `<line class="graph-edge ${kindClass}${active ? ' active' : ''}" x1="${fmt(a.x + ux * (a.r + GAP_START))}" y1="${fmt(a.y + uy * (a.r + GAP_START))}" x2="${fmt(b.x - ux * (b.r + GAP_END))}" y2="${fmt(b.y - uy * (b.r + GAP_END))}" marker-end="url(#${active ? 'kairos-arrow-active' : 'kairos-arrow'})" />`,
    ];
  });

  const nodeMarkup = [...placed]
    .map(([id, p]) => {
      if (clusterCounts.has(id)) {
        const count = clusterCounts.get(id)!;
        return `<g class="node-group cluster" transform="translate(${fmt(p.x)}, ${fmt(p.y)})">
            <title>${count} more file${count === 1 ? '' : 's'} not shown</title>
            <circle class="node-circle" r="${p.r}" />
            <text class="node-label" y="${p.r + 20}">+${count} more</text>
          </g>`;
      }
      const relation = relationById.get(id);
      const relClass = id !== requestedFile && relation ? ` rel-${relation}` : '';
      const label = nodeById.get(id)?.className ?? shortName(id).replace(/\.java$/, '');
      return `<g class="node-group${id === requestedFile ? ' root' : ''}${relClass}" transform="translate(${fmt(p.x)}, ${fmt(p.y)})" style="cursor:pointer" onclick="openNode('${escapeJsString(id)}')">
          <title>${escapeHtml(id)}</title>
          <circle class="node-circle" r="${p.r}" />
          <text class="node-label" y="${p.r + 20}">${escapeHtml(truncate(label, 24))}</text>
        </g>`;
    })
    .join('');

  const captions = layers
    .map((layer, ci) => {
      const text = layer === 0 ? 'target' : `${layer < 0 ? 'dependents' : 'depends on'} &#183; ${Math.abs(layer)}`;
      return `<text class="col-caption" x="${fmt(x0 + ci * COL_W)}" y="22">${text}</text>`;
    })
    .join('');

  const truncatedNote = clusterCounts.size
    ? `<div class="graph-truncated-note">Some nodes are grouped into "+N more" clusters to keep this view readable. Open the file directly, or check the table above, to see everything.</div>`
    : '';

  return `<div class="graph-card">
      <div class="graph-header">
        <span>Topology Map :: Layered View</span>
        <span class="legend">
          <span><span class="legend-dot dependency"></span>dependency</span>
          <span><span class="legend-dot dependent"></span>dependent</span>
          <span><span class="legend-dot historical"></span>historical</span>
          <span class="root-key">&#9679; Selected Root</span>
        </span>
      </div>
      <div class="graph-scroll">
        <svg class="graph-canvas" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Dependency graph for ${escapeHtml(shortName(requestedFile))}">
          <defs>
            <marker id="kairos-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto"><path class="arrow-head" d="M 0 0 L 10 5 L 0 10 z" /></marker>
            <marker id="kairos-arrow-active" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto"><path class="arrow-head active" d="M 0 0 L 10 5 L 0 10 z" /></marker>
          </defs>
          ${captions}${edgeLines.join('')}${nodeMarkup}
        </svg>
      </div>
      ${truncatedNote}
    </div>`;
}

function fmt(v: number): string { return String(Math.round(v * 10) / 10); }
function pad2(n: number): string { return String(n).padStart(2, '0'); }
function truncate(s: string, max: number): string { return s.length > max ? s.slice(0, max - 1) + '\u2026' : s; }
function shortName(path: string): string { return path.split('/').pop() ?? path; }
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeJsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
async function openRepoFile(relPath: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return;
  const uri = vscode.Uri.joinPath(root, relPath);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preserveFocus: false });
  } catch {
    vscode.window.showWarningMessage(`Kairos: could not open ${relPath}`);
  }
}
