#!/usr/bin/env node
/**
 * 插件安装器回归测试（不需要 Electron）
 * ============================================================================
 * 覆盖：包校验、路径安全、大小限制、内置冲突、覆盖安装、卸载、自动扫描、
 * 旧版本/旧数据兼容所需的基础文件操作。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const installer = require('../src/plugins/plugin-installer');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertCode(fn, code, label) {
  try {
    fn();
  } catch (e) {
    assert(e.code === code, `${label}: 期望 ${code}，实际 ${e.code || e.message}`);
    return;
  }
  throw new Error(`${label}: 期望抛错 ${code}`);
}

function makeManifest(overrides = {}) {
  return {
    id: 'demo-plugin',
    name: 'Demo 插件',
    version: '1.0.0',
    description: '测试插件',
    author: 'tester',
    apiVersion: 1,
    main: 'main.js',
    contributes: {
      settings: {
        title: 'Demo',
        fields: [{ key: 'value', label: '值', type: 'text', default: 'x' }]
      }
    },
    ...overrides
  };
}

function writePackage(packagePath, files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(String(content)));
  }
  zip.writeZip(packagePath);
}

function makePackage(dir, name, manifest, extra = {}) {
  const packagePath = path.join(dir, `${name}.dlmpet`);
  writePackage(packagePath, {
    'plugin.json': JSON.stringify(manifest),
    'main.js': 'module.exports = { activate() {} };',
    ...extra
  });
  return packagePath;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskllmpet-installer-'));
  const packagesDir = path.join(root, 'packages');
  const userDir = path.join(root, 'user-plugins');
  const dataDir = path.join(root, 'plugin-data');
  fs.mkdirSync(packagesDir, { recursive: true });

  try {
    console.log('\n[插件安装器]');

    check('inspectPackage 读取合法插件包', () => {
      const pkg = makePackage(packagesDir, 'demo-1.0.0', makeManifest());
      const info = installer.inspectPackage(pkg);
      assert(info.ok === true, 'ok 应为 true');
      assert(info.manifest.id === 'demo-plugin', 'id 解析错误');
      assert(info.manifest.version === '1.0.0', 'version 解析错误');
      assert(info.fileCount === 2, `文件数错误: ${info.fileCount}`);
      assert(/^[0-9a-f]{64}$/.test(info.packageHash), '缺少 sha256');
    });

    check('非法路径 / Windows 保留名被拒绝', () => {
      for (const bad of ['../evil', '/abs', 'a\\b', 'C:/x', 'con/x', 'a./x', 'a /x', 'a//b']) {
        assert(installer.normalizeEntryName(bad) === null, `应拒绝: ${bad}`);
      }
      assert(installer.normalizeEntryName('renderer/index.js') === 'renderer/index.js', '合法路径被误伤');
      assert(installer.normalizeEntryName('./main.js') === 'main.js', '没有去掉 ./ 前缀');
    });

    check('symlink 条目能被识别', () => {
      const fake = { header: { attr: (0o120777 << 16) >>> 0 } };
      assert(installer.isSymlinkEntry(fake) === true, 'symlink 未识别');
    });

    check('缺少 plugin.json 时拒绝', () => {
      const pkg = path.join(packagesDir, 'no-manifest.dlmpet');
      writePackage(pkg, { 'main.js': 'module.exports = {};' });
      assertCode(() => installer.inspectPackage(pkg), 'INVALID_PACKAGE', '缺清单');
    });

    check('清单声明的入口不存在时拒绝', () => {
      const pkg = path.join(packagesDir, 'no-main.dlmpet');
      writePackage(pkg, { 'plugin.json': JSON.stringify(makeManifest()) });
      assertCode(() => installer.inspectPackage(pkg), 'INVALID_PACKAGE', '缺入口');
    });

    check('apiVersion 过高时拒绝', () => {
      const pkg = makePackage(packagesDir, 'future', makeManifest({ apiVersion: 99 }));
      assertCode(() => installer.inspectPackage(pkg), 'INVALID_PACKAGE', 'apiVersion');
    });

    check('包大小限制生效', () => {
      const pkg = makePackage(packagesDir, 'limit', makeManifest());
      assertCode(
        () => installer.inspectPackage(pkg, { limits: { maxPackageBytes: 10 } }),
        'TOO_LARGE',
        '包大小'
      );
    });

    check('唯一包装目录会自动识别', () => {
      const pkg = path.join(packagesDir, 'wrapped.dlmpet');
      writePackage(pkg, {
        'demo/plugin.json': JSON.stringify(makeManifest()),
        'demo/main.js': 'module.exports = { activate() {} };'
      });
      const info = installer.inspectPackage(pkg);
      assert(info.rootPrefix === 'demo/', `rootPrefix 错误: ${info.rootPrefix}`);
    });

    await checkAsync('安装 / 覆盖 / 卸载完整链路', async () => {
      const pkg = makePackage(packagesDir, 'demo-1.0.0', makeManifest());
      const result = installer.installPackage(pkg, { userPluginsDir: userDir, builtinIds: ['llm-chat'] });
      assert(result.ok === true, '安装失败');
      assert(fs.existsSync(path.join(userDir, 'demo-plugin', 'main.js')), '入口未安装');
      assert(fs.existsSync(path.join(userDir, '.packages', 'demo-plugin-1.0.0.dlmpet')), '插件包未归档');

      const v2 = makePackage(packagesDir, 'demo-2.0.0', makeManifest({ version: '2.0.0' }));
      assertCode(
        () => installer.installPackage(v2, { userPluginsDir: userDir, builtinIds: [] }),
        'ALREADY_INSTALLED',
        '未确认覆盖'
      );
      const upgraded = installer.installPackage(v2, {
        userPluginsDir: userDir,
        builtinIds: [],
        overwrite: true
      });
      assert(upgraded.version === '2.0.0', '覆盖安装后版本未更新');
      assert(fs.existsSync(path.join(userDir, '.packages', 'demo-plugin-2.0.0.dlmpet')), '新包未归档');

      installer.uninstallPackage({
        userPluginsDir: userDir,
        pluginDir: path.join(userDir, 'demo-plugin'),
        dataDir,
        id: 'demo-plugin',
        deleteData: false
      });
      assert(!fs.existsSync(path.join(userDir, 'demo-plugin')), '插件目录未删除');
    });

    await checkAsync('与内置插件 id 冲突时拒绝', async () => {
      const pkg = makePackage(packagesDir, 'conflict', makeManifest({ id: 'llm-chat' }));
      assertCode(
        () => installer.installPackage(pkg, { userPluginsDir: userDir, builtinIds: ['llm-chat'] }),
        'ID_CONFLICT',
        '内置冲突'
      );
    });

    await checkAsync('scanPendingPackages 安装合法包并隔离坏包', async () => {
      const scanRoot = path.join(root, 'scan-user');
      fs.mkdirSync(scanRoot, { recursive: true });
      makePackage(scanRoot, 'scan-plugin', makeManifest({ id: 'scan-plugin' }));
      const bad = path.join(scanRoot, 'broken.dlmpet');
      fs.writeFileSync(bad, 'not a zip');

      const result = installer.scanPendingPackages({ userPluginsDir: scanRoot, builtinIds: [] });
      assert(result.installed.length === 1, `安装数量错误: ${result.installed.length}`);
      assert(result.failed.length === 1, `失败数量错误: ${result.failed.length}`);
      assert(fs.existsSync(path.join(scanRoot, 'scan-plugin', 'plugin.json')), '扫描安装未落盘');
      assert(fs.readdirSync(path.join(scanRoot, '.failed')).some((name) => name.endsWith('.error.txt')), '缺少失败原因');
      assert(!fs.existsSync(path.join(scanRoot, 'broken.dlmpet')), '坏包应移入 .failed');
    });

    await checkAsync('卸载时可选择删除插件数据', async () => {
      const deleteRoot = path.join(root, 'delete-user');
      const deleteDataDir = path.join(root, 'delete-data');
      const pkg = makePackage(packagesDir, 'delete-demo', makeManifest({ id: 'delete-demo' }));
      installer.installPackage(pkg, { userPluginsDir: deleteRoot, builtinIds: [] });
      const dataPath = path.join(deleteDataDir, 'delete-demo');
      fs.mkdirSync(dataPath, { recursive: true });
      fs.writeFileSync(path.join(dataPath, 'data.json'), '{}');

      installer.uninstallPackage({
        userPluginsDir: deleteRoot,
        pluginDir: path.join(deleteRoot, 'delete-demo'),
        dataDir: deleteDataDir,
        id: 'delete-demo',
        deleteData: true
      });
      assert(!fs.existsSync(dataPath), '插件数据未删除');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length) {
    console.error(`❌ 插件安装器测试失败：${passed} 项通过，${failures.length} 项失败`);
    for (const failure of failures) console.error(`   - ${failure.name}: ${failure.error}`);
    process.exit(1);
  }
  console.log(`✅ 插件安装器测试通过：${passed} 项`);
}

main().catch((e) => {
  console.error('❌ 测试异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
