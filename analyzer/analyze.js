#!/usr/bin/env node
/**
 * Kairos analyzer — language-agnostic core.
 *
 * Phase 2 refactor: the Java-specific parsing logic that used to live
 * directly in this file has moved to analyzer/languages/java.js. This
 * file now only handles:
 *   - language dispatch (picking a plugin by file extension)
 *   - dependency graph assembly (buildGraph)
 *   - impact analysis (computeImpact, analyze, CLI)
 *   - co-change scoring (computeCoChangeScores) — Step 4, gated behind
 *     the includeHistory flag, additive-only on top of impact.affected
 *
 * No behavior change from Phase 1 when includeHistory is not set — see
 * analyzer/analyze.test.js, which must still pass unmodified.
 *
 * Usage:
 *   node analyze.js <repositoryRoot> <requestedFile> [--include-history]
 *
 * Also usable as a module:
 *   const { analyze } = require('./analyze');
 *   const result = analyze(repoRoot, requestedFile, { includeHistory: true });
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.0';

// ---------------------------------------------------------------------
// Language dispatch
// ---------------------------------------------------------------------

const javaPlugin = require('./languages/java');
const typescriptPlugin = require('./languages/typescript');
const { getCommitFileGroups } = require('./history/gitLog');

// extension -> plugin. Add new plugins here (or make this dynamic later).
const LANGUAGE_PLUGINS = [javaPlugin, typescriptPlugin];

const EXTENSION_TO_PLUGIN = new Map();
for (const plugin of LANGUAGE_PLUGINS) {
  for (const ext of plugin.extensions) {
    EXTENSION_TO_PLUGIN.set(ext, plugin);
  }
}

function pluginForFile(absPath) {
  const ext = path.extname(absPath);
  return EXTENSION_TO_PLUGIN.get(ext) || null;
}

/**
 * Finds every source file (any known language) under repoRoot, as
 * absolute paths, using each registered plugin's findSourceFiles().
 */
function findSourceFiles(repoRoot) {
  const allFiles = [];
  for (const plugin of LANGUAGE_PLUGINS) {
    allFiles.push(...plugin.findSourceFiles(repoRoot));
  }
  return allFiles;
}

// Back-compat alias — existing tests/tools may still call this by its
// original Phase-1 name.
function findJavaFiles(repoRoot) {
  return javaPlugin.findSourceFiles(repoRoot);
}

/**
 * Parses one file using whichever plugin owns its extension.
 * Returns null if no plugin handles this file type.
 */
function parseFile(absPath) {
  const plugin = pluginForFile(absPath);
  if (!plugin) return null;
  return plugin.parseFile(absPath);
}

// Back-compat alias for the Phase-1 name.
function parseJavaFile(absPath) {
  return javaPlugin.parseFile(absPath);
}

