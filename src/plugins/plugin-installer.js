/**
 * 插件安装器
 * ============================================================================
 * 负责「一个插件包 → userData/plugins/<id>/」的全部文件操作：
 *   - inspectPackage：只读校验（预览用），不解压；
 *   - installPackage：解压到 .staging、校验、原子替换；
 *   - uninstallPackage：删除插件目录（Windows 占用时移入 .trash）；
 *   - scanPendingPackages：扫描插件目录顶层的 .dlmpet/.zip 并自动安装；
 *   - sweepTempDirs：清理过期的 .staging / .trash。
 *
 * 安全边界：
 *   - 拒绝绝对路径、`..`、反斜杠、Windows 保留名、symlink、加密条目；
 *   - 限制包大小 / 解压总量 / 条目数 / 单文件大小；
 *   - 解压后再次校验清单与入口文件；
 *   - 只允许删除 userPluginsDir 内部的目录。
 *
 * 本模块不依赖 Electron，方便 `npm run check` 直接测试。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  isValidSemver,
  compareVersions,
  normalizeManifest,
  validateManifestPaths,
  isPathInside
} = require('./manifest');

/** 接受的插件包扩展名 */
const PACKAGE_EXTENSIONS = ['.dlmpet', '.zip'];

/** 默认限制 */
const DEFAULT_LIMITS = {
  maxPackageBytes: 20 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxEntries: 2000,
  maxFileBytes: 32 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxPathLength: 240
};

/** 内部目录名（以 . 开头，宿主发现时会忽略） */
const INTERNAL_DIRS = {
  staging: '.staging',
  trash: '.trash',
  failed: '.failed',
  packages: '.packages'
};

const ERROR_CODES = {
  INVALID_PACKAGE: 'INVALID_PACKAGE',
  UNSAFE_ENTRY: 'UNSAFE_ENTRY',
  TOO_LARGE: 'TOO_LARGE',
  ID_CONFLICT: 'ID_CONFLICT',
  ALREADY_INSTALLED: 'ALREADY_INSTALLED',
  VERSION_DOWNGRADE: 'VERSION_DOWNGRADE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INSTALL_FAILED: 'INSTALL_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  BUILTIN_READONLY: 'BUILTIN_READONLY'
};

class InstallerError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'InstallerError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function fail(code, message, cause) {
  throw new InstallerError(code, message, cause);
}

/** 懒加载 adm-zip：依赖缺失时只影响安装功能 */
function loadAdmZip() {
  try {
    // eslint-disable-next-line global-require
    return require('adm-zip');
  } catch (e) {
    throw new InstallerError('INSTALLER_UNAVAILABLE', '插件安装组件不可用（缺少 adm-zip）', e);
  }
}

