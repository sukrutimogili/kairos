#!/usr/bin/env node
/**
 * Unit tests for git history extraction (history/gitLog.js).
 *
 * No test framework dependency — plain Node `assert`, run with:
 *   node history/gitLog.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getCommitFileGroups, DEFAULT_MAX_COMMITS } = require('./gitLog');

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

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-gitlog-fixture-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'kairos-test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Kairos Test'], { cwd: dir });
  return dir;
}

function writeAndCommit(dir, files, message) {
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  execFileSync('git', ['add', ...Object.keys(files)], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

console.log('getCommitFileGroups()');

test('returns [] for a directory that is not a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-no-git-'));
  assert.deepStrictEqual(getCommitFileGroups(dir), []);
});

test('returns [] for a fresh git repo with no commits yet', () => {
  const dir = makeTempRepo();
  assert.deepStrictEqual(getCommitFileGroups(dir), []);
});

test('returns one entry per commit, newest first', () => {
  const dir = makeTempRepo();
  writeAndCommit(dir, { 'a.txt': 'one' }, 'first commit');
  writeAndCommit(dir, { 'b.txt': 'two' }, 'second commit');
  const commits = getCommitFileGroups(dir);
  assert.strictEqual(commits.length, 2);
  assert.deepStrictEqual(commits[0].files, ['b.txt']);
  assert.deepStrictEqual(commits[1].files, ['a.txt']);
});

test('lists every file touched together in one commit', () => {
  const dir = makeTempRepo();
  writeAndCommit(dir, { 'x.txt': '1', 'y.txt': '2' }, 'two files together');
  const commits = getCommitFileGroups(dir);
  assert.strictEqual(commits.length, 1);
  assert.deepStrictEqual(commits[0].files.sort(), ['x.txt', 'y.txt']);
});

test('each entry has a real commit hash', () => {
  const dir = makeTempRepo();
  writeAndCommit(dir, { 'a.txt': '1' }, 'commit');
  const commits = getCommitFileGroups(dir);
  assert.match(commits[0].hash, /^[0-9a-f]{40}$/);
});

test('maxCommits limits how many recent commits are returned', () => {
  const dir = makeTempRepo();
  writeAndCommit(dir, { 'a.txt': '1' }, 'commit 1');
  writeAndCommit(dir, { 'b.txt': '1' }, 'commit 2');
  writeAndCommit(dir, { 'c.txt': '1' }, 'commit 3');
  const commits = getCommitFileGroups(dir, { maxCommits: 2 });
  assert.strictEqual(commits.length, 2);
  assert.deepStrictEqual(commits[0].files, ['c.txt']);
  assert.deepStrictEqual(commits[1].files, ['b.txt']);
});

test('DEFAULT_MAX_COMMITS is exported and used when no option is given', () => {
  assert.strictEqual(typeof DEFAULT_MAX_COMMITS, 'number');
  assert.ok(DEFAULT_MAX_COMMITS > 0);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', with failures' : ''}.`);
