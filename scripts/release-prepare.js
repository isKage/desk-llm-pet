#!/usr/bin/env node
/**
 * 发布准备：同步版本号 + 在 CHANGELOG 插入新版本占位
 *
 * 用法：
 *   npm run release:prepare -- 1.2.0
 *   node scripts/release-prepare.js 1.2.0 --date 2026-12-01
 *   node scripts/release-prepare.js 1.2.0 --dry-run
 *
 * 不做任何 git 操作；提交、打 tag、推送由维护者完成。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function parseSemver(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] || '' };
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  return pa.prerelease.localeCompare(pb.prerelease);
}

function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 解析参数：第一个非 -- 参数是版本；支持 --date、--dry-run、--force */
function parseArgs(argv) {
  const out = { version: '', date: '', dryRun: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--date') out.date = argv[++i] || '';
    else if (!arg.startsWith('--') && !out.version) out.version = arg;
  }
  return out;
}

function insertChangelogSection(changelog, version, date) {
  if (new RegExp(`^##\\s+\\[?v?${version.replace(/\./g, '\\.')}\\]?`, 'm').test(changelog)) {
    fail(`CHANGELOG.md 已存在版本 ${version} 的段落`);
  }
  const section = `## [${version}] - ${date}\n\n### Added\n\n- \n`;
  const lines = changelog.split(/\r?\n/);
  const unreleased = lines.findIndex((line) => /^##\s+\[Unreleased\]/.test(line.trim()));
  if (unreleased >= 0) {
    let insertAt = lines.length;
    for (let i = unreleased + 1; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i])) {
        insertAt = i;
        break;
      }
    }
    const sectionLines = section.trimEnd().split('\n');
    lines.splice(insertAt, 0, ...sectionLines, '');
    return `${lines.join('\n').trimEnd()}\n`;
  }
  return `${changelog.trimEnd()}\n\n${section}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) fail('用法: npm run release:prepare -- <版本，如 1.2.0>');
  if (!parseSemver(args.version)) fail(`版本号格式不正确: ${args.version}`);
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    args.date = formatDate(new Date());
  }

  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');

  if (args.version === pkg.version && !args.force) {
    fail(`版本号与当前版本相同（${pkg.version}）；如需重新生成请加 --force`);
  }
  if (compareSemver(args.version, pkg.version) < 0 && !args.force) {
    fail(`新版本 ${args.version} 低于当前版本 ${pkg.version}；如确实要降级请加 --force`);
  }

  const nextChangelog = insertChangelogSection(changelog, args.version, args.date);
  const nextPkg = { ...pkg, version: args.version };
  const nextLock = { ...lock };
  nextLock.version = args.version;
  if (nextLock.packages && nextLock.packages['']) {
    nextLock.packages[''] = { ...nextLock.packages[''], version: args.version };
  }

  if (args.dryRun) {
    console.log(`[dry-run] package.json: ${pkg.version} -> ${args.version}`);
    console.log(`[dry-run] 将插入 CHANGELOG 段落: ## [${args.version}] - ${args.date}`);
    return;
  }

  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(nextPkg, null, 2)}\n`);
  fs.writeFileSync(LOCK_PATH, `${JSON.stringify(nextLock, null, 2)}\n`);
  fs.writeFileSync(CHANGELOG_PATH, nextChangelog);

  console.log(`✅ 版本号已更新: ${pkg.version} -> ${args.version}`);
  console.log(`✅ 已更新 package.json / package-lock.json`);
  console.log(`✅ 已在 CHANGELOG.md 插入 ## [${args.version}] - ${args.date}`);
  console.log('');
  console.log('下一步：');
  console.log('  1. 补全 CHANGELOG.md 的变更内容');
  console.log('  2. npm run check && npm run check:renderer');
  console.log('  3. git commit / git tag v' + args.version + ' / git push');
  console.log('  4. 推送 tag 后由 GitHub Actions 构建并发布 Release');
}

if (require.main === module) main();

module.exports = { parseSemver, compareSemver, insertChangelogSection, formatDate };