function toRepoRelativePosixPath(repoRoot, absPath) {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

// ---------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------

/**
 * Builds the dependency graph for a repository, matching the `graph`
 * shape in docs/CONTRACT.md:
 *   { nodes: [{id, className, package}], edges: [{from, to, kind}] }
 *
 * `id` on every node is the repo-relative, POSIX-style file path —
 * this is also what the extension uses to open the file directly.
 *
 * Files are grouped by which plugin owns them, and each plugin's
 * extractRelationships() is called only with its own files — so a
 * language plugin never has to know about any other language.
 */
function buildGraph(repoRoot) {
  const absFiles = findSourceFiles(repoRoot);

  // plugin -> Map(relPath -> parsed)
  const parsedByPlugin = new Map();
  const allNodes = [];

  for (const absPath of absFiles) {
    const plugin = pluginForFile(absPath);
    if (!plugin) continue; // shouldn't happen: findSourceFiles only returns known extensions

    const relPath = toRepoRelativePosixPath(repoRoot, absPath);
    const parsed = plugin.parseFile(absPath);

    if (!parsedByPlugin.has(plugin)) parsedByPlugin.set(plugin, new Map());
    parsedByPlugin.get(plugin).set(relPath, parsed);

    allNodes.push({ id: relPath, className: parsed.className, package: parsed.package });
  }

  // Stable, deterministic ordering makes output diffable in tests/CI.
  allNodes.sort((a, b) => a.id.localeCompare(b.id));

  const allEdges = [];
  for (const [plugin, parsedByRelPath] of parsedByPlugin.entries()) {
    allEdges.push(...plugin.extractRelationships(parsedByRelPath));
  }

  return { nodes: allNodes, edges: allEdges };
}

// ---------------------------------------------------------------------
// Impact analysis
// ---------------------------------------------------------------------

/**
 * Given a graph and a requested file (repo-relative path), computes:
 *   dependsOn  — direct successors of requestedFile (distance 1, forward)
 *   dependents — direct predecessors of requestedFile (distance 1, backward)
 *   affected   — every reachable node in either direction, each tagged
 *                with { id, relation, distance }.
 *
 * Per docs/CONTRACT.md's design rules: dependsOn/dependents are exactly
 * the distance-1 neighbors of requestedFile in graph.edges, so they can
 * never drift from a fresh traversal — see analyze.test.js.
 */
function computeImpact(graph, requestedFile) {
  const forwardAdj = new Map(); // file -> files it depends on
  const backwardAdj = new Map(); // file -> files that depend on it

  for (const node of graph.nodes) {
    forwardAdj.set(node.id, []);
    backwardAdj.set(node.id, []);
  }
  for (const edge of graph.edges) {
    forwardAdj.get(edge.from).push(edge.to);
    backwardAdj.get(edge.to).push(edge.from);
  }

  const dependsOn = [...(forwardAdj.get(requestedFile) || [])].sort();
  const dependents = [...(backwardAdj.get(requestedFile) || [])].sort();

  const affectedById = new Map(); // id -> {id, relation, distance}

  function bfs(startId, adjacency, relation) {
    const visited = new Set([startId]);
    let frontier = [startId];
    let distance = 0;
    while (frontier.length > 0) {
      distance += 1;
      const nextFrontier = [];
      for (const current of frontier) {
        for (const neighbor of adjacency.get(current) || []) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          nextFrontier.push(neighbor);

          const existing = affectedById.get(neighbor);
          if (!existing || existing.distance > distance) {
            affectedById.set(neighbor, { id: neighbor, relation, distance });
          }
        }
      }
      frontier = nextFrontier;
    }
  }

  bfs(requestedFile, forwardAdj, 'dependency'); // things requestedFile depends on
  bfs(requestedFile, backwardAdj, 'dependent'); // things that depend on requestedFile

  const affected = [...affectedById.values()].sort(
    (a, b) => a.distance - b.distance || a.id.localeCompare(b.id)
  );

  return { dependsOn, dependents, affected };
}

// ---------------------------------------------------------------------
// Co-change scoring (historical relation) — Step 4
// ---------------------------------------------------------------------

/**
 * Scores how often each other file in the repo changed in the same
 * commit as requestedFile, using git history (history/gitLog.js).
 *
 * Only files that are also nodes in the current dependency graph are
 * returned, so "historical" entries stay clickable/openable in the
 * extension panel, same as dependency/dependent entries.
 *
 * Returns [] (never throws) if there's no git history available —
 * matches gitLog.js's own "no history available" contract, so a repo
 * with no .git or no commits just gets zero historical entries rather
 * than breaking the whole analyze() call.
 *
 * @param {string} repoRoot
 * @param {string} requestedFile - repo-relative POSIX path, matching graph.nodes[].id
 * @param {object} graph - the current dependency graph (from buildGraph)
 * @param {object} [options]
 * @param {number} [options.maxCommits] - passed through to getCommitFileGroups
 * @returns {Array<{id, relation: 'historical', count}>} sorted by count
 *   desc, then id
 */
