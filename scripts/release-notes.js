#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取某个版本的发布正文（供 GitHub Release / 本地预览使用）
 *
 * 用法：
 *   node scripts/release-notes.js v1.1.1
 *   node scripts/release-notes.js 1.1.1
 *
 * 找不到版本段落时以非 0 退出，避免发布一个空正文的 Release。
 */

const fs = require('fs');
const path = require('path');

const CHANGELOG = path.join(__dirname, '..', 'CHANGELOG.md');

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 提取 CHANGELOG 中 `## [<version>]` 到下一个 `## ` 之间的内容。
 * @param {string} changelog
 * @param {string} version
 * @returns {string} 段落（包含标题）；找不到返回空字符串
 */
function extractSection(changelog, version) {
  const target = normalizeVersion(version);
  if (!target) return '';
  const lines = String(changelog || '').split(/\r?\n/);
  const heading = new RegExp(`^##\\s+\\[?v?${escapeRegExp(target)}\\]?(?:\\s|$)`);

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (heading.test(lines[i].trim())) {
      start = i;
      break;
    }
  }
  if (start < 0) return '';

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return `${lines.slice(start, end).join('\n').trim()}\n`;
}

function main() {
  const version = process.argv[2];
  if (!version) {
    console.error('用法: node scripts/release-notes.js <版本，如 v1.1.1>');
    process.exit(2);
  }
  if (!fs.existsSync(CHANGELOG)) {
    console.error(`找不到 ${CHANGELOG}`);
    process.exit(1);
  }
  const section = extractSection(fs.readFileSync(CHANGELOG, 'utf8'), version);
  if (!section) {
    console.error(`CHANGELOG.md 中找不到版本 ${normalizeVersion(version)} 的段落`);
    process.exit(1);
  }
  process.stdout.write(section);
}

if (require.main === module) main();

module.exports = { extractSection, normalizeVersion };