function limitsOf(options = {}) {
  return { ...DEFAULT_LIMITS, ...(options.limits || {}) };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 创建插件目录下的内部目录 */
function ensurePluginDirs(userPluginsDir) {
  ensureDir(userPluginsDir);
  for (const name of Object.values(INTERNAL_DIRS)) {
    ensureDir(path.join(userPluginsDir, name));
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function isPackageFile(filePath) {
  return PACKAGE_EXTENSIONS.includes(path.extname(String(filePath || '')).toLowerCase());
}

// ============================================================================
// ZIP 条目安全
// ============================================================================

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 校验 zip 条目相对路径是否安全（纯函数，便于单测）。
 * @param {string} rawName
 * @param {{maxPathLength?: number}} [options]
 * @returns {string|null} 规范化后的相对路径；不安全返回 null
 */
function normalizeEntryName(rawName, options = {}) {
  const maxPathLength = options.maxPathLength || DEFAULT_LIMITS.maxPathLength;
  if (typeof rawName !== 'string' || !rawName) return null;
  if (rawName.includes('\0') || /[\u0000-\u001f]/.test(rawName)) return null;
  if (rawName.includes('\\')) return null;
  if (rawName.length > maxPathLength) return null;
  if (rawName.startsWith('/') || /^[a-zA-Z]:/.test(rawName)) return null;

  let name = rawName;
  while (name.startsWith('./')) name = name.slice(2);
  const isDir = name.endsWith('/');
  if (isDir) name = name.replace(/\/+$/, '');
  if (!name || name.includes('//')) return null;

  const segments = name.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null;
    if (/[<>:"|?*]/.test(segment)) return null;
    if (/[. ]$/.test(segment)) return null;
    if (WINDOWS_RESERVED.test(segment)) return null;
  }
  return isDir ? `${name}/` : name;
}

/** 归档内应忽略的垃圾条目 */
function shouldIgnoreEntry(name) {
  if (!name) return true;
  if (name === '__MACOSX/' || name.startsWith('__MACOSX/')) return true;
  const base = name.replace(/\/$/, '').split('/').pop();
  return base === '.DS_Store' || base === 'Thumbs.db';
}

/** 从 entry 的 header 判断是否是符号链接 / 特殊文件 */
function entryMode(entry) {
  const raw = Number(entry && entry.header && entry.header.attr);
  if (!Number.isFinite(raw) || raw === 0) return 0;
  return (raw >>> 16) & 0xffff;
}

function isSymlinkEntry(entry) {
  const mode = entryMode(entry);
  return (mode & 0o170000) === 0o120000;
}

function isSpecialEntry(entry) {
  const mode = entryMode(entry);
  if (!mode) return false;
  const type = mode & 0o170000;
  return type !== 0 && type !== 0o100000 && type !== 0o040000;
}

function entrySize(entry) {
  const size = Number(entry && entry.header && entry.header.size);
  return Number.isFinite(size) && size >= 0 ? size : 0;
}

function entryMethod(entry) {
  const method = Number(entry && entry.header && entry.header.method);
  return Number.isFinite(method) ? method : 0;
}

function entryIsEncrypted(entry) {
  const flags = Number(entry && entry.header && entry.header.flags);
  return Number.isFinite(flags) && (flags & 0x1) !== 0;
}

// ============================================================================
// 只读检查
// ============================================================================

/**
 * 读取 zip 条目并做大小/路径/类型校验。
 * @param {string} packagePath
 * @param {Object} options
 * @returns {{zip: Object, entries: Array, packageBytes: number, packageHash: string, limits: Object}}
 */
function openPackage(packagePath, options = {}) {
  const limits = limitsOf(options);
  if (!isPackageFile(packagePath)) {
    fail(ERROR_CODES.INVALID_PACKAGE, `不支持的插件包扩展名: ${path.extname(packagePath) || '(无)'}`);
  }

  let stat;
  try {
    stat = fs.statSync(packagePath);
  } catch (e) {
    fail(ERROR_CODES.NOT_FOUND, `插件包不存在: ${packagePath}`, e);
  }
  if (!stat.isFile()) fail(ERROR_CODES.INVALID_PACKAGE, '插件包必须是文件');
  if (stat.size > limits.maxPackageBytes) {
    fail(ERROR_CODES.TOO_LARGE, `插件包超过大小限制（${formatBytes(stat.size)} > ${formatBytes(limits.maxPackageBytes)}）`);
  }

  let zip;
  try {
    const AdmZip = loadAdmZip();
    zip = new AdmZip(packagePath);
  } catch (e) {
    if (e instanceof InstallerError) throw e;
    fail(ERROR_CODES.INVALID_PACKAGE, `无法读取插件包（不是有效的 ZIP？）: ${e.message}`, e);
  }

  const entries = zip.getEntries();
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(ERROR_CODES.INVALID_PACKAGE, '插件包是空的');
  }
  if (entries.length > limits.maxEntries) {
    fail(ERROR_CODES.TOO_LARGE, `插件包条目过多（${entries.length} > ${limits.maxEntries}）`);
  }

  for (const entry of entries) {
    const normalized = normalizeEntryName(entry.entryName, { maxPathLength: limits.maxPathLength });
    if (!normalized) {
      fail(ERROR_CODES.UNSAFE_ENTRY, `插件包包含不安全的路径: ${entry.entryName}`);
    }
    if (shouldIgnoreEntry(normalized)) continue;
    if (entryIsEncrypted(entry)) {
      fail(ERROR_CODES.UNSAFE_ENTRY, `插件包包含加密条目: ${normalized}`);
    }
    if (isSymlinkEntry(entry)) {
      fail(ERROR_CODES.UNSAFE_ENTRY, `插件包包含符号链接: ${normalized}`);
    }
    if (isSpecialEntry(entry)) {
      fail(ERROR_CODES.UNSAFE_ENTRY, `插件包包含特殊文件: ${normalized}`);
    }
    if (!entry.isDirectory) {
      const method = entryMethod(entry);
      if (method !== 0 && method !== 8) {
        fail(ERROR_CODES.INVALID_PACKAGE, `不支持的压缩方式 (${method}): ${normalized}`);
      }
      if (entrySize(entry) > limits.maxFileBytes) {
        fail(ERROR_CODES.TOO_LARGE, `单个文件超过限制: ${normalized}`);
      }
    }
  }

  return {
    zip,
    entries,
    packageBytes: stat.size,
    packageHash: sha256File(packagePath),
    limits
  };
}

/** 从条目列表里定位 plugin.json 与包根前缀 */
function locateManifest(entries) {
  const candidates = [];
  let totalBytes = 0;
  let fileCount = 0;

  for (const entry of entries) {
    const name = normalizeEntryName(entry.entryName);
    if (!name || shouldIgnoreEntry(name)) continue;
    if (!entry.isDirectory) {
      totalBytes += entrySize(entry);
      fileCount += 1;
    }
    if (name === 'plugin.json') candidates.push({ entry, name, prefix: '' });
    else if (/^[^/]+\/plugin\.json$/.test(name)) {
      candidates.push({ entry, name, prefix: name.slice(0, name.length - 'plugin.json'.length) });
    }
  }

  if (candidates.length === 0) {
    fail(ERROR_CODES.INVALID_PACKAGE, '插件包根目录缺少 plugin.json');
  }
  if (candidates.length > 1) {
    fail(ERROR_CODES.INVALID_PACKAGE, `插件包包含多个 plugin.json: ${candidates.map((c) => c.name).join(', ')}`);
  }

  return { candidate: candidates[0], totalBytes, fileCount };
}

function readManifestFromEntry(entry, limits) {
  if (entrySize(entry) > limits.maxManifestBytes) {
    fail(ERROR_CODES.TOO_LARGE, 'plugin.json 过大');
  }
  let text;
  try {
    text = entry.getData().toString('utf8');
  } catch (e) {
    fail(ERROR_CODES.INVALID_PACKAGE, `无法读取 plugin.json: ${e.message}`, e);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(ERROR_CODES.INVALID_PACKAGE, `plugin.json 解析失败: ${e.message}`, e);
  }
}

/**
 * 只读检查插件包（不落盘）。
 * @param {string} packagePath
 * @param {Object} [options]
 * @returns {Object} 预览信息
 */
function inspectPackage(packagePath, options = {}) {
  const opened = openPackage(packagePath, options);
  const { candidate, totalBytes, fileCount } = locateManifest(opened.entries);
  const limits = opened.limits;
  if (totalBytes > limits.maxTotalBytes) {
    fail(ERROR_CODES.TOO_LARGE, `插件包解压后超过限制（${formatBytes(totalBytes)} > ${formatBytes(limits.maxTotalBytes)}）`);
  }

  const rawManifest = readManifestFromEntry(candidate.entry, limits);
  const fallbackId = candidate.prefix ? candidate.prefix.replace(/\/$/, '') : '';
  let manifest;
  try {
    manifest = normalizeManifest(rawManifest, { fallbackId });
  } catch (e) {
    fail(ERROR_CODES.INVALID_PACKAGE, e.message, e);
  }
  if (!isValidSemver(manifest.version)) {
    fail(ERROR_CODES.INVALID_PACKAGE, `version 必须是 semver（如 1.0.0）: ${manifest.version}`);
  }

  // 清单声明的入口必须在包里（大小写不敏感，兼容 Windows 打包）
  const names = new Set(
    opened.entries
      .map((entry) => normalizeEntryName(entry.entryName))
      .filter(Boolean)
      .filter((name) => !name.endsWith('/'))
  );
  const lowerNames = new Set([...names].map((name) => name.toLowerCase()));
  const rootPrefix = candidate.prefix;
  const required = [manifest.main];
  if (manifest.preload) required.push(manifest.preload);
  for (const rel of required) {
    const full = `${rootPrefix}${rel}`.toLowerCase();
    if (!lowerNames.has(full)) {
      fail(ERROR_CODES.INVALID_PACKAGE, `清单声明的文件不在包内: ${rel}`);
    }
  }

  // 包内只能是根目录或唯一包装目录下的文件
  if (rootPrefix) {
    for (const name of names) {
      if (!name.startsWith(rootPrefix)) {
        fail(ERROR_CODES.INVALID_PACKAGE, `插件包根目录与包装目录混放: ${name}`);
      }
    }
  }

  const warnings = [];
  if (manifest.author === '') warnings.push('清单未填写 author');
  if (rootPrefix) warnings.push(`插件包外层有一层目录 ${rootPrefix.replace(/\/$/, '')}，安装时会自动去掉`);
  if ([...names].some((name) => name.startsWith(`${rootPrefix}node_modules/`))) {
    warnings.push('插件包包含 node_modules，安装包体积可能较大');
  }

  return {
    ok: true,
    packagePath,
    packageName: path.basename(packagePath),
    packageBytes: opened.packageBytes,
    packageHash: opened.packageHash,
    manifest,
    rootPrefix,
    fileCount,
    totalBytes,
    warnings
  };
}

// ============================================================================
// 安装
// ============================================================================

function formatBytes(bytes) {
  const num = Number(bytes) || 0;
  if (num < 1024) return `${num}B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)}KB`;
  return `${(num / (1024 * 1024)).toFixed(1)}MB`;
}

function safeBaseName(name) {
  return String(name || '').replace(/[^a-z0-9._-]/gi, '_') || 'plugin';
}

/** 读取 userPluginsDir 下某个目录里的清单 id（失败返回 null） */
function readDirManifestId(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    const manifest = normalizeManifest(raw, { fallbackId: path.basename(dir) });
    return manifest.id;
  } catch (e) {
    return null;
  }
}

/** 查找 userPluginsDir 下所有 manifest.id === id 的目录 */
function findDirsById(userPluginsDir, id) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(userPluginsDir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(userPluginsDir, entry.name);
    if (readDirManifestId(dir) === id) out.push(dir);
  }
  return out;
}

/** 读取已安装版本（用户目录） */
function getInstalledInfo(userPluginsDir, id) {
  for (const dir of findDirsById(userPluginsDir, id)) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
      const manifest = normalizeManifest(raw, { fallbackId: path.basename(dir) });
      return { dir, id: manifest.id, version: manifest.version, manifest };
    } catch (e) { /* 继续找 */ }
  }
  return null;
}

