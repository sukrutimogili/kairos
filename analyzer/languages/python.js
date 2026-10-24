#!/usr/bin/env node
/**
 * Kairos analyzer — Python language plugin.
 *
 * Same plugin interface as java.js / typescript.js:
 *   extensions, findSourceFiles(root), parseFile(absPath),
 *   extractRelationships(parsedByRelPath)
 *
 * Edge kinds produced:
 *   import          — `import a.b`, `from a.b import c`, relative `from . import x`
 *   dynamic-import  — importlib.import_module('a.b'), __import__('a.b'),
 *                     import_module(f'pkg.{name}') (static-prefix fan-out)
 *
 * Third-party / stdlib modules never resolve to a repo file, so they never
 * become edges (same "internal only" scope as the other plugins).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXTENSIONS = ['.py'];

const SKIP_DIRS = new Set([
  'node_modules', 'out', 'dist', 'target', '.git', '.vscode-test', 'build',
  '__pycache__', 'venv', '.venv', 'env', 'site-packages', '.tox', '.mypy_cache',
]);

// import a.b.c [as x], d.e   (comma separated)
const IMPORT_RE = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm;
// from a.b import c, d   |   from . import x   |   from ..pkg import (a, b)
const FROM_RE = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm;
// importlib.import_module('x.y') / import_module("x") / __import__('x')
const DYN_LITERAL_RE = /\b(?:importlib\.import_module|import_module|__import__)\(\s*['"]([\w.]+)['"]/g;
// f-string or concatenation: import_module(f'plugins.{name}') / import_module('plugins.' + name)
const DYN_FSTRING_RE = /\b(?:importlib\.import_module|import_module|__import__)\(\s*f['"]([\w.]*)\{/g;
const DYN_CONCAT_RE = /\b(?:importlib\.import_module|import_module|__import__)\(\s*['"]([\w.]+)['"]\s*\+/g;

function findSourceFiles(repoRoot) {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        results.push(fullPath);
      }
    }
  }
  walk(repoRoot);
  return results;
}

function parseFile(absPath) {
  const source = fs.readFileSync(absPath, 'utf8');
  const className = path.basename(absPath, '.py');

  // imports: [{ module: 'a.b', level: 0, names: ['c'] }]
  const imports = [];

  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    for (const part of m[1].split(',')) {
      const mod = part.trim().split(/\s+as\s+/)[0].trim();
      if (mod) imports.push({ module: mod, level: 0, names: [] });
    }
  }

  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(source)) !== null) {
    const raw = m[1];
    const level = raw.length - raw.replace(/^\.+/, '').length;
    const module = raw.replace(/^\.+/, '');
    const names = m[2]
      .replace(/[()]/g, '')
      .split(',')
      .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
      .filter((n) => n && n !== '*');
    imports.push({ module, level, names });
  }

  const dynamicImports = [];
  const dynamicPatterns = [];
  DYN_LITERAL_RE.lastIndex = 0;
  while ((m = DYN_LITERAL_RE.exec(source)) !== null) dynamicImports.push(m[1]);
  DYN_FSTRING_RE.lastIndex = 0;
  while ((m = DYN_FSTRING_RE.exec(source)) !== null) dynamicPatterns.push(m[1]);
  DYN_CONCAT_RE.lastIndex = 0;
  while ((m = DYN_CONCAT_RE.exec(source)) !== null) dynamicPatterns.push(m[1]);

  return { package: '', className, imports, dynamicImports, dynamicPatterns, rawSource: source };
}

/**
 * Maps a dotted module name to candidate repo-relative file paths:
 *   a.b.c -> a/b/c.py, a/b/c/__init__.py
 * Tried relative to `baseDir` ('' = repo root, and also each ancestor of the
 * importing file so `src/` layouts resolve).
 */
function moduleCandidates(baseDir, dotted) {
  const rel = dotted ? dotted.split('.').join('/') : '';
  const join = (...p) => path.posix.normalize(path.posix.join(...p.filter((x) => x !== '')));
  if (!rel) return [join(baseDir, '__init__.py')];
  return [join(baseDir, `${rel}.py`), join(baseDir, rel, '__init__.py')];
}

function resolveModule(fromRelPath, imp, knownRelPaths, moduleName = imp.module) {
  const fromDir = path.posix.dirname(fromRelPath);

  if (imp.level > 0) {
    // relative: one dot = current package dir, each extra dot = one level up
    let base = fromDir === '.' ? '' : fromDir;
    for (let i = 1; i < imp.level; i++) base = path.posix.dirname(base) === '.' ? '' : path.posix.dirname(base);
    for (const c of moduleCandidates(base, moduleName)) if (knownRelPaths.has(c)) return c;
    return null;
  }

  // absolute: try repo root, then each ancestor dir of the importing file
  // (handles src/ layouts and sibling-script imports).
  const bases = [''];
  let dir = fromDir === '.' ? '' : fromDir;
  while (dir && dir !== '.') {
    bases.push(dir);
    dir = path.posix.dirname(dir);
  }
  for (const base of bases) {
    for (const c of moduleCandidates(base, moduleName)) if (knownRelPaths.has(c)) return c;
  }
  return null;
}

function extractRelationships(parsedByRelPath) {
  const known = new Set(parsedByRelPath.keys());
  const seen = new Set();
  const edges = [];

  function addEdge(from, to, kind) {
    if (from === to) return;
    const key = `${from}=>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  }

  for (const [relPath, parsed] of parsedByRelPath.entries()) {
    for (const imp of parsed.imports) {
      // `import a.b.c` — the module itself.
      // `from a.b import c` — module a.b, and also a/b/c.py if `c` is a submodule.
      const target = resolveModule(relPath, imp, known);
      if (target) addEdge(relPath, target, 'import');
      for (const name of imp.names) {
        const sub = resolveModule(relPath, imp, known, imp.module ? `${imp.module}.${name}` : name);
        if (sub) addEdge(relPath, sub, 'import');
      }
    }

    for (const mod of parsed.dynamicImports || []) {
      const target = resolveModule(relPath, { module: mod, level: 0, names: [] }, known);
      if (target) addEdge(relPath, target, 'dynamic-import');
    }

    // import_module(f'plugins.{name}') -> every module under plugins/
    for (const prefix of parsed.dynamicPatterns || []) {
      const pkgPath = prefix.replace(/\.$/, '').split('.').filter(Boolean).join('/');
      if (!pkgPath) continue;
      for (const k of known) {
        if (k === relPath) continue;
        if (k.startsWith(`${pkgPath}/`) || k.includes(`/${pkgPath}/`)) addEdge(relPath, k, 'dynamic-import');
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
  resolveModule,
};
