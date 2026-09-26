import * as path from 'path';

// Leela's analyzer lives at repoRoot/analyzer/analyze.js — plain CommonJS,
// outside this extension's TS project and outside rootDir, so it's loaded
// with require() rather than a typed import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { analyze } = require(path.resolve(__dirname, '../../../analyzer/analyze.js'));

export const ANALYZER_ENTRY = path.resolve(__dirname, '../../../analyzer/analyze.js');

/**
 * Sukruti's Stage 3 integration layer. Calls straight into Leela's
 * analyzer and returns JSON matching docs/CONTRACT.md exactly.
 *
 * analyze() never throws — on failure it returns an ImpactErrorResponse
 * matching the contract (schemaVersion + error.code/message). So this is a
 * pure passthrough: no try/catch, no translation. That matches how
 * extension.ts and ImpactPanel.ts already consume the result via
 * isImpactError() rather than a try/catch.
 *
 * @param repositoryRoot - path to the repo being analyzed. In the real
 *   extension this is vscode.workspace.workspaceFolders[0].uri.fsPath.
 * @param requestedFile - path to the file the user selected.
 * @param options.includeHistory - Sukruti's Step 5 plumbing: forwarded
 *   straight through to analyze()'s own includeHistory option (default
 *   false), which is itself forwarded straight through to
 *   computeCoChangeScores() — no logic duplicated at this layer.
 */
export function getImpactData(
  repositoryRoot: string,
  requestedFile: string,
  options: { includeHistory?: boolean } = {}
) {
  return analyze(repositoryRoot, requestedFile, options);
}
