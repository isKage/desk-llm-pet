/**
 * 插件清单（plugin.json）规范化与校验
 * ============================================================================
 * 这里的函数是纯函数 / 只依赖 fs，不依赖 Electron，方便安装器与自检直接复用。
 * 宿主（plugin-manager）与安装器（plugin-installer）共用同一套规则，避免
 * 「安装时通过、加载时拒绝」或反过来。
 */

const fs = require('fs');
const path = require('path');

/** 宿主插件 API 版本：清单里的 apiVersion 大于它时拒绝加载 */
const PLUGIN_API_VERSION = 1;

/** 插件 id 规范：小写字母/数字开头，允许 . _ - */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;
/** 设置字段 key 规范：只允许字母数字 _ -（可直接用于 DOM 选择器） */
const SAFE_KEY = /^[a-z0-9_-]+$/i;
/** 允许的设置字段类型 */
const FIELD_TYPES = ['text', 'password', 'number', 'boolean', 'textarea', 'select'];
/** 不允许作为插件 id 的保留名 */
const RESERVED_IDS = new Set(['node_modules', 'plugins', 'plugin-data', 'package.json']);

/** 确保目标路径位于目录内部（阻止 ../ 逃逸）；允许 target 等于 dir 时由调用方决定 */
function isPathInside(dir, target) {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 解析 semver（支持 x.y.z 与 x.y.z-prerelease），失败返回 null */
function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || ''
  };
}

/** 是否是合法 semver */
function isValidSemver(value) {
  return parseSemver(value) !== null;
}

/**
 * 比较两个版本号；a > b 返回正数，a < b 返回负数，相等返回 0。
 * 非 semver 时退化为字符串比较（内置插件兼容）。
 */
function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(a || '').localeCompare(String(b || ''));
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }
  // 没有 prerelease 的版本更高
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  return pa.prerelease.localeCompare(pb.prerelease);
}

// ============================================================================
// 贡献点清洗（纯函数，便于单测）
// ============================================================================

/** 规范化设置字段列表 */
function sanitizeFields(rawFields) {
  if (!Array.isArray(rawFields)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of rawFields) {
    if (!raw || typeof raw !== 'object') continue;
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!key || !SAFE_KEY.test(key) || seen.has(key)) continue;
    const type = FIELD_TYPES.includes(raw.type) ? raw.type : 'text';
    seen.add(key);
    const field = {
      key,
      label: raw.label || key,
      type,
      default: raw.default,
      hint: raw.hint || '',
      placeholder: raw.placeholder || ''
    };
    if (type === 'number') {
      if (Number.isFinite(Number(raw.min))) field.min = Number(raw.min);
      if (Number.isFinite(Number(raw.max))) field.max = Number(raw.max);
      if (Number.isFinite(Number(raw.step))) field.step = Number(raw.step);
      if (!Number.isFinite(Number(field.default))) field.default = 0;
    }
    if (type === 'boolean') field.default = raw.default === true;
    if (type === 'textarea') field.rows = Number.isFinite(Number(raw.rows)) ? Number(raw.rows) : 3;
    if (type === 'select') {
      field.options = (Array.isArray(raw.options) ? raw.options : [])
        .filter((o) => o && typeof o === 'object' && o.value !== undefined)
        .map((o) => ({ value: String(o.value), label: o.label ? String(o.label) : String(o.value) }));
      if (!field.options.length) field.options = [{ value: '', label: '（无选项）' }];
      const values = field.options.map((o) => o.value);
      field.default = values.includes(String(field.default)) ? String(field.default) : values[0];
    }
    if (typeof field.default !== 'string' && field.type !== 'number' && field.type !== 'boolean') {
      field.default = field.default === undefined || field.default === null ? '' : String(field.default);
    }
    out.push(field);
  }
  return out;
}

/** 规范化设置动作列表 */
function sanitizeActions(rawActions) {
  if (!Array.isArray(rawActions)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of rawActions) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: raw.label || id, style: raw.style === 'primary' ? 'primary' : 'secondary' });
  }
  return out;
}

/** 读取清单中的菜单贡献 */
function sanitizeMenuItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter((item) => item && typeof item === 'object' && typeof item.command === 'string' && item.command.trim())
    .map((item) => ({
      command: item.command.trim(),
      label: item.label ? String(item.label) : item.command.trim(),
      icon: item.icon ? String(item.icon) : '🧩',
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : 0
    }));
}

