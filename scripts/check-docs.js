#!/usr/bin/env node
/**
 * 文档相对链接检查
 * ============================================================================
 * 扫描 README / CONTRIBUTING / CHANGELOG / docs / src/plugins/README.md，
 * 确认 Markdown 链接与 HTML src/href 指向的本地文件存在。
 *
 * 跳过：
 *   - http(s) / mailto / data / 纯锚点
 *   - docs/local（本地文档，gitignore）
 *   - 代码块内的内容
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const ROOT_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'src/plugins/README.md'
];

function listMarkdown(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    if (entry.name === 'local') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listMarkdown(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function stripCodeFences(text) {
  return String(text).replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

function shouldSkip(target) {
  if (!target) return true;
  if (/^(https?:|mailto:|data:|#)/i.test(target)) return true;
  return false;
}

function cleanTarget(target) {
  let value = String(target || '').trim();
  value = value.replace(/^<|>$/g, '');
  value = value.split('#')[0].split('?')[0];
  try {
    value = decodeURIComponent(value);
  } catch (e) { /* 保留原值 */ }
  return value;
}

function checkFile(file, problems) {
  const text = stripCodeFences(fs.readFileSync(file, 'utf8'));
  const dir = path.dirname(file);
  const rel = path.relative(ROOT, file);

  // Markdown 链接 / 图片：](target)
  for (const match of text.matchAll(/!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g)) {
    const target = cleanTarget(match[1]);
    if (shouldSkip(target) || !target) continue;
    const resolved = path.resolve(dir, target);
    if (!fs.existsSync(resolved)) {
      problems.push(`${rel} -> ${match[1]}（找不到 ${path.relative(ROOT, resolved)}）`);
    }
  }

  // HTML src / href="..."
  for (const match of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const target = cleanTarget(match[1]);
    if (shouldSkip(target) || !target) continue;
    const resolved = path.resolve(dir, target);
    if (!fs.existsSync(resolved)) {
      problems.push(`${rel} -> ${match[1]}（找不到 ${path.relative(ROOT, resolved)}）`);
    }
  }
}

function main() {
  const files = [];
  for (const rel of ROOT_FILES) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) files.push(full);
    else console.warn(`⚠️ 缺少文档文件: ${rel}`);
  }
  files.push(...listMarkdown(path.join(ROOT, 'docs')));

  const problems = [];
  for (const file of files) checkFile(file, problems);

  // 旧的逐版本发布说明不应再生
  const legacy = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^RELEASE_v.*\.md$/.test(entry.name))
    .map((entry) => entry.name);
  if (legacy.length) problems.push(`仍存在旧发布说明文件: ${legacy.join(', ')}（应统一放进 CHANGELOG.md）`);

  if (problems.length) {
    console.error(`❌ 文档链接检查失败（${problems.length} 项）：`);
    for (const problem of problems) console.error(`   - ${problem}`);
    process.exit(1);
  }
  console.log(`✅ 文档链接检查通过（${files.length} 个 Markdown 文件）`);
}

if (require.main === module) main();

module.exports = { listMarkdown, stripCodeFences, cleanTarget, shouldSkip };
