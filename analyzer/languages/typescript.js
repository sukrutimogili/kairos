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
  'coverage', '.next', '.nuxt',
]);

// import Foo from '...'; import { a, b } from "..."; import * as x from '...';
// export ... from '...'; side-effect import '...';
const IMPORT_RE = /\bimport\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /\bexport\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
// require('...') / require("...")
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

// Dynamic imports: import('./x'), import(`./x`), React.lazy(() => import('./x')),
// require.resolve('./x'). Only the first argument is captured.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"`])([^'"`]*?)\1/g;
const DYNAMIC_IMPORT_TEMPLATE_RE = /\bimport\s*\(\s*`([^`]*\$\{[^`]*)`/g;
const REQUIRE_TEMPLATE_RE = /\brequire\(\s*`([^`]*\$\{[^`]*)`/g;
const REQUIRE_RESOLVE_RE = /\brequire\.resolve\(\s*['"]([^'"]+)['"]\s*\)/g;
// require('./a' + name) / import('./a' + name) — static prefix before '+'
const CONCAT_RE = /\b(?:require|import)\(\s*(['"])([^'"]+)\1\s*\+/g;

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

  // Dynamic references (kept separate so static `imports` is unchanged).
  const dynamicImports = [];
  const dynamicPatterns = []; // static prefix of a computed specifier, e.g. './locales/'
  for (const re of [DYNAMIC_IMPORT_RE, REQUIRE_RESOLVE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const spec = m[2] !== undefined ? m[2] : m[1];
      if (spec && !spec.includes('${')) dynamicImports.push(spec);
    }
  }
  for (const re of [DYNAMIC_IMPORT_TEMPLATE_RE, REQUIRE_TEMPLATE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      dynamicPatterns.push(m[1].split('${')[0]);
    }
  }
  CONCAT_RE.lastIndex = 0;
  {
    let m;
    while ((m = CONCAT_RE.exec(source)) !== null) dynamicPatterns.push(m[2]);
  }

  return { package: '', className, imports, dynamicImports, dynamicPatterns, rawSource: source };
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

    // Dynamic imports with a literal specifier: import('./x'), require.resolve('./x').
    // A static import of the same file wins (addEdge dedupes by from=>to).
    for (const specifier of parsed.dynamicImports || []) {
      const target = resolveFromRelPath(relPath, specifier);
      if (target) addEdge(relPath, target, 'dynamic-import');
    }

    // Computed specifiers with a static directory prefix, e.g.
    // import(`./locales/${lang}.js`) -> every file under ./locales/.
    // Over-approximates on purpose: "potentially affected".
    for (const prefix of parsed.dynamicPatterns || []) {
      if (!prefix.startsWith('.')) continue;
      const fromDir = path.posix.dirname(relPath);
      const joined = path.posix.normalize(path.posix.join(fromDir, prefix));
      const dirPrefix = prefix.endsWith('/') ? joined.replace(/\/?$/, '/') : joined;
      for (const known of knownRelPaths) {
        if (known !== relPath && known.startsWith(dirPrefix)) {
          addEdge(relPath, known, 'dynamic-import');
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
