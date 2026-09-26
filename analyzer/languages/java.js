#!/usr/bin/env node
/**
 * Kairos analyzer — Java language plugin.
 *
 * Implements the parser interface used by the language-dispatch layer in
 * analyze.js:
 *   - extensions            — file extensions this plugin handles
 *   - findSourceFiles(root) — locate all files of this language in a repo
 *   - parseFile(absPath)    — parse one file into a lightweight structural model
 *   - extractRelationships(parsedByRelPath) — turn parsed files into edges
 *
 * This is a lift-and-shift of the Java-specific logic that used to live
 * directly in analyze.js (Phase 1). No behavior change — see
 * analyzer/analyze.test.js, which must still pass unmodified against the
 * existing Java fixtures.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXTENSIONS = ['.java'];

const SKIP_DIRS = new Set([
  'node_modules', 'out', 'dist', 'target', '.git', '.vscode-test',
]);

const PACKAGE_RE = /^\s*package\s+([\w.]+)\s*;/m;
const IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
// First public (or package-private) top-level type declaration in the file.
const TYPE_RE = /\b(?:public\s+)?(?:final\s+|abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/;

/**
 * Walks a directory and returns every .java file found, as absolute paths.
 * Skips common non-source directories so build output / VCS metadata
 * never gets treated as part of the codebase.
 */
function findSourceFiles(repoRoot) {
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

/**
 * Parses one Java file into a lightweight structural model:
 *   { package, className, imports, rawSource }
 * This is intentionally not a full AST — just enough to build the
 * dependency graph.
 */
function parseFile(absPath) {
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

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns parsed Java files into (fromFile, toFile, kind) edges.
 * Only relationships between files INSIDE the analyzed repo become
 * edges — external/library imports (java.util.*, org.springframework.*,
 * ...) are out of scope.
 *
 * @param {Map<string, object>} parsedByRelPath - repo-relative path -> parseFile() result
 */
function extractRelationships(parsedByRelPath) {
  const fqcnIndex = new Map(); // "pkg.ClassName" -> relPath
  const simpleNameIndex = new Map(); // "ClassName" -> [relPath, ...]

  for (const [relPath, parsed] of parsedByRelPath.entries()) {
    const fqcn = parsed.package ? `${parsed.package}.${parsed.className}` : parsed.className;
    fqcnIndex.set(fqcn, relPath);

    if (!simpleNameIndex.has(parsed.className)) simpleNameIndex.set(parsed.className, []);
    simpleNameIndex.get(parsed.className).push(relPath);
  }

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

module.exports = {
  extensions: EXTENSIONS,
  findSourceFiles,
  parseFile,
  extractRelationships,
};
