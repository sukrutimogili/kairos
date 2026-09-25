#!/usr/bin/env node
/**
 * Unit tests for the analyzer, run against
 * tests/fixtures/sample-project/ (UserController -> UserService -> UserRepository).
 *
 * No test framework dependency — plain Node `assert`, run with:
 *   node analyze.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { buildGraph, computeImpact, analyze } = require('./analyze');

const FIXTURE_ROOT = path.resolve(__dirname, '../tests/fixtures/sample-project');

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

console.log('buildGraph()');
test('finds all 3 files in the sample project', () => {
  const graph = buildGraph(FIXTURE_ROOT);
  assert.strictEqual(graph.nodes.length, 3);
  const ids = graph.nodes.map((n) => n.id).sort();
  assert.deepStrictEqual(ids, [CONTROLLER, REPOSITORY, SERVICE].sort());
});

test('assigns correct className/package per node', () => {
  const graph = buildGraph(FIXTURE_ROOT);
  const service = graph.nodes.find((n) => n.id === SERVICE);
  assert.strictEqual(service.className, 'UserService');
  assert.strictEqual(service.package, 'com.example.service');
});

test('extracts exactly the two internal import edges', () => {
  const graph = buildGraph(FIXTURE_ROOT);
  const edgePairs = graph.edges.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepStrictEqual(edgePairs, [
    `${CONTROLLER}->${SERVICE}`,
    `${SERVICE}->${REPOSITORY}`,
  ].sort());
});

console.log('computeImpact()');
test('UserService dependsOn UserRepository', () => {
  const graph = buildGraph(FIXTURE_ROOT);
  const impact = computeImpact(graph, SERVICE);
  assert.deepStrictEqual(impact.dependsOn, [REPOSITORY]);
});

test('UserService has UserController as a dependent', () => {
  const graph = buildGraph(FIXTURE_ROOT);
  const impact = computeImpact(graph, SERVICE);
  assert.deepStrictEqual(impact.dependents, [CONTROLLER]);
});

test('dependsOn/dependents always match a fresh graph traversal (CONTRACT.md design rule)', () => {
  const graph = buildGraph(FIXTURE_ROOT);
  for (const node of graph.nodes) {
    const impact = computeImpact(graph, node.id);
    const freshDependsOn = graph.edges.filter((e) => e.from === node.id).map((e) => e.to).sort();
    const freshDependents = graph.edges.filter((e) => e.to === node.id).map((e) => e.from).sort();
    assert.deepStrictEqual([...impact.dependsOn].sort(), freshDependsOn);
    assert.deepStrictEqual([...impact.dependents].sort(), freshDependents);
  }
});

test('UserRepository affected list includes both UserService (distance 1) and UserController (distance 2)', () => {
  const graph = buildGraph(FIXTURE_ROOT);
  const impact = computeImpact(graph, REPOSITORY);
  const byId = Object.fromEntries(impact.affected.map((a) => [a.id, a]));
  assert.strictEqual(byId[SERVICE].relation, 'dependent');
  assert.strictEqual(byId[SERVICE].distance, 1);
  assert.strictEqual(byId[CONTROLLER].relation, 'dependent');
  assert.strictEqual(byId[CONTROLLER].distance, 2);
});

console.log('analyze() — full CONTRACT.md response shape');
test('matches the exact response shape for UserService', () => {
  const result = analyze(FIXTURE_ROOT, SERVICE);
  assert.strictEqual(result.schemaVersion, '1.0');
  assert.strictEqual(result.requestedFile, SERVICE);
  assert.strictEqual(result.meta.language, 'java');
  assert.strictEqual(result.meta.fileCount, 3);
  assert.deepStrictEqual(result.impact.dependsOn, [REPOSITORY]);
  assert.deepStrictEqual(result.impact.dependents, [CONTROLLER]);
  assert.ok(Array.isArray(result.graph.nodes));
  assert.ok(Array.isArray(result.graph.edges));
});

test('accepts requestedFile as an absolute path too', () => {
  const abs = path.join(FIXTURE_ROOT, SERVICE);
  const result = analyze(FIXTURE_ROOT, abs);
  assert.strictEqual(result.requestedFile, SERVICE);
});

test('returns FILE_NOT_FOUND error for an unknown file', () => {
  const result = analyze(FIXTURE_ROOT, 'src/main/java/com/example/DoesNotExist.java');
  assert.strictEqual(result.error.code, 'FILE_NOT_FOUND');
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', with failures' : ''}.`);

// ---------------------------------------------------------------------
// computeCoChangeScores() / includeHistory — Step 4
// ---------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { buildGraph: buildGraphForHistory } = require('./analyze');

function makeTempGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-cochange-fixture-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'kairos-test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Kairos Test'], { cwd: dir });

  const pkgDir = path.join(dir, 'src/main/java/com/example/service');
  fs.mkdirSync(pkgDir, { recursive: true });
  const repoDir = path.join(dir, 'src/main/java/com/example/repository');
  fs.mkdirSync(repoDir, { recursive: true });
  const ctrlDir = path.join(dir, 'src/main/java/com/example/controller');
  fs.mkdirSync(ctrlDir, { recursive: true });

  const SVC = 'src/main/java/com/example/service/UserService.java';
  const REPO = 'src/main/java/com/example/repository/UserRepository.java';
  const CTRL = 'src/main/java/com/example/controller/UserController.java';

  fs.writeFileSync(path.join(dir, REPO), `package com.example.repository;\npublic class UserRepository {}\n`);
  fs.writeFileSync(path.join(dir, SVC), `package com.example.service;\nimport com.example.repository.UserRepository;\npublic class UserService {}\n`);
  fs.writeFileSync(path.join(dir, CTRL), `package com.example.controller;\nimport com.example.service.UserService;\npublic class UserController {}\n`);

  execFileSync('git', ['add', REPO], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'add repository'], { cwd: dir });

  // SVC and CTRL changed together twice — SVC's strongest co-change partner.
  execFileSync('git', ['add', SVC, CTRL], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'add service and controller together'], { cwd: dir });

  fs.appendFileSync(path.join(dir, SVC), `// tweak\n`);
  fs.appendFileSync(path.join(dir, CTRL), `// tweak\n`);
  execFileSync('git', ['add', SVC, CTRL], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'tweak both again'], { cwd: dir });

  // REPO changed alone — should never show up as historical for SVC.
  fs.appendFileSync(path.join(dir, REPO), `// solo tweak\n`);
  execFileSync('git', ['add', REPO], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'solo repository tweak'], { cwd: dir });

  return { dir, SVC, REPO, CTRL };
}

console.log('computeCoChangeScores() / includeHistory');

test('finds the file that co-changed most often, sorted by count desc', () => {
  const { dir, SVC, CTRL } = makeTempGitFixture();
  const { computeCoChangeScores } = require('./analyze');
  const graph = buildGraphForHistory(dir);
  const scores = computeCoChangeScores(dir, SVC, graph);
  assert.strictEqual(scores.length, 1);
  assert.strictEqual(scores[0].id, CTRL);
  assert.strictEqual(scores[0].relation, 'historical');
  assert.strictEqual(scores[0].count, 2);
});

test('excludes files that changed alone, and never includes the file itself', () => {
  const { dir, REPO } = makeTempGitFixture();
  const { computeCoChangeScores } = require('./analyze');
  const graph = buildGraphForHistory(dir);
  const scores = computeCoChangeScores(dir, REPO, graph);
  assert.deepStrictEqual(scores, []);
});

test('returns [] when the directory has no git history at all', () => {
  const { computeCoChangeScores } = require('./analyze');
  const graph = buildGraph(FIXTURE_ROOT); // real fixture has no .git
  const scores = computeCoChangeScores(FIXTURE_ROOT, SERVICE, graph);
  assert.deepStrictEqual(scores, []);
});

test('analyze() with includeHistory:false (default) never adds historical entries', () => {
  const { dir, SVC } = makeTempGitFixture();
  const result = analyze(dir, SVC);
  const relations = result.impact.affected.map((a) => a.relation);
  assert.ok(!relations.includes('historical'));
});

test('analyze() with includeHistory:true adds historical entries additively, not replacing dependency/dependent', () => {
  const { dir, SVC, REPO, CTRL } = makeTempGitFixture();
  const result = analyze(dir, SVC, { includeHistory: true });
  const dependencyEntry = result.impact.affected.find((a) => a.id === REPO && a.relation === 'dependency');
  const dependentEntry = result.impact.affected.find((a) => a.id === CTRL && a.relation === 'dependent');
  assert.ok(dependencyEntry, 'expected a dependency entry for REPO to still be present');
  assert.ok(dependentEntry, 'expected a dependent entry for CTRL to still be present');
  const historicalEntries = result.impact.affected.filter((a) => a.relation === 'historical');
  assert.strictEqual(historicalEntries.length, 1);
  assert.strictEqual(historicalEntries[0].id, CTRL);
  assert.strictEqual(historicalEntries[0].count, 2);
});

test('maxCommits option passes through analyze() to co-change scoring', () => {
  const { dir, SVC, CTRL } = makeTempGitFixture();
  // With maxCommits: 1, only the most recent commit ("solo repository
  // tweak") is walked — it never touches SVC, so no historical entries.
  const result = analyze(dir, SVC, { includeHistory: true, maxCommits: 1 });
  const historicalEntries = result.impact.affected.filter((a) => a.relation === 'historical');
  assert.deepStrictEqual(historicalEntries, []);
});
