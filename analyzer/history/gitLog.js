#!/usr/bin/env node
/**
 * Kairos analyzer — git history extraction.
 *
 * Walks commit history for a repository and, for each commit, lists
 * which files were touched together. This is the raw data that
 * co-change scoring (analyze.js's computeImpact, gated behind
 * includeHistory) is built on top of.
 *
 * Uses `git log --name-only` via child_process rather than an npm
 * dependency (e.g. simple-git), keeping the analyzer dependency-free.
 */

'use strict';

const { execFileSync } = require('child_process');

const DEFAULT_MAX_COMMITS = 500;

// Separates commits in the git log output below.
const COMMIT_MARKER = '@@KAIROS_COMMIT@@';

/**
 * Returns commit history for repoRoot as:
 *   [ { hash, files: ['a/b.js', 'c/d.java', ...] }, ... ]
 * newest first, each `files` entry a repo-relative POSIX path.
 *
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {number} [options.maxCommits] - how many recent commits to walk
 *   (keeps this fast on large repos with long histories). Defaults to
 *   DEFAULT_MAX_COMMITS.
 * @returns {Array<{hash: string, files: string[]}>} empty array if
 *   repoRoot is not a git repository, or has no commits yet — this is
 *   a "no history available" signal, not a crash.
 */
function getCommitFileGroups(repoRoot, options = {}) {
  const maxCommits = Number.isInteger(options.maxCommits) && options.maxCommits > 0
    ? options.maxCommits
    : DEFAULT_MAX_COMMITS;

  let rawOutput;
  try {
    rawOutput = execFileSync(
      'git',
      ['log', `-n`, String(maxCommits), `--pretty=format:${COMMIT_MARKER}%H`, '--name-only'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (err) {
    // Not a git repo, no commits yet, or git isn't installed — treat as
    // "no history available" rather than propagating a crash up to the
    // analyzer's top-level response.
    return [];
  }

  const commits = [];
  const blocks = rawOutput.split(COMMIT_MARKER).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const hash = lines[0];
    const files = lines.slice(1).map((f) => f.split('\\').join('/'));
    commits.push({ hash, files });
  }

  return commits;
}

module.exports = {
  DEFAULT_MAX_COMMITS,
  getCommitFileGroups,
};
