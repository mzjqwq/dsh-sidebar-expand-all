/**
 * asar-patch.js — 原地、等长地给 DSH 的侧栏会话列表打补丁。
 *
 * 目标：@deepseek-ai/dsh-client-ui-workspace 的 lib/client.js（在 app.asar 内）。
 *
 * 两处补丁：
 *   1. expand-all   点一次「展开其余 N 个会话」→ 该组 watermark 设为 Infinity，剩余全部展开。
 *   2. collapse-to-5 折叠基线恒为 5 → 点「收起」严格显示 5 个。
 *
 * 为什么必须等长：asar 的 header 记录每个条目的 offset/size，变长会打乱后续条目；
 * 同时要更新该条目的 asar integrity（SHA256，hash 与 blocks[0].hash 各一次）。
 *
 * 这个模块只做纯文件操作，不依赖 DSH 运行时，CLI 脚本与宿主插件共用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js';

/** 每个补丁：old 是官方原文片段，newText 会被空格填充到与 old 等长。 */
export const PATCHES = [
  {
    id: 'expand-all',
    old: 'visible.hiddenCount <= SESSION_WATERMARK_BASE ? Infinity : watermark + SESSION_WATERMARK_BASE',
    newText: 'Number.POSITIVE_INFINITY',
    effect: '点击「展开其余 N 个会话」时一次展开该工作区全部剩余会话',
  },
  {
    id: 'collapse-to-5',
    old: 'Math.max(SESSION_WATERMARK_BASE, requiredWatermark(group.sessions, current, group.key === revealGroup ? revealSessionId : void 0))',
    newText: 'SESSION_WATERMARK_BASE',
    effect: '点击「收起」后严格只显示 5 个会话',
  },
];

export function padded(patch) {
  return patch.newText.padEnd(patch.old.length, ' ');
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 默认备份目录：用户级，跟着 ~/.dsh 走，不写进 DSH 安装目录。
 * 可用 DSH_BAK 覆盖。
 */
export function defaultBackupDir() {
  return process.env.DSH_BAK || path.join(os.homedir(), '.dsh', 'dsh-sidebar-expand-all', '.asar-bak');
}

/** 优先显式路径，其次 DSH_ASAR，最后从宿主可执行文件推断（桌面版）。 */
function asarForExe(exe) {
  if (!exe) return undefined;
  return path.join(path.dirname(exe), 'resources', 'app.asar');
}

/**
 * 普通 node 运行时 execPath 是 node.exe，推断不出 DSH 安装位置；
 * 桌面重启插件会在 ~/.dsh/desktop-restart 下留 handoff/日志，里面有主进程 exe 路径。
 */
function candidatesFromRestartLogs() {
  const dir = path.join(os.homedir(), '.dsh', 'desktop-restart');
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  const files = names
    .map((n) => {
      const full = path.join(dir, n);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 5);
  for (const { full } of files) {
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const exes = [
        data.exe,
        data.executablePath,
        data.mainExe,
        data.helperIdentity?.path,
      ].filter((v) => typeof v === 'string' && path.isAbsolute(v));
      for (const exe of exes) {
        const candidate = asarForExe(exe);
        if (candidate) out.push(candidate);
      }
    } catch {
      // 单个日志坏了就跳过
    }
  }
  return out;
}

export function resolveAsar(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.DSH_ASAR) candidates.push(process.env.DSH_ASAR);
  try {
    const exeDir = path.dirname(process.execPath);
    candidates.push(path.join(exeDir, 'resources', 'app.asar'));
    // 部分安装把 resources 放在上一级（例如 portable 布局）
    candidates.push(path.join(exeDir, '..', 'resources', 'app.asar'));
  } catch {
    // 无法推断时只用显式路径
  }
  candidates.push(...candidatesFromRestartLogs());
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return path.resolve(candidate);
      }
    } catch {
      // 忽略不可访问的候选
    }
  }
  return undefined;
}

function readHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonSize = head.readUInt32LE(12);
  const base = 8 + head.readUInt32LE(4);
  const jsonBuf = Buffer.alloc(jsonSize);
  fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
  return { head, jsonSize, base, jsonBuf, header: JSON.parse(jsonBuf.toString('utf8')) };
}

