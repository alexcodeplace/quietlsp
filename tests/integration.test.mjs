// R10/R12 integration test: drives a REAL session against the INSTALLED
// typescript-language-server, once through quietlsp and once bare, and
// compares the two captured streams. Not a mock — this is the rerunnable
// proof artifact the spec (R12) requires: "proof is a test, not an
// attestation".
//
// rust-analyzer equivalent: gated on a functional rust-analyzer binary,
// which this box does not have (only a non-functional `rustup` proxy
// stub — see README/SPEC.md). That case is named as a gap below, not faked.
//
// Run: node tests/integration.test.mjs
'use strict';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUIETLSP = path.join(__dirname, '..', 'quietlsp');
const NODE = process.execPath;
const LOG_PATH = path.join(os.homedir(), '.local/state/overdeck/quietlsp.log');

const TSSERVER = (() => {
  const r = spawnSync('/bin/sh', ['-c', 'command -v typescript-language-server']);
  return r.status === 0 ? r.stdout.toString('utf8').trim() : null;
})();
const RUST_ANALYZER_FUNCTIONAL = (() => {
  const r = spawnSync('/bin/sh', ['-c', 'command -v rust-analyzer']);
  if (r.status !== 0) return false;
  const bin = r.stdout.toString('utf8').trim();
  const probe = spawnSync(bin, ['--version'], { timeout: 5000 });
  // Correction 2026-08-16: on this box `command -v rust-analyzer` resolves
  // to the ~/.cargo/bin rustup proxy, and its --version transparently falls
  // back to the real /usr/bin/rust-analyzer and succeeds (exit 0) — this
  // check already detects that correctly. See README "rustup proxy
  // footgun" — do not assume the proxy itself is non-functional.
  return probe.status === 0 && /^rust-analyzer /.test(probe.stdout?.toString('utf8') ?? '');
})();

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function parseFrames(buf) {
  const out = [];
  let rest = buf;
  while (rest.length) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const headerText = rest.slice(0, headerEnd).toString('ascii');
    const m = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!m) break;
    const len = Number(m[1]);
    const bodyStart = headerEnd + 4;
    if (rest.length < bodyStart + len) break;
    const body = rest.slice(bodyStart, bodyStart + len);
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      parsed = { __unparseable: body.toString('utf8') };
    }
    out.push(parsed);
    rest = rest.slice(bodyStart + len);
  }
  return out;
}

