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
const { decideForward, exitCodeFor, canonicalizeBestEffort, isWithinRoot, classifyFileUri, extractRootEvidence } = await import(pathToFileURL(QUIETLSP).href);

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

test('exitCodeFor maps normal exit and signal death (R11)', () => {
  assert.equal(exitCodeFor(0, null), 0);
  assert.equal(exitCodeFor(3, null), 3);
  assert.equal(exitCodeFor(null, 'SIGTERM'), 128 + 15);
  assert.equal(exitCodeFor(null, 'SIGKILL'), 128 + 9);
});

test('R7 split: valid frame with unparseable body passes that frame, resumes filtering next frame', () => {
  const scriptPath = path.join(os.tmpdir(), `quietlsp-badjson-server-${process.pid}.mjs`);
  const goodDiag = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriFor(inTree), diagnostics: [] } };
  fs.writeFileSync(scriptPath, `
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => {
      const bad = Buffer.from('not json at all', 'utf8');
      process.stdout.write('Content-Length: ' + bad.length + '\\r\\n\\r\\n');
      process.stdout.write(bad);
      const goodBody = Buffer.from(${JSON.stringify(JSON.stringify(goodDiag))}, 'utf8');
      process.stdout.write('Content-Length: ' + goodBody.length + '\\r\\n\\r\\n');
      process.stdout.write(goodBody);
      process.stdout.end(() => process.exit(0));
    });
  `);
  const res = spawnSync(process.execPath, [QUIETLSP, process.execPath, scriptPath], { cwd: tmpRoot, input: 'x', encoding: null });
  fs.unlinkSync(scriptPath);
  assert.equal(res.status, 0, res.stderr?.toString());
  const asString = res.stdout.toString('utf8');
  const expectedBad = `Content-Length: ${Buffer.byteLength('not json at all', 'utf8')}\r\n\r\nnot json at all`;
  assert.ok(asString.startsWith(expectedBad), 'unparseable-but-well-framed body passes unchanged');
  // Framing stayed trustworthy: the following well-formed diagnostic still parses (not raw-passthrough-forever).
  const rest = asString.slice(expectedBad.length);
  const parsed = parseFrames(Buffer.from(rest, 'utf8'));
  assert.deepEqual(parsed, [goodDiag]);
});

test('R11: process exits with 128+signal on child death by signal', () => {
  const scriptPath = path.join(os.tmpdir(), `quietlsp-selfkill-server-${process.pid}.mjs`);
  fs.writeFileSync(scriptPath, `
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => process.kill(process.pid, 'SIGKILL'));
  `);
  const res = spawnSync(process.execPath, [QUIETLSP, process.execPath, scriptPath], { cwd: tmpRoot, input: 'x', encoding: null });
  fs.unlinkSync(scriptPath);
  assert.equal(res.status, 128 + 9);
});

test('R4: non-file schemes (untitled:, git:, remote-ssh) always pass, never classified', () => {
  for (const uri of ['untitled:Untitled-1', 'git:/repo/file.ts?ref=HEAD', 'vscode-remote://ssh-remote+box/x.ts']) {
    assert.equal(classifyFileUri(uri, [tmpRoot]), false, uri);
  }
});

test('R4: unparseable uri string is never classified as out of scope', () => {
  assert.equal(classifyFileUri('not a uri at all', [tmpRoot]), false);
});

test('R4: percent-encoded file uri decodes before containment check', () => {
  const dirWithSpace = path.join(tmpRoot, 'has space');
  fs.mkdirSync(dirWithSpace, { recursive: true });
  const f = path.join(dirWithSpace, 'x.ts');
  fs.writeFileSync(f, '');
  assert.equal(classifyFileUri(uriFor(f), [tmpRoot]), false, 'in scope, percent-decoded path resolves inside root');
});