// ============================================================================
// 清单规范化
// ============================================================================

/**
 * 规范化清单。校验失败抛错（只影响该插件）。
 * @param {Object} raw plugin.json 解析后的对象
 * @param {{fallbackId?: string}} [options] 清单缺少 id 时用目录名兜底
 * @returns {Object} 规范化后的清单
 */
function normalizeManifest(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('plugin.json 内容必须是对象');
  }

  const id = String(raw.id || options.fallbackId || '').trim();
  if (!id) throw new Error('缺少 id');
  if (!SAFE_ID.test(id)) throw new Error(`id 非法（只允许小写字母数字 . _ -，且以字母/数字开头）: ${id}`);
  if (RESERVED_IDS.has(id)) throw new Error(`id 是保留名: ${id}`);

  const normalizeRel = (value) => String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const main = normalizeRel(raw.main || 'main.js');
  if (!main) throw new Error('main 不能为空');
  const preload = raw.preload ? normalizeRel(raw.preload) : '';
  if (raw.preload !== undefined && !preload) throw new Error('preload 不能为空字符串');

  const apiVersion = raw.apiVersion === undefined ? PLUGIN_API_VERSION : Number(raw.apiVersion);
  if (!Number.isInteger(apiVersion) || apiVersion < 1) throw new Error(`apiVersion 非法: ${raw.apiVersion}`);
  if (apiVersion > PLUGIN_API_VERSION) {
    throw new Error(`插件需要更新的 DeskLLMPet（apiVersion ${apiVersion} > 宿主 ${PLUGIN_API_VERSION}）`);
  }

  const contributes = raw.contributes && typeof raw.contributes === 'object' && !Array.isArray(raw.contributes)
    ? raw.contributes
    : {};
  for (const key of ['petMenu', 'trayMenu']) {
    if (contributes[key] !== undefined && !Array.isArray(contributes[key])) {
      throw new Error(`contributes.${key} 必须是数组`);
    }
  }
  if (contributes.settings !== undefined) {
    const settings = contributes.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('contributes.settings 必须是对象');
    }
    if (settings.fields !== undefined && !Array.isArray(settings.fields)) {
      throw new Error('contributes.settings.fields 必须是数组');
    }
    if (settings.actions !== undefined && !Array.isArray(settings.actions)) {
      throw new Error('contributes.settings.actions 必须是数组');
    }
  }

  return {
    ...raw,
    id,
    name: String(raw.name || id).trim() || id,
    version: String(raw.version || '0.0.0').trim() || '0.0.0',
    description: String(raw.description || '').trim(),
    author: String(raw.author || '').trim(),
    apiVersion,
    main,
    preload,
    enabled: raw.enabled !== false,
    contributes
  };
}

/**
 * 校验清单里的入口文件位于插件目录内、存在且不是 symlink 逃逸。
 * @param {Object} manifest 已 normalize 的清单
 * @param {string} dir 插件目录
 * @returns {{mainPath: string, preloadPath: string|null}}
 */
function validateManifestPaths(manifest, dir) {
  const root = path.resolve(dir);
  const realRoot = safeRealpath(root);

  function resolveFile(rel, label) {
    const target = path.resolve(root, rel);
    if (!isPathInside(root, target)) throw new Error(`${label} 必须位于插件目录内`);
    if (!fs.existsSync(target)) throw new Error(`${label} 不存在: ${rel}`);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`${label} 不允许是符号链接: ${rel}`);
    if (!stat.isFile()) throw new Error(`${label} 不是普通文件: ${rel}`);
    const realTarget = safeRealpath(target);
    if (realRoot && realTarget && !isPathInside(realRoot, realTarget)) {
      throw new Error(`${label} 指向插件目录之外: ${rel}`);
    }
    return target;
  }

  const mainPath = resolveFile(manifest.main, 'main');
  const preloadPath = manifest.preload ? resolveFile(manifest.preload, 'preload') : null;
  return { mainPath, preloadPath };
}

/** realpath 失败时返回空字符串（asar/受限环境兜底） */
function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch (e) {
    return '';
  }
}

module.exports = {
  PLUGIN_API_VERSION,
  SAFE_ID,
  SAFE_KEY,
  FIELD_TYPES,
  RESERVED_IDS,
  isPathInside,
  isValidSemver,
  parseSemver,
  compareVersions,
  sanitizeFields,
  sanitizeActions,
  sanitizeMenuItems,
  normalizeManifest,
  validateManifestPaths
};
