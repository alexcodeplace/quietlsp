// R10/R12 integration test: drives a REAL session against the INSTALLED
// typescript-language-server, once through quietlsp and once bare, and
// compares the two captured streams. Not a mock — this is the rerunnable
// proof artifact the spec (R12) requires: "proof is a test, not an
// attestation".
//
// rust-analyzer equivalent: gated on a functional rust-analyzer binary.
// The induced-diagnostic case is not implemented yet; that gap is named below, not faked.
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
const STATE_HOME = process.env.XDG_STATE_HOME || (process.platform === 'win32'
  ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
  : path.join(os.homedir(), '.local', 'state'));
const LOG_PATH = process.env.QUIETLSP_LOG || path.join(STATE_HOME, 'quietlsp', 'quietlsp.log');

function findCommand(name) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, process.platform === 'win32' ? name + ext.toLowerCase() : name);
      try {
        if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
      } catch {}
    }
  }
  return null;
}

const TSSERVER_CLI = process.env.QUIETLSP_TYPESCRIPT_LANGUAGE_SERVER_CLI || null;
const TSSERVER = TSSERVER_CLI ? process.execPath : findCommand('typescript-language-server');
const TSSERVER_PREFIX_ARGS = TSSERVER_CLI ? [path.resolve(TSSERVER_CLI)] : [];
const TSSERVER_JS = process.env.QUIETLSP_TSSERVER_PATH || null;
const RUST_ANALYZER_FUNCTIONAL = (() => {
  const bin = findCommand('rust-analyzer');
  if (!bin || /\.(cmd|bat)$/i.test(bin)) return false;
  const probe = spawnSync(bin, ['--version'], { timeout: 5000 });
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

function sameFileUri(left, right) {
  try {
    const a = path.resolve(fileURLToPath(left));
    const b = path.resolve(fileURLToPath(right));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return left === right;
  }
}

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
      ...(TSSERVER_JS ? { initializationOptions: { tsserver: { path: TSSERVER_JS } } } : {}),
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
    const sawInTree = msgs.some((m) => m.method === 'textDocument/publishDiagnostics' && sameFileUri(m.params?.uri, uriFor(inTreeFile)));
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
  console.log('SKIP - integration: typescript-language-server is not installed');
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
    driveSession({ command: NODE, args: [QUIETLSP, TSSERVER, ...TSSERVER_PREFIX_ARGS, '--stdio'], cwd: inTreeDir, inTreeFile, siblingFile }),
    driveSession({ command: TSSERVER, args: [...TSSERVER_PREFIX_ARGS, '--stdio'], cwd: inTreeDir, inTreeFile, siblingFile }),
  ]);

  test('bare server (ground truth): both in-tree and sibling diagnostics arrive', () => {
    const diagUris = bare.filter((m) => m.method === 'textDocument/publishDiagnostics').map((m) => m.params.uri);
    assert.ok(diagUris.some((uri) => sameFileUri(uri, uriFor(inTreeFile))), `in-tree diagnostic missing from ground truth run; got ${JSON.stringify(diagUris)}`);
    assert.ok(diagUris.some((uri) => sameFileUri(uri, uriFor(siblingFile))), `sibling diagnostic missing from ground truth run — got ${JSON.stringify(diagUris)}`);
  });

  test('wrapped: in-tree diagnostic is delivered, sibling diagnostic is dropped', () => {
    const diagUris = wrapped.filter((m) => m.method === 'textDocument/publishDiagnostics').map((m) => m.params.uri);
    assert.ok(diagUris.some((uri) => sameFileUri(uri, uriFor(inTreeFile))), `in-tree diagnostic missing through the wrapper; got ${JSON.stringify(diagUris)}`);
    assert.ok(!diagUris.some((uri) => sameFileUri(uri, uriFor(siblingFile))), `sibling diagnostic leaked through the wrapper; got ${JSON.stringify(diagUris)}`);
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

  test('typescript-language-server may omit diagnosticProvider — R1 proof is the rewrite log, not a negotiated-capability diff', () => {
    const bareInit = bare.find((m) => m.id === 1 && m.result);
    assert.ok(bareInit, 'bare initialize response missing');
    assert.equal('diagnosticProvider' in bareInit.result.capabilities, false);
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (!RUST_ANALYZER_FUNCTIONAL) {
  console.log('GAP - integration: no functional rust-analyzer binary detected — rust-analyzer induced-diagnostic case not run');
} else {
  console.log('GAP - integration: functional rust-analyzer detected, but the induced-diagnostic driveSession case is not wired yet; it needs a real Cargo project fixture. See SPEC.md R10');
}

if (process.exitCode) {
  console.error('quietlsp integration tests: FAILED');
  process.exit(1);
} else {
  console.log('quietlsp integration tests: all passed (or honestly skipped/gapped)');
}
