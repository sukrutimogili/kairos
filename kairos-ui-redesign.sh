#!/usr/bin/env bash
#
# kairos-ui-redesign.sh
#
# Applies the Swiss / editorial webview redesign to Kairos by editing ONE file:
#     extension/src/panel/ImpactPanel.ts
#
# What changes: renderError / renderImpact / renderGraph / shortName / escapeHtml
#               (the "presentation" half of the file, from `function renderError`
#               to end-of-file).
# What never changes: the ImpactPanel class (lifecycle, createWebviewPanel options),
#               extension.ts, analyzerClient.ts, getImpactData.ts, types.ts,
#               docs/CONTRACT.md, analyzer/, package.json, tsconfig.json.
#
# Safety model:
#   1. Pre-flight checks abort BEFORE touching anything if the file isn't in the
#      shape this script expects, or has uncommitted edits.
#   2. A backup is stored inside .git/ (never shows up in git status).
#   3. After writing, the script verifies: class half byte-identical, protected
#      files unchanged, TypeScript compiles, the compiled panel renders correctly
#      (real ImpactPanel.show() path, VS Code stubbed), analyzer tests still pass,
#      and git sees exactly one changed file.
#   4. If ANY step fails, the original file is restored automatically.
#
# Usage:
#   ./kairos-ui-redesign.sh             apply + verify
#   ./kairos-ui-redesign.sh --dry-run   show what would change; write nothing
#   ./kairos-ui-redesign.sh --revert    restore the most recent backup
#
set -Eeuo pipefail

MODE="apply"
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry-run" ;;
    --revert)  MODE="revert" ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n> %s\n' "$*"; }