function computeCoChangeScores(repoRoot, requestedFile, graph, options = {}) {
  const commits = getCommitFileGroups(repoRoot, { maxCommits: options.maxCommits });
  const knownIds = new Set(graph.nodes.map((n) => n.id));

  const counts = new Map();
  for (const commit of commits) {
    if (!commit.files.includes(requestedFile)) continue;
    for (const file of commit.files) {
      if (file === requestedFile) continue;
      if (!knownIds.has(file)) continue; // only files the graph actually knows about
      counts.set(file, (counts.get(file) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([id, count]) => ({ id, relation: 'historical', count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------
// Top-level entry point — matches docs/CONTRACT.md response/error shape
// ---------------------------------------------------------------------

/**
 * @param {string} repositoryRoot - path to the repo to analyze
 * @param {string} requestedFile  - path to the target file (absolute, or
 *   relative to repositoryRoot, or relative to cwd)
 * @param {object} [options]
 * @param {boolean} [options.includeHistory] - if true, adds "historical"
 *   entries to impact.affected from co-change scoring. Default false —
 *   matches docs/CONTRACT.md's includeHistory request field.
 * @param {number} [options.maxCommits] - passed through to co-change scoring
 * @returns {object} JSON matching docs/CONTRACT.md exactly (success or error)
 */
function analyze(repositoryRoot, requestedFile, options = {}) {
  const repoRoot = path.resolve(repositoryRoot);

  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    return {
      schemaVersion: SCHEMA_VERSION,
      error: { code: 'ANALYSIS_FAILED', message: `repositoryRoot does not exist: ${repositoryRoot}` },
    };
  }

  // Check the requested file's extension up front: if it's not a
  // recognized language at all, that's UNSUPPORTED_LANGUAGE, distinct
  // from FILE_NOT_FOUND (which means "no plugin recognizes this path
  // inside the analyzed repo, even though the language is supported").
  const requestedAbsGuess = path.isAbsolute(requestedFile)
    ? requestedFile
    : path.resolve(repoRoot, requestedFile);
  if (!pluginForFile(requestedAbsGuess)) {
    return {
      schemaVersion: SCHEMA_VERSION,
      error: { code: 'UNSUPPORTED_LANGUAGE', message: `no analyzer plugin for file: ${requestedFile}` },
    };
  }

  const graph = buildGraph(repoRoot);

  const requestedRelPath = resolveRequestedFile(repoRoot, requestedFile, graph.nodes);
  if (!requestedRelPath) {
    return {
      schemaVersion: SCHEMA_VERSION,
      error: { code: 'FILE_NOT_FOUND', message: 'requestedFile was not found in the analyzed repository' },
    };
  }

  const impact = computeImpact(graph, requestedRelPath);

  if (options.includeHistory) {
    const historical = computeCoChangeScores(repoRoot, requestedRelPath, graph, {
      maxCommits: options.maxCommits,
    });
    // Additive only — never replaces the existing dependency/dependent
    // entries already in impact.affected (per docs/CONTRACT.md).
    impact.affected = [...impact.affected, ...historical];
  }

  const requestedPlugin = pluginForFile(path.resolve(repoRoot, requestedRelPath));
  const languageByPlugin = new Map([[javaPlugin, 'java'], [typescriptPlugin, 'typescript']]);

  return {
    schemaVersion: SCHEMA_VERSION,
    requestedFile: requestedRelPath,
    graph,
    impact,
    meta: {
      language: languageByPlugin.get(requestedPlugin) || 'unknown',
      fileCount: graph.nodes.length,
    },
  };
}

/**
 * Accepts requestedFile as absolute, repo-relative, or cwd-relative, and
 * resolves it to the exact repo-relative POSIX id used in graph.nodes.
 */
function resolveRequestedFile(repoRoot, requestedFile, nodes) {
  const candidates = [
    requestedFile,
    path.resolve(repoRoot, requestedFile),
    path.resolve(process.cwd(), requestedFile),
  ];

  for (const candidate of candidates) {
    const absCandidate = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
    const relPosix = toRepoRelativePosixPath(repoRoot, absCandidate);
    if (nodes.some((n) => n.id === relPosix)) return relPosix;
  }

  const directMatch = nodes.find((n) => n.id === requestedFile.split(path.sep).join('/'));
  return directMatch ? directMatch.id : null;
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

function main() {
  const [, , repoRootArg, requestedFileArg, ...rest] = process.argv;

  if (!repoRootArg || !requestedFileArg) {
    console.error('Usage: node analyze.js <repositoryRoot> <requestedFile> [--include-history]');
    process.exitCode = 1;
    return;
  }

  const includeHistory = rest.includes('--include-history');
  const result = analyze(repoRootArg, requestedFileArg, { includeHistory });
  console.log(JSON.stringify(result, null, 2));

  if (result.error) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  findJavaFiles,
  findSourceFiles,
  parseJavaFile,
  parseFile,
  buildGraph,
  computeImpact,
  computeCoChangeScores,
  analyze,
};
