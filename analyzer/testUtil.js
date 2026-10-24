'use strict';
/**
 * Tiny shared test harness (no dependencies) used by the Phase 3 test files.
 * Same style as analyze.test.js: plain Node `assert`, and when
 * KAIROS_JUNIT_OUT is set, a JUnit XML report is written too — one file per
 * suite (analyzer-junit.xml -> analyzer-junit-<suite>.xml) so Jenkins picks
 * up every suite without them overwriting each other.
 */
const fs = require('fs');
const path = require('path');

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function createSuite(suiteName) {
  const results = [];
  let passed = 0;

  function test(name, fn) {
    const start = Date.now();
    try {
      fn();
      passed += 1;
      results.push({ name, status: 'pass', time: (Date.now() - start) / 1000 });
      console.log(`  ok - ${name}`);
    } catch (err) {
      results.push({ name, status: 'fail', time: (Date.now() - start) / 1000, message: err.message });
      console.error(`  FAIL - ${name}\n    ${err.message}`);
      process.exitCode = 1;
    }
  }

  process.on('exit', () => {
    console.log(`\n${suiteName}: ${passed} test(s) passed${process.exitCode ? ', with failures' : ''}.`);
    const base = process.env.KAIROS_JUNIT_OUT;
    if (!base) return;
    const out = base.replace(/\.xml$/, `-${suiteName}.xml`);
    const failures = results.filter((r) => r.status === 'fail').length;
    const cases = results.map((r) => (r.status === 'fail'
      ? `    <testcase name="${escapeXml(r.name)}" time="${r.time.toFixed(3)}">\n      <failure message="${escapeXml(r.message)}"/>\n    </testcase>`
      : `    <testcase name="${escapeXml(r.name)}" time="${r.time.toFixed(3)}"/>`)).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="kairos-${suiteName}" tests="${results.length}" failures="${failures}" time="${results.reduce((s, r) => s + r.time, 0).toFixed(3)}">\n${cases}\n</testsuite>\n`;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, xml);
  });

  return { test, section: (t) => console.log(t) };
}

module.exports = { createSuite };
