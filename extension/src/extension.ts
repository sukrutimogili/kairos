import * as vscode from 'vscode';
import { getImpactData } from './data/getImpactData';
import { ImpactPanel } from './panel/ImpactPanel';

export function activate(context: vscode.ExtensionContext) {
  const analyzeCodebase = vscode.commands.registerCommand('kairos.analyzeCodebase', async () => {
    vscode.window.showInformationMessage('Kairos: codebase analysis started.');
  });

  const showImpact = vscode.commands.registerCommand('kairos.showImpact', async () => {
    const file = getSelectedFile();
    if (!file) {
      vscode.window.showWarningMessage('Kairos: open or select a source file first.');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showWarningMessage('Kairos: open a folder or workspace first.');
      return;
    }
    const config = vscode.workspace.getConfiguration('kairos');
    const includeHistory = config.get<boolean>('includeHistory', false);
    const includeFunctions = config.get<boolean>('includeFunctions', false);
    const includeCrossFile = config.get<boolean>('includeCrossFile', false);
    const result = await getImpactData(workspaceRoot, file, {
      includeHistory,
      includeFunctions,
      includeCrossFile,
    });
    ImpactPanel.show(result);
  });

  context.subscriptions.push(analyzeCodebase, showImpact);
}

function getSelectedFile(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!workspaceFolder) return editor.document.uri.fsPath;
  return vscode.workspace.asRelativePath(editor.document.uri, false);
}

export function deactivate() {}