say()  { printf '    %s\n' "$*"; }
ok()   { printf '    ok    %s\n' "$*"; }
die()  { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

TARGET="extension/src/panel/ImpactPanel.ts"
MARKER="KAIROS-EDITORIAL-UI"

# Files this script must leave byte-for-byte untouched.
PROTECTED=(
  extension/src/extension.ts
  extension/src/integration/analyzerClient.ts
  extension/src/data/getImpactData.ts
  extension/src/types.ts
  extension/src/mocks/sampleImpact.json
  extension/src/test/suite/extension.test.ts
  extension/package.json
  extension/tsconfig.json
  docs/CONTRACT.md
  analyzer/analyze.js
)

APPLIED=0
DONE=0
WORK=""
BACKUP=""

rollback() {
  local code=$?
  if [ "$APPLIED" = 1 ] && [ "$DONE" != 1 ] && [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
    printf '\n<< Something failed (exit %s). Restoring %s from backup...\n' "$code" "$TARGET" >&2
    if cp -p "$BACKUP" "$ROOT/$TARGET"; then
      printf '   Restored. The repo is exactly as it was before this script ran.\n' >&2
    else
      printf '   COULD NOT RESTORE AUTOMATICALLY. Backup is at: %s\n' "$BACKUP" >&2
    fi
  fi
  [ -n "$WORK" ] && rm -rf "$WORK"
  return 0
}
trap rollback EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------
# New presentation layer (TypeScript). Quoted heredoc: nothing is expanded.
# ---------------------------------------------------------------------------
emit_new_code() {
cat <<'KAIROS_UI_EOF'
// =============================================================================
// KAIROS-EDITORIAL-UI
// Swiss / editorial presentation layer. Presentation only: these functions turn
// an ImpactResult into static HTML. They perform no analysis, open no files and
// send or receive no messages, so the ImpactPanel lifecycle above and the data
// contract (docs/CONTRACT.md) are unaffected.
// =============================================================================

// Scripts are disabled for this panel, so the page needs nothing but inline CSS.
const CSP = "default-src 'none'; style-src 'unsafe-inline';";

const STYLES = `
  :root {
    --bg: #0d0d0e;
    --fg: #f5f5f7;
    --fg-muted: #8e8e93;
    --accent: #2558ff;
    --accent-glow: rgba(37, 88, 255, 0.35);
    --border: #26262b;
    --panel: #121216;
    --node: #19191e;
    --node-hover: #22222a;
    --node-stroke: #42424e;
    --edge: #33333d;
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
    padding: 3rem 4rem 12rem 4rem;
  }

  .hero-title {
    font-size: clamp(4.5rem, 12vw, 10rem);
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.06em;
    line-height: 0.85;
    user-select: none;
    margin-bottom: 0.5rem;
  }

  .sub-tag {
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--fg);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 3.2rem;
    overflow-wrap: anywhere;
  }

  .watermark-bottom {
    position: fixed;
    bottom: -4rem;
    right: -1.5rem;
    font-size: clamp(7rem, 16vw, 17rem);
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.05em;
    line-height: 1;
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
    z-index: 1;
    opacity: 0.9;
  }

  .content-wrapper { position: relative; z-index: 2; max-width: 1150px; }

  .section-label {
    font-size: 0.95rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--fg-muted);
    margin-bottom: 1rem;
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .section-label::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    background-color: var(--accent);
  }

  .section-container { margin-bottom: 3.5rem; }

  .summary-cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 2.5rem;
    border-top: 1.5px solid var(--border);
    padding-top: 1.5rem;
    margin-bottom: 3.2rem;
  }

  .summary-cols.single { grid-template-columns: minmax(0, 1fr); }

  .item-list { list-style: none; }
  .item-list li {
    font-size: 1.1rem;
    padding: 0.45rem 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }
  .item-list li.empty { color: var(--fg-muted); font-style: italic; }
  .item-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bullet-accent { color: var(--accent); font-weight: 700; }

  .impact-grid {
    display: grid;
    grid-template-columns: minmax(0, 3.2fr) minmax(0, 1.6fr) minmax(0, 1.3fr);
    border-top: 1.5px solid var(--border);
    padding-top: 1.25rem;
  }

  .col-header {
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--fg-muted);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding-bottom: 1rem;
  }
  .col-header.align-right { text-align: right; }

  .data-row { display: contents; }

  .cell {
    padding: 0.75rem 0;
    font-size: 1.12rem;
    line-height: 1.45;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 0.15s ease;
  }
  .cell-file { display: flex; gap: 1.25rem; align-items: center; min-width: 0; }
  .cell.align-right { text-align: right; }

  .index-num { color: var(--fg-muted); min-width: 2.2rem; font-size: 1rem; }

  .filename {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 2px 6px;
    margin-left: -6px;
  }
  .data-row:hover .filename { color: #fff; background: var(--accent); }
  .data-row:hover .cell { color: var(--fg); }

  .impact-grid .empty-row {
    grid-column: 1 / -1;
    padding: 0.75rem 0;
    font-size: 1.1rem;
    color: var(--fg-muted);
    font-style: italic;
  }

  .disclaimer-note {
    font-size: 0.95rem;
    color: var(--fg-muted);
    margin-top: 1.25rem;
    font-style: italic;
  }

  .error-message { font-size: 1.1rem; line-height: 1.6; max-width: 70ch; overflow-wrap: anywhere; }

  .graph-card {
    margin-top: 1.75rem;
    border: 1.5px solid var(--border);
    background-color: var(--panel);
    overflow: hidden;
  }
  .graph-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.5rem;
    border-bottom: 1.5px solid var(--border);
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .graph-header .root-key { color: var(--accent); white-space: nowrap; }
  .graph-scroll { overflow-x: auto; }
  .graph-canvas { display: block; margin: 0 auto; }

  .graph-edge { stroke: var(--edge); stroke-width: 2.5; stroke-dasharray: 5; fill: none; }
  .graph-edge.active { stroke: var(--accent); stroke-dasharray: none; }
  .arrow-head { fill: var(--node-stroke); }
  .arrow-head.active { fill: var(--accent); }

  .col-caption {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    fill: var(--fg-muted);
    text-anchor: middle;
    user-select: none;
  }

  .node-circle { fill: var(--node); stroke: var(--node-stroke); stroke-width: 2.5; transition: all 0.2s ease; }
  .node-group.root .node-circle { fill: var(--accent); stroke: #fff; }
  .node-group:hover .node-circle { stroke: var(--accent); fill: var(--node-hover); filter: drop-shadow(0 0 10px var(--accent-glow)); }
  .node-group.root:hover .node-circle { fill: var(--accent); }

  .node-label {
    font-family: var(--font-mono);
    font-size: 13px;
    fill: var(--fg);
    text-anchor: middle;
    user-select: none;
    pointer-events: none;
  }
  .node-group.root .node-label, .node-group:hover .node-label { fill: #fff; font-weight: 700; }

  @media (max-width: 720px) {
    body { padding: 2rem 1.25rem 9rem 1.25rem; }
    .summary-cols { grid-template-columns: minmax(0, 1fr); gap: 1.5rem; }
    .cell { font-size: 1rem; }
    .cell-file { gap: 0.6rem; }
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
</body>
</html>`;
}

function renderError(result: ImpactErrorResponse): string {
  const body = `
    <div class="hero-title">kairos-</div>
    <div class="sub-tag">impact :: could not analyze</div>
    <div class="summary-cols single">
      <div>
        <div class="section-label">${escapeHtml(result.error.code)}</div>
        <p class="error-message">${escapeHtml(result.error.message)}</p>
      </div>
    </div>`;
  return page('error', body, 'error');
}

function renderImpact(result: ImpactResponse): string {
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
function renderGraph(result: ImpactResponse): string {
  const { graph, impact, requestedFile } = result;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

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
    return [
      `<line class="graph-edge${active ? ' active' : ''}" x1="${fmt(a.x + ux * (a.r + GAP_START))}" y1="${fmt(a.y + uy * (a.r + GAP_START))}" x2="${fmt(b.x - ux * (b.r + GAP_END))}" y2="${fmt(b.y - uy * (b.r + GAP_END))}" marker-end="url(#${active ? 'kairos-arrow-active' : 'kairos-arrow'})" />`,
    ];
  });

  const nodeMarkup = [...placed]
    .map(([id, p]) => {
      const label = nodeById.get(id)?.className ?? shortName(id).replace(/\.java$/, '');
      return `<g class="node-group${id === requestedFile ? ' root' : ''}" transform="translate(${fmt(p.x)}, ${fmt(p.y)})">
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

  return `<div class="graph-card">
      <div class="graph-header"><span>Topology Map :: Layered View</span><span class="root-key">&#9679; Selected Root</span></div>
      <div class="graph-scroll">
        <svg class="graph-canvas" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Dependency graph for ${escapeHtml(shortName(requestedFile))}">
          <defs>
            <marker id="kairos-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto"><path class="arrow-head" d="M 0 0 L 10 5 L 0 10 z" /></marker>
            <marker id="kairos-arrow-active" viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto"><path class="arrow-head active" d="M 0 0 L 10 5 L 0 10 z" /></marker>
          </defs>
          ${captions}${edgeLines.join('')}${nodeMarkup}
        </svg>
      </div>
    </div>`;
}

function fmt(v: number): string { return String(Math.round(v * 10) / 10); }
function pad2(n: number): string { return String(n).padStart(2, '0'); }
function truncate(s: string, max: number): string { return s.length > max ? s.slice(0, max - 1) + '\u2026' : s; }
function shortName(path: string): string { return path.split('/').pop() ?? path; }
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
KAIROS_UI_EOF
}

# ---------------------------------------------------------------------------
# Smoke test (Node). Loads the REAL compiled ImpactPanel with `vscode` stubbed,
# drives it through ImpactPanel.show(), and asserts on the HTML it produces.
# ---------------------------------------------------------------------------
emit_smoke_test() {
cat <<'KAIROS_SMOKE_EOF'
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const [, , panelJs, analyzerJs, fixtureRoot, previewDir] = process.argv;

const created = [];
const panelStub = { webview: { html: '' }, onDidDispose() {}, reveal() {}, dispose() {} };
const vscodeStub = {
  window: {
    activeTextEditor: undefined,
    createWebviewPanel(...args) { created.push(args); return panelStub; },
  },
  ViewColumn: { Beside: 2 },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const { ImpactPanel } = require(panelJs);
const { analyze } = require(analyzerJs);
const render = (result) => { ImpactPanel.show(result); return panelStub.webview.html; };
const pad2 = (n) => String(n).padStart(2, '0');
const short = (p) => p.split('/').pop();

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('    ok    ' + name); }
  catch (err) { failed += 1; console.error('    FAIL  ' + name + '\n          ' + err.message); }
}

function checkImpact(label, r) {
  const html = render(r);
  check(`${label}: standalone page, CSP present, no scripts, no network references`, () => {
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(/Content-Security-Policy/.test(html));
    assert.ok(!/<script/i.test(html), 'found <script>');
    assert.ok(!/https?:\/\//i.test(html), 'found an external URL');
  });
  check(`${label}: every dependsOn / dependents / affected file is shown`, () => {
    for (const id of [...r.impact.dependsOn, ...r.impact.dependents, ...r.impact.affected.map((a) => a.id)]) {
      assert.ok(html.includes(short(id)), 'missing ' + id);
    }
    assert.ok(html.includes(`Depends on (${r.impact.dependsOn.length})`));
    assert.ok(html.includes(`Dependents (${r.impact.dependents.length})`));
  });
  check(`${label}: relation + depth columns match the data`, () => {
    for (const a of r.impact.affected) assert.ok(html.includes(`depth: ${pad2(a.distance)}`));
    for (const rel of new Set(r.impact.affected.map((a) => a.relation))) assert.ok(html.includes(`>${rel}<`));
  });
  check(`${label}: graph draws exactly the impact neighbourhood`, () => {
    const ids = new Set([r.requestedFile, ...r.impact.affected.map((a) => a.id)]);
    assert.strictEqual((html.match(/<circle /g) || []).length, ids.size);
    const edges = r.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).length;
    assert.strictEqual((html.match(/<line /g) || []).length, edges);
  });
  check(`${label}: "areas to review" disclaimer preserved`, () => {
    assert.ok(html.includes('These are areas to review'));
    assert.ok(html.includes('does not mean the change is safe'));
  });
  return html;
}

const save = (name, html) => fs.writeFileSync(path.join(previewDir, name), html);

// 1) Real analyzer output on the shared fixture (dependents on the left, dependencies on the right).
const CTRL = 'src/main/java/com/example/controller/UserController.java';
const SVC = 'src/main/java/com/example/service/UserService.java';
const REPO = 'src/main/java/com/example/repository/UserRepository.java';
console.log('  real analyzer output (tests/fixtures/sample-project)');
for (const f of [CTRL, SVC, REPO]) {
  const r = analyze(fixtureRoot, f);
  assert.ok(!r.error, 'analyzer returned an error for ' + f);
  const html = checkImpact(short(f), r);
  if (f === SVC) save('preview-fixture-UserService.html', html);
}

// 2) Data shaped like the design mockup (OrderController).
console.log('  mockup-shaped data');
const P = 'src/main/java/com/example/';
const mk = (dir, name) => ({ id: `${P}${dir}/${name}.java`, className: name, package: `com.example.${dir}` });
const N = {
  ctl: mk('controller', 'OrderController'), order: mk('model', 'Order'), svc: mk('service', 'OrderService'),
  pay: mk('model', 'Payment'), user: mk('model', 'User'), orepo: mk('repository', 'OrderRepository'),
  urepo: mk('repository', 'UserRepository'), notif: mk('service', 'NotificationService'),
  psvc: mk('service', 'PaymentService'), prepo: mk('repository', 'PaymentRepository'),
};
const E = (a, b) => ({ from: N[a].id, to: N[b].id, kind: 'import' });
const A = (k, relation, distance) => ({ id: N[k].id, relation, distance });
const mockup = {
  schemaVersion: '1.0',
  requestedFile: N.ctl.id,
  graph: {
    nodes: Object.values(N),
    edges: [E('ctl', 'order'), E('ctl', 'svc'), E('svc', 'pay'), E('svc', 'user'), E('svc', 'orepo'), E('svc', 'urepo'), E('svc', 'notif'), E('svc', 'psvc'), E('psvc', 'prepo')],
  },
  impact: {
    dependsOn: [N.order.id, N.svc.id],
    dependents: [],
    affected: [A('order', 'dependency', 1), A('svc', 'dependency', 1), A('pay', 'dependency', 2), A('user', 'dependency', 2), A('orepo', 'dependency', 2), A('urepo', 'dependency', 2), A('notif', 'dependency', 2), A('psvc', 'dependency', 2), A('prepo', 'dependency', 3)],
  },
  meta: { language: 'java', fileCount: 10 },
};
save('preview-mockup-data.html', checkImpact('OrderController', mockup));

// 3) Edge cases.
console.log('  edge cases');
check('hostile file/class names are escaped (no markup injection)', () => {
  const evil = 'src/<img src=x onerror=alert(1)>/A&B"\'.java';
  const r = {
    schemaVersion: '1.0', requestedFile: evil,
    graph: { nodes: [{ id: evil, className: '"><script>alert(1)</script>', package: 'p' }], edges: [] },
    impact: { dependsOn: [], dependents: [], affected: [] }, meta: { language: 'java', fileCount: 1 },
  };
  const html = render(r);
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes('<img src=x'));
});
check('target with no relationships renders (empty state, single node)', () => {
  const id = 'src/Lonely.java';
  const html = render({
    schemaVersion: '1.0', requestedFile: id,
    graph: { nodes: [{ id, className: 'Lonely', package: '' }], edges: [] },
    impact: { dependsOn: [], dependents: [], affected: [] }, meta: { language: 'java', fileCount: 1 },
  });
  assert.ok(html.includes('None found'));
  assert.strictEqual((html.match(/<circle /g) || []).length, 1);
});
check('300 affected files render without error', () => {
  const root = 'src/Root.java';
  const nodes = [{ id: root, className: 'Root', package: 'p' }];
  const edges = [];
  const affected = [];
  for (let i = 0; i < 300; i++) {
    const id = `src/dep/D${i}.java`;
    nodes.push({ id, className: 'D' + i, package: 'p.dep' });
    edges.push({ from: root, to: id, kind: 'import' });
    affected.push({ id, relation: 'dependency', distance: 1 });
  }
  const html = render({ schemaVersion: '1.0', requestedFile: root, graph: { nodes, edges },
    impact: { dependsOn: affected.map((a) => a.id), dependents: [], affected }, meta: { language: 'java', fileCount: 301 } });
  assert.strictEqual((html.match(/<circle /g) || []).length, 301);
});
check('error response renders code + escaped message', () => {
  const html = render({ schemaVersion: '1.0', error: { code: 'FILE_NOT_FOUND', message: '<b>nope</b> & more' } });
  assert.ok(html.includes('FILE_NOT_FOUND'));
  assert.ok(html.includes('&lt;b&gt;nope&lt;/b&gt; &amp; more'));
  assert.ok(!/<script/i.test(html));
  save('preview-error.html', html);
});

// 4) Lifecycle untouched: still one panel, same view type, scripts still disabled.
console.log('  panel lifecycle');
check('createWebviewPanel called once with viewType "kairosImpact" and enableScripts:false', () => {
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0][0], 'kairosImpact');
  assert.strictEqual(created[0][3].enableScripts, false);
});

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
KAIROS_SMOKE_EOF
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
snapshot() {
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    for (const f of process.argv.slice(1)) {
      const h = fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : "MISSING";
      console.log(h + "  " + f);
    }' "${PROTECTED[@]}"
}

count_matches() { grep -c -E "$1" "$2" || true; }

# ---------------------------------------------------------------------------
# 0. Environment
# ---------------------------------------------------------------------------
command -v git  >/dev/null 2>&1 || die "git is required."
command -v node >/dev/null 2>&1 || die "node is required."
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Run this from inside the kairos git repository."
cd "$ROOT"
GITDIR="$(git rev-parse --absolute-git-dir)"
BACKUP_DIR="$GITDIR/kairos-ui-backup"

[ -f "$TARGET" ]                 || die "$TARGET not found. Is this the kairos repo?"
[ -f docs/CONTRACT.md ]          || die "docs/CONTRACT.md not found. Is this the kairos repo?"
grep -q '"name": "kairos"' extension/package.json 2>/dev/null || die "extension/package.json is not the kairos extension."

# ---------------------------------------------------------------------------
# --revert
# ---------------------------------------------------------------------------
if [ "$MODE" = "revert" ]; then
  step "Reverting $TARGET"
  LATEST="$(ls -1t "$BACKUP_DIR"/ImpactPanel.ts.*.bak 2>/dev/null | head -n 1 || true)"
  [ -n "$LATEST" ] || die "No backup found in $BACKUP_DIR. Use: git checkout -- $TARGET"
  cp -p "$LATEST" "$TARGET"
  ok "restored from $LATEST"
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Pre-flight: abort before touching anything if the file isn't what we expect
# ---------------------------------------------------------------------------
step "Pre-flight checks"

if grep -q "$MARKER" "$TARGET"; then
  ok "redesign already applied to $TARGET - nothing to do"
  exit 0
fi

if ! git diff --quiet -- "$TARGET" || ! git diff --cached --quiet -- "$TARGET"; then
  die "$TARGET has uncommitted changes. Commit or stash them first so nothing is lost."
fi
ok "$TARGET has no uncommitted changes"

for fn in renderError renderImpact renderGraph shortName escapeHtml; do
  [ "$(count_matches "^function ${fn}\\(" "$TARGET")" = "1" ] || die "Expected exactly one top-level 'function ${fn}(' in $TARGET. The file has changed shape; aborting without edits."
done
ok "found the five presentation functions exactly once each"

CUT_LINE="$(grep -n '^function renderError(' "$TARGET" | head -n 1 | cut -d: -f1)"
CLASS_LINE="$(grep -n '^export class ImpactPanel' "$TARGET" | head -n 1 | cut -d: -f1 || true)"
[ -n "$CLASS_LINE" ] && [ "$CLASS_LINE" -lt "$CUT_LINE" ] || die "ImpactPanel class was not found before renderError. Aborting without edits."

# Everything from renderError to EOF will be replaced: make sure it contains ONLY the five known functions.
UNEXPECTED="$(tail -n +"$CUT_LINE" "$TARGET" | grep -E '^(export |async |function |class |const |let |var |interface |type |enum |import )' | grep -v -E '^function (renderError|renderImpact|renderGraph|shortName|escapeHtml)\(' || true)"
[ -z "$UNEXPECTED" ] || die "Found extra top-level code after renderError that would be deleted:
$UNEXPECTED"
ok "nothing else lives below the cut point (line $CUT_LINE); the class above it stays untouched"

grep -q 'enableScripts: false' "$TARGET" && ok "panel keeps enableScripts:false (no IPC surface added)"

# ---------------------------------------------------------------------------
# 2. Baselines
# ---------------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kairos-ui.XXXXXX")"
snapshot > "$WORK/protected.before"
git diff --name-only | sort > "$WORK/changed.before"

# ---------------------------------------------------------------------------
# 3. Build the candidate file (class half copied verbatim, new UI appended)
# ---------------------------------------------------------------------------
CAND="$WORK/ImpactPanel.ts.new"
head -n $((CUT_LINE - 1)) "$TARGET" > "$CAND"
if grep -q $'\r' "$TARGET"; then
  emit_new_code | awk '{ printf "%s\r\n", $0 }' >> "$CAND"
  say "CRLF line endings detected; new code written with CRLF"
else
  emit_new_code >> "$CAND"
fi

if [ "$MODE" = "dry-run" ]; then
  step "Dry run: nothing written"
  git diff --no-index --numstat -- "$TARGET" "$CAND" | awk '{ printf "    lines added:   %s\n    lines removed: %s\n", $1, $2 }' || true
  say "class half (lines 1-$((CUT_LINE - 1))) is copied byte-for-byte"
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Backup, then apply. From here on any failure triggers automatic rollback.
# ---------------------------------------------------------------------------
step "Applying"
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/ImpactPanel.ts.$(date +%Y%m%d-%H%M%S).bak"
cp -p "$TARGET" "$BACKUP"
ok "backup saved to .git/kairos-ui-backup/$(basename "$BACKUP")"
cp "$CAND" "$TARGET"
APPLIED=1
ok "wrote $TARGET"

# ---------------------------------------------------------------------------
# 5. Verify
# ---------------------------------------------------------------------------
step "Verifying"

cmp -s <(head -n $((CUT_LINE - 1)) "$BACKUP") <(head -n $((CUT_LINE - 1)) "$TARGET") \
  || die "ImpactPanel class half is not identical to the original."
ok "ImpactPanel class (lifecycle, panel options) is byte-identical"

snapshot > "$WORK/protected.after"
if ! diff -q "$WORK/protected.before" "$WORK/protected.after" >/dev/null; then
  diff "$WORK/protected.before" "$WORK/protected.after" || true
  die "A protected file changed."
fi
ok "extension.ts, analyzerClient.ts, getImpactData.ts, types.ts, CONTRACT.md, analyzer/ unchanged"

if [ ! -e extension/node_modules/.bin/tsc ]; then
  say "installing extension dev dependencies (npm ci; node_modules is git-ignored)..."
  ( cd extension && npm ci --no-audit --no-fund >/dev/null 2>&1 ) || die "npm ci failed. Check your network, then re-run."
fi

( cd extension && npx --no-install tsc --noEmit -p . ) || die "TypeScript type-check failed."
ok "TypeScript type-check passes (strict mode, --noEmit: no out/ files written)"

( cd extension && npx --no-install tsc -p . --outDir "$WORK/out" ) || die "TypeScript build to temp dir failed."
PREVIEW_DIR="$BACKUP_DIR/previews"
mkdir -p "$PREVIEW_DIR"
emit_smoke_test > "$WORK/smoke.js"
say "rendering through the real ImpactPanel.show() path (vscode stubbed):"
node "$WORK/smoke.js" "$WORK/out/panel/ImpactPanel.js" "$ROOT/analyzer/analyze.js" "$ROOT/tests/fixtures/sample-project" "$PREVIEW_DIR" \
  || die "Render smoke test failed."

node analyzer/analyze.test.js >"$WORK/analyzer.log" 2>&1 || { cat "$WORK/analyzer.log"; die "Analyzer tests failed."; }
ok "analyzer test suite still passes ($(tail -n 1 "$WORK/analyzer.log"))"

git diff --name-only | sort > "$WORK/changed.after"
NEW_CHANGES="$(comm -13 "$WORK/changed.before" "$WORK/changed.after")"
[ "$NEW_CHANGES" = "$TARGET" ] || die "git sees unexpected changes: $NEW_CHANGES"
ok "git sees exactly one changed file: $TARGET"

DONE=1

# ---------------------------------------------------------------------------
# 6. Summary
# ---------------------------------------------------------------------------
step "Done"
git diff --numstat -- "$TARGET" | awk '{ printf "    %s: +%s / -%s lines\n", $3, $1, $2 }'
say ""
say "Preview in a browser (no VS Code needed):"
say "  $PREVIEW_DIR/preview-mockup-data.html"
say "  $PREVIEW_DIR/preview-fixture-UserService.html   (has dependents on the left)"
say "  $PREVIEW_DIR/preview-error.html"
say ""
say "Try it live: open extension/ in VS Code, press F5, run \"Code Impact: Show Impact\" on a Java file."
say "Undo:        ./$(basename "$0") --revert     (or: git checkout -- $TARGET)"
