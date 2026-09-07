#!/usr/bin/env node
'use strict';

// Run with: node tests/scanner-contract.cjs
// Windows only. All generated data lives in a uniquely named OS-temp directory.
// The 8 GiB logical-size fixture is explicitly sparse and does not write 8 GiB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const exe = path.resolve(__dirname, '../runtime/scanner/SpaceLens.Scanner.exe');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spacelens-scanner-test-'));
const fixture = path.join(scratch, 'fixture');
fs.mkdirSync(fixture);
let expectedBytes = 0, expectedFiles = 0;
const checks = [];

function file(relative, content) {
  const target = path.join(fixture, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  expectedFiles++;
  expectedBytes += Buffer.byteLength(content);
  return target;
}

function scan(root, destination, workers = 4, cancel = false) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(exe, ['scan', '--path', root, '--output', destination, '--workers', String(workers)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', cancelled = false;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Scanner exceeded 30 second test timeout.')); }, 30_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (cancel && !cancelled && stdout.includes('"type":"progress"')) {
        cancelled = true;
        child.stdin.end('cancel\n');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, wallMs: Math.round(performance.now() - started),
        events: stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) });
    });
  });
}

function inspect(snapshot) {
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.nodes[0].id, 0);
  assert.equal(snapshot.nodes[0].parent, null);
  assert.equal(snapshot.summary.sizeMetric, 'logical');
  const sums = snapshot.nodes.map(node => ({
    bytes: node.kind === 'file' ? node.bytes : 0,
    files: node.kind === 'file' ? 1 : 0, dirs: 0
  }));
  const paths = [''];
  for (let id = 0; id < snapshot.nodes.length; id++) {
    const node = snapshot.nodes[id];
    assert.equal(node.id, id, 'IDs must be dense and in array order.');
    assert.ok(['file', 'directory'].includes(node.kind));
    assert.ok(node.modified === null || !Number.isNaN(Date.parse(node.modified)));
    assert.ok(node.accessed === null || !Number.isNaN(Date.parse(node.accessed)));
    if (id) {
      assert.ok(Number.isInteger(node.parent) && node.parent < node.id);
      assert.equal(snapshot.nodes[node.parent].kind, 'directory');
      paths[id] = path.join(paths[node.parent], node.name);
    }
  }
  for (let id = snapshot.nodes.length - 1; id > 0; id--) {
    const node = snapshot.nodes[id], parent = sums[node.parent], own = sums[id];
    assert.equal(node.bytes, own.bytes, `bytes aggregation: ${paths[id]}`);
    assert.equal(node.files, own.files, `files aggregation: ${paths[id]}`);
    assert.equal(node.dirs, own.dirs, `dirs aggregation: ${paths[id]}`);
    parent.bytes += own.bytes; parent.files += own.files;
    parent.dirs += own.dirs + (node.kind === 'directory' ? 1 : 0);
  }
  for (const key of ['bytes', 'files', 'dirs']) {
    assert.equal(snapshot.nodes[0][key], sums[0][key]);
    assert.equal(snapshot.summary[key], sums[0][key]);
  }
  return snapshot.nodes.map((node, id) => [paths[id], node.kind, node.bytes, node.files, node.dirs, node.category, node.warning || ''])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

