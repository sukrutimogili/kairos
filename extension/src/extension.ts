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
      vscode.window.showWarningMessage('Kairos: open or select a Java file first.');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showWarningMessage('Kairos: open a folder or workspace first.');
      return;
    }
    const includeHistory = vscode.workspace
      .getConfiguration('kairos')
      .get<boolean>('includeHistory', false);
    const result = await getImpactData(workspaceRoot, file, { includeHistory });
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
