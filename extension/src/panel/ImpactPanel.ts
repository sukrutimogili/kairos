import * as vscode from 'vscode';
import { ImpactResponse, ImpactErrorResponse, isImpactError, ImpactResult } from '../types';

export class ImpactPanel {
  public static currentPanel: ImpactPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static show(result: ImpactResult) {
    const column = vscode.window.activeTextEditor?.viewColumn;
    if (ImpactPanel.currentPanel) {
      ImpactPanel.currentPanel.panel.reveal(column);
      ImpactPanel.currentPanel.update(result);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'kairosImpact', 'Code Impact', column ?? vscode.ViewColumn.Beside, { enableScripts: false }
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

function renderError(result: ImpactErrorResponse): string {
  return `<html><body style="font-family: var(--vscode-font-family); padding: 1rem;">
    <h2>Couldn't analyze this file</h2>
    <p><strong>${escapeHtml(result.error.code)}</strong></p>
    <p>${escapeHtml(result.error.message)}</p>
  </body></html>`;
}

function renderImpact(result: ImpactResponse): string {
  const { requestedFile, impact } = result;
  const list = (items: string[]) =>
    items.length ? `<ul>${items.map((i) => `<li>${escapeHtml(shortName(i))}</li>`).join('')}</ul>` : '<p><em>None</em></p>';
  const affectedList = impact.affected
    .map((a) => `<li>${escapeHtml(shortName(a.id))} — <em>${a.relation}</em>, distance ${a.distance}</li>`)
    .join('');
  return `<html><body style="font-family: var(--vscode-font-family); padding: 1rem;">
    <h2>Impact for ${escapeHtml(shortName(requestedFile))}</h2>
    <h3>Depends on</h3>${list(impact.dependsOn)}
    <h3>Dependents</h3>${list(impact.dependents)}
    <h3>Potentially affected</h3><ul>${affectedList}</ul>
    <p style="opacity:0.7;font-size:0.9em;">These are areas to review — this does not mean the change is safe.</p>
    <h3>Dependency graph</h3>${renderGraph(result)}
  </body></html>`;
}

function renderGraph(result: ImpactResponse): string {
  const { graph } = result;
  const spacing = 140;
  const width = Math.max(320, graph.nodes.length * spacing);
  const height = 160;
  const y = 80;
  const positions = new Map<string, number>();
  graph.nodes.forEach((n, i) => positions.set(n.id, 60 + i * spacing));
  const edgeLines = graph.edges.map((e) => {
    const x1 = positions.get(e.from) ?? 0;
    const x2 = positions.get(e.to) ?? 0;
    return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="var(--vscode-editor-foreground)" stroke-width="1.5" marker-end="url(#arrow)" />`;
  }).join('');
  const nodeCircles = graph.nodes.map((n) => {
    const x = positions.get(n.id) ?? 0;
    const isSelected = n.id === result.requestedFile;
    return `<circle cx="${x}" cy="${y}" r="8" fill="${isSelected ? 'var(--vscode-charts-blue, #3794ff)' : 'var(--vscode-editor-foreground)'}" />
      <text x="${x}" y="${y + 24}" font-size="11" text-anchor="middle" fill="var(--vscode-editor-foreground)">${escapeHtml(n.className)}</text>`;
  }).join('');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="var(--vscode-editor-foreground)" /></marker></defs>
    ${edgeLines}${nodeCircles}
  </svg>`;
}

function shortName(path: string): string { return path.split('/').pop() ?? path; }
function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
