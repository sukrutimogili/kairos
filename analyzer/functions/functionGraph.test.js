#!/usr/bin/env node
/**
 * Feature 2 — function-level dependency graph.
 *   node functions/functionGraph.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { analyze, analyzeFunction } = require('../analyze');
const { maskSource, shortestCallPath, computeFunctionImpact } = require('./functionGraph');
const { createSuite } = require('../testUtil');

const { test, section } = createSuite('functions');
const FIX = path.resolve(__dirname, '../../tests/fixtures');

const JAVA_ROOT = path.join(FIX, 'sample-app');
const J = 'src/main/java/com/kairos/sample';
const javaRes = analyze(JAVA_ROOT, `${J}/service/OrderService.java`, { includeFunctions: true });
const jid = (file, cls, name) => `${J}/${file}#${cls}.${name}`;
const hasCall = (res, from, to) => res.functionGraph.edges.some((e) => e.from === from && e.to === to && e.kind === 'call');

section('opt-in contract');
test('functionGraph is absent unless includeFunctions is set', () => {
  const r = analyze(JAVA_ROOT, `${J}/service/OrderService.java`);
  assert.strictEqual(r.functionGraph, undefined);
});
test('functionGraph nodes carry id/file/name/className/kind/lines', () => {
  const n = javaRes.functionGraph.nodes.find((x) => x.id === jid('service/OrderService.java', 'OrderService', 'getUserOrders'));
  assert.ok(n);
  assert.strictEqual(n.name, 'getUserOrders');
  assert.strictEqual(n.className, 'OrderService');
  assert.strictEqual(n.kind, 'method');
  assert.ok(n.startLine > 0 && n.endLine >= n.startLine);
});

section('Java');
test('field-typed receiver call resolves (orderRepository.findOrdersByUserId)', () => {
  assert.ok(hasCall(javaRes,
    jid('service/OrderService.java', 'OrderService', 'getUserOrders'),
    jid('repository/OrderRepository.java', 'OrderRepository', 'findOrdersByUserId')));
});
test('static call resolves (Logger.info)', () => {
  assert.ok(hasCall(javaRes,
    jid('service/OrderService.java', 'OrderService', 'getUserOrders'),
    jid('util/Logger.java', 'Logger', 'info')));
});
test('function impact reports direct callers/callees and transitive reach', () => {
  const fi = javaRes.impact.functionImpact.find((f) => f.id === jid('service/OrderService.java', 'OrderService', 'getUserOrders'));
  assert.deepStrictEqual(fi.callers, [jid('controller/OrderController.java', 'OrderController', 'handleGetOrdersRequest')]);
  assert.ok(fi.callees.includes(jid('repository/OrderRepository.java', 'OrderRepository', 'findOrdersByUserId')));
  const transitive = fi.affected.find((a) => a.id === jid('config/DatabaseConfig.java', 'DatabaseConfig', 'connect'));
  assert.ok(transitive && transitive.relation === 'callee' && transitive.distance === 2);
});
test('callers/callees always match a fresh traversal of functionGraph.edges', () => {
  for (const fi of javaRes.impact.functionImpact) {
    const edges = javaRes.functionGraph.edges;
    assert.deepStrictEqual(fi.callees, edges.filter((e) => e.from === fi.id).map((e) => e.to).sort());
    assert.deepStrictEqual(fi.callers, edges.filter((e) => e.to === fi.id).map((e) => e.from).sort());
  }
});

section('TypeScript');
const ts = analyze(path.join(FIX, 'sample-calls'), 'src/userService.ts', { includeFunctions: true });
const tid = (f, n) => `src/${f}#${n}`;
test('finds functions, class methods, constructors and arrow-function fields', () => {
  const ids = ts.functionGraph.nodes.map((n) => n.id);
  for (const want of ['bootstrap', 'UserService.getUser', 'UserService.constructor', 'UserService.save', 'UserService.audit']) {
    assert.ok(ids.includes(tid('userService.ts', want)), `missing ${want}`);
  }
});
test('named import with alias resolves (saveUser as persist)', () => {
  assert.ok(hasCall(ts, tid('userService.ts', 'UserService.save'), tid('repo.ts', 'saveUser')));
});
test('namespace import resolves (logger.info)', () => {
  assert.ok(hasCall(ts, tid('userService.ts', 'UserService.getUser'), tid('logger.ts', 'info')));
});
test('default import resolves (AuditLog -> audit)', () => {
  assert.ok(hasCall(ts, tid('userService.ts', 'UserService.audit'), tid('audit.ts', 'audit')));
});
test('this.method() and typed field receiver (this.cache.lookup) resolve', () => {
  assert.ok(hasCall(ts, tid('userService.ts', 'UserService.getUser'), tid('userService.ts', 'UserService.audit')));
  assert.ok(hasCall(ts, tid('userService.ts', 'UserService.getUser'), tid('cache.ts', 'Cache.lookup')));
});
test('local variable typed by `new` resolves (svc.getUser in bootstrap)', () => {
  assert.ok(hasCall(ts, tid('userService.ts', 'bootstrap'), tid('userService.ts', 'UserService.getUser')));
  assert.ok(hasCall(ts, tid('userService.ts', 'bootstrap'), tid('userService.ts', 'UserService.constructor')));
});
test('mentions inside comments and strings never create edges', () => {
  // db.ts only has a comment mentioning findUser(
  assert.ok(!ts.functionGraph.edges.some((e) => e.from.startsWith('src/db.ts#')));
});

section('Python');
const py = analyze(path.join(FIX, 'sample-calls'), 'py/service.py', { includeFunctions: true });
test('methods, constructors and top-level functions are extracted', () => {
  const ids = py.functionGraph.nodes.map((n) => n.id);
  for (const want of ['py/service.py#main', 'py/service.py#Service.handle', 'py/service.py#Service.__init__', 'py/repo.py#Repo.fetch']) {
    assert.ok(ids.includes(want), `missing ${want}`);
  }
});
test('self.method(), annotated attribute (self.repo.fetch), module call (utils.log), from-import call resolve', () => {
  assert.ok(hasCall(py, 'py/service.py#Service.handle', 'py/service.py#Service._format'));
  assert.ok(hasCall(py, 'py/service.py#Service.handle', 'py/repo.py#Repo.fetch'));
  assert.ok(hasCall(py, 'py/service.py#Service.handle', 'py/utils.py#log'));
  assert.ok(hasCall(py, 'py/service.py#Service._format', 'py/repo.py#helper_fn'));
});
test('Service(Repo()) links to both __init__ constructors', () => {
  assert.ok(hasCall(py, 'py/service.py#main', 'py/service.py#Service.__init__'));
  assert.ok(hasCall(py, 'py/service.py#main', 'py/repo.py#Repo.__init__'));
});

section('Helpers');
test('maskSource blanks comments/strings but preserves length and newlines', () => {
  const src = 'a("x(1)"); // foo(2)\nb();';
  const masked = maskSource(src, 'typescript');
  assert.strictEqual(masked.length, src.length);
  assert.ok(!masked.includes('foo'));
  assert.ok(!masked.includes('x(1)'));
  assert.ok(masked.includes('b()'));
});
test('shortestCallPath finds the controller -> repository chain (bug localization)', () => {
  const p = shortestCallPath(javaRes.functionGraph,
    jid('controller/OrderController.java', 'OrderController', 'handleGetOrdersRequest'),
    jid('repository/OrderRepository.java', 'OrderRepository', 'findOrdersByUserId'));
  assert.strictEqual(p.length, 3);
  assert.deepStrictEqual(shortestCallPath(javaRes.functionGraph, jid('util/Logger.java', 'Logger', 'info'), jid('controller/OrderController.java', 'OrderController', 'handleGetOrdersRequest')), []);
});
test('analyzeFunction() finds a function by bare name and returns paths with pathTo', () => {
  const r = analyzeFunction(JAVA_ROOT, 'handleGetOrdersRequest', { pathTo: 'findOrdersByUserId' });
  assert.strictEqual(r.matches.length, 1);
  assert.strictEqual(r.matches[0].paths[0].path.length, 3);
});
test('analyzeFunction() returns an error for an unknown function', () => {
  assert.ok(analyzeFunction(JAVA_ROOT, 'doesNotExist').error);
});
test('computeFunctionImpact on an unknown id returns empty lists, never throws', () => {
  const r = computeFunctionImpact(javaRes.functionGraph, 'nope#x');
  assert.deepStrictEqual(r.callers, []);
  assert.deepStrictEqual(r.callees, []);
});
