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
 *
 * No behavior change from Phase 1 — see analyzer/analyze.test.js, which
 * must still pass unmodified.
 *
 * Usage:
 *   node analyze.js <repositoryRoot> <requestedFile>
 *
 * Also usable as a module:
 *   const { analyze } = require('./analyze');
 *   const result = analyze(repoRoot, requestedFile);
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
// Top-level entry point — matches docs/CONTRACT.md response/error shape
// ---------------------------------------------------------------------

/**
 * @param {string} repositoryRoot - path to the repo to analyze
 * @param {string} requestedFile  - path to the target file (absolute, or
 *   relative to repositoryRoot, or relative to cwd)
 * @returns {object} JSON matching docs/CONTRACT.md exactly (success or error)
 */
function analyze(repositoryRoot, requestedFile) {
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
  const [, , repoRootArg, requestedFileArg] = process.argv;

  if (!repoRootArg || !requestedFileArg) {
    console.error('Usage: node analyze.js <repositoryRoot> <requestedFile>');
    process.exitCode = 1;
    return;
  }

  const result = analyze(repoRootArg, requestedFileArg);
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
  analyze,
};
