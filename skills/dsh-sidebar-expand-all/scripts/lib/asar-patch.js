// 仓库内：转发到插件的 lib/asar-patch.js（单一实现）。
// 插件安装 skill 时会把真实的 asar-patch.js 复制到这里覆盖本文件，
// 因此 ~/.dsh/skills 下的脚本可以完全独立运行。
export * from '../../../../lib/asar-patch.js';