const uriFor = (p) => pathToFileURL(p).href;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function driveSession({ command, args, cwd, inTreeFile, siblingFile }) {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = Buffer.alloc(0);
  child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
  child.stderr.on('data', () => {}); // tsserver logs to stderr sometimes; not part of this proof

  const send = (obj) => child.stdin.write(frame(obj));
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: uriFor(cwd),
      capabilities: { textDocument: { publishDiagnostics: {}, diagnostic: { dynamicRegistration: true } } },
      workspaceFolders: [{ uri: uriFor(cwd), name: 'in-tree' }],
    },
  });
  await new Promise((r) => setTimeout(r, 400));
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  send({
    jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri: uriFor(inTreeFile), languageId: 'typescript', version: 1, text: fs.readFileSync(inTreeFile, 'utf8') } },
  });
  send({
    jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri: uriFor(siblingFile), languageId: 'typescript', version: 1, text: fs.readFileSync(siblingFile, 'utf8') } },
  });

  // Poll for both diagnostics to have had a chance to arrive (or not, for
  // the wrapped/sibling case) rather than a fixed sleep, but bound total wait.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const msgs = parseFrames(out);
    const sawInTree = msgs.some((m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uriFor(inTreeFile));
    if (sawInTree) {
      await new Promise((r) => setTimeout(r, 500)); // let any sibling diagnostic land too
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  child.kill('SIGTERM');
  await new Promise((r) => child.on('close', r));
  return parseFrames(out);
}

if (!TSSERVER) {
  console.log('SKIP - integration: typescript-language-server not installed on this box');
} else {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quietlsp-integration-'));
  const inTreeDir = path.join(tmpRoot, 'in-tree');
  const siblingDir = path.join(tmpRoot, 'sibling');
  fs.mkdirSync(inTreeDir);
  fs.mkdirSync(siblingDir);
  const inTreeFile = path.join(inTreeDir, 'a.ts');
  const siblingFile = path.join(siblingDir, 'b.ts');
  fs.writeFileSync(inTreeFile, 'const x: number = "should-be-num";\n');
  fs.writeFileSync(siblingFile, 'const y: number = "should-be-num-2";\n');

  const logSizeBefore = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0;

  const [wrapped, bare] = await Promise.all([
    driveSession({ command: NODE, args: [QUIETLSP, TSSERVER, '--stdio'], cwd: inTreeDir, inTreeFile, siblingFile }),
    driveSession({ command: TSSERVER, args: ['--stdio'], cwd: inTreeDir, inTreeFile, siblingFile }),
  ]);

  test('bare server (ground truth): both in-tree and sibling diagnostics arrive', () => {
    const diagUris = bare.filter((m) => m.method === 'textDocument/publishDiagnostics').map((m) => m.params.uri);
    assert.ok(diagUris.includes(uriFor(inTreeFile)), 'in-tree diagnostic missing from ground truth run');
    assert.ok(diagUris.includes(uriFor(siblingFile)), 'sibling diagnostic missing from ground truth run — test fixture is not exercising real diagnostics');
  });

  test('wrapped: in-tree diagnostic is delivered, sibling diagnostic is dropped', () => {
    const diagUris = wrapped.filter((m) => m.method === 'textDocument/publishDiagnostics').map((m) => m.params.uri);
    assert.ok(diagUris.includes(uriFor(inTreeFile)), 'in-tree diagnostic missing through the wrapper');
    assert.ok(!diagUris.includes(uriFor(siblingFile)), 'sibling diagnostic leaked through the wrapper');
  });

  test('unrelated traffic (initialize response) is byte-identical wrapped vs bare', () => {
    const wrappedInit = wrapped.find((m) => m.id === 1 && m.result);
    const bareInit = bare.find((m) => m.id === 1 && m.result);
    assert.ok(wrappedInit && bareInit, 'both runs must have an initialize response to compare');
    assert.deepEqual(wrappedInit, bareInit, 'server->client initialize response must be untouched by the wrapper');
  });

  test('R1: capability rewrite is recorded in the log for this session (negotiated capabilities diff)', () => {
    const logTail = fs.readFileSync(LOG_PATH, 'utf8').slice(logSizeBefore);
    const line = logTail.split('\n').find((l) => l.includes('capability rewrite:'));
    assert.ok(line, `no capability-rewrite log line found in this session's log tail:\n${logTail}`);
    assert.ok(line.includes('"diagnostic"'), 'original capabilities must show the client advertised diagnostic (pull-mode)');
    const rewrittenPart = line.slice(line.indexOf('rewritten textDocument='));
    assert.ok(!rewrittenPart.includes('"diagnostic"'), 'rewritten capabilities must have diagnostic stripped');
  });

  test('honest gap: typescript-language-server never advertises diagnosticProvider on this box (5.9.3) — R1 proof is the log, not a negotiated-capability diff', () => {
    const bareInit = bare.find((m) => m.id === 1 && m.result);
    assert.ok(bareInit, 'bare initialize response missing');
    assert.equal('diagnosticProvider' in bareInit.result.capabilities, false);
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (!RUST_ANALYZER_FUNCTIONAL) {
  console.log('GAP - integration: no functional rust-analyzer binary on this box — rust-analyzer push/pull integration case is structural only, not run here');
} else {
  console.log('GAP - integration: functional rust-analyzer detected (/usr/bin/rust-analyzer) but the induced-diagnostic driveSession case is not wired for it yet — needs a real Cargo project per fixture dir and untangling rust-analyzer\'s own internal cargo resolution from this box\'s remote-build cargo PATH shim; see SPEC.md R10');
}

if (process.exitCode) {
  console.error('quietlsp integration tests: FAILED');
  process.exit(1);
} else {
  console.log('quietlsp integration tests: all passed (or honestly skipped/gapped)');
}
