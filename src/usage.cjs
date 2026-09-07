'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const DAY_MS = 86400000;
const FILETIME_EPOCH = 116444736000000000n;
const UNKNOWN_NOTE = '没有可确认的运行记录；这不表示从未打开或长期未使用。';

function rot13(value) {
  return String(value).replace(/[a-zA-Z]/g, c => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(base + (c.charCodeAt(0) - base + 13) % 26);
  });
}

// Windows paths are compared lexically, case-insensitively, with segment boundaries.
// Never turn a relative registry value, icon name, or app basename into a directory.
function canonicalPath(value) {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  let clean = value.trim().replace(/^"(.*)"$/, '$1').replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(clean)) clean = '\\\\' + clean.slice(8);
  else if (/^\\\\\?\\/.test(clean)) clean = clean.slice(4);
  if (!/^[a-z]:\\/i.test(clean) && !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(clean)) return null;
  clean = path.win32.normalize(clean).toLowerCase();
  const root = path.win32.parse(clean).root;
  while (clean.length > root.length && clean.endsWith('\\')) clean = clean.slice(0, -1);
  return clean;
}

function withinPath(childValue, parentValue) {
  const child = canonicalPath(childValue);
  const parent = canonicalPath(parentValue);
  return Boolean(child && parent && (child === parent || child.startsWith(parent.endsWith('\\') ? parent : parent + '\\')));
}

function validTime(value, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis >= 0 && millis <= now + 300000 ? new Date(millis).toISOString() : null;
}

function filetimeToIso(bytes, offset = 0, now = Date.now()) {
  if (!Buffer.isBuffer(bytes) || offset < 0 || offset + 8 > bytes.length) return null;
  const ticks = bytes.readBigUInt64LE(offset);
  if (ticks <= FILETIME_EPOCH) return null;
  const millis = Number((ticks - FILETIME_EPOCH) / 10000n);
  if (!Number.isSafeInteger(millis) || millis > now + 300000 || millis > 8640000000000000) return null;
  return new Date(millis).toISOString();
}

function parseUserAssistRecord(record, now = Date.now()) {
  if (!record || typeof record.data !== 'string') return null;
  const bytes = Buffer.from(record.data, 'base64');
  // Modern Windows layout: 72-byte records, FILETIME at offset 60.
  // Unknown/truncated/legacy layouts are intentionally not guessed.
  if (bytes.length < 72) return null;
  const lastRun = filetimeToIso(bytes, 60, now);
  const decoded = typeof record.encodedName === 'string' ? rot13(record.encodedName).replace(/^UEME_RUNPATH:/i, '') : '';
  const resolved = record.path || decoded;
  if (!lastRun || !canonicalPath(resolved)) return null;
  return { path: resolved, lastRun, source: record.shortcut ? 'UserAssist/Shortcut' : 'UserAssist' };
}

function isBroadInstallLocation(value) {
  const key = canonicalPath(value);
  if (!key) return true;
  if (key === path.win32.parse(key).root) return true;
  const broad = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData,
    process.env.LOCALAPPDATA, process.env.APPDATA, process.env.USERPROFILE, process.env.SystemRoot,
    process.env.LOCALAPPDATA && path.win32.join(process.env.LOCALAPPDATA, 'Programs')];
  return broad.some(p => p && canonicalPath(p) === key) || /^[a-z]:\\(?:program files(?: \(x86\))?|programdata|users|windows)$/i.test(key);
}

function sourceNote(source, appName, aggregated) {
  const subject = appName ? `关联软件「${appName}」` : aggregated ? '目录内程序' : '此程序';
  if (source === 'RunningProcess') return `${subject}在采集时正在运行；这是可见的进程证据，不代表前台使用时长。`;
  if (source === 'UserAssist/Shortcut') return `${subject}有 Windows 启动记录；快捷方式按当前目标解析，历史目标可能不同。记录可能不完整。`;
  return `${subject}有 Windows 启动记录；这是最后可见记录，不等于精确的最后使用时间，缺失记录不能证明未使用。`;
}

function latestObservation(observations, now) {
  let result = null;
  for (const observation of observations) {
    const time = validTime(observation && observation.lastRun, now);
    if (!time) continue;
    if (!result || time > result.lastRun || (time === result.lastRun && observation.source === 'RunningProcess')) {
      result = { ...observation, lastRun: time };
    }
  }
  return result;
}

function translateWarning(value) {
  const exact = {
    'Known folder resolution unavailable; unresolved records were skipped.': '无法解析 Windows 已知目录；相关记录已跳过。',
    'An uninstall registry view could not be read.': '部分安装信息注册表无法读取。',
    'Shortcut target resolution unavailable.': '无法读取快捷方式目标；相关记录已跳过。',
    'Some current-user UserAssist records could not be read.': '部分当前用户的 Windows 启动记录无法读取。',
    'Current-user UserAssist is unavailable.': '当前用户的 Windows 启动记录不可用。',
    'Running process paths are unavailable.': '无法读取正在运行的程序路径。'
  };
  if (exact[value]) return exact[value];
  const unresolved = /^Skipped (\d+) records without a resolvable local target\.$/.exec(value);
  if (unresolved) return `已跳过 ${unresolved[1]} 条无法解析到本地目标的记录。`;
  const protectedProcesses = /^Executable paths unavailable for (\d+) protected or inaccessible processes\.$/.exec(value);
  if (protectedProcesses) return `${protectedProcesses[1]} 个受保护或无权读取的进程未提供路径。`;
  return value;
}