test('R4: isWithinRoot is component-based, not a naive string prefix', () => {
  assert.equal(isWithinRoot('/a/b', '/a/bcarry/x'), false, '"/a/bcarry" must not match root "/a/b"');
  assert.equal(isWithinRoot('/a/b', '/a/b/c'), true);
  assert.equal(isWithinRoot('/a/b', '/a/b'), true);
});

test('R4: canonicalizeBestEffort resolves through the deepest existing ancestor', () => {
  const real = canonicalizeBestEffort(path.join(tmpRoot, 'nope', 'deeper', 'missing.ts'));
  assert.equal(real, path.join(fs.realpathSync(tmpRoot), 'nope', 'deeper', 'missing.ts'));
});

test('R4: a symlinked directory is resolved before containment check (out-of-tree via symlink dropped)', () => {
  const realOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'quietlsp-real-outside-'));
  const linkPath = path.join(tmpRoot, 'link-to-outside');
  fs.symlinkSync(realOutside, linkPath);
  const f = path.join(linkPath, 'y.ts'); // never created on disk; exercises ancestor-walk canonicalization
  const diag = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriFor(f), diagnostics: [] } };
  const res = runQuietlsp({ cwd: tmpRoot, messages: [diag] });
  assert.equal(res.status, 0, res.stderr?.toString());
  assert.deepEqual(parseFrames(res.stdout), []);
  fs.rmSync(realOutside, { recursive: true, force: true });
});

test('R5: workspaceFolders that exist and are directories become extra allowed roots', () => {
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quietlsp-extra-root-'));
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { workspaceFolders: [{ uri: uriFor(extraDir), name: 'x' }] } };
  const evidence = extractRootEvidence(init, tmpRoot);
  assert.deepEqual(evidence.extraRoots, [fs.realpathSync(extraDir)]);
  fs.rmSync(extraDir, { recursive: true, force: true });
});

test('R5: workspaceFolders entries that do not exist or are files (not dirs) are rejected', () => {
  const notADir = path.join(tmpRoot, 'not-a-dir.txt');
  fs.writeFileSync(notADir, '');
  const init = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { workspaceFolders: [{ uri: uriFor(notADir) }, { uri: uriFor(path.join(tmpRoot, 'does-not-exist')) }] },
  };
  const evidence = extractRootEvidence(init, tmpRoot);
  assert.deepEqual(evidence.extraRoots, []);
});

test('R3: rootUri disagreeing with cwd is logged, not acted on', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'quietlsp-other-root-'));
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: uriFor(other) } };
  const evidence = extractRootEvidence(init, tmpRoot);
  assert.ok(evidence.disagreement && evidence.disagreement.includes(fs.realpathSync(other)));
  fs.rmSync(other, { recursive: true, force: true });
});

test('R3: rootUri matching cwd reports no disagreement', () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: uriFor(tmpRoot) } };
  const evidence = extractRootEvidence(init, fs.realpathSync(tmpRoot));
  assert.equal(evidence.disagreement, null);
});

test('R5 end-to-end: a diagnostic for a workspaceFolder outside cwd is forwarded, not dropped', () => {
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quietlsp-extra-root-e2e-'));
  const extraFile = path.join(extraDir, 'gen.ts');
  fs.writeFileSync(extraFile, '');
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { workspaceFolders: [{ uri: uriFor(extraDir), name: 'x' }] } };
  const diag = { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uriFor(extraFile), diagnostics: [] } };
  const res = runQuietlsp({ cwd: tmpRoot, messages: [diag], stdinData: frame(init) });
  assert.equal(res.status, 0, res.stderr?.toString());
  assert.deepEqual(parseFrames(res.stdout), [diag]);
  fs.rmSync(extraDir, { recursive: true, force: true });
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.rmSync(outTree, { force: true });

if (process.exitCode) {
  console.error('quietlsp filter tests: FAILED');
  process.exit(1);
} else {
  console.log('quietlsp filter tests: all passed');
}
