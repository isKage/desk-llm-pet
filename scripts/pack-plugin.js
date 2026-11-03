#!/usr/bin/env node
/**
 * 把一个插件目录打包成 .dlmpet（ZIP）
 *
 * 用法：
 *   npm run pack:plugin -- src/plugins/llm-chat
 *   node scripts/pack-plugin.js path/to/plugin --out release-plugins
 *
 * 输出：<out>/<id>-<version>.dlmpet
 * 打包后会立即调用安装器的 inspectPackage() 自校验。
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { normalizeManifest } = require('../src/plugins/manifest');
const { inspectPackage } = require('../src/plugins/plugin-installer');

const ROOT = path.join(__dirname, '..');
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.github', '.vscode', '.idea']);
const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function parseArgs(argv) {
  const out = { pluginDir: '', outDir: path.join(ROOT, 'dist-plugins') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.outDir = argv[++i] || out.outDir;
    else if (!arg.startsWith('--') && !out.pluginDir) out.pluginDir = arg;
  }
  return out;
}

function walk(dir, base, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (entry.name === '.DS_Store') continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walk(full, base, files);
    } else if (!EXCLUDED_FILES.has(entry.name) && !/\.log$/i.test(entry.name)) {
      files.push({ rel, full });
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pluginDir) {
    console.error('用法: node scripts/pack-plugin.js <插件目录> [--out <输出目录>]');
    process.exit(2);
  }

  const pluginDir = path.resolve(ROOT, args.pluginDir);
  const manifestPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`❌ 找不到 plugin.json: ${manifestPath}`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = normalizeManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
      fallbackId: path.basename(pluginDir)
    });
  } catch (e) {
    console.error(`❌ plugin.json 校验失败: ${e.message}`);
    process.exit(1);
  }

  const files = [];
  walk(pluginDir, pluginDir, files);
  if (!files.some((file) => file.rel === 'plugin.json')) {
    console.error('❌ 打包列表里缺少 plugin.json');
    process.exit(1);
  }

  const outDir = path.resolve(ROOT, args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, `${manifest.id}-${manifest.version}.dlmpet`);

  const zip = new AdmZip();
  for (const file of files) {
    zip.addFile(file.rel, fs.readFileSync(file.full));
  }
  zip.writeZip(outputPath);

  try {
    const info = inspectPackage(outputPath);
    console.log(`✅ 已生成 ${path.relative(ROOT, outputPath)}`);
    console.log(`   id: ${info.manifest.id}  version: ${info.manifest.version}`);
    console.log(`   文件: ${info.fileCount} 个 / ${(info.totalBytes / 1024).toFixed(1)}KB（解压后）`);
    console.log(`   SHA-256: ${info.packageHash.slice(0, 12)}…`);
    console.log('');
    console.log('安装：设置 → 🧩 插件 → 选择插件包，或把文件放进插件目录后重新扫描。');
  } catch (e) {
    try { fs.rmSync(outputPath, { force: true }); } catch (err) { /* 忽略 */ }
    console.error(`❌ 打包后校验失败（产物已删除）: ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
