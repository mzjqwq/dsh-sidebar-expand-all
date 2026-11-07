# dsh-sidebar-expand-all

One-click **expand all** for the DeepSeek Harness sidebar — expanded by default, with a strict **collapse to 5**.

DSH 侧栏默认只展开 5 个会话；这个插件让它**默认全部展开**，「展开其余 N 个会话」点一次展开该工作区**全部**剩余会话，点「收起」严格回到 5 个。

> 中文说明见 [README.zh.md](./README.zh.md)。

## A note on the two run paths

If you run this from a DSH **host plugin** (the packaged `/dsh-sidebar-expand-all` control page), the code runs inside Electron, where `node:fs` resolves `app.asar` as a *directory* — `statSync().isFile()` is `false` and `openSync()` throws `ENOENT`. This package therefore reads the archive through Electron's `original-fs` (falling back to `process.noAsar`) whenever it detects `process.versions.electron`. If you patch from a plain terminal, the ordinary `node:fs` path is used instead. Both were verified against a real install.

> The marketplace renders its install button with `--profile web`. On DSH Desktop, use `--profile desktop` instead — that is the profile the app actually boots.

## What it changes

DSH stores a per-workspace "watermark": how many sessions of a group are visible. The upstream UI advances it by `SESSION_WATERMARK_BASE = 5` on every click, and the collapsed baseline is raised whenever a running or unread session must stay visible.

That watermark lives **only in React component state** (`useState({})` — not persisted, reset on remount), so patching just the click handler makes the sidebar fall back to 5 sessions after a restart. Hence the default is patched to `Infinity` too.

This plugin applies four **same-length** patches to the bundled client at

```
app.asar
└─ dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js
```

| Patch | Official code | Patched code | Effect |
| --- | --- | --- | --- |
| `toggle-all` | the whole `onClick` (`if (sessionsExpanded) { dropWatermarks(...); return; }` plus the `visible.hiddenCount <= SESSION_WATERMARK_BASE ? Infinity : watermark + SESSION_WATERMARK_BASE` ternary) | `setStoredWatermarks((marks) => ({ ...marks, [group.key]: sessionsExpanded ? SESSION_WATERMARK_BASE : Number.POSITIVE_INFINITY }))` | one click reveals every remaining session; collapse writes back 5 |
| `collapse-baseline` | `Math.max(SESSION_WATERMARK_BASE, requiredWatermark(...))` | `SESSION_WATERMARK_BASE` | collapse always shows exactly 5 |
| `default-expanded` | `const watermark = sessionWatermarks[group.key] ?? SESSION_WATERMARK_BASE;` | `... ?? Infinity;` | **expanded by default** |
| `default-expanded-drag` | `sessionWatermarks[group.key] ?? SESSION_WATERMARK_BASE).rows` | `... ?? Infinity).rows` | drag ordering uses the same visible rows |

All replacements are padded with spaces so the file size does not change, and the entry's `integrity.hash` (and `blocks[0].hash`) in the asar header is updated in place. Any change to file length would corrupt every following entry in the archive.

## Install

From the plugin market / npm (after publishing):

```bash
dsh plugin --profile desktop add dsh-sidebar-expand-all
```

From a local checkout:

```bash
dsh plugin --profile desktop add ./dsh-sidebar-expand-all
```

Or add the repository directly:

```bash
dsh plugin --profile desktop add github:mzjqwq/dsh-sidebar-expand-all
```

## Use

### Web page

After DSH starts, open

```
http://127.0.0.1:<your DSH port>/dsh-sidebar-expand-all
```

You get the current status of all four patches plus **Apply**, **Restore** and **Refresh** buttons.

### CLI

```bash
node scripts/patch-workspace-expand-all.mjs --check    # inspect only
node scripts/patch-workspace-expand-all.mjs            # apply (idempotent)
node scripts/patch-workspace-expand-all.mjs --list     # list built-in patches
node scripts/patch-workspace-expand-all.mjs --restore  # restore official file
```

Exit codes: `0` ok · `2` asar or backup missing · `3` file/header integrity mismatch (refused) · `4` check found inconsistent header.

### Restart is required

The DSH host caches every client bundle in memory at startup, and `dsh-client-hmr` keeps seeing the startup-time `stat` of files inside `app.asar`, so **editing the asar cannot hot-reload**. Fully quit DSH and open it again (a page refresh is not enough).

## Safety

- Files are never resized: patches are equal-length and verified by re-reading the entry and its header hash.
- The original `client.js` and the original asar header are backed up to `~/.dsh/dsh-sidebar-expand-all/.asar-bak/` before the first write (`DSH_BAK` overrides).
- Restore writes the backup back and re-checks that backup header and content match.
- If the current content does not match the header integrity (another tool already modified the archive), the apply step aborts instead of guessing.
- If a patch anchor is missing, the plugin reports `unsupported` and writes nothing — it never guesses a replacement.

## Upgrades

A DSH upgrade replaces `app.asar` as a whole, so the patch disappears. Re-run **Apply** (or the CLI) after upgrading. If the anchors changed in a new DSH release, the status becomes `unsupported`; the four expressions above must then be re-located in the new `client.js`.

## Bundled skill

The plugin also installs a user-level skill to `~/.dsh/skills/dsh-sidebar-expand-all/`, so an agent session can perform the same check/apply/restore without the web page.

## Development

```bash
node --check lib/asar-patch.js
node --check lib/index.js
node scripts/patch-workspace-expand-all.mjs --check   # read-only: is the patch applied?
node scripts/smoke-plugin.mjs                         # loads both halves, asserts the patch set fits
```

`lib/asar-patch.js` is dependency-free and can be used outside the plugin.

## License

MIT
