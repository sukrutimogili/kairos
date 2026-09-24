import { ImpactResult } from '../types';
import { getImpactData as getRealImpactData } from '../integration/analyzerClient';

/**
 * Single, swappable entry point for fetching impact data.
 * Stage 3: swapped from mock JSON to Leela's real analyzer, via Sukruti's
 * integration layer at ../integration/analyzerClient.ts.
 */
export async function getImpactData(
  repositoryRoot: string,
  requestedFile: string
): Promise<ImpactResult> {
  return getRealImpactData(repositoryRoot, requestedFile) as ImpactResult;
}
