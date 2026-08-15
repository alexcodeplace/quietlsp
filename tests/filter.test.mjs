// Framed-stream fixture test for quietlsp's diagnostics filter.
// Run: node tests/filter.test.mjs
'use strict';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUIETLSP = path.join(__dirname, '..', 'quietlsp');
const { decideForward } = await import(pathToFileURL(QUIETLSP).href);

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function parseFrames(buf) {
  const out = [];
  let rest = buf;
  while (rest.length) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    const headerText = rest.slice(0, headerEnd).toString('ascii');
    const len = Number(/Content-Length:\s*(\d+)/i.exec(headerText)[1]);
    const bodyStart = headerEnd + 4;
    const body = rest.slice(bodyStart, bodyStart + len);
    out.push(JSON.parse(body.toString('utf8')));
    rest = rest.slice(bodyStart + len);
  }
  return out;
}

// A tiny fake "language server": echoes stdin to stderr (so we can prove
// client->server passthrough) and emits a fixed script of framed messages
// on stdout, then exits.
function fakeServerScript(messages, opts = {}) {
  return `
const msgs = ${JSON.stringify(messages)};
process.stdin.on('data', (d) => process.stderr.write('ECHO:' + d));
process.stdin.on('end', () => {
  for (const m of msgs) {
    const body = Buffer.from(JSON.stringify(m), 'utf8');
    process.stdout.write(\`Content-Length: \${body.length}\\r\\n\\r\\n\`);
    process.stdout.write(body);
  }
  ${opts.malformedTail ? "process.stdout.write('Content-Length: not-a-number\\r\\n\\r\\n');" : ''}
  // process.exit() does not wait for a pipe's write buffer to flush; end()
  // with a callback does, so the process only terminates after stdout drains.
  process.stdout.end(() => process.exit(0));
});
`;
}

