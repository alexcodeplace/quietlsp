import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(repo, 'install-quietlsp.mjs');
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'quietlsp-installer-'));
const shimDir = path.join(sandbox, 'shim');
const realDir = path.join(sandbox, 'real');
mkdirSync(realDir, { recursive: true });

const realName = process.platform === 'win32' ? 'typescript-language-server.cmd' : 'typescript-language-server';
const realPath = path.join(realDir, realName);
writeFileSync(realPath, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
if (process.platform !== 'win32') chmodSync(realPath, 0o755);

const dest = path.join(shimDir, process.platform === 'win32' ? 'typescript-language-server.cmd' : 'typescript-language-server');
const baseEnv = {
  ...process.env,
  QUIETLSP_SHIM_DIR: shimDir,
  QUIETLSP_NODE: process.execPath,
  PATH: `${realDir}${path.delimiter}${process.env.PATH || ''}`,
};

function run(args = [], env = baseEnv) {
  return spawnSync(process.execPath, [installer, ...args], { env, encoding: 'utf8' });
}

function check(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); console.error(error); process.exitCode = 1; }
}

check('first install writes an owned platform-native shim', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(dest), true);
  const body = readFileSync(dest, 'utf8');
  assert.match(body, /quietlsp-guard v3/);
  assert.ok(body.includes(realPath));
});

check('status is clean after install', () => {
  const r = run(['--status']);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

check('install is idempotent', () => {
  const before = readFileSync(dest, 'utf8');
  const r = run();
  const after = readFileSync(dest, 'utf8');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(after, before);
  assert.match(r.stdout, /wrapped=0 refreshed=0 current=1/);
});

check('status detects owned drift and install repairs it', () => {
  writeFileSync(dest, `${process.platform === 'win32' ? 'rem' : '#'} quietlsp-guard v3\ncorrupt\n`);
  const bad = run(['--status']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /DRIFTED/);
  const repaired = run();
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /refreshed=1/);
  assert.equal(run(['--status']).status, 0);
});

check('resolver skips the shim directory and keeps the real target', () => {
  const env = { ...baseEnv, PATH: `${shimDir}${path.delimiter}${realDir}${path.delimiter}${process.env.PATH || ''}` };
  const r = run([], env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(dest, 'utf8').includes(realPath));
});

check('foreign shim collision is refused', () => {
  run(['--uninstall']);
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(dest, 'foreign\n');
  const r = run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to overwrite/);
  assert.equal(readFileSync(dest, 'utf8'), 'foreign\n');
  rmSync(dest, { force: true });
});

check('uninstall removes only an owned shim even if the real target disappeared', () => {
  assert.equal(run().status, 0);
  rmSync(realPath, { force: true });
  const r = run(['--uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(dest), false);
});

rmSync(sandbox, { recursive: true, force: true });
if (process.exitCode) process.exit(1);
else console.log('install-quietlsp cross-platform tests: all passed');
