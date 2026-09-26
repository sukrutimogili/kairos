export interface ImpactRequest {
  schemaVersion: '1.0';
  repositoryRoot: string;
  requestedFile: string;
}

export interface GraphNode {
  id: string;
  className: string;
  package: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'import' | 'historical';
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
  impact: { dependsOn: string[]; dependents: string[]; affected: AffectedEntry[] };
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