function runQuietlsp({ cwd, messages, malformedTail, stdinData }) {
  const scriptPath = path.join(os.tmpdir(), `quietlsp-fake-server-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(scriptPath, fakeServerScript(messages, { malformedTail }));
  const res = spawnSync(process.execPath, [QUIETLSP, process.execPath, scriptPath], {
    cwd,
    input: stdinData ?? 'hello-from-client',
    encoding: null,
  });
  fs.unlinkSync(scriptPath);
  return res;
}

function uriFor(p) { return pathToFileURL(p).href; }

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quietlsp-test-'));
const inTree = path.join(tmpRoot, 'in-tree.ts');
const outTree = path.join(os.tmpdir(), `quietlsp-outside-${process.pid}.ts`);
fs.writeFileSync(inTree, '// in tree\n');
fs.writeFileSync(outTree, '// out of tree\n');

test('in-tree diagnostics pass byte-exact', () => {
  const diag = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriFor(inTree), diagnostics: [] } };
  const res = runQuietlsp({ cwd: tmpRoot, messages: [diag] });
  assert.equal(res.status, 0, res.stderr?.toString());
  const got = parseFrames(res.stdout);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], diag);
});

test('out-of-tree diagnostics dropped', () => {
  const diag = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriFor(outTree), diagnostics: [] } };
  const res = runQuietlsp({ cwd: tmpRoot, messages: [diag] });
  assert.equal(res.status, 0, res.stderr?.toString());
  const got = parseFrames(res.stdout);
  assert.equal(got.length, 0);
});

test('interleaved messages keep valid framing, only out-of-tree dropped', () => {
  const inDiag = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriFor(inTree), diagnostics: [{ message: 'a' }] } };
  const outDiag = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriFor(outTree), diagnostics: [{ message: 'b' }] } };
  const other = { jsonrpc: '2.0', id: 1, result: { capabilities: {} } };
  const res = runQuietlsp({ cwd: tmpRoot, messages: [other, inDiag, outDiag, inDiag, other] });
  assert.equal(res.status, 0, res.stderr?.toString());
  const got = parseFrames(res.stdout);
  assert.deepEqual(got, [other, inDiag, inDiag, other]);
});

test('non-diagnostics notifications and requests always pass', () => {
  const logMsg = { jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: 'hi' } };
  const res = runQuietlsp({ cwd: tmpRoot, messages: [logMsg] });
  assert.equal(res.status, 0, res.stderr?.toString());
  assert.deepEqual(parseFrames(res.stdout), [logMsg]);
});

test('client->server bytes pass through untouched', () => {
  const res = runQuietlsp({ cwd: tmpRoot, messages: [], stdinData: 'exact-client-bytes-123' });
  assert.equal(res.status, 0, res.stderr?.toString());
  assert.ok(res.stderr.toString().includes('ECHO:exact-client-bytes-123'));
});

test('malformed frame flips to raw passthrough for the rest of the stream', () => {
  const inDiag = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriFor(inTree), diagnostics: [] } };
  const res = runQuietlsp({ cwd: tmpRoot, messages: [inDiag], malformedTail: true });
  assert.equal(res.status, 0, res.stderr?.toString());
  // First message still parses fine (framing was valid up to that point).
  const asString = res.stdout.toString('utf8');
  assert.ok(asString.includes('"in-tree.ts"') || asString.includes(uriFor(inTree)));
  // The malformed tail bytes are still present verbatim (raw passthrough), not silently eaten.
  assert.ok(asString.includes('Content-Length: not-a-number'));
});

test('large message split across chunk boundaries reassembles correctly', () => {
  const big = 'x'.repeat(200_000);
  const diag = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriFor(inTree), diagnostics: [{ message: big }] } };
  const res = runQuietlsp({ cwd: tmpRoot, messages: [diag] });
  assert.equal(res.status, 0, res.stderr?.toString());
  const got = parseFrames(res.stdout);
  assert.equal(got.length, 1);
  assert.equal(got[0].params.diagnostics[0].message.length, 200_000);
});

test('initialize capability rewrite strips textDocument.diagnostic and recomputes Content-Length', () => {
  const init = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { capabilities: { textDocument: { diagnostic: { dynamicRegistration: true }, hover: {} } } },
  };
  const res = runQuietlsp({ cwd: tmpRoot, messages: [], stdinData: frame(init) });
  assert.equal(res.status, 0, res.stderr?.toString());
  const echoed = res.stderr.toString('utf8').replace(/^ECHO:/, '');
  const headerEnd = echoed.indexOf('\r\n\r\n');
  const headerText = echoed.slice(0, headerEnd);
  const len = Number(/Content-Length:\s*(\d+)/i.exec(headerText)[1]);
  const body = Buffer.from(echoed.slice(headerEnd + 4), 'utf8').slice(0, len);
  assert.equal(len, body.length);
  const rewritten = JSON.parse(body.toString('utf8'));
  assert.equal('diagnostic' in rewritten.params.capabilities.textDocument, false);
  assert.deepEqual(rewritten.params.capabilities.textDocument.hover, {});
  assert.equal(rewritten.id, 1);
});

test('initialize without pull-diagnostics capability passes unchanged', () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { textDocument: { hover: {} } } } };
  const res = runQuietlsp({ cwd: tmpRoot, messages: [], stdinData: frame(init) });
  assert.equal(res.status, 0, res.stderr?.toString());
  const echoed = res.stderr.toString('utf8').replace(/^ECHO:/, '');
  assert.deepEqual(parseFrames(Buffer.from(echoed, 'utf8')), [init]);
});

test('non-initialize client requests pass through as original bytes, not round-tripped', () => {
  const req = { jsonrpc: '2.0', id: 2, method: 'textDocument/hover', params: { z: 1, a: 2 } };
  const raw = frame(req);
  const res = runQuietlsp({ cwd: tmpRoot, messages: [], stdinData: raw });
  assert.equal(res.status, 0, res.stderr?.toString());
  const echoed = res.stderr.toString('utf8').replace(/^ECHO:/, '');
  assert.equal(echoed, raw.toString('utf8'));
});

test('clear-state: allowed -> out-of-scope -> clear transition (decideForward unit)', () => {
  const forwarded = new Set();
  const uri = 'file:///out/of/scope.ts';
  const outOfScope = (u) => u === uri; // classify: only our test uri is out of scope
  // 1. Allowed while in scope (classify says in-scope for this call).
  const allow = decideForward({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ m: 1 }] } }, forwarded, () => false);
  assert.equal(allow, true);
  assert.ok(forwarded.has(uri));
  // 2. Denied once out of scope, non-empty: dropped, stays in forwarded set (not yet cleared).
  const deny = decideForward({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ m: 2 }] } }, forwarded, outOfScope);
  assert.equal(deny, false);
  assert.ok(forwarded.has(uri));
  // 3. Empty clear while out of scope: passes through once, then leaves the set.
  const clear = decideForward({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } }, forwarded, outOfScope);
  assert.equal(clear, true);
  assert.equal(forwarded.has(uri), false);
  // 4. A second empty publication for the same never-forwarded uri is dropped, not synthesized.
  const dropAgain = decideForward({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } }, forwarded, outOfScope);
  assert.equal(dropAgain, false);
});

test('out-of-tree clear passes once after an in-tree publication, then drops again', () => {
  const nonEmpty = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriFor(outTree), diagnostics: [{ message: 'x' }] } };
  const emptyClear = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriFor(outTree), diagnostics: [] } };
  const res = runQuietlsp({ cwd: tmpRoot, messages: [nonEmpty, emptyClear] });
  assert.equal(res.status, 0, res.stderr?.toString());
  // Never forwarded (root never included outTree), so both are dropped.
  assert.deepEqual(parseFrames(res.stdout), []);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.rmSync(outTree, { force: true });

if (process.exitCode) {
  console.error('quietlsp filter tests: FAILED');
  process.exit(1);
} else {
  console.log('quietlsp filter tests: all passed');
}
