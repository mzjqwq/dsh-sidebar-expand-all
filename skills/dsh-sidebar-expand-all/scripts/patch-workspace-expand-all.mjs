#!/usr/bin/env node
/**
 * patch-workspace-expand-all — 独立 CLI。
 *
 *   node patch-workspace-expand-all.mjs            # 打补丁（幂等）
 *   node patch-workspace-expand-all.mjs --check    # 只检查
 *   node patch-workspace-expand-all.mjs --list     # 列出内置补丁
 *   node patch-workspace-expand-all.mjs --restore  # 还原官方文件
 *
 * 退出码：0 正常；2 找不到 asar/备份；3 内容与 header integrity 不一致；4 --check 发现不一致。
 * 环境变量：DSH_ASAR 指定 app.asar；DSH_BAK 指定备份目录。
 */
import { ENTRY, PATCHES, apply, inspect, restore } from './lib/asar-patch.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);

function printStatus(info) {
  if (!info.available) {
    console.error(info.error || '找不到 app.asar');
    return 2;
  }
  console.log(`asar: ${info.asarPath}`);
  console.log(`条目: ${ENTRY}`);
  console.log(`状态: ${info.status}`);
  if (info.error) console.log(`错误: ${info.error}`);
  if (info.patches) {
    for (const p of info.patches) {
      const mark = p.state === 'applied' ? '✓ 已应用' : p.state === 'pending' ? '· 未应用' : '✗ 找不到官方片段';
      console.log(`  - ${p.id}: ${mark} — ${p.effect}`);
    }
  }
  if (info.headerOk === false) console.log('header integrity 与实际内容不一致，请先还原或重装 DSH。');
  return 0;
}

if (flag('--list')) {
  console.log(`${ENTRY}\n`);
  for (const p of PATCHES) {
    console.log(`- ${p.id}`);
    console.log(`  old: ${p.old}`);
    console.log(`  new: ${p.newText}`);
    console.log(`  效果: ${p.effect}\n`);
  }
  process.exit(0);
}

if (flag('--help') || flag('-h')) {
  console.log('用法: node patch-workspace-expand-all.mjs [--check|--restore|--list|--help]');
  process.exit(0);
}

if (flag('--check')) {
  const info = inspect();
  const code = printStatus(info);
  if (code) process.exit(code);
  process.exit(info.headerOk === false ? 4 : 0);
}

if (flag('--restore')) {
  try {
    const result = restore();
    console.log(`已还原: ${result.asarPath}`);
    console.log(`备份: ${result.backupDir}`);
    console.log('请完全退出并重新打开 DSH 才生效。');
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

try {
  const result = apply();
  if (result.already?.length && !result.applied?.length) {
    console.log('补丁已经是应用状态，无需修改。');
    console.log(`asar: ${result.asarPath}`);
  } else {
    console.log(`已应用: ${result.applied.join(', ')}`);
    if (result.already?.length) console.log(`先前已应用: ${result.already.join(', ')}`);
    console.log(`asar: ${result.asarPath}`);
    console.log(`备份: ${result.backupDir}`);
    console.log(`新 integrity hash: ${result.hash}`);
  }
  console.log('必须完全退出并重新打开 DSH 才生效（刷新页面无效）。');
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(message.includes('integrity') ? 3 : 2);
}
