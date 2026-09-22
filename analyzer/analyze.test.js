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
