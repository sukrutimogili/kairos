import * as mockData from '../mocks/sampleImpact.json';
import { ImpactResult } from '../types';

/**
 * Single, swappable entry point for fetching impact data.
 * Sukruti swaps the body of this at Stage 3 — nothing else should change.
 */
export async function getImpactData(
  repositoryRoot: string,
  requestedFile: string
): Promise<ImpactResult> {
  return Promise.resolve(mockData as unknown as ImpactResult);
}