function entryOf(header) {
  let node = header;
  for (const part of ENTRY.split('/')) {
    node = node?.files?.[part];
    if (!node) throw new Error(`asar 中找不到 ${ENTRY}（在 ${part} 处中断）`);
  }
  if (node.files || node.offset === undefined) throw new Error('目标不是文件条目');
  return node;
}

function readEntry(fd, base, node) {
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
  return buf;
}

/** 在 header JSON 原文里等长替换目标条目的旧 hash（出现两次：hash 与 blocks[0].hash）。 */
function swapHash(jsonBuf, oldHash, newHash) {
  const before = jsonBuf.toString('utf8');
  const occurrences = before.split(oldHash).length - 1;
  if (occurrences < 2) throw new Error(`header 中旧 hash 出现 ${occurrences} 次，预期至少 2 次`);
  const after = before.split(oldHash).join(newHash);
  const out = Buffer.from(after, 'utf8');
  if (out.length !== jsonBuf.length) throw new Error(`header 长度会变化（${jsonBuf.length} -> ${out.length}），中止`);
  return out;
}

function patchState(text, patch) {
  if (text.includes(padded(patch))) return 'applied';
  if (text.includes(patch.old)) return 'pending';
  return 'missing';
}

/**
 * 读取当前补丁状态。
 * @returns {{
 *   available: boolean, asarPath?: string, entry: string, headerOk?: boolean,
 *   size?: number, offset?: number, headerHash?: string, actualHash?: string,
 *   patches?: Array<{id: string, state: string, effect: string}>, status?: string,
 *   error?: string,
 * }}
 */
