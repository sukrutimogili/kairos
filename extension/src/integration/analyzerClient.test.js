#!/usr/bin/env node
/**
 * Integration test: runs the REAL analyzer (not the mock) against
 * tests/fixtures/sample-project and asserts the compiled integration layer
 * (out/integration/analyzerClient.js — the exact file getImpactData.ts
 * calls at runtime) returns correctly shaped, correct results.
 *
 * Requires a fresh build: run `npm run compile` (inside extension/) before
 * this test.
 *
 * Run with: node src/integration/analyzerClient.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');

const COMPILED_ENTRY = path.resolve(__dirname, '../../out/integration/analyzerClient.js');

let getImpactData;
try {
  ({ getImpactData } = require(COMPILED_ENTRY));
} catch (err) {
  console.error(`Could not load compiled integration layer at:\n  ${COMPILED_ENTRY}`);
  console.error('Run "npm run compile" inside extension/ first, then re-run this test.');
  console.error(err.message);
  process.exit(1);
}

const FIXTURE_ROOT = path.resolve(__dirname, '../../../tests/fixtures/sample-project');

const CONTROLLER = 'src/main/java/com/example/controller/UserController.java';
const SERVICE = 'src/main/java/com/example/service/UserService.java';
const REPOSITORY = 'src/main/java/com/example/repository/UserRepository.java';

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

console.log('getImpactData() — real analyzer, compiled integration layer');

test('returns correctly shaped result matching docs/CONTRACT.md', () => {
  const result = getImpactData(FIXTURE_ROOT, SERVICE);
  assert.strictEqual(result.schemaVersion, '1.0');
  assert.strictEqual(result.requestedFile, SERVICE);
  assert.ok(Array.isArray(result.graph.nodes));
  assert.ok(Array.isArray(result.graph.edges));
  assert.ok(Array.isArray(result.impact.dependsOn));
  assert.ok(Array.isArray(result.impact.dependents));
  assert.ok(Array.isArray(result.impact.affected));
  assert.strictEqual(result.meta.language, 'java');
});

test('matches the Stage 4 acceptance-test scenario exactly', () => {
  // Select UserService.java, run Show Impact:
  //   UserRepository.java as a dependency, UserController.java as a dependent.
  const result = getImpactData(FIXTURE_ROOT, SERVICE);
  assert.deepStrictEqual(result.impact.dependsOn, [REPOSITORY]);
  assert.deepStrictEqual(result.impact.dependents, [CONTROLLER]);
});

test('returns a FILE_NOT_FOUND error as data, not a thrown exception', () => {
  // analyze() never throws -- and neither extension.ts nor ImpactPanel.ts
  // wraps the call in try/catch; they branch on isImpactError(result)
  // instead. The integration layer must preserve that: errors are data.
  const result = getImpactData(FIXTURE_ROOT, 'src/main/java/com/example/DoesNotExist.java');
  assert.strictEqual(result.schemaVersion, '1.0');
  assert.ok(result.error, 'expected an error field, got none');
  assert.strictEqual(result.error.code, 'FILE_NOT_FOUND');
});

test('result is freshly computed, not a stale mock', () => {
  // fileCount is recomputed from the actual fixture tree, and graph.nodes
  // is deterministically sorted by buildGraph() -- both are properties of
  // the live analyzer, not of a static mock JSON file.
  const result = getImpactData(FIXTURE_ROOT, SERVICE);
  assert.strictEqual(result.meta.fileCount, 3);
  const ids = result.graph.nodes.map((n) => n.id);
  assert.deepStrictEqual(ids, [...ids].sort());
});

// --- Sukruti's Step 5 integration test: includeHistory, TS project + real
// git history, flowing all the way through the *compiled* client the
// extension actually loads at runtime (not analyze.js directly). ---

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');

function makeTempTsGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-client-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@kairos.local');
  git('config', 'user.name', 'Kairos Test');

  const SVC = 'src/userService.ts';
  const REPO = 'src/userRepository.ts';
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, REPO), 'export function findUser() { return null; }\n');
  fs.writeFileSync(
    path.join(dir, SVC),
    "import { findUser } from './userRepository';\nexport function getUser() { return findUser(); }\n"
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'add service and repository');

  // A second commit touching both files together, so they co-change.
  fs.appendFileSync(path.join(dir, REPO), '// note\n');
  fs.appendFileSync(path.join(dir, SVC), '// note\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'touch both files together');

  return { dir, SVC, REPO };
}

test('includeHistory:true flows through the compiled client into a historical entry with a distance', () => {
  const { dir, SVC, REPO } = makeTempTsGitFixture();
  const withoutHistory = getImpactData(dir, SVC, { includeHistory: false });
  assert.strictEqual(
    withoutHistory.impact.affected.some((a) => a.relation === 'historical'),
    false,
    'includeHistory:false (or omitted) must not add historical entries'
  );

  const withHistory = getImpactData(dir, SVC, { includeHistory: true });
  assert.strictEqual(withHistory.meta.language, 'typescript');
  const historical = withHistory.impact.affected.find((a) => a.relation === 'historical');
  assert.ok(historical, 'expected a historical entry when includeHistory is true');
  assert.strictEqual(typeof historical.distance, 'number', 'historical entry must carry a numeric distance (CONTRACT.md)');
  // REPO is already a dependency edge, so co-change history for this tiny
  // fixture surfaces on REPO too -- additive, not a replacement of it.
  const dependencyEntry = withHistory.impact.affected.find((a) => a.id === REPO && a.relation === 'dependency');
  assert.ok(dependencyEntry, 'the existing dependency entry must still be present alongside history');
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', with failures' : ''}.`);
