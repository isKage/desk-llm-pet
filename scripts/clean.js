#!/usr/bin/env node
/**
 * 清理本地生成物（不会删除源码）
 *
 * 用法：
 *   npm run clean              # dist / 冒烟数据 / .DS_Store / 单实例锁 / 日志
 *   npm run clean -- --node-modules  # 额外删除 node_modules
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = new Set(process.argv.slice(2));

const TARGETS = [
  'dist',
  'dist-plugins',
  '.smoke-userdata',
  '.tmp-selfcheck',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket'
];

function remove(target) {
  const full = path.resolve(ROOT, target);
  if (full !== ROOT && !full.startsWith(`${ROOT}${path.sep}`)) {
    console.warn(`⚠️ 跳过工作区外路径: ${full}`);
    return;
  }
  if (!fs.existsSync(full)) return;
  try {
    fs.rmSync(full, { recursive: true, force: true });
    console.log(`🧹 已删除 ${target}`);
  } catch (e) {
    console.warn(`⚠️ 无法删除 ${target}: ${e.message}`);
  }
}

function removeDsStore(dir, depth = 0) {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeDsStore(full, depth + 1);
    } else if (entry.name === '.DS_Store') {
      try {
        fs.rmSync(full, { force: true });
        console.log(`🧹 已删除 ${path.relative(ROOT, full)}`);
      } catch (e) { /* 忽略 */ }
    }
  }
}

function removeRootLogs() {
  let entries = [];
  try {
    entries = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.log')) remove(entry.name);
  }
}

for (const target of TARGETS) remove(target);
removeRootLogs();
removeDsStore(ROOT);
if (args.has('--node-modules')) remove('node_modules');

console.log('✅ 清理完成');
