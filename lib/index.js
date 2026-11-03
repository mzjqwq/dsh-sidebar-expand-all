/**
 * dsh-sidebar-expand-all — 宿主端插件。
 *
 * 提供三件事：
 *   1. 本机 HTTP 页面 / 接口，用来查看补丁状态、一键应用 / 还原；
 *   2. 把随包的 SKILL.md 与 CLI 脚本安装到 ~/.dsh/skills/dsh-sidebar-expand-all/，
 *      让任何会话里的 agent 都能直接调用；
 *   3. 应用后提示必须重启 DSH（宿主在启动时缓存 asar 内 bundle，刷新页面无效）。
 *
 * 本插件只做文件补丁，不接管 UI；侧栏行为补丁在重启后由宿主自己生效。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply as applyPatches, inspect, packageRoot, restore } from './asar-patch.js';

export const name = 'dsh-sidebar-expand-all';

export const ROUTE_PREFIX = '/dsh-sidebar-expand-all';

const SKILL_NAME = 'dsh-sidebar-expand-all';

const root = packageRoot();

function log(...args) {
  try {
    console.log('[dsh-sidebar-expand-all]', ...args);
  } catch {
    // 日志失败不影响主流程
  }
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 把随包的 skill 与脚本安装到用户级 skill 目录。
 * 只写本插件自己的目录；已存在的同名文件会被插件版本覆盖（插件是这些文件的来源）。
 */
