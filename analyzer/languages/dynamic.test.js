#!/usr/bin/env node
/**
 * Feature 1 — dynamic dependency mapping + broader language support.
 * Covers: TS/JS dynamic import(), require.resolve, computed-specifier fan-out,
 * the Python plugin (static, relative, importlib/__import__), Java reflection.
 *   node languages/dynamic.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { buildGraph, analyze } = require('../analyze');
const { createSuite } = require('../testUtil');

const { test, section } = createSuite('dynamic');
const ROOT = path.resolve(__dirname, '../../tests/fixtures/sample-dynamic');
const graph = buildGraph(ROOT);
const edge = (from, to) => graph.edges.find((e) => e.from === from && e.to === to);

section('TypeScript / JavaScript dynamic imports');
test('static import still produces kind "import"', () => {
  assert.strictEqual(edge('src/app.ts', 'src/greeter.ts').kind, 'import');
});
test("import('./chart') and React.lazy(() => import('./x')) become dynamic-import edges", () => {
  assert.strictEqual(edge('src/app.ts', 'src/chart.ts').kind, 'dynamic-import');
  assert.strictEqual(edge('src/app.ts', 'src/lazyPanel.ts').kind, 'dynamic-import');
});
test('require.resolve is treated as a dynamic reference', () => {
  assert.strictEqual(edge('src/app.ts', 'src/legacy.js').kind, 'dynamic-import');
});
test('import(`./locales/${lang}.js`) fans out to every file under ./locales/', () => {
  assert.ok(edge('src/app.ts', 'src/locales/en.js'));
  assert.ok(edge('src/app.ts', 'src/locales/es.js'));
});
test("require('./plugins/' + x) fans out to every file under ./plugins/", () => {
  assert.ok(edge('src/app.ts', 'src/plugins/auth.js'));
});
test('bare/package dynamic imports never become edges', () => {
  assert.ok(graph.edges.every((e) => !e.to.includes('node_modules')));
});

section('Python plugin');
test('python files become nodes', () => {
  assert.ok(graph.nodes.some((n) => n.id === 'app/main.py'));
});
test('relative and absolute imports resolve', () => {
  assert.strictEqual(edge('app/main.py', 'app/helpers.py').kind, 'import'); // from . import helpers
  assert.strictEqual(edge('app/main.py', 'app/models.py').kind, 'import'); // from .models import User
  assert.strictEqual(edge('app/main.py', 'app/plugins/base.py').kind, 'import'); // from app.plugins import base
});
test("importlib.import_module(f'app.plugins.{name}') fans out to the package", () => {
  assert.strictEqual(edge('app/main.py', 'app/plugins/csv_plugin.py').kind, 'dynamic-import');
});
test('stdlib imports (importlib, os) create no edges', () => {
  const targets = graph.edges.filter((e) => e.from === 'app/main.py').map((e) => e.to);
  assert.ok(targets.every((t) => t.startsWith('app/')));
});
test('analyze() reports meta.language "python" for a .py file', () => {
  const r = analyze(ROOT, 'app/main.py');
  assert.strictEqual(r.meta.language, 'python');
  assert.ok(r.impact.dependsOn.includes('app/helpers.py'));
});

section('Java reflection');
test('Class.forName("pkg.Class") becomes a reflection edge', () => {
  assert.strictEqual(
    edge('src/main/java/com/dyn/Loader.java', 'src/main/java/com/dyn/Driver.java').kind,
    'reflection'
  );
});

section('Backward compatibility');
test('default analyze() output on the Phase 1 fixture is unchanged (no new keys)', () => {
  const r = analyze(path.resolve(__dirname, '../../tests/fixtures/sample-project'),
    'src/main/java/com/example/service/UserService.java');
  assert.strictEqual(r.functionGraph, undefined);
  assert.strictEqual(r.impact.functionImpact, undefined);
  assert.ok(r.graph.nodes.every((n) => n.fileType === undefined));
});