(async () => {
  if (process.platform !== 'win32') throw new Error('The native scanner fixture requires Windows.');
  assert.ok(fs.existsSync(exe), 'Publish the scanner first.');
  file('空目录的邻居/空白 🎬.mp4', '');
  file('工作素材 🎬/分镜脚本.md', '# 分镜\n剪辑的节奏与留白。\n');
  const image = file('alpha/beta/frame.png', Buffer.alloc(513, 7));
  fs.linkSync(image, path.join(fixture, 'same-data-hardlink.png'));
  expectedFiles++; expectedBytes += 513;
  file(path.join(...Array.from({ length: 6 }, (_, i) => `long-${i}-${'长'.repeat(43)}`), 'final.txt'), 'long-path');
  fs.mkdirSync(path.join(fixture, 'truly-empty'));

  const sparse = file('declared-8GiB.iso', '');
  const sparseFlag = spawnSync('fsutil.exe', ['sparse', 'setflag', sparse], { encoding: 'utf8', windowsHide: true });
  assert.equal(sparseFlag.status, 0, `Could not create safe sparse fixture: ${sparseFlag.stderr || sparseFlag.stdout}`);
  const sparseBytes = 8 * 1024 ** 3 + 123;
  const fd = fs.openSync(sparse, 'r+');
  fs.ftruncateSync(fd, sparseBytes); fs.closeSync(fd);
  expectedBytes += sparseBytes;
  fs.symlinkSync(fixture, path.join(fixture, 'junction-loop'), 'junction');

  // More siblings than the shared 2,048-item queue. One worker must drain its
  // depth-first overflow without deadlock; four workers must yield identical totals.
  for (let i = 0; i < 2500; i++) {
    for (let j = 0; j < 4; j++) file(`bulk-${String(i).padStart(4, '0')}/item-${j}.json`, '0123456789abcdef');
  }

  const serialPath = path.join(scratch, 'serial.json');
  const serialRun = await scan(fixture, serialPath, 1);
  assert.equal(serialRun.code, 0, serialRun.stderr);
  const serial = JSON.parse(fs.readFileSync(serialPath, 'utf8'));
  const serialRows = inspect(serial);
  assert.equal(serial.summary.bytes, expectedBytes);
  assert.equal(serial.summary.files, expectedFiles);
  assert.equal(serial.summary.skipped, 1);
  assert.equal(serial.summary.errors, 0);
  assert.equal(serial.status, 'partial'); // The intentional junction loop is skipped.
  assert.ok(serial.nodes.some(n => n.name === '空白 🎬.mp4' && n.bytes === 0 && n.category === 'video'));
  assert.ok(serial.nodes.some(n => n.name === 'declared-8GiB.iso' && n.bytes === sparseBytes));
  assert.ok(serial.nodes.some(n => n.name === 'junction-loop' && n.warning === 'reparse_directory_skipped' && n.bytes === 0));
  checks.push('Unicode, emoji, empty file/directory, >260-char paths, 8 GiB sparse logical size, category mapping, hardlink logical counting, junction loop skip, bounded queue overflow');

  const parallelPath = path.join(scratch, 'parallel.json');
  const parallelRun = await scan(fixture, parallelPath, 4);
  assert.equal(parallelRun.code, 0, parallelRun.stderr);
  const parallel = JSON.parse(fs.readFileSync(parallelPath, 'utf8'));
  assert.deepEqual(inspect(parallel), serialRows);
  checks.push('Parallel and single-worker aggregation match for every node');

  const invalidOutput = path.join(scratch, 'must-not-exist.json');
  const invalid = await scan(path.join(scratch, 'nonexistent-root'), invalidOutput);
  assert.equal(invalid.code, 2); assert.equal(fs.existsSync(invalidOutput), false);
  assert.equal(JSON.parse(invalid.stderr.trim()).error, 'invalid_root');
  const fileRoot = await scan(image, invalidOutput);
  assert.equal(fileRoot.code, 2); assert.equal(fs.existsSync(invalidOutput), false);
  checks.push('Nonexistent and file roots fail with structured errors and no snapshot');

  const cancelledPath = path.join(scratch, 'cancelled.json');
  const cancelled = await scan(fixture, cancelledPath, 1, true);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  const partial = JSON.parse(fs.readFileSync(cancelledPath, 'utf8'));
  assert.equal(partial.status, 'cancelled'); inspect(partial);
  assert.ok(partial.summary.files < expectedFiles, 'Cancellation must interrupt enumeration.');
  checks.push('stdin cancellation returns promptly and saves an internally consistent partial snapshot');

  const emptyRoot = path.join(scratch, 'empty'); fs.mkdirSync(emptyRoot);
  const emptyPath = path.join(scratch, 'empty.json');
  assert.equal((await scan(emptyRoot, emptyPath)).code, 0);
  const empty = JSON.parse(fs.readFileSync(emptyPath, 'utf8')); inspect(empty);
  assert.equal(empty.status, 'complete'); assert.equal(empty.nodes.length, 1);
  checks.push('Empty-root scan completes with a single zero-byte root');

  const report = {
    passed: true, runAt: new Date().toISOString(), checks,
    fixture: { files: expectedFiles, logicalBytes: expectedBytes, sparseBytes, nodes: serial.nodes.length },
    serial: { ...serial.summary, wallMs: serialRun.wallMs },
    parallel: { ...parallel.summary, wallMs: parallelRun.wallMs },
    cancellation: { ...partial.summary, wallMs: cancelled.wallMs },
    executableSha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex')
  };
  fs.writeFileSync(path.join(__dirname, 'scanner-test-results.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(() => {
    // Guard the exact generated temporary target before recursive cleanup.
    const resolved = path.resolve(scratch), temp = path.resolve(os.tmpdir());
    if (path.dirname(resolved) === temp && path.basename(resolved).startsWith('spacelens-scanner-test-'))
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
  });