export function inspect({ asarPath } = {}) {
  const resolved = resolveAsar(asarPath);
  if (!resolved) {
    return {
      available: false,
      entry: ENTRY,
      status: 'no-asar',
      error: '找不到 app.asar：本插件只支持 DeepSeek Harness 桌面版；可用 DSH_ASAR 指定路径。',
    };
  }
  let fd;
  try {
    fd = fs.openSync(resolved, 'r');
    const { base, jsonBuf, header } = readHeader(fd);
    const node = entryOf(header);
    const buf = readEntry(fd, base, node);
    const text = buf.toString('utf8');
    const actualHash = sha256(buf);
    const headerHash = node.integrity?.hash;
    const headerOk = actualHash === headerHash;
    const patches = PATCHES.map((p) => ({ id: p.id, state: patchState(text, p), effect: p.effect }));
    let status;
    if (!headerOk) status = 'inconsistent';
    else if (patches.every((p) => p.state === 'applied')) status = 'patched';
    else if (patches.every((p) => p.state === 'missing')) status = 'unsupported';
    else if (patches.some((p) => p.state === 'applied') || patches.some((p) => p.state === 'pending')) status = 'partial';
    else status = 'clean';
    return {
      available: true,
      asarPath: resolved,
      entry: ENTRY,
      headerOk,
      size: node.size,
      offset: node.offset,
      headerHash,
      actualHash,
      patches,
      status,
    };
  } catch (error) {
    return {
      available: true,
      asarPath: resolved,
      entry: ENTRY,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** 打补丁（幂等）。返回与 inspect 相同结构，外加 applied/already/backupDir。 */
export function apply({ asarPath, backupDir } = {}) {
  const resolved = resolveAsar(asarPath);
  if (!resolved) throw new Error('找不到 app.asar：本插件只支持 DeepSeek Harness 桌面版；可用 DSH_ASAR 指定路径。');
  const bak = backupDir || defaultBackupDir();
  const fd = fs.openSync(resolved, 'r+');
  try {
    const { jsonSize, base, jsonBuf, header } = readHeader(fd);
    const node = entryOf(header);
    const buf = readEntry(fd, base, node);
    const text0 = buf.toString('utf8');
    const actualHash = sha256(buf);
    const headerHash = node.integrity?.hash;
    if (actualHash !== headerHash) {
      throw new Error('当前文件内容与 header integrity 不一致（asar 可能已被其它工具改过），中止以免破坏。');
    }

    const applied = [];
    const already = [];
    let text = text0;
    for (const patch of PATCHES) {
      const newStr = padded(patch);
      if (text.includes(newStr)) {
        already.push(patch.id);
        continue;
      }
      const idx = text.indexOf(patch.old);
      if (idx === -1) {
        throw new Error(`补丁 ${patch.id} 找不到官方片段（DSH 可能已改版，请更新插件）`);
      }
      if (text.indexOf(patch.old, idx + 1) !== -1) {
        throw new Error(`补丁 ${patch.id} 的官方片段出现多次，拒绝猜测替换哪一处`);
      }
      text = text.slice(0, idx) + newStr + text.slice(idx + patch.old.length);
      applied.push(patch.id);
    }

    if (applied.length === 0) {
      return { available: true, asarPath: resolved, entry: ENTRY, status: 'patched', applied, already, backupDir: bak };
    }

    fs.mkdirSync(bak, { recursive: true });
    const bakHeader = path.join(bak, 'header.bin');
    const bakClient = path.join(bak, 'client.js.orig');
    if (fs.existsSync(bakHeader) && fs.existsSync(bakClient)) {
      let prev;
      try {
        prev = entryOf(JSON.parse(fs.readFileSync(bakHeader, 'utf8')));
      } catch {
        prev = undefined;
      }
      if (!prev || prev.size !== node.size || String(prev.offset) !== String(node.offset)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const archive = path.join(bak, `legacy-${stamp}`);
        fs.mkdirSync(archive, { recursive: true });
        fs.renameSync(bakHeader, path.join(archive, 'header.bin'));
        fs.renameSync(bakClient, path.join(archive, 'client.js.orig'));
      }
    }
    if (!fs.existsSync(bakHeader)) fs.writeFileSync(bakHeader, jsonBuf);
    if (!fs.existsSync(bakClient)) fs.writeFileSync(bakClient, buf);

    const patched = Buffer.from(text, 'utf8');
    if (patched.length !== buf.length) throw new Error('替换后大小变化，中止');
    const patchedHash = sha256(patched);
    const newHeader = swapHash(jsonBuf, headerHash, patchedHash);
    fs.writeSync(fd, patched, 0, patched.length, base + Number(node.offset));
    fs.writeSync(fd, newHeader, 0, newHeader.length, 16);

    const verify = readHeader(fd);
    const vNode = entryOf(verify.header);
    const vBuf = readEntry(fd, verify.base, vNode);
    const vHash = sha256(vBuf);
    if (vHash !== vNode.integrity.hash) throw new Error('回读校验失败：header hash 与内容不一致');
    const vText = vBuf.toString('utf8');
    for (const patch of PATCHES) {
      if (!vText.includes(padded(patch))) throw new Error(`回读校验失败：补丁 ${patch.id} 片段不存在`);
    }
    return {
      available: true,
      asarPath: resolved,
      entry: ENTRY,
      status: 'patched',
      applied,
      already,
      backupDir: bak,
      size: vNode.size,
      offset: vNode.offset,
      previousHash: headerHash,
      hash: vHash,
      headerBytes: jsonSize,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** 从备份还原（只还原目标条目与 header）。 */
export function restore({ asarPath, backupDir } = {}) {
  const resolved = resolveAsar(asarPath);
  if (!resolved) throw new Error('找不到 app.asar');
  const bak = backupDir || defaultBackupDir();
  const bakHeader = path.join(bak, 'header.bin');
  const bakClient = path.join(bak, 'client.js.orig');
  if (!fs.existsSync(bakHeader) || !fs.existsSync(bakClient)) {
    throw new Error(`找不到备份（${bak}），无法自动还原。`);
  }
  const fd = fs.openSync(resolved, 'r+');
  try {
    const { jsonSize, base } = readHeader(fd);
    const origHeader = fs.readFileSync(bakHeader);
    const origClient = fs.readFileSync(bakClient);
    if (origHeader.length !== jsonSize) throw new Error('备份 header 大小与当前 asar header 不一致，中止');
    const origNode = entryOf(JSON.parse(origHeader.toString('utf8')));
    if (origNode.size !== origClient.length || sha256(origClient) !== origNode.integrity.hash) {
      throw new Error('备份 header 与备份 client.js 不匹配，中止');
    }
    fs.writeSync(fd, origClient, 0, origClient.length, base + Number(origNode.offset));
    fs.writeSync(fd, origHeader, 0, origHeader.length, 16);
    return { available: true, asarPath: resolved, entry: ENTRY, status: 'restored', backupDir: bak };
  } finally {
    fs.closeSync(fd);
  }
}

/** 包内脚本/skill 的位置（用于 CLI 与插件安装 skill）。 */
export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
