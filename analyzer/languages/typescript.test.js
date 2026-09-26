#!/usr/bin/env node
/**
 * Unit tests for the TypeScript/JavaScript language plugin
 * (languages/typescript.js), against a small synthetic TS fixture.
 *
 * No test framework dependency — plain Node `assert`, run with:
 *   node languages/typescript.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extensions,
  findSourceFiles,
  parseFile,
  extractRelationships,
} = require('./typescript');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-ts-fixture-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function toRepoRelativePosixPath(repoRoot, absPath) {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

// A tiny TS "project": an entry point that imports a service via ES import,
// a service that pulls in a util via require(), and a util with no
// internal edges. Also includes an external/bare-specifier import and a
// .d.ts file, both of which should be excluded from real edges/files.
const FIXTURE = {
  'src/index.ts': `
    import { UserService } from './userService';
    import * as fs from 'fs';
    const svc = new UserService();
  `,
  'src/userService.ts': `
    const { formatUser } = require('./utils/format');
    export class UserService {}
  `,
  'src/utils/format.js': `
    module.exports = { formatUser: (u) => u };
  `,
  'src/types.d.ts': `
    export interface Unused {}
  `,
};

console.log('extensions');

test('exports the expected TS/JS extensions', () => {
  assert.deepStrictEqual(extensions, ['.ts', '.tsx', '.js', '.jsx']);
});

console.log('\nfindSourceFiles()');

test('finds .ts and .js files, skipping .d.ts declaration files', () => {
  const dir = makeFixture(FIXTURE);
  const found = findSourceFiles(dir).map((p) => toRepoRelativePosixPath(dir, p)).sort();
  assert.deepStrictEqual(found, [
    'src/index.ts',
    'src/userService.ts',
    'src/utils/format.js',
  ]);
});

test('skips node_modules/out/dist/target/.git directories', () => {
  const dir = makeFixture({
    ...FIXTURE,
    'node_modules/some-pkg/index.js': 'module.exports = {};',
  });
  const found = findSourceFiles(dir).map((p) => toRepoRelativePosixPath(dir, p));
  assert.ok(!found.includes('node_modules/some-pkg/index.js'));
});

console.log('\nparseFile()');

test('extracts ES import and require() specifiers, ignores bare specifiers separately', () => {
  const dir = makeFixture(FIXTURE);
  const parsed = parseFile(path.join(dir, 'src/index.ts'));
  assert.strictEqual(parsed.package, '');
  assert.strictEqual(parsed.className, 'index');
  assert.ok(parsed.imports.includes('./userService'));
  assert.ok(parsed.imports.includes('fs')); // parsed, but not internal
});

test('extracts require() specifiers from CommonJS-style files', () => {
  const dir = makeFixture(FIXTURE);
  const parsed = parseFile(path.join(dir, 'src/userService.ts'));
  assert.ok(parsed.imports.includes('./utils/format'));
});

console.log('\nextractRelationships()');

function buildParsedByRelPath(dir) {
  const files = findSourceFiles(dir);
  const parsedByRelPath = new Map();
  for (const absPath of files) {
    const relPath = toRepoRelativePosixPath(dir, absPath);
    parsedByRelPath.set(relPath, parseFile(absPath));
  }
  return parsedByRelPath;
}

test('resolves relative import specifiers to repo-relative file edges', () => {
  const dir = makeFixture(FIXTURE);
  const parsedByRelPath = buildParsedByRelPath(dir);
  const edges = extractRelationships(parsedByRelPath);
  assert.deepStrictEqual(
    edges.find((e) => e.from === 'src/index.ts'),
    { from: 'src/index.ts', to: 'src/userService.ts', kind: 'import' }
  );
});

test('resolves require() specifiers the same way as import specifiers', () => {
  const dir = makeFixture(FIXTURE);
  const parsedByRelPath = buildParsedByRelPath(dir);
  const edges = extractRelationships(parsedByRelPath);
  assert.deepStrictEqual(
    edges.find((e) => e.from === 'src/userService.ts'),
    { from: 'src/userService.ts', to: 'src/utils/format.js', kind: 'import' }
  );
});

test('never creates an edge for a bare/package specifier', () => {
  const dir = makeFixture(FIXTURE);
  const parsedByRelPath = buildParsedByRelPath(dir);
  const edges = extractRelationships(parsedByRelPath);
  assert.ok(!edges.some((e) => e.to === 'fs'));
});

test('resolves extensionless specifiers against .ts/.tsx/.js/.jsx and index files', () => {
  const dir = makeFixture({
    'a.ts': `import './lib';`,
    'lib/index.ts': `export const x = 1;`,
  });
  const parsedByRelPath = buildParsedByRelPath(dir);
  const edges = extractRelationships(parsedByRelPath);
  assert.deepStrictEqual(edges, [{ from: 'a.ts', to: 'lib/index.ts', kind: 'import' }]);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', with failures' : ''}.`);
