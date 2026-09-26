#!/usr/bin/env node
/**
 * Kairos analyzer — TypeScript / JavaScript language plugin.
 *
 * Implements the same parser interface as analyzer/languages/java.js:
 *   - extensions
 *   - findSourceFiles(root)
 *   - parseFile(absPath)
 *   - extractRelationships(parsedByRelPath)
 *
 * Scope: extracts ES module imports (`import ... from '...'`) and
 * CommonJS requires (`require('...')`), resolves relative specifiers
 * ('./foo', '../bar/baz') to repo-relative file ids. Bare specifiers
 * (package imports like 'react', 'lodash') are parsed but not turned
 * into edges — same "internal only" scope as the Java plugin's
 * external/library imports.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

const SKIP_DIRS = new Set([
  'node_modules', 'out', 'dist', 'target', '.git', '.vscode-test', 'build',
]);

// import Foo from '...'; import { a, b } from "..."; import * as x from '...';
// export ... from '...'; side-effect import '...';
const IMPORT_RE = /\bimport\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /\bexport\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
// require('...') / require("...")
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

// Candidate extensions/resolutions to try when resolving a relative
// specifier like './foo' to an actual file on disk.
const RESOLVE_CANDIDATES = (specPath) => [
  specPath,
  `${specPath}.ts`,
  `${specPath}.tsx`,
  `${specPath}.js`,
  `${specPath}.jsx`,
  path.join(specPath, 'index.ts'),
  path.join(specPath, 'index.tsx'),
  path.join(specPath, 'index.js'),
  path.join(specPath, 'index.jsx'),
];

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
      } else if (entry.isFile() && EXTENSIONS.includes(path.extname(entry.name))) {
        // Skip .d.ts declaration files — no runtime relationships to extract.
        if (entry.name.endsWith('.d.ts')) continue;
        results.push(fullPath);
      }
    }
  }

  walk(repoRoot);
  return results;
}

/**
 * Parses one TS/JS file into a lightweight structural model:
 *   { package, className, imports, rawSource }
 * `package` is always '' (no Java-style package concept here).
 * `className` is the file's base name (without extension), used only
 * for node display — TS/JS relationships are resolved by path, not by
 * symbol name.
 * `imports` is the raw list of specifiers found (e.g. './service',
 * 'react', '../utils/foo').
 */
function parseFile(absPath) {
  const source = fs.readFileSync(absPath, 'utf8');
  const className = path.basename(absPath).replace(/\.(tsx?|jsx?)$/, '');

  const imports = [];
  for (const re of [IMPORT_RE, EXPORT_FROM_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      imports.push(m[1]);
    }
  }

  return { package: '', className, imports, rawSource: source };
}

/**
 * Resolves a relative import specifier (e.g. './userService') from the
 * importing file's directory to a repo-relative POSIX path that matches
 * an id in parsedByRelPath — or null if it doesn't resolve to a known
 * file (external package, or a file kind we don't parse).
 */
function resolveSpecifier(repoRoot, fromRelPath, specifier, knownRelPaths) {
  if (!specifier.startsWith('.')) return null; // bare/package specifier — out of scope

  const fromAbsDir = path.dirname(path.join(repoRoot, fromRelPath));
  const specAbsPath = path.resolve(fromAbsDir, specifier);

  for (const candidate of RESOLVE_CANDIDATES(specAbsPath)) {
    const relPosix = path.relative(repoRoot, candidate).split(path.sep).join('/');
    if (knownRelPaths.has(relPosix)) return relPosix;
  }
  return null;
}

/**
 * Turns parsed TS/JS files into (fromFile, toFile, kind) edges, resolving
 * relative import/require specifiers to repo-relative file ids. Bare
 * specifiers (package imports) are parsed but never become edges.
 *
 * @param {Map<string, object>} parsedByRelPath - repo-relative path -> parseFile() result
 */
function extractRelationships(parsedByRelPath) {
  const knownRelPaths = new Set(parsedByRelPath.keys());
  const edgeKeySeen = new Set();
  const edges = [];

  // repoRoot isn't passed in directly, but every relPath is already
  // relative to it, and resolveSpecifier only needs a consistent base —
  // so we reconstruct a "virtual root" of '.' and resolve relPath-to-relPath.
  function resolveFromRelPath(fromRelPath, specifier) {
    if (!specifier.startsWith('.')) return null;
    const fromDir = path.posix.dirname(fromRelPath);
    const specPath = path.posix.normalize(path.posix.join(fromDir, specifier));

    const candidates = [
      specPath, `${specPath}.ts`, `${specPath}.tsx`, `${specPath}.js`, `${specPath}.jsx`,
      path.posix.join(specPath, 'index.ts'), path.posix.join(specPath, 'index.tsx'),
      path.posix.join(specPath, 'index.js'), path.posix.join(specPath, 'index.jsx'),
    ];
    for (const c of candidates) {
      if (knownRelPaths.has(c)) return c;
    }
    return null;
  }

  function addEdge(fromRelPath, toRelPath, kind) {
    if (fromRelPath === toRelPath) return;
    const key = `${fromRelPath}=>${toRelPath}`;
    if (edgeKeySeen.has(key)) return;
    edgeKeySeen.add(key);
    edges.push({ from: fromRelPath, to: toRelPath, kind });
  }

  for (const [relPath, parsed] of parsedByRelPath.entries()) {
    for (const specifier of parsed.imports) {
      const target = resolveFromRelPath(relPath, specifier);
      if (target) addEdge(relPath, target, 'import');
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