function extractPackage(packagePath, stagingDir, inspection, options) {
  const limits = limitsOf(options);
  const AdmZip = loadAdmZip();
  const zip = new AdmZip(packagePath);
  const entries = zip.getEntries();
  const seen = new Set();
  let total = 0;

  for (const entry of entries) {
    const normalized = normalizeEntryName(entry.entryName, { maxPathLength: limits.maxPathLength });
    if (!normalized) fail(ERROR_CODES.UNSAFE_ENTRY, `插件包包含不安全的路径: ${entry.entryName}`);
    if (shouldIgnoreEntry(normalized)) continue;
    if (entryIsEncrypted(entry)) fail(ERROR_CODES.UNSAFE_ENTRY, `插件包包含加密条目: ${normalized}`);
    if (isSymlinkEntry(entry)) fail(ERROR_CODES.UNSAFE_ENTRY, `插件包包含符号链接: ${normalized}`);
    if (isSpecialEntry(entry)) fail(ERROR_CODES.UNSAFE_ENTRY, `插件包包含特殊文件: ${normalized}`);

    let rel = normalized;
    if (inspection.rootPrefix) {
      if (!rel.startsWith(inspection.rootPrefix)) {
        fail(ERROR_CODES.INVALID_PACKAGE, `插件包根目录与包装目录混放: ${rel}`);
      }
      rel = rel.slice(inspection.rootPrefix.length);
    }
    if (!rel) continue;

    const target = path.resolve(stagingDir, rel);
    if (!isPathInside(stagingDir, target)) {
      fail(ERROR_CODES.UNSAFE_ENTRY, `插件包路径逃逸: ${normalized}`);
    }

    if (entry.isDirectory || rel.endsWith('/')) {
      ensureDir(target);
      continue;
    }

    const duplicateKey = process.platform === 'win32' || process.platform === 'darwin'
      ? target.toLowerCase()
      : target;
    if (seen.has(duplicateKey)) {
      fail(ERROR_CODES.INVALID_PACKAGE, `插件包包含重复路径: ${normalized}`);
    }
    seen.add(duplicateKey);

    const declaredSize = entrySize(entry);
    if (declaredSize > limits.maxFileBytes) {
      fail(ERROR_CODES.TOO_LARGE, `单个文件超过限制: ${normalized}`);
    }
    let data;
    try {
      data = entry.getData();
    } catch (e) {
      fail(ERROR_CODES.INVALID_PACKAGE, `解压失败: ${normalized}`, e);
    }
    if (data.length > limits.maxFileBytes) {
      fail(ERROR_CODES.TOO_LARGE, `单个文件超过限制: ${normalized}`);
    }
    total += data.length;
    if (total > limits.maxTotalBytes) {
      fail(ERROR_CODES.TOO_LARGE, `插件包解压后超过限制（> ${formatBytes(limits.maxTotalBytes)}）`);
    }

    ensureDir(path.dirname(target));
    fs.writeFileSync(target, data, { mode: 0o644 });
  }

  const manifestPath = path.join(stagingDir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    fail(ERROR_CODES.INVALID_PACKAGE, '解压后缺少 plugin.json');
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    fail(ERROR_CODES.INVALID_PACKAGE, `解压后的 plugin.json 解析失败: ${e.message}`, e);
  }
  let manifest;
  try {
    manifest = normalizeManifest(raw, { fallbackId: inspection.manifest.id });
  } catch (e) {
    fail(ERROR_CODES.INVALID_PACKAGE, e.message, e);
  }
  if (manifest.id !== inspection.manifest.id) {
    fail(ERROR_CODES.INVALID_PACKAGE, '解压后的插件 id 与预览不一致');
  }
  validateManifestPaths(manifest, stagingDir);
  return manifest;
}

