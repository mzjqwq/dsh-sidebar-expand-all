# dsh-sidebar-expand-all

深色侧栏里会话很多时，DSH 默认每点一次「展开其余 N 个会话」只多展开 5 个，几十个会话要点很多次；点「收起」后也常常回不到 5 个。这个插件把它改成：

- **点一次就展开该工作区的全部会话**；
- **点「收起」严格回到 5 个**。

> English: [README.md](./README.md)

## 它改了什么

DSH 给每个工作区维护一个「水位线」——该组显示多少个会话。上游逻辑每次点击加 `SESSION_WATERMARK_BASE = 5`；折叠基线又会被 `Math.max(...)` 抬高（为了让运行中/未读会话可见），所以收起后往往不止 5 个。

插件对 asar 内的

```
app.asar
└─ dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js
```

做两处**等长**替换：

| 补丁 | 官方原文 | 替换为 | 效果 |
| --- | --- | --- | --- |
| `expand-all` | `visible.hiddenCount <= SESSION_WATERMARK_BASE ? Infinity : watermark + SESSION_WATERMARK_BASE` | `Number.POSITIVE_INFINITY` | 点一次展开全部剩余会话 |
| `collapse-to-5` | `Math.max(SESSION_WATERMARK_BASE, requiredWatermark(...))` | `SESSION_WATERMARK_BASE` | 收起后严格 5 个 |

替换用空格填充到原长度（文件大小不变），并原地更新 asar header 里该条目的 `integrity.hash` 与 `blocks[0].hash`。asar 的 header 记录每个条目的 offset/size，任何长度变化都会让后续所有条目错位，所以必须等长替换。

## 安装

发布后从插件市场 / npm 安装：

```bash
dsh plugin --profile desktop add dsh-sidebar-expand-all
```

本地目录：

```bash
dsh plugin --profile desktop add ./dsh-sidebar-expand-all
```

直接从 GitHub 仓库：

```bash
dsh plugin --profile desktop add github:mzjqwq/dsh-sidebar-expand-all
```

## 使用

### 本机页面

DSH 启动后打开：

```
http://127.0.0.1:<当前 DSH 端口>/dsh-sidebar-expand-all
```

页面上能看到当前状态，并点「应用补丁」/「还原官方文件」/「刷新」。

### 命令行

```bash
node scripts/patch-workspace-expand-all.mjs --check    # 只检查
node scripts/patch-workspace-expand-all.mjs            # 打补丁（幂等）
node scripts/patch-workspace-expand-all.mjs --list     # 列出内置补丁
node scripts/patch-workspace-expand-all.mjs --restore  # 还原官方文件
```

退出码：`0` 正常 · `2` 找不到 asar 或备份 · `3` 内容与 header integrity 不一致（拒绝写入）· `4` 检查发现 header 与实际内容不一致。

### 必须重启

DSH 宿主启动时把每个 client bundle 缓存在内存，`dsh-client-hmr` 对 asar 内文件做 `stat` 得到的还是启动时的值，所以**改 asar 无法热更**。请完全退出 DSH 再重新打开（刷新页面无效）。

## 安全

- 不改文件大小：两处替换等长，写完后回读条目内容与 header hash 双重校验。
- 首次写入前把原 `client.js` 与原 asar header 备份到 `~/.dsh/dsh-sidebar-expand-all/.asar-bak/`（可用 `DSH_BAK` 覆盖）。
- 还原时校验备份 header 与备份内容一致后再写回。
- 当前内容与 header integrity 不一致（比如被别的工具改过）时直接中止，不猜。
- 找不到官方片段时报 `unsupported` 并放弃写入，绝不乱替换。

## DSH 升级之后

升级会整体替换 `app.asar`，补丁随之消失，升级后重新点一次「应用补丁」即可。如果新版本源码结构变了、两处原文找不到，状态会变成 `unsupported`，需要按新版 `client.js` 重新定位这两处表达式。

## 随包 SKILL

插件启用时会把同名 skill 安装到 `~/.dsh/skills/dsh-sidebar-expand-all/`，会话里的 agent 可以直接按 SKILL 执行检查 / 应用 / 还原，不必依赖网页。

## 开发

```bash
node --check lib/asar-patch.js
node --check lib/index.js
node scripts/patch-workspace-expand-all.mjs --check
```

`lib/asar-patch.js` 无依赖，可以脱离插件单独使用。

## 许可证

MIT
