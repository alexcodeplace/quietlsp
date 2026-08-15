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

fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.rmSync(outTree, { force: true });

if (process.exitCode) {
  console.error('quietlsp filter tests: FAILED');
  process.exit(1);
} else {
  console.log('quietlsp filter tests: all passed');
}
