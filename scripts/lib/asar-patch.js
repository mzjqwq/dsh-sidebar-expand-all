// 仓库内：直接转发到插件的 lib/asar-patch.js（单一实现）。
// 安装 skill 时，插件会把真实的 asar-patch.js 复制到这里覆盖本文件，
// 这样 ~/.dsh/skills 下的脚本可以完全独立运行。
export * from '../../lib/asar-patch.js';