function normalizeProbe(probe = {}, now = Date.now()) {
  const collectedAt = validTime(probe.collectedAt, now) || new Date(now).toISOString();
  const observations = [];
  const seenObservations = new Map();
  const append = observation => {
    if (!observation || !canonicalPath(observation.path)) return;
    const lastRun = validTime(observation.lastRun, now);
    if (!lastRun) return;
    const key = canonicalPath(observation.path) + '\0' + observation.source;
    const previous = seenObservations.get(key);
    if (!previous || previous.lastRun < lastRun) seenObservations.set(key, { path: observation.path, lastRun, source: observation.source });
  };
  for (const record of Array.isArray(probe.userAssist) ? probe.userAssist : []) append(parseUserAssistRecord(record, now));
  for (const processPath of Array.isArray(probe.processes) ? probe.processes : []) {
    if (typeof processPath === 'string') append({ path: processPath, lastRun: collectedAt, source: 'RunningProcess' });
  }
  observations.push(...seenObservations.values());
  const apps = [];
  const seenApps = new Set();
  for (const raw of Array.isArray(probe.apps) ? probe.apps : []) {
    if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) continue;
    const installLocation = canonicalPath(raw.installLocation) && !isBroadInstallLocation(raw.installLocation) ? raw.installLocation : '';
    const executable = canonicalPath(raw.executable) && /\.exe$/i.test(raw.executable) ? raw.executable : undefined;
    const key = raw.name.trim().toLowerCase() + '\0' + (canonicalPath(installLocation) || '') + '\0' + (canonicalPath(executable) || '');
    if (seenApps.has(key)) continue;
    seenApps.add(key);
    const observed = latestObservation(observations.filter(o =>
      (installLocation && withinPath(o.path, installLocation)) || (executable && canonicalPath(o.path) === canonicalPath(executable))), now);
    const app = { name: raw.name.trim(), installLocation, lastRun: observed?.lastRun || null,
      source: observed?.source || 'Unavailable', confidence: observed ? 'observed' : 'unknown',
      note: observed ? sourceNote(observed.source, raw.name.trim(), false) : UNKNOWN_NOTE };
    if (executable) app.executable = executable;
    const estimated=Number(raw.estimatedSizeKB);
    app.estimatedBytes=Number.isFinite(estimated)&&estimated>0&&estimated<Number.MAX_SAFE_INTEGER/1024?Math.round(estimated*1024):null;
    app.publisher=typeof raw.publisher==='string'?raw.publisher:'';
    app.version=typeof raw.version==='string'?raw.version:'';
    app.uninstall=raw.uninstall&&typeof raw.uninstall.key==='string'?raw.uninstall:null;
    apps.push(app);
  }
  const rawPolicy = typeof probe.lastAccessPolicy === 'string' && /^NtfsDisableLastAccessUpdate=(0x[0-9A-F]+);/i.exec(probe.lastAccessPolicy);
  return { collectedAt, apps, observations, warnings: Array.isArray(probe.warnings) ? probe.warnings.filter(s => typeof s === 'string').map(translateWarning) : [],
    lastAccessPolicy: rawPolicy ? `NTFS 访问时间策略原始值 ${rawPolicy[1]}；文件访问时间不用于推断软件使用。` : '无法读取；文件访问时间不用于推断软件使用。' };
}

async function collectUsage() {
  if (process.platform !== 'win32') return normalizeProbe({ warnings: ['使用记录采集只支持 Windows。'] });
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await runFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'usage-probe.ps1')], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 25000, maxBuffer: 32 * 1024 * 1024 });
    return normalizeProbe(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
  } catch (error) {
    const reason = error.killed ? '采集超时' : error.code === 'ENOENT' ? '未找到 Windows PowerShell' : '当前权限或系统策略不允许完成采集';
    return normalizeProbe({ warnings: [`使用证据未能采集：${reason}。缺少记录不能证明未使用。`] });
  }
}

function evidenceForPath(targetPath, usage = {}) {
  const target = canonicalPath(targetPath);
  const unknown = { lastRun: null, daysSince: null, source: 'Unavailable', confidence: 'unknown', note: UNKNOWN_NOTE };
  if (!target) return unknown;
  const now = Date.parse(usage.collectedAt) || Date.now();
  const apps = (Array.isArray(usage.apps) ? usage.apps : []).filter(app => app && (
    (app.installLocation && !isBroadInstallLocation(app.installLocation) && withinPath(target, app.installLocation)) ||
    (app.executable && target === canonicalPath(app.executable))))
    .sort((a, b) => (canonicalPath(b.installLocation)?.length || 0) - (canonicalPath(a.installLocation)?.length || 0));
  const app = apps[0];
  const observations = (Array.isArray(usage.observations) ? usage.observations : []).filter(observation => observation && (
    withinPath(observation.path, target) ||
    (app?.installLocation && withinPath(observation.path, app.installLocation)) ||
    (app?.executable && canonicalPath(observation.path) === canonicalPath(app.executable))));
  if (app?.confidence === 'observed' && app.lastRun) observations.push({ lastRun: app.lastRun, source: app.source });
  const latest = latestObservation(observations, now);
  if (!latest) return app ? { ...unknown, appName: app.name } : unknown;
  const aggregated = Boolean(latest.path && canonicalPath(latest.path) !== target);
  return { lastRun: latest.lastRun, daysSince: Math.max(0, Math.floor((now - Date.parse(latest.lastRun)) / DAY_MS)),
    source: latest.source || 'Unavailable', confidence: 'observed', note: sourceNote(latest.source, app?.name, aggregated),
    ...(app ? { appName: app.name } : {}) };
}

module.exports = { collectUsage, evidenceForPath, rot13, canonicalPath, withinPath, filetimeToIso, parseUserAssistRecord, normalizeProbe };
