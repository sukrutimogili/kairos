#!/usr/bin/env node
/**
 * Kairos analyzer — Leela's Stage 2 deliverable.
 *
 * Takes a repository path + a target file and returns JSON matching
 * docs/CONTRACT.md exactly. Built up commit-by-commit to mirror the
 * task breakdown in the workflow doc:
 *   1. repository traversal    (findJavaFiles)
 *   2. Java source parsing     (parseJavaFile)
 *   3. relationship extraction (extractRelationships)
 *   4. dependency graph        (buildGraph)
 *   5. impact analysis         (computeImpact, analyze, CLI)
 *
 * Phase 1 scope: Java only, only relationships between files INSIDE the
 * analyzed repo (external/library imports are parsed but not turned
 * into edges), no git history or runtime data.
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
// 1. Repository traversal
//    feat: add repository traversal
// ---------------------------------------------------------------------

/**
 * Walks a directory and returns every .java file found, as absolute paths.
 * Skips common non-source directories so build output / VCS metadata
 * never gets treated as part of the codebase.
 */
function findJavaFiles(repoRoot) {
  const SKIP_DIRS = new Set([
    'node_modules', 'out', 'dist', 'target', '.git', '.vscode-test',
  ]);

  const results = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.java')) {
        results.push(fullPath);
      }
    }
  }

  walk(repoRoot);
  return results;
}

// ---------------------------------------------------------------------
// 2. Java source parsing
//    feat: parse Java source files
// ---------------------------------------------------------------------

const PACKAGE_RE = /^\s*package\s+([\w.]+)\s*;/m;
const IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
// First public (or package-private) top-level type declaration in the file.
const TYPE_RE = /\b(?:public\s+)?(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/;

/**
 * Parses one Java file into a lightweight structural model:
 *   { package, className, imports, rawSource }
 * This is intentionally not a full AST — Phase 1 only needs package,
 * primary type name, and import list to build the dependency graph.
 */
function parseJavaFile(absPath) {
  const source = fs.readFileSync(absPath, 'utf8');

  const packageMatch = source.match(PACKAGE_RE);
  const pkg = packageMatch ? packageMatch[1] : '';

  const typeMatch = source.match(TYPE_RE);
  const className = typeMatch ? typeMatch[1] : path.basename(absPath, '.java');

  const imports = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    imports.push(m[1]);
  }

  return { package: pkg, className, imports, rawSource: source };
}

// ---------------------------------------------------------------------
// 3. Relationship extraction
//    feat: extract import relationships
// ---------------------------------------------------------------------

function toRepoRelativePosixPath(repoRoot, absPath) {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns parsed imports/usages into (fromFile, toFile, kind) edges.
 * Only relationships between files INSIDE the analyzed repo become
 * edges — external/library imports (java.util.*, org.springframework.*,
 * ...) are Phase 1 out of scope.
 */
function extractRelationships(parsedByRelPath, fqcnIndex, simpleNameIndex) {
  const edgeKeySeen = new Set();
  const edges = [];

  function addEdge(fromRelPath, toRelPath, kind) {
    if (fromRelPath === toRelPath) return; // no self-edges
    const key = `${fromRelPath}=>${toRelPath}`;
    if (edgeKeySeen.has(key)) return;
    edgeKeySeen.add(key);
    edges.push({ from: fromRelPath, to: toRelPath, kind });
  }

  for (const [relPath, parsed] of parsedByRelPath.entries()) {
    // (a) Explicit imports that resolve to another file inside this repo.
    for (const imp of parsed.imports) {
      if (imp.endsWith('.*')) continue; // wildcard package import — ambiguous, skip
      const targetRelPath = fqcnIndex.get(imp);
      if (targetRelPath) {
        addEdge(relPath, targetRelPath, 'import');
      }
    }

    // (b) Same-package usage without an explicit import. Java doesn't
    // require importing classes in your own package.
    for (const [simpleName, candidateRelPaths] of simpleNameIndex.entries()) {
      if (simpleName === parsed.className) continue;
      const usageRe = new RegExp(`\\b${escapeRegExp(simpleName)}\\b`);
      if (!usageRe.test(parsed.rawSource)) continue;

      for (const candidateRelPath of candidateRelPaths) {
        const candidate = parsedByRelPath.get(candidateRelPath);
        if (candidate.package === parsed.package) {
          addEdge(relPath, candidateRelPath, 'same-package-reference');
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------
// 4. Dependency graph
//    feat: build dependency graph
// ---------------------------------------------------------------------

/**
 * Builds the dependency graph for a repository, matching the `graph`
 * shape in docs/CONTRACT.md:
 *   { nodes: [{id, className, package}], edges: [{from, to, kind}] }
 *
 * `id` on every node is the repo-relative, POSIX-style file path —
 * this is also what the extension uses to open the file directly.
 */
function buildGraph(repoRoot) {
  const absFiles = findJavaFiles(repoRoot);

  const parsedByRelPath = new Map();
  const fqcnIndex = new Map(); // "pkg.ClassName" -> relPath
  const simpleNameIndex = new Map(); // "ClassName" -> [relPath, ...]

  for (const absPath of absFiles) {
    const relPath = toRepoRelativePosixPath(repoRoot, absPath);
    const parsed = parseJavaFile(absPath);
    parsedByRelPath.set(relPath, parsed);

    const fqcn = parsed.package ? `${parsed.package}.${parsed.className}` : parsed.className;
    fqcnIndex.set(fqcn, relPath);

    if (!simpleNameIndex.has(parsed.className)) simpleNameIndex.set(parsed.className, []);
    simpleNameIndex.get(parsed.className).push(relPath);
  }

  const nodes = [];
  for (const [relPath, parsed] of parsedByRelPath.entries()) {
    nodes.push({ id: relPath, className: parsed.className, package: parsed.package });
  }
  // Stable, deterministic ordering makes output diffable in tests/CI.
  nodes.sort((a, b) => a.id.localeCompare(b.id));

  const edges = extractRelationships(parsedByRelPath, fqcnIndex, simpleNameIndex);

  return { nodes, edges };
}
