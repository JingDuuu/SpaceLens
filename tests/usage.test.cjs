'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rot13, canonicalPath, withinPath, filetimeToIso, parseUserAssistRecord, normalizeProbe, evidenceForPath } = require('../src/usage.cjs');
const now = Date.parse('2026-09-05T12:00:00Z');
const lastRun = '2026-08-01T12:00:00.000Z';

function userAssist(path, time = lastRun) {
  const data = Buffer.alloc(72);
  data.writeBigUInt64LE(BigInt(Date.parse(time)) * 10000n + 116444736000000000n, 60);
  return { encodedName: rot13(path), data: data.toString('base64') };
}

test('UserAssist ROT13 is ASCII-only and reads FILETIME at byte 60', () => {
  assert.equal(rot13('P:\\软件\\GbbY.rkr'), 'C:\\软件\\TooL.exe');
  const parsed = parseUserAssistRecord(userAssist('C:\\Apps\\Tool\\Tool.exe'), now);
  assert.deepEqual(parsed, { path: 'C:\\Apps\\Tool\\Tool.exe', lastRun, source: 'UserAssist' });
  assert.equal(filetimeToIso(Buffer.alloc(8), 0, now), null);
  assert.equal(parseUserAssistRecord({ ...userAssist('C:\\A.exe'), data: Buffer.alloc(68).toString('base64') }, now), null);
  assert.equal(parseUserAssistRecord(userAssist('C:\\A.exe', '2099-01-01T00:00:00Z'), now), null);
});

test('canonical path matches complete segments and rejects relative paths', () => {
  assert.equal(canonicalPath('"C:/Apps/Tool/../TOOL/"'), 'c:\\apps\\tool');
  assert.equal(canonicalPath('\\\\?\\C:\\Apps\\Tool'), 'c:\\apps\\tool');
  assert.equal(canonicalPath('\\\\?\\UNC\\nas\\disk\\Tools'), '\\\\nas\\disk\\tools');
  assert.equal(canonicalPath('Tool.exe'), null);
  assert.equal(canonicalPath('C:Tool.exe'), null);
  assert.equal(canonicalPath('\\Apps\\Tool'), null);
  assert.equal(withinPath('c:\\Apps\\Tool\\bin\\tool.exe', 'C:\\APPS\\Tool\\'), true);
  assert.equal(withinPath('c:\\Apps\\Toolbox\\app.exe', 'C:\\Apps\\Tool'), false);
  assert.equal(withinPath('D:\\Tool\\app.exe', 'C:\\Tool'), false);
});

test('missing evidence remains unknown even for installed apps or file timestamps', () => {
  const usage = normalizeProbe({ collectedAt: new Date(now).toISOString(), apps: [{ name: 'Tool', installLocation: 'C:\\Apps\\Tool', lastAccess: lastRun, lastModified: lastRun }] }, now);
  assert.equal(usage.apps[0].confidence, 'unknown');
  const evidence = evidenceForPath('C:\\Apps\\Tool', usage);
  assert.equal(evidence.lastRun, null);
  assert.equal(evidence.daysSince, null);
  assert.equal(evidence.confidence, 'unknown');
  assert.match(evidence.note, /不表示从未打开/);
});

test('currently running evidence wins over older launch evidence', () => {
  const usage = normalizeProbe({ collectedAt: new Date(now).toISOString(),
    apps: [{ name: 'Tool', installLocation: 'C:\\Apps\\Tool' }],
    userAssist: [userAssist('C:\\Apps\\Tool\\Tool.exe')], processes: ['c:\\Apps\\Tool\\Tool.exe'] }, now);
  const evidence = evidenceForPath('C:\\Apps\\Tool', usage);
  assert.equal(evidence.source, 'RunningProcess');
  assert.equal(evidence.daysSince, 0);
  assert.equal(evidence.lastRun, new Date(now).toISOString());
  assert.match(evidence.note, /采集时正在运行/);
});

test('latest launch wins independently of record order with honest elapsed days', () => {
  const usage = normalizeProbe({ collectedAt: new Date(now).toISOString(),
    apps: [{ name: 'Tool', installLocation: 'C:\\Apps\\Tool' }],
    userAssist: [userAssist('C:\\Apps\\Tool\\B.exe', '2026-08-15T12:00:00Z'), userAssist('C:\\Apps\\Tool\\A.exe')] }, now);
  const evidence = evidenceForPath('C:\\Apps\\Tool', usage);
  assert.equal(evidence.lastRun, '2026-08-15T12:00:00.000Z');
  assert.equal(evidence.daysSince, 21);
  assert.equal(evidence.confidence, 'observed');
  assert.equal(evidence.appName, 'Tool');
});

test('similarly named sibling folders and executables cannot borrow usage', () => {
  const usage = normalizeProbe({ collectedAt: new Date(now).toISOString(),
    apps: [{ name: 'Tool', installLocation: 'C:\\Apps\\Tool' }], processes: ['C:\\Apps\\Toolbox\\Tool.exe', 'D:\\Apps\\Tool\\Tool.exe'] }, now);
  assert.equal(evidenceForPath('C:\\Apps\\Tool', usage).confidence, 'unknown');
});

test('missing install directory never expands an icon executable to its parent', () => {
  const usage = normalizeProbe({ collectedAt: new Date(now).toISOString(),
    apps: [{ name: 'Portable', executable: 'C:\\Programs\\shared.exe' }], processes: ['C:\\Programs\\other.exe'] }, now);
  assert.equal(usage.apps[0].installLocation, '');
  assert.equal(usage.apps[0].lastRun, null);
  assert.equal(evidenceForPath('C:\\Programs\\shared.exe', usage).confidence, 'unknown');
});

test('broad install roots are not accepted as app ownership', () => {
  const usage = normalizeProbe({ collectedAt: new Date(now).toISOString(),
    apps: [{ name: 'Bad installer', installLocation: 'C:\\' }, { name: 'Other bad installer', installLocation: 'C:\\Program Files' }],
    processes: ['C:\\Other\\App.exe'] }, now);
  assert.ok(usage.apps.every(app => app.installLocation === '' && app.lastRun === null));
  assert.equal(evidenceForPath('C:\\Other', usage).appName, undefined);
});

test('more specific install location wins and links retain their evidence caveat', () => {
  const linked = { ...userAssist('{GUID}\\App.lnk'), path: 'C:\\Suite\\Specific\\tool.exe', shortcut: true };
  const usage = normalizeProbe({ collectedAt: new Date(now).toISOString(),
    apps: [{ name: 'Suite', installLocation: 'C:\\Suite' }, { name: 'Specific', installLocation: 'C:\\Suite\\Specific' }], userAssist: [linked] }, now);
  const evidence = evidenceForPath('C:\\Suite\\Specific', usage);
  assert.equal(evidence.appName, 'Specific');
  assert.equal(evidence.source, 'UserAssist/Shortcut');
  assert.match(evidence.note, /历史目标可能不同/);
});
