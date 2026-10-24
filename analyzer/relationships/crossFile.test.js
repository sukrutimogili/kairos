#!/usr/bin/env node
/**
 * Feature 3 — cross-file and non-code relationship mapping.
 *   node relationships/crossFile.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { analyze, buildGraph } = require('../analyze');
const { createSuite } = require('../testUtil');

const { test, section } = createSuite('crossfile');
const ROOT = path.resolve(__dirname, '../../tests/fixtures/sample-web');
const res = analyze(ROOT, 'public/index.html', { includeCrossFile: true, includeFunctions: true });
const edge = (from, to) => res.graph.edges.find((e) => e.from === from && e.to === to);
const kindOf = (from, to) => (edge(from, to) || {}).kind;

section('opt-in contract');
test('non-code files are not in the graph unless includeCrossFile is set', () => {
  const g = buildGraph(ROOT);
  assert.ok(g.nodes.every((n) => /\.(js|java|py)$/.test(n.id)));
});
test('an .html request is UNSUPPORTED_LANGUAGE without includeCrossFile, and works with it', () => {
  assert.strictEqual(analyze(ROOT, 'public/index.html').error.code, 'UNSUPPORTED_LANGUAGE');
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.meta.language, 'html');
});
test('non-code nodes carry fileType', () => {
  const byId = Object.fromEntries(res.graph.nodes.map((n) => [n.id, n]));
  assert.strictEqual(byId['public/index.html'].fileType, 'html');
  assert.strictEqual(byId['public/styles.css'].fileType, 'style');
  assert.strictEqual(byId['config/settings.json'].fileType, 'config');
  assert.strictEqual(byId['templates/home.html'].fileType, 'template');
});

section('HTML <-> JS');
test('<script src> links html -> js', () => {
  assert.strictEqual(kindOf('public/index.html', 'static/js/app.js'), 'html-script');
});
test('<link rel=stylesheet> links html -> css, and @import links css -> css', () => {
  assert.strictEqual(kindOf('public/index.html', 'public/styles.css'), 'html-style');
  assert.strictEqual(kindOf('public/styles.css', 'public/theme.css'), 'style-import');
});
test('getElementById / querySelector link js -> the html that defines the id/class', () => {
  const e = edge('static/js/app.js', 'public/index.html');
  assert.strictEqual(e.kind, 'dom-reference');
  assert.ok(e.detail.includes('#submitBtn'));
  assert.ok(e.detail.includes('.container'));
});
test('inline onclick="submitForm()" links html -> the js file defining submitForm', () => {
  assert.ok(edge('public/index.html', 'static/js/app.js').detail.includes('submitForm()'));
});
test('<a href="about.html"> links html -> html', () => {
  assert.strictEqual(kindOf('public/index.html', 'public/about.html'), 'html-link');
});

section('Templates');
test('{% extends %} / {% include %} link template -> template', () => {
  assert.strictEqual(kindOf('templates/home.html', 'templates/base.html'), 'template-include');
  assert.strictEqual(kindOf('templates/home.html', 'templates/partials/nav.html'), 'template-include');
});
test("url_for('profile') links the template to the python view function's file", () => {
  assert.strictEqual(kindOf('templates/home.html', 'views.py'), 'template-call');
});
test("url_for('static', filename=...) resolves the script even with nested quotes", () => {
  assert.strictEqual(kindOf('templates/home.html', 'static/js/app.js'), 'html-script');
});
test("render_template('home.html') and res.render('home') link code -> template", () => {
  assert.strictEqual(kindOf('views.py', 'templates/home.html'), 'template-render');
  assert.strictEqual(kindOf('src/server.js', 'templates/home.html'), 'template-render');
});

section('Configuration');
test('process.env.API_URL links code -> .env', () => {
  assert.strictEqual(kindOf('src/server.js', '.env'), 'config-reference');
  assert.strictEqual(kindOf('static/js/app.js', '.env'), 'config-reference');
});
test('os.environ.get("DB_URL") links python -> .env', () => {
  assert.strictEqual(kindOf('views.py', '.env'), 'config-reference');
});
test('@Value("${server.port}") links java -> every config file defining that key', () => {
  assert.strictEqual(kindOf('src/main/java/com/web/Handler.java', 'src/main/resources/application.yml'), 'config-reference');
  assert.strictEqual(kindOf('src/main/java/com/web/Handler.java', 'config/settings.json'), 'config-reference');
});
test("require('../../config/settings.json') links code -> that config file", () => {
  assert.ok(edge('static/js/app.js', 'config/settings.json'));
});
test('package.json main/scripts link config -> entry-point code', () => {
  const e = edge('package.json', 'src/server.js');
  assert.strictEqual(e.kind, 'config-binding');
  assert.ok(e.detail.includes('main'));
  assert.ok(e.detail.includes('scripts.start'));
});
test('config naming a fully-qualified Java class or package links config -> code', () => {
  assert.strictEqual(kindOf('src/main/resources/application.yml', 'src/main/java/com/web/Handler.java'), 'config-binding');
  assert.strictEqual(kindOf('src/main/resources/application.yml', 'src/main/java/com/web/service/Svc.java'), 'config-binding');
});
test('yaml entry-point value links config -> code', () => {
  assert.strictEqual(kindOf('config/app.yml', 'src/server.js'), 'config-binding');
});

section('Impact + function-level integration');
test('impact reaches through non-code nodes (index.html -> app.js -> settings.json)', () => {
  const byId = Object.fromEntries(res.impact.affected.map((a) => [a.id, a]));
  assert.strictEqual(byId['static/js/app.js'].distance, 1);
  assert.ok(byId['config/settings.json'].distance <= 2);
});
test('dependsOn/dependents still match a fresh traversal with non-code nodes present', () => {
  const edges = res.graph.edges;
  assert.deepStrictEqual(res.impact.dependsOn, edges.filter((e) => e.from === 'public/index.html').map((e) => e.to).sort());
  assert.deepStrictEqual(res.impact.dependents, edges.filter((e) => e.to === 'public/index.html').map((e) => e.from).sort());
});
test('template handlers appear in the function graph as template-call edges', () => {
  const e = res.functionGraph.edges.find((x) => x.kind === 'template-call' && x.from === 'public/index.html#<template>');
  assert.ok(e);
  assert.strictEqual(e.to, 'static/js/app.js#submitForm');
});
test('no edge points at a node that does not exist', () => {
  const ids = new Set(res.graph.nodes.map((n) => n.id));
  for (const e of res.graph.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from} -> ${e.to}`);
});
