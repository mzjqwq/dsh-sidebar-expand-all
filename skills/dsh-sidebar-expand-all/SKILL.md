---
name: dsh-sidebar-expand-all
description: 给 DeepSeek Harness 桌面版打侧栏会话列表补丁：点一次「展开其余 N 个会话」就展开该工作区全部会话，「收起」严格回到 5 个。适用于 DSH 升级后补丁失效需要重打、侧栏一次只展开 5 个、收起后仍显示太多会话，以及需要安全原地修改 app.asar（等长替换 + 更新 asar integrity）再重启 DSH 的场景。
---

# DSH 侧栏会话：一次全展开 + 收起回 5

## 适用场景

- 侧栏分组里「展开其余 XX 个会话」每点一次只多 5 个，要点很多次。
- 点「收起」后没有回到 5 个（折叠基线被运行中/未读会话抬高）。
- DSH 升级后原来的补丁失效（asar 被整体替换）。
- 需要不重打包、原地修改 app.asar 内的 client bundle。

## 目标

- asar：桌面版默认 `<DeepSeek Harness.exe 所在目录>/resources/app.asar`；可用 `DSH_ASAR` 覆盖。
- 条目：`dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`

四处等长替换（v1.0.1 起）：

1. **toggle-all**（点击「展开其余」的整个 onClick 块，含收起分支）：
   原文是 `if (sessionsExpanded) { dropWatermarks(...); return; }` + 三元 `visible.hiddenCount <= SESSION_WATERMARK_BASE ? Infinity : watermark + SESSION_WATERMARK_BASE`；
   改为一行 `setStoredWatermarks((marks) => ({ ...marks, [group.key]: sessionsExpanded ? SESSION_WATERMARK_BASE : Number.POSITIVE_INFINITY }));`
   效果：点一次「展开其余 N 个会话」把该组 watermark 写成 Infinity（剩余全部展开），点「收起」写回 5（**不再 dropWatermarks**——drop 会让 watermark 落回默认值，重启后又变回 5）。

2. **collapse-baseline**（折叠基线）：
   `Math.max(SESSION_WATERMARK_BASE, requiredWatermark(group.sessions, current, group.key === revealGroup ? revealSessionId : void 0))`
   → `SESSION_WATERMARK_BASE`
   效果：`baselines` 恒为 5 → `requiredWatermarks` 恒为 5 → 收起后严格显示 5 个，`sessionsExpanded` 判断不受影响。

3. **default-expanded**（渲染时的默认值）：
   `const watermark = sessionWatermarks[group.key] ?? SESSION_WATERMARK_BASE;`
   → `const watermark = sessionWatermarks[group.key] ?? Infinity;`
   效果：**默认全展开**——没有手动收起过的工作区（`storedWatermarks` 里没有该 key）显示全部会话。

4. **default-expanded-drag**（拖拽排序取可见行）：
   `sessionWatermarks[group.key] ?? SESSION_WATERMARK_BASE).rows`
   → `sessionWatermarks[group.key] ?? Infinity).rows`
   效果：拖拽时的 `renderedSessions` 与实际渲染一致，避免全展开状态下拖到不可见行。

> **为什么必须加 3、4（默认全展开）**：官方的 watermark 存在 `const [storedWatermarks, setStoredWatermarks] = useState({})` 里，**只存在组件内存**，既没有持久化（`dsh.workspace.view.v5` 只存 groupBy/orderBy/groupExpansion/sessionOrderByAccount/archivedFilter），组件重挂载（切工作区、切页、重启）就会丢。
> 只改补丁 1、2 时，重启后侧栏又变回 5 个，用户看到的就是「展开又不生效了」。把默认值改成 `Infinity` 才是真正的「一直全部展开」。

## 两种用法

### A. 插件提供的本机页面（推荐）

插件启用后打开：

```text
http://127.0.0.1:<当前 DSH 端口>/dsh-sidebar-expand-all
```

页面上可看状态、点「应用补丁」/「还原官方文件」。等价接口：

- `GET  /dsh-sidebar-expand-all/status`
- `POST /dsh-sidebar-expand-all/apply`
- `POST /dsh-sidebar-expand-all/restore`

### B. 命令行脚本

```bash
node scripts/patch-workspace-expand-all.mjs --check    # 只检查
node scripts/patch-workspace-expand-all.mjs            # 打补丁（幂等）
node scripts/patch-workspace-expand-all.mjs --list     # 列出内置补丁
node scripts/patch-workspace-expand-all.mjs --restore  # 还原官方文件
```

退出码：`0` 正常；`2` 找不到 asar 或备份；`3` 内容与 integrity 不一致（拒绝写入）；`4` `--check` 时 header 与实际内容 hash 不一致。

## 关键约束（踩过的坑）

- **不能改变文件大小**。asar header 为每个条目记录 offset/size，任意变长都会打乱后续条目。必须等长替换（`padEnd(old.length, ' ')`），并同步更新 header 中该条目的 `integrity.hash` 与 `integrity.blocks[0].hash`（两处同值），否则 Electron/宿主校验失败。
- **header 结构**：前 16 字节里 `readUInt32LE(4)` 参与计算数据基址（`base = 8 + 该值`），`readUInt32LE(12)` 是 header JSON 字节长度；JSON 从 offset 16 开始。
- **宿主缓存**：0.2.1-rc.5 起，host 启动时把 asar 内每个 client bundle 的 mtime/size 与内容缓存在内存；`dsh-client-hmr` 每 500ms stat 到的仍是启动时的旧值，所以改 asar 后**热更和刷新页面都不生效**，必须重启主进程。
- **备份版本判定用 size/offset，不要只用 hash**：补丁不改变 size/offset；只比 hash 会把同版本官方备份误判为旧版本而归档。
- **DSH 升级会整体替换 asar**：升级后补丁消失，重新执行一次即可；若 `--check` 报「找不到官方片段」，说明新版源码结构变了，需要按新版重新定位两处表达式。
- Electron fuse `EnableEmbeddedAsarIntegrityValidation` 在发行版里是 disabled，但更新 hash 仍要照做，保证自检与将来 fuse 打开时不炸。

## 验证

1. `--check`：四处补丁「已应用」且 header hash 与实际内容一致。
2. 从 asar 提取 client.js：`node --check` 通过。
3. 遍历所有 entry 校验 integrity：`bad=0`。
4. 重启后：**默认就是全部展开**；点「收起」严格 5 个；再点一次「展开其余 N 个会话」一次全展开；再重启仍保持（默认值即 Infinity）。

## 重启 DSH

改完必须重启整个 DSH 桌面应用（不是刷新页面）。推荐用已装的 `@luoshuizhiwei/dsh-desktop-restart`：

```bash
node ~/.dsh/profiles/desktop/node_modules/@luoshuizhiwei/dsh-desktop-restart/lib/helper.cjs <handoff.json>
```

handoff 字段：`mainPid`、`exe`（完整反斜杠路径）、`hostPid`、`port`、`logPath`、`handoffPath`、`delayMs`、`startedAt`。helper 会等 `delayMs` → `taskkill /PID mainPid /F`（不带 `/T`，让 host 优雅落盘）→ 等端口释放 → 重新拉起 exe。

没有该插件时，让用户手动完全退出并重新打开 DSH 即可。
