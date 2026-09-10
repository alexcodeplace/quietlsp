#!/usr/bin/env node
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER_FAMILY = 'quietlsp-guard';
const MARKER = `${MARKER_FAMILY} v3`;
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const QUIETLSP_BIN = path.join(SELF_DIR, 'quietlsp');
const SHIM_DIR = path.resolve(process.env.QUIETLSP_SHIM_DIR || path.join(os.homedir(), '.claude', 'bin'));
const NODE_BIN = path.resolve(process.env.QUIETLSP_NODE || process.execPath);
const TARGETS = ['typescript-language-server', 'rust-analyzer'];

function usage(code = 2) {
  console.error(`usage: node install-quietlsp.mjs [--uninstall] [--status]\n\nInstalls PATH-shadowing QuietLSP shims without modifying Claude Code plugin-cache files.`);
  process.exit(code);
}

let mode = 'install';
for (const arg of process.argv.slice(2)) {
  if (arg === '--uninstall') mode = 'uninstall';
  else if (arg === '--status') mode = 'status';
  else if (arg === '-h' || arg === '--help') usage(0);
  else { console.error(`install-quietlsp: unknown arg: ${arg}`); usage(2); }
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function candidateNames(command) {
  if (process.platform !== 'win32') return [command];
  if (path.extname(command)) return [command];
  const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [command, ...pathext.map((ext) => command + ext.toLowerCase()), ...pathext.map((ext) => command + ext.toUpperCase())];
}

function isUsableFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveReal(command) {
  for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    if (samePath(entry, SHIM_DIR)) continue;
    for (const name of candidateNames(command)) {
      const candidate = path.join(entry, name);
      if (isUsableFile(candidate)) return path.resolve(candidate);
    }
  }
  return null;
}

function destFor(command) {
  return path.join(SHIM_DIR, process.platform === 'win32' ? `${command}.cmd` : command);
}

function quoteCmd(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function shimBody(command, real) {
  if (process.platform === 'win32') {
    return [
      '@echo off',
      `rem ${MARKER} - DO NOT EDIT. Reinstall with install-quietlsp.mjs.`,
      `${quoteCmd(NODE_BIN)} ${quoteCmd(QUIETLSP_BIN)} ${quoteCmd(real)} %*`,
      'exit /b %errorlevel%',
      '',
    ].join('\r\n');
  }
  return [
    '#!/usr/bin/env bash',
    `# ${MARKER} - DO NOT EDIT. Reinstall with install-quietlsp.mjs.`,
    `exec ${JSON.stringify(NODE_BIN)} ${JSON.stringify(QUIETLSP_BIN)} ${JSON.stringify(real)} "$@"`,
    '',
  ].join('\n');
}

function owned(pathname) {
  if (!existsSync(pathname)) return false;
  try { return readFileSync(pathname, 'utf8').slice(0, 512).includes(MARKER_FAMILY); }
  catch { return false; }
}

function bodyCurrent(pathname, command, real) {
  try { return readFileSync(pathname, 'utf8') === shimBody(command, real); }
  catch { return false; }
}

if (!existsSync(QUIETLSP_BIN)) {
  console.error(`install-quietlsp: FATAL missing wrapper at ${QUIETLSP_BIN}`);
  process.exit(1);
}
mkdirSync(SHIM_DIR, { recursive: true });

let wrapped = 0, refreshed = 0, current = 0, unwrapped = 0, stale = 0, restored = 0, skipped = 0;
for (const command of TARGETS) {
  const dest = destFor(command);

  if (mode === 'uninstall') {
    if (existsSync(dest) && owned(dest)) {
      rmSync(dest, { force: true });
      restored += 1;
    }
    continue;
  }

  const real = resolveReal(command);
  if (!real) {
    console.error(`install-quietlsp: WARN no real '${command}' found on PATH outside ${SHIM_DIR} - skipping`);
    skipped += 1;
    continue;
  }

  if (mode === 'status') {
    if (!existsSync(dest)) {
      unwrapped += 1;
      console.log(`UNWRAPPED ${dest}`);
    } else if (!owned(dest)) {
      unwrapped += 1;
      console.log(`UNWRAPPED ${dest} (foreign file, not a quietlsp shim)`);
    } else if (bodyCurrent(dest, command, real)) {
      wrapped += 1;
    } else {
      stale += 1;
      console.log(`DRIFTED ${dest}`);
    }
    continue;
  }

  if (existsSync(dest) && !owned(dest)) {
    console.error(`install-quietlsp: FATAL ${dest} exists and is not a quietlsp shim - refusing to overwrite`);
    process.exit(1);
  }
  if (existsSync(dest) && bodyCurrent(dest, command, real)) {
    current += 1;
    continue;
  }
  const tmp = `${dest}.quietlsp.${process.pid}`;
  writeFileSync(tmp, shimBody(command, real), { mode: 0o755 });
  if (process.platform !== 'win32') {
    try { accessSync(tmp, constants.X_OK); } catch { rmSync(tmp, { force: true }); throw new Error(`cannot make ${tmp} executable`); }
  }
  if (existsSync(dest)) refreshed += 1; else wrapped += 1;
  renameSync(tmp, dest);
}

if (mode === 'install') console.log(`install-quietlsp: wrapped=${wrapped} refreshed=${refreshed} current=${current} skipped=${skipped} (${SHIM_DIR})`);
if (mode === 'uninstall') console.log(`install-quietlsp: restored=${restored} (${SHIM_DIR})`);
if (mode === 'status') {
  console.log(`install-quietlsp: wrapped=${wrapped} stale=${stale} unwrapped=${unwrapped} skipped=${skipped} (${SHIM_DIR})`);
  if (unwrapped !== 0 || stale !== 0) process.exitCode = 1;
}