function removeOldArchives(archiveDir, id) {
  let entries = [];
  try {
    entries = fs.readdirSync(archiveDir);
  } catch (e) {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(`${id}-`) || !name.endsWith('.dlmpet')) continue;
    try { fs.rmSync(path.join(archiveDir, name), { force: true }); } catch (e) { /* 忽略 */ }
  }
}

function copyOrMove(source, destination, moveSource) {
  try {
    if (moveSource) {
      fs.renameSync(source, destination);
      return;
    }
  } catch (e) {
    // 跨设备 / 占用时退回复制
  }
  fs.copyFileSync(source, destination);
  if (moveSource) {
    try { fs.rmSync(source, { force: true }); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 安装插件包。
 * @param {string} packagePath
 * @param {{userPluginsDir: string, builtinIds?: string[], overwrite?: boolean, moveSource?: boolean, limits?: Object}} options
 */
function installPackage(packagePath, options = {}) {
  const { userPluginsDir: rawUserDir, builtinIds = [], overwrite = false, moveSource = false } = options;
  if (!rawUserDir) fail(ERROR_CODES.INSTALL_FAILED, '缺少 userPluginsDir');
  const userPluginsDir = path.resolve(rawUserDir);
  const limits = limitsOf(options);
  ensurePluginDirs(userPluginsDir);

  const inspection = inspectPackage(packagePath, { limits });
  const { manifest } = inspection;
  const builtin = new Set([...builtinIds].map((id) => String(id).toLowerCase()));
  if (builtin.has(manifest.id.toLowerCase())) {
    fail(ERROR_CODES.ID_CONFLICT, `插件 id 与内置插件冲突: ${manifest.id}`);
  }

  const existing = findDirsById(userPluginsDir, manifest.id);
  const target = path.join(userPluginsDir, manifest.id);
  const targetExists = fs.existsSync(target);
  if ((targetExists || existing.length > 0) && !overwrite) {
    const installed = getInstalledInfo(userPluginsDir, manifest.id);
    fail(
      ERROR_CODES.ALREADY_INSTALLED,
      `已安装 ${manifest.id}${installed ? ` v${installed.version}` : ''}，如需覆盖请确认`,
    );
  }

  const stagingRoot = fs.mkdtempSync(path.join(userPluginsDir, INTERNAL_DIRS.staging, 'install-'));
  const trashRoot = path.join(userPluginsDir, INTERNAL_DIRS.trash);
  const archiveDir = path.join(userPluginsDir, INTERNAL_DIRS.packages);
  const backups = [];
  let installed = false;

  try {
    const extractedManifest = extractPackage(packagePath, stagingRoot, inspection, { limits });

    // 把同 id 的旧目录（包括目录名与 id 不同的手动插件）移到备份
    for (const dir of existing) {
      if (path.resolve(dir) === path.resolve(stagingRoot)) continue;
      const backup = path.join(trashRoot, `${safeBaseName(path.basename(dir))}-${Date.now()}-${backups.length}`);
      try {
        fs.renameSync(dir, backup);
        backups.push({ from: dir, to: backup });
      } catch (e) {
        fail(ERROR_CODES.INSTALL_FAILED, `无法备份旧插件目录: ${e.message}`, e);
      }
    }
    if (targetExists && !existing.some((dir) => path.resolve(dir) === path.resolve(target))) {
      const backup = path.join(trashRoot, `${manifest.id}-${Date.now()}`);
      try {
        fs.renameSync(target, backup);
        backups.push({ from: target, to: backup });
      } catch (e) {
        fail(ERROR_CODES.INSTALL_FAILED, `无法备份旧插件目录: ${e.message}`, e);
      }
    }

    fs.renameSync(stagingRoot, target);
    installed = true;

    // 重新校验安装后的目录（防止 staging 到 target 之间被替换）
    validateManifestPaths(extractedManifest, target);

    removeOldArchives(archiveDir, manifest.id);
    const archiveName = `${safeBaseName(manifest.id)}-${safeBaseName(manifest.version)}.dlmpet`;
    const archivePath = path.join(archiveDir, archiveName);
    try {
      copyOrMove(packagePath, archivePath, moveSource);
    } catch (e) {
      // 归档失败不影响插件可用
    }

    return {
      ok: true,
      id: manifest.id,
      dir: target,
      version: manifest.version,
      manifest,
      packageHash: inspection.packageHash,
      archivePath: fs.existsSync(archivePath) ? archivePath : '',
      warnings: inspection.warnings
    };
  } catch (e) {
    // 回滚：删除刚安装的目录，恢复备份
    if (installed) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (err) { /* 忽略 */ }
    }
    for (const backup of backups.reverse()) {
      try {
        if (fs.existsSync(backup.to) && !fs.existsSync(backup.from)) {
          fs.renameSync(backup.to, backup.from);
        }
      } catch (err) { /* 忽略 */ }
    }
    if (e instanceof InstallerError) throw e;
    const code = e && (e.code === 'EACCES' || e.code === 'EPERM') ? ERROR_CODES.PERMISSION_DENIED : ERROR_CODES.INSTALL_FAILED;
    fail(code, `安装失败: ${e.message}`, e);
  } finally {
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

// ============================================================================
// 卸载 / 扫描 / 清理
// ============================================================================

function isManagedDir(userPluginsDir, dir) {
  const root = path.resolve(userPluginsDir);
  const target = path.resolve(dir);
  if (target === root) return false;
  return isPathInside(root, target);
}

/**
 * 卸载插件目录。只允许 userPluginsDir 内部目录。
 * @param {{userPluginsDir: string, pluginDir: string, dataDir?: string, id: string, deleteData?: boolean}} options
 */
function uninstallPackage(options = {}) {
  const { userPluginsDir, pluginDir, dataDir, id, deleteData = false } = options;
  if (!userPluginsDir || !pluginDir || !id) {
    fail(ERROR_CODES.INSTALL_FAILED, '卸载参数不完整');
  }
  const root = path.resolve(userPluginsDir);
  const target = path.resolve(pluginDir);
  if (!isManagedDir(root, target)) {
    fail(ERROR_CODES.INSTALL_FAILED, '拒绝删除插件目录以外的路径');
  }
  if (!fs.existsSync(target)) {
    fail(ERROR_CODES.NOT_FOUND, '插件目录不存在');
  }

  let pendingCleanup = false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) {
      const trashRoot = path.join(root, INTERNAL_DIRS.trash);
      ensureDir(trashRoot);
      const backup = path.join(trashRoot, `${safeBaseName(id)}-${Date.now()}`);
      try {
        fs.renameSync(target, backup);
        pendingCleanup = true;
      } catch (err) {
        fail(ERROR_CODES.PERMISSION_DENIED, `无法删除插件目录: ${err.message}`, err);
      }
    } else {
      fail(ERROR_CODES.INSTALL_FAILED, `卸载失败: ${e.message}`, e);
    }
  }

  removeOldArchives(path.join(root, INTERNAL_DIRS.packages), id);

  let dataDeleted = false;
  if (deleteData && dataDir) {
    const dataPath = path.join(path.resolve(dataDir), id);
    try {
      fs.rmSync(dataPath, { recursive: true, force: true });
      dataDeleted = true;
    } catch (e) {
      // 数据删除失败不阻塞插件卸载
    }
  }

  return { ok: true, id, pendingCleanup, dataDeleted };
}

function moveToFailed(userPluginsDir, packagePath, reason) {
  const failedDir = path.join(userPluginsDir, INTERNAL_DIRS.failed);
  ensureDir(failedDir);
  const base = path.basename(packagePath);
  let target = path.join(failedDir, base);
  if (fs.existsSync(target)) {
    target = path.join(failedDir, `${Date.now()}-${base}`);
  }
  try {
    fs.renameSync(packagePath, target);
  } catch (e) {
    try {
      fs.copyFileSync(packagePath, target);
      fs.rmSync(packagePath, { force: true });
    } catch (err) {
      return packagePath;
    }
  }
  try {
    fs.writeFileSync(`${target}.error.txt`, `${reason}\n`, 'utf8');
  } catch (e) { /* 忽略 */ }
  return target;
}

/**
 * 扫描 userPluginsDir 顶层的插件包并自动安装。
 * 已安装相同/更高版本、或与内置冲突的包会移入 .failed，避免每次启动重复尝试。
 */
function scanPendingPackages(options = {}) {
  const { userPluginsDir: rawUserDir, builtinIds = [], limits } = options;
  if (!rawUserDir) return { installed: [], failed: [], skipped: [] };
  const userPluginsDir = path.resolve(rawUserDir);
  ensurePluginDirs(userPluginsDir);

  let entries = [];
  try {
    entries = fs.readdirSync(userPluginsDir, { withFileTypes: true });
  } catch (e) {
    return { installed: [], failed: [], skipped: [] };
  }

  const installed = [];
  const failed = [];
  const skipped = [];
  const builtin = new Set([...builtinIds].map((id) => String(id).toLowerCase()));

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (!PACKAGE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
    const packagePath = path.join(userPluginsDir, entry.name);

    let inspection;
    try {
      inspection = inspectPackage(packagePath, { limits });
    } catch (e) {
      const moved = moveToFailed(userPluginsDir, packagePath, e.message);
      failed.push({ file: moved, error: e.message, code: e.code || 'INVALID_PACKAGE' });
      continue;
    }

    if (builtin.has(inspection.manifest.id.toLowerCase())) {
      const moved = moveToFailed(userPluginsDir, packagePath, `插件 id 与内置插件冲突: ${inspection.manifest.id}`);
      failed.push({ file: moved, error: '与内置插件冲突', code: ERROR_CODES.ID_CONFLICT });
      continue;
    }

    const current = getInstalledInfo(userPluginsDir, inspection.manifest.id);
    if (current && compareVersions(current.version, inspection.manifest.version) >= 0) {
      const reason = `已安装 ${current.id} v${current.version}，跳过 ${inspection.manifest.version}`;
      const moved = moveToFailed(userPluginsDir, packagePath, reason);
      skipped.push({ file: moved, id: current.id, error: reason });
      continue;
    }

    try {
      const result = installPackage(packagePath, {
        userPluginsDir,
        builtinIds,
        overwrite: true,
        moveSource: true,
        limits
      });
      installed.push({
        id: result.id,
        version: result.version,
        file: result.archivePath || packagePath,
        dir: result.dir
      });
    } catch (e) {
      const moved = moveToFailed(userPluginsDir, packagePath, e.message);
      failed.push({ file: moved, error: e.message, code: e.code || 'INSTALL_FAILED' });
    }
  }

  return { installed, failed, skipped };
}

/** 清理过期的 .staging / .trash / .failed（默认 24 小时） */
function sweepTempDirs(userPluginsDir, options = {}) {
  if (!userPluginsDir) return;
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const name of [INTERNAL_DIRS.staging, INTERNAL_DIRS.trash]) {
    const dir = path.join(userPluginsDir, name);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(target);
        if (now - stat.mtimeMs > maxAgeMs) fs.rmSync(target, { recursive: true, force: true });
      } catch (e) { /* 忽略 */ }
    }
  }
}

module.exports = {
  PACKAGE_EXTENSIONS,
  DEFAULT_LIMITS,
  INTERNAL_DIRS,
  ERROR_CODES,
  InstallerError,
  normalizeEntryName,
  shouldIgnoreEntry,
  isSymlinkEntry,
  inspectPackage,
  installPackage,
  uninstallPackage,
  scanPendingPackages,
  sweepTempDirs,
  ensurePluginDirs,
  getInstalledInfo,
  findDirsById,
  formatBytes
};