export function installSkill() {
  const target = path.join(dshHome(), 'skills', SKILL_NAME);
  try {
    fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
    fs.copyFileSync(
      path.join(root, 'skills', SKILL_NAME, 'SKILL.md'),
      path.join(target, 'SKILL.md'),
    );
    // CLI 脚本 + 单一实现的 asar-patch.js（覆盖仓库里的 re-export 占位文件）
    fs.copyFileSync(
      path.join(root, 'scripts', 'patch-workspace-expand-all.mjs'),
      path.join(target, 'scripts', 'patch-workspace-expand-all.mjs'),
    );
    fs.mkdirSync(path.join(target, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(
      path.join(root, 'lib', 'asar-patch.js'),
      path.join(target, 'scripts', 'lib', 'asar-patch.js'),
    );
    log(`skill installed at ${target}`);
    return target;
  } catch (error) {
    log(`skill install failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(body));
  });
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-sidebar-expand-all</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 32px; max-width: 860px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #777; margin-bottom: 24px; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
  button { font: inherit; padding: 7px 16px; border-radius: 8px; border: 1px solid #8886; background: #8881; cursor: pointer; }
  button:hover { background: #8882; }
  button.primary { background: #4c8dff; border-color: #4c8dff; color: #fff; }
  button.danger { color: #d33; border-color: #d336; }
  code { font-family: ui-monospace, Consolas, monospace; background: #8881; padding: 1px 5px; border-radius: 4px; }
  pre { background: #8881; padding: 12px; border-radius: 8px; overflow: auto; font-size: 12px; }
  .ok { color: #2a8a3a; } .warn { color: #c47f00; } .bad { color: #c22; }
</style>
</head>
<body>
<h1>DSH 侧栏会话：一次全展开 + 收起回 5</h1>
<div class="sub">dsh-sidebar-expand-all · 打补丁后必须<b>完全退出并重新打开 DSH</b> 才生效（刷新页面无效）。</div>

<div class="card">
  <div class="row"><b>状态</b><span id="status">读取中…</span></div>
  <div id="detail" class="row"></div>
  <div class="row">
    <button class="primary" id="apply">应用补丁</button>
    <button id="restore" class="danger">还原官方文件</button>
    <button id="refresh">刷新</button>
  </div>
  <pre id="log" hidden></pre>
</div>

<div class="card">
  <b>说明</b>
  <ul>
    <li>应用后点一次侧栏里的「展开其余 N 个会话」，该工作区剩下的会话会<b>一次全部展开</b>。</li>
    <li>点「收起」严格回到 5 个。</li>
    <li>DSH 升级后 asar 会被整体替换，补丁失效；回来这里重新点「应用补丁」即可。</li>
    <li>插件同时把 SKILL 安装到 <code>~/.dsh/skills/dsh-sidebar-expand-all/</code>，可以直接让 agent 调用。</li>
  </ul>
</div>

<script>
const el = (id) => document.getElementById(id);
const show = (payload) => { el('log').hidden = false; el('log').textContent = JSON.stringify(payload, null, 2); };
const STATUS_TEXT = {
  patched: ['已应用（重启后生效）', 'ok'],
  partial: ['部分应用（再次点击应用即可补齐）', 'warn'],
  clean: ['未应用', 'warn'],
  unsupported: ['当前 DSH 版本未找到补丁锚点，需要更新插件', 'bad'],
  inconsistent: ['asar 内容与 integrity 不一致，已停止操作', 'bad'],
  'no-asar': ['找不到 app.asar（仅支持桌面版）', 'bad'],
  error: ['读取失败', 'bad'],
};
async function refresh() {
  try {
    const res = await fetch('/dsh-sidebar-expand-all/status', { cache: 'no-store' });
    const data = await res.json();
    const [text, cls] = STATUS_TEXT[data.status] || [data.status, ''];
    el('status').textContent = text;
    el('status').className = cls;
    const parts = [];
    if (data.asarPath) parts.push('asar: ' + data.asarPath);
    if (data.patches) parts.push('补丁: ' + data.patches.map(p => p.id + '=' + p.state).join(', '));
    if (data.error) parts.push('错误: ' + data.error);
    el('detail').textContent = parts.join(' · ');
  } catch (error) {
    el('status').textContent = '请求失败：' + error;
    el('status').className = 'bad';
  }
}
async function post(url) {
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  show(data);
  await refresh();
}
el('apply').onclick = () => post('/dsh-sidebar-expand-all/apply');
el('restore').onclick = () => post('/dsh-sidebar-expand-all/restore');
el('refresh').onclick = refresh;
refresh();
</script>
</body>
</html>`;

/**
 * 插件入口。ctx 为 DSH 的 Host 插件上下文。
 */
export function applyPlugin(ctx) {
  // 安装/更新随包 skill：即使 webServer 不可用也能完成
  try {
    installSkill();
  } catch (error) {
    log(`skill install error: ${error instanceof Error ? error.message : String(error)}`);
  }

  const current = inspect();
  if (current.available) log(`asar=${current.asarPath} status=${current.status}`);

  ctx.inject(['webServer', 'connection'], (child) => {
    const fence = (req, res) => {
      const rejection = child.connection.requestRejection(req);
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return true;
      }
      return false;
    };

    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (fence(req, res)) return;
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET');
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(PAGE);
      },
    }), 'dsh-sidebar-expand-all: page');

    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: async (req, res) => {
        if (fence(req, res)) return;
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('allow', 'GET');
          res.end();
          return;
        }
        json(res, 200, inspect());
      },
    }), 'dsh-sidebar-expand-all: status');

    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/apply`,
      handler: async (req, res) => {
        if (fence(req, res)) return;
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('allow', 'POST');
          res.end();
          return;
        }
        await readBody(req);
        try {
          const result = applyPatches();
          json(res, 200, { ...result, restartRequired: true, note: '必须完全退出并重新打开 DSH 才生效。' });
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    }), 'dsh-sidebar-expand-all: apply');

    child.effect(() => child.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/restore`,
      handler: async (req, res) => {
        if (fence(req, res)) return;
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('allow', 'POST');
          res.end();
          return;
        }
        await readBody(req);
        try {
          const result = restore();
          json(res, 200, { ...result, restartRequired: true, note: '必须完全退出并重新打开 DSH 才生效。' });
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    }), 'dsh-sidebar-expand-all: restore');
  });
}

/** DSH 的插件加载器默认调用 apply(ctx)。 */
export function apply(ctx) {
  return applyPlugin(ctx);
}
