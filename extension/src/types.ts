export interface ImpactRequest {
  schemaVersion: '1.0';
  repositoryRoot: string;
  requestedFile: string;
  includeHistory?: boolean;
  /** Phase 3: add the function/method call graph (response.functionGraph + impact.functionImpact). */
  includeFunctions?: boolean;
  /** Phase 3: add HTML / template / CSS / config files and their non-import relationships. */
  includeCrossFile?: boolean;
}

/** Options accepted by getImpactData() — the request flags minus the identifying fields. */
export interface ImpactOptions {
  includeHistory?: boolean;
  includeFunctions?: boolean;
  includeCrossFile?: boolean;
}

export type NonCodeFileType = 'html' | 'template' | 'style' | 'config';

export interface GraphNode {
  id: string;
  className: string;
  package: string;
  /** Phase 3 (includeCrossFile only): set on non-code nodes; absent on source files. */
  fileType?: NonCodeFileType;
}

export type GraphEdgeKind =
  | 'import'
  | 'same-package-reference'
  | 'historical'
  // Phase 3 — dynamic / language-specific
  | 'dynamic-import'
  | 'reflection'
  // Phase 3 — cross-file and non-code (includeCrossFile)
  | 'html-script'
  | 'html-style'
  | 'html-link'
  | 'style-import'
  | 'dom-reference'
  | 'template-render'
  | 'template-include'
  | 'template-call'
  | 'config-reference'
  | 'file-reference'
  | 'config-binding';

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** Phase 3: evidence for cross-file edges, e.g. "#submitBtn" or "process.env.API_URL". */
  detail?: string;
}

// ---- Phase 3: function-level graph (includeFunctions) -------------------

export interface FunctionNode {
  /** "<repo-relative file>#<Class.>name" */
  id: string;
  file: string;
  name: string;
  className: string | null;
  kind: 'function' | 'method' | 'constructor' | 'template';
  startLine: number;
  endLine: number;
  arity: number;
}

export interface FunctionEdge {
  from: string;
  to: string;
  kind: 'call' | 'template-call';
  confidence: 'high' | 'medium';
  line: number;
}

export interface FunctionAffectedEntry {
  id: string;
  relation: 'caller' | 'callee';
  distance: number;
}

export interface FunctionImpact {
  id: string;
  callers: string[];
  callees: string[];
  affected: FunctionAffectedEntry[];
}

export type AffectedRelation = 'dependent' | 'dependency' | 'historical';

export interface AffectedEntry {
  id: string;
  relation: AffectedRelation;
  distance: number;
}

export interface ImpactResponse {
  schemaVersion: '1.0';
  requestedFile: string;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  impact: {
    dependsOn: string[];
    dependents: string[];
    affected: AffectedEntry[];
    /** Phase 3 (includeFunctions only): one entry per function defined in requestedFile. */
    functionImpact?: FunctionImpact[];
  };
  /** Phase 3 (includeFunctions only). */
  functionGraph?: { nodes: FunctionNode[]; edges: FunctionEdge[] };
  meta: { language: string; fileCount: number };
}

export type ImpactErrorCode = 'FILE_NOT_FOUND' | 'UNSUPPORTED_LANGUAGE' | 'ANALYSIS_FAILED';

export interface ImpactErrorResponse {
  schemaVersion: '1.0';
  error: { code: ImpactErrorCode; message: string };
}

export type ImpactResult = ImpactResponse | ImpactErrorResponse;

export function isImpactError(result: ImpactResult): result is ImpactErrorResponse {
  return 'error' in result;
}
