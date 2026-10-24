#!/usr/bin/env node
/**
 * Readable terminal report for the Kairos analyzer.
 *
 * Usage (from anywhere):
 *   node analyzer/report.js <repoRoot> <targetFile> [--include-history] [--functions] [--cross-file]
 */
'use strict';

const { analyze } = require('./analyze');

const [, , repoRoot, target, ...flags] = process.argv;
if (!repoRoot || !target) {
  console.error('Usage: node analyzer/report.js <repoRoot> <targetFile> [--include-history] [--functions] [--cross-file]');
  process.exit(1);
}

const r = analyze(repoRoot, target, {
  includeHistory: flags.includes('--include-history'),
  includeFunctions: flags.includes('--functions'),
  includeCrossFile: flags.includes('--cross-file'),
});

if (r.error) {
  console.error(`\nError (${r.error.code}): ${r.error.message}\n`);
  process.exit(1);
}

const line = '-'.repeat(64);
const fn = (id) => { const [f, n] = id.split('#'); return `${n}  (${f})`; };
const list = (items, fmt = (x) => x, empty = '(none)') =>
  items.length ? items.map((x) => `    ${fmt(x)}`).join('\n') : `    ${empty}`;

const { impact, graph, meta } = r;
console.log(`\n${line}\n KAIROS IMPACT REPORT\n${line}`);
console.log(` File     : ${r.requestedFile}`);
console.log(` Project  : ${graph.nodes.length} files, ${graph.edges.length} relationships (${meta.language})`);
console.log(` Summary  : depends on ${impact.dependsOn.length}, used by ${impact.dependents.length}, ` +
  `${impact.affected.filter((a) => a.relation !== 'historical').length} affected in total`);

console.log(`\n DEPENDS ON  (${impact.dependsOn.length})  - things this file needs`);
console.log(list(impact.dependsOn));

console.log(`\n USED BY  (${impact.dependents.length})  - files that break if you change this one`);
console.log(list(impact.dependents));

const indirect = impact.affected.filter((a) => a.relation === 'dependent' && a.distance > 1);
console.log(`\n INDIRECTLY AFFECTED  (${indirect.length})  - further away, by distance`);
console.log(list(indirect.sort((a, b) => a.distance - b.distance), (a) => `[distance ${a.distance}]  ${a.id}`));

if (flags.includes('--include-history')) {
  const hist = impact.affected.filter((a) => a.relation === 'historical' && a.count >= 2).sort((a, b) => b.count - a.count);
  console.log(`\n CHANGES TOGETHER IN GIT  (${hist.length})  - no import link, but edited together in 2+ commits`);
  console.log(list(hist, (h) => `${String(h.count).padStart(3)} commits together  ${h.id}`));
}

if (flags.includes('--functions') && impact.functionImpact) {
  const mine = impact.functionImpact.filter((f) => f.id.startsWith(`${r.requestedFile}#`));
  console.log(`\n FUNCTIONS IN THIS FILE  (${mine.length})`);
  for (const f of mine) {
    console.log(`\n   ${fn(f.id).split('  (')[0]}()`);
    console.log(`     called by : ${f.callers.length ? f.callers.map((c) => fn(c).split('  (')[0]).join(', ') : '(none)'}`);
    console.log(`     calls     : ${f.callees.length ? f.callees.map((c) => fn(c).split('  (')[0]).join(', ') : '(none)'}`);
    console.log(`     reaches   : ${f.affected.length} functions in total`);
  }
}
console.log(`\n${line}\n`);
