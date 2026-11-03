/**
 * 插件宿主（主进程）
 * ============================================================================
 * 目标：
 *   1. 把「可扩展功能」与本体彻底解耦，插件出错/缺失都不影响本体；
 *   2. 插件可以来自内置目录（src/plugins，只读），也可以从用户数据目录安装
 *      （userData/plugins，可写），支持启用/禁用、热重载；
 *   3. 为插件预留统一接口：菜单项、设置页表单、命名空间化 IPC、独立存储与窗口。
 *
 * 一个插件就是一个目录：
 *   plugin.json   清单（必需）
 *   main.js       主进程入口，导出 { activate(ctx), deactivate?(ctx) }
 *   preload.js    渲染进程桥（可选，由清单的 preload 字段声明）
 *   renderer/*    插件自己的页面（可选）
 *
 * 详细接口说明见 docs/plugins/development.md。
 *
 * 本模块不直接 require('electron')，所有 Electron 能力由外部注入，
 * 因此可以脱离 GUI 单独做自检（见 scripts/self-check.js）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  PLUGIN_API_VERSION,
  SAFE_ID,
  sanitizeFields,
  sanitizeActions,
  sanitizeMenuItems,
  normalizeManifest,
  validateManifestPaths,
  compareVersions
} = require('./manifest');

// 安装器依赖 adm-zip；缺失时只影响「安装/扫描」功能，不影响已有插件加载
let installer = null;
try {
  installer = require('./plugin-installer');
} catch (e) {
  console.warn('⚠️ 插件安装器加载失败（安装功能不可用，已有插件不受影响）:', e.message);
}

/** 内置插件根目录（本文件所在目录） */
const PLUGINS_DIR = __dirname;
/** 宿主对渲染进程暴露的注册表通道前缀 */
const CHANNEL_PREFIX = 'plugins:';
/** 插件自有 IPC 的通道前缀（完整形如 plugin:<id>:<channel>） */
const PLUGIN_CHANNEL_PREFIX = 'plugin:';

let currentHost = null;

/**
 * 默认的存储工厂：数据落在 <userData>/<name>.json
 * 可注入替换（自检脚本用内存实现），避免在非 Electron 环境加载 electron-store。
 */
function defaultStoreFactory({ name, cwd, defaults }) {
  const Store = require('electron-store');
  return new Store({ name, cwd, defaults });
}

/** 极简内存 store，作为 electron-store 不可用时的兜底 */
function createFallbackStore(defaults = {}) {
  const data = JSON.parse(JSON.stringify(defaults));
  return {
    get(key) { return key === undefined ? data : data[key]; },
    set(key, value) { data[key] = value; }
  };
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    return false;
  }
}

function copyDirMerge(source, target) {
  ensureDir(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirMerge(from, to);
    } else if (!fs.existsSync(to)) {
      fs.copyFileSync(from, to);
    }
  }
}

/** 清除某个目录下所有 require 缓存（插件升级/卸载后重新加载新代码） */
function purgeRequireCache(dir) {
  const root = path.resolve(dir);
  for (const key of Object.keys(require.cache)) {
    if (key === root || key.startsWith(`${root}${path.sep}`)) {
      try { delete require.cache[key]; } catch (e) { /* 忽略 */ }
    }
  }
}

// ============================================================================
// 插件宿主
// ============================================================================

function createPluginManager(options = {}) {
  const electron = options.electron || {};
  const { app, ipcMain, BrowserWindow, shell, dialog } = electron;
  const log = options.logger || console;
  const storeFactory = typeof options.storeFactory === 'function' ? options.storeFactory : defaultStoreFactory;
  const hostServices = options.hostServices && typeof options.hostServices === 'object' ? options.hostServices : {};
  const onPluginsChanged = typeof options.onPluginsChanged === 'function' ? options.onPluginsChanged : null;

  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('插件宿主需要 electron.ipcMain');
  }

  function userDataDir() {
    try {
      if (app && typeof app.getPath === 'function') return app.getPath('userData');
    } catch (e) { /* 回退到临时目录 */ }
    return path.join(os.tmpdir(), 'deskllmpet-plugins');
  }

  /** 内置插件目录（只读） */
  const builtinPluginsDir = path.resolve(options.builtinPluginsDir || options.pluginsDir || PLUGINS_DIR);
  /** 用户插件目录（可写，userData/plugins） */
  const userPluginsDir = path.resolve(options.userPluginsDir || path.join(userDataDir(), 'plugins'));
  /** 插件数据目录（userData/plugin-data，和代码目录分开，避免和旧版本数据混淆） */
  const pluginDataDir = path.resolve(options.dataDir || path.join(userDataDir(), 'plugin-data'));

  /** id -> 插件记录（仅已加载的插件） */
  const records = new Map();
  /** id -> 目录项（含禁用/失败/未加载） */
  const catalog = new Map();
  /** 加载报告（用于日志 / 自检 / 设置页） */
  const reports = [];
  /** 发现阶段的错误（重复 id 等） */
  let discoveryErrors = [];
  let registryRegistered = false;
  let initialLoad = null;
  let loaded = false;

  /** 状态存储（disabled / installed） */
  let stateStore = null;
  function getStateStore() {
    if (stateStore) return stateStore;
    try {
      stateStore = storeFactory({
        name: 'plugins-state',
        cwd: userDataDir(),
        defaults: { version: 1, disabled: [], installed: {} }
      });
    } catch (e) {
      log.warn('⚠️ 插件状态存储不可用，使用内存兜底:', e.message);
      stateStore = createFallbackStore({ version: 1, disabled: [], installed: {} });
    }
    return stateStore;
  }

  function readDisabled() {
    try {
      const raw = getStateStore().get('disabled');
      return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && SAFE_ID.test(id)) : []);
    } catch (e) {
      return new Set();
    }
  }

  function readInstalled() {
    try {
      const raw = getStateStore().get('installed');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const out = {};
      for (const [id, info] of Object.entries(raw)) {
        if (!SAFE_ID.test(id) || !info || typeof info !== 'object') continue;
        out[id] = {
          version: typeof info.version === 'string' ? info.version : '',
          installedAt: typeof info.installedAt === 'string' ? info.installedAt : null,
          packageHash: typeof info.packageHash === 'string' ? info.packageHash : '',
          archive: typeof info.archive === 'string' ? info.archive : '',
          source: info.source === 'manual' ? 'manual' : 'package'
        };
      }
      return out;
    } catch (e) {
      return {};
    }
  }

  function writeState(disabled, installed) {
    try {
      getStateStore().set('disabled', [...disabled].sort());
      getStateStore().set('installed', installed);
    } catch (e) {
      log.warn('⚠️ 保存插件状态失败:', e.message);
    }
  }

  function dataDirOf(id) {
    return path.join(pluginDataDir, id);
  }

  const tag = (id) => `[插件:${id}]`;

  // ---------- 旧数据迁移 ----------

  /**
   * 旧版本把插件数据放在 userData/plugins/<id>/，新版本放在 userData/plugin-data/<id>/。
   * 这里只迁移「没有 plugin.json、没有 .js 文件、含 settings.json/data.json 等」的数据目录，
   * 避免误伤用户手动放入的插件代码。
   */
  function migrateLegacyData() {
    if (!ensureDir(userPluginsDir)) return;
    ensureDir(pluginDataDir);
    let entries = [];
    try {
      entries = fs.readdirSync(userPluginsDir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const legacyDir = path.join(userPluginsDir, entry.name);
      if (fs.existsSync(path.join(legacyDir, 'plugin.json'))) continue;

      let names = [];
      try { names = fs.readdirSync(legacyDir); } catch (e) { continue; }
      const looksLikeCode = names.some((name) => /\.(js|cjs|mjs|node)$/i.test(name));
      const looksLikeStore = names.some((name) => /\.json$/i.test(name));
      if (looksLikeCode || !looksLikeStore) continue;

      const target = path.join(pluginDataDir, entry.name);
      try {
        if (!fs.existsSync(target)) {
          fs.renameSync(legacyDir, target);
        } else {
          copyDirMerge(legacyDir, target);
          fs.rmSync(legacyDir, { recursive: true, force: true });
        }
        log.log(`[插件] 已迁移旧数据目录: ${entry.name} -> plugin-data/`);
      } catch (e) {
        log.warn(`[插件] 旧数据迁移失败（保留原目录）[${entry.name}]:`, e.message);
      }
    }
  }

  // ---------- 内置插件 id ----------

  function collectBuiltinIds() {
    const ids = new Set();
    let entries = [];
    try {
      entries = fs.readdirSync(builtinPluginsDir, { withFileTypes: true });
    } catch (e) {
      return ids;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const manifestPath = path.join(builtinPluginsDir, entry.name, 'plugin.json');
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        ids.add(String(raw.id || entry.name).toLowerCase());
      } catch (e) {
        ids.add(entry.name.toLowerCase());
      }
    }
    return ids;
  }

  // ---------- 发现 ----------

  function discoverCatalog() {
    catalog.clear();
    discoveryErrors = [];
    const seen = new Set();

    function scanRoot(root, origin) {
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch (e) {
        if (origin === 'builtin') log.warn('[插件] 无法读取内置插件目录:', e.message);
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

        const dir = path.join(root, entry.name);
        const manifestPath = path.join(dir, 'plugin.json');
        let manifest = null;
        let error = '';

        if (!fs.existsSync(manifestPath)) {
          if (origin === 'builtin') continue;
          error = '缺少 plugin.json';
        } else {
          try {
            const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
            manifest = normalizeManifest(raw, { fallbackId: entry.name });
          } catch (e) {
            error = e.message;
          }
        }

        const id = manifest ? manifest.id : entry.name;
        if (!SAFE_ID.test(id)) {
          discoveryErrors.push({ id: entry.name, status: 'error', origin, error: `id 非法: ${id}` });
          continue;
        }
        if (seen.has(id)) {
          discoveryErrors.push({
            id,
            name: manifest ? manifest.name : id,
            status: 'error',
            origin,
            error: 'id 重复（内置插件优先）'
          });
          continue;
        }
        seen.add(id);
        catalog.set(id, {
          id,
          origin,
          dir,
          manifest,
          error,
          status: 'disabled',
          active: false,
          enabled: false,
          locked: !!(manifest && manifest.enabled === false)
        });
      }
    }

    scanRoot(builtinPluginsDir, 'builtin');
    scanRoot(userPluginsDir, 'user');
  }

  /** 同步状态：手动放入的插件补登记；目录已删的旧状态清掉 */
  function reconcileState() {
    const disabled = readDisabled();
    const installed = readInstalled();
    let changed = false;

    for (const id of [...disabled]) {
      if (!catalog.has(id)) {
        disabled.delete(id);
        changed = true;
      }
    }
    for (const id of Object.keys(installed)) {
      if (!catalog.has(id)) {
        delete installed[id];
        changed = true;
      }
    }
    for (const entry of catalog.values()) {
      if (entry.origin === 'builtin' || !entry.manifest) continue;
      if (!installed[entry.id]) {
        installed[entry.id] = {
          version: entry.manifest.version,
          installedAt: null,
          packageHash: '',
          archive: '',
          source: 'manual'
        };
        changed = true;
      }
    }

    if (changed) writeState(disabled, installed);
  }

  // ---------- 校验 / 上下文 ----------

  function buildRecord(entry) {
    const { id, dir, manifest, origin } = entry;
    const paths = validateManifestPaths(manifest, dir);
    ensureDir(dataDirOf(id));

    const record = {
      id,
      origin,
      dir,
      manifest,
      mainPath: paths.mainPath,
      preloadPath: paths.preloadPath,
      channels: new Set(),
      windows: new Set(),
      commandHandlers: [],
      settingsActions: [],
      settingsListeners: [],
      deactivateHandlers: [],
      active: false,
      store: null,
      ctx: null,
      module: null
    };

    record.store = storeFactory({
      name: 'settings',
      cwd: dataDirOf(id),
      defaults: { settings: {} }
    });
    record.ctx = createContext(record);
    return record;
  }

  function createContext(record) {
    const { id, dir, manifest, origin } = record;
    const settingsManifest = (manifest.contributes && manifest.contributes.settings) || {};
    const fields = sanitizeFields(settingsManifest.fields);

    const channelOf = (channel) => {
      if (typeof channel !== 'string' || !channel.trim()) throw new Error('IPC channel 必须是非空字符串');
      return `${PLUGIN_CHANNEL_PREFIX}${id}:${channel.trim()}`;
    };

    function defaultsOf() {
      const out = {};
      for (const f of fields) out[f.key] = f.default;
      return out;
    }

    function coerce(field, value) {
      switch (field.type) {
        case 'boolean':
          return value === true || value === 'true';
        case 'number': {
          const num = Number(value);
          if (!Number.isFinite(num)) return field.default;
          const min = field.min === undefined ? -Infinity : field.min;
          const max = field.max === undefined ? Infinity : field.max;
          return Math.min(max, Math.max(min, num));
        }
        case 'select': {
          const allowed = field.options.map((o) => o.value);
          const str = value === undefined || value === null ? '' : String(value);
          return allowed.includes(str) ? str : field.default;
        }
        default:
          return value === undefined || value === null ? '' : String(value);
      }
    }

    function getSettings() {
      const stored = record.store.get('settings') || {};
      const out = defaultsOf();
      for (const f of fields) {
        if (Object.prototype.hasOwnProperty.call(stored, f.key)) out[f.key] = coerce(f, stored[f.key]);
      }
      return out;
    }

    function setSettings(values) {
      const next = getSettings();
      if (values && typeof values === 'object') {
        for (const f of fields) {
          if (Object.prototype.hasOwnProperty.call(values, f.key)) next[f.key] = coerce(f, values[f.key]);
        }
        record.store.set('settings', next);
      }
      for (const listener of [...record.settingsListeners]) {
        try { listener(next); } catch (e) { log.warn(tag(id), '设置变更回调异常:', e.message); }
      }
      return next;
    }

    function openExternal(url) {
      try {
        if (shell && typeof shell.openExternal === 'function') shell.openExternal(url);
      } catch (e) { /* 忽略 */ }
    }

    function createWindow(windowOptions = {}) {
      if (!BrowserWindow) throw new Error('BrowserWindow 不可用');
      const opts = { ...windowOptions };
      const webPreferences = { ...(opts.webPreferences || {}), contextIsolation: true, nodeIntegration: false };
      if (record.preloadPath) webPreferences.preload = record.preloadPath;
      opts.webPreferences = webPreferences;

      const win = new BrowserWindow(opts);
      record.windows.add(win);
      win.on('closed', () => record.windows.delete(win));

      // 安全兜底：插件窗口只允许停留在自己的插件目录内，外链交给系统浏览器
      const pluginUrlPrefix = pathToFileURL(dir).href.replace(/\/?$/, '/');
      try {
        win.webContents.on('will-navigate', (event, url) => {
          if (!String(url).startsWith(pluginUrlPrefix)) {
            event.preventDefault();
            if (/^https?:/i.test(url)) openExternal(url);
          }
        });
        win.webContents.setWindowOpenHandler(({ url }) => {
          if (/^https?:/i.test(url)) openExternal(url);
          return { action: 'deny' };
        });
      } catch (e) { /* 老版本 Electron 兜底 */ }

      return win;
    }

    const ctx = {
      id,
      name: manifest.name || id,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      author: manifest.author || '',
      apiVersion: manifest.apiVersion || PLUGIN_API_VERSION,
      origin,
      dir,
      manifest,
      dataDir: dataDirOf(id),
      log: (...args) => log.log(tag(id), ...args),
      warn: (...args) => log.warn(tag(id), ...args),
      resolve: (...parts) => path.join(dir, ...parts),
      resolveData: (...parts) => path.join(dataDirOf(id), ...parts),

      ipc: {
        handle(channel, handler) {
          if (typeof handler !== 'function') throw new Error('ipc.handle 需要函数');
          const full = channelOf(channel);
          ipcMain.handle(full, handler);
          record.channels.add(full);
          return full;
        },
        on(channel, handler) {
          if (typeof handler !== 'function') throw new Error('ipc.on 需要函数');
          const full = channelOf(channel);
          ipcMain.on(full, handler);
          record.channels.add(full);
          return full;
        },
        send(channel, payload) {
          const full = `${PLUGIN_CHANNEL_PREFIX}${id}:${String(channel)}`;
          for (const win of record.windows) {
            try {
              if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                win.webContents.send(full, payload);
              }
            } catch (e) { /* 忽略单个窗口的异常 */ }
          }
        }
      },

      /** 插件专属存储（数据隔离在 <userData>/plugin-data/<id>/） */
      createStore(name, defaults) {
        const safeName = String(name || 'data').replace(/[^a-z0-9._-]/gi, '_') || 'data';
        return storeFactory({
          name: safeName,
          cwd: dataDirOf(id),
          defaults: defaults && typeof defaults === 'object' ? defaults : {}
        });
      },

      createWindow,
      settings: { get: getSettings, set: setSettings },

      /** 菜单项被点击时回调 (command, payload) */
      onCommand(fn) { if (typeof fn === 'function') record.commandHandlers.push(fn); },
      /** 设置页动作按钮被点击时回调 (actionId, values)，可返回 { message } */
      onSettingsAction(fn) { if (typeof fn === 'function') record.settingsActions.push(fn); },
      /** 设置被保存后回调 (values) */
      onSettingsChanged(fn) { if (typeof fn === 'function') record.settingsListeners.push(fn); },
      /** 插件卸载时回调 */
      onDeactivate(fn) { if (typeof fn === 'function') record.deactivateHandlers.push(fn); },

      host: {
        app,
        BrowserWindow,
        shell,
        dialog,
        getSharedLLMConfig: typeof hostServices.getSharedLLMConfig === 'function'
          ? () => {
            try { return hostServices.getSharedLLMConfig() || null; }
            catch (e) { return null; }
          }
          : () => null,
        openSettings: typeof hostServices.openSettings === 'function'
          ? () => {
            try { return hostServices.openSettings() !== false; }
            catch (e) { return false; }
          }
          : null
      }
    };

    return ctx;
  }

  // ---------- 生命周期 ----------

  function disposeRecord(record) {
    record.active = false;
    for (const handler of [...record.deactivateHandlers].reverse()) {
      try { handler(); } catch (e) { log.warn(tag(record.id), '卸载回调异常:', e.message); }
    }
    record.deactivateHandlers = [];

    for (const channel of record.channels) {
      try { ipcMain.removeHandler(channel); } catch (e) { /* 非 handle 通道会抛错，忽略 */ }
      try { if (typeof ipcMain.removeAllListeners === 'function') ipcMain.removeAllListeners(channel); } catch (e) { /* 忽略 */ }
    }
    record.channels.clear();

    for (const win of [...record.windows]) {
      try { if (!win.isDestroyed()) win.destroy(); } catch (e) { /* 忽略 */ }
    }
    record.windows.clear();
  }

  async function deactivatePlugin(id, { purge = true } = {}) {
    const record = records.get(String(id || ''));
    if (!record) return;
    try {
      if (record.module && typeof record.module.deactivate === 'function') {
        await record.module.deactivate(record.ctx);
      }
    } catch (e) {
      log.warn(tag(record.id), 'deactivate 异常:', e.message);
    }
    try { disposeRecord(record); } catch (e) { /* 忽略 */ }
    records.delete(record.id);
    if (purge) purgeRequireCache(record.dir);
  }

  async function deactivateAll() {
    for (const id of [...records.keys()]) {
      try { await deactivatePlugin(id); } catch (e) { /* 忽略 */ }
    }
    records.clear();
  }

  async function loadAllInternal() {
    registerRegistryIpc();

    ensureDir(userPluginsDir);
    ensureDir(pluginDataDir);
    migrateLegacyData();

    let scan = { installed: [], failed: [], skipped: [] };
    if (installer) {
      try {
        installer.sweepTempDirs(userPluginsDir);
        scan = installer.scanPendingPackages({
          userPluginsDir,
          builtinIds: [...collectBuiltinIds()]
        });
        if (scan.installed.length || scan.failed.length) {
          log.log(`[插件] 自动扫描：安装 ${scan.installed.length} 个，失败 ${scan.failed.length} 个`);
        }
      } catch (e) {
        log.warn('[插件] 扫描插件目录失败:', e.message);
      }
    }

    discoverCatalog();
    reconcileState();

    const disabled = readDisabled();

    for (const err of discoveryErrors) {
      reports.push({ ...err });
    }

    for (const entry of catalog.values()) {
      const { id, manifest } = entry;
      if (entry.error) {
        entry.status = 'error';
        entry.enabled = false;
        reports.push({
          id,
          name: manifest ? manifest.name : id,
          version: manifest ? manifest.version : '',
          origin: entry.origin,
          status: 'error',
          error: entry.error
        });
        continue;
      }

      const locked = manifest.enabled === false;
      const enabled = !locked && !disabled.has(id);
      entry.locked = locked;
      entry.enabled = enabled;

      if (!enabled) {
        entry.status = 'disabled';
        reports.push({
          id,
          name: manifest.name,
          version: manifest.version,
          origin: entry.origin,
          status: 'disabled',
          error: locked ? '插件清单中 enabled=false（作者禁用）' : ''
        });
        continue;
      }

      try {
        const record = buildRecord(entry);
        const mod = require(record.mainPath);
        record.module = mod;
        const activate = typeof mod === 'function' ? mod : mod && mod.activate;
        if (typeof activate !== 'function') throw new Error('入口文件必须导出 activate(ctx)');

        // 先登记，插件在 activate 期间即可使用宿主 API
        records.set(id, record);
        await activate(record.ctx);
        record.active = true;
        entry.active = true;
        entry.status = 'active';
        reports.push({
          id,
          name: manifest.name,
          version: manifest.version,
          origin: entry.origin,
          status: 'active'
        });
        log.log(`✅ 插件已加载: ${manifest.name} v${manifest.version} (${id}, ${entry.origin})`);
      } catch (e) {
        const record = records.get(id);
        if (record) {
          records.delete(id);
          try { disposeRecord(record); } catch (err) { /* 忽略 */ }
        }
        entry.active = false;
        entry.status = 'error';
        entry.error = e.message;
        reports.push({
          id,
          name: manifest.name,
          version: manifest.version,
          origin: entry.origin,
          status: 'error',
          error: e.message
        });
        log.warn(`⚠️ 插件加载失败 [${id}]: ${e.message}（已跳过，不影响本体功能）`);
      }
    }

    loaded = true;
    broadcastChanged('reload');
    if (onPluginsChanged) {
      try { onPluginsChanged(); } catch (e) { log.warn('插件变更回调异常:', e.message); }
    }
    return { reports: [...reports], scan };
  }

  let reloadQueue = Promise.resolve();

  /** 强制重新扫描并加载全部插件；串行执行，避免并发重载 */
  function reloadAll() {
    const run = reloadQueue.then(async () => {
      await deactivateAll();
      records.clear();
      catalog.clear();
      reports.length = 0;
      loaded = false;
      return loadAllInternal();
    });
    reloadQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function loadAll() {
    if (loaded) return [...reports];
    if (initialLoad) return initialLoad;
    initialLoad = reloadAll()
      .then((result) => result.reports)
      .catch((e) => {
        log.warn('⚠️ 插件系统初始化失败（本体功能不受影响）:', e.message);
        return [...reports];
      });
    return initialLoad;
  }

  // ---------- 对外查询 ----------

  function collectMenu(kind) {
    const out = [];
    for (const record of records.values()) {
      if (!record.active) continue;
      const contributes = record.manifest.contributes || {};
      for (const item of sanitizeMenuItems(contributes[kind])) {
        out.push({
          pluginId: record.id,
          pluginName: record.ctx ? record.ctx.name : record.id,
          command: item.command,
          label: item.label,
          icon: item.icon,
          order: item.order
        });
      }
    }
    return out.sort((a, b) => (a.order - b.order) || a.pluginId.localeCompare(b.pluginId));
  }

  function getSettingsSections() {
    const out = [];
    for (const record of records.values()) {
      if (!record.active) continue;
      const settings = (record.manifest.contributes || {}).settings;
      if (!settings || typeof settings !== 'object') continue;
      const fields = sanitizeFields(settings.fields);
      const actions = sanitizeActions(settings.actions);
      if (!fields.length && !actions.length) continue;
      out.push({
        pluginId: record.id,
        title: settings.title || (record.ctx ? record.ctx.name : record.id),
        icon: settings.icon || '🧩',
        description: settings.description || '',
        fields,
        actions
      });
    }
    return out;
  }

  function listPlugins() {
    const installed = readInstalled();
    const list = [];
    for (const entry of catalog.values()) {
      const manifest = entry.manifest || {};
      const stateInfo = installed[entry.id] || {};
      const origin = entry.origin === 'builtin'
        ? 'builtin'
        : (stateInfo.source === 'manual' ? 'manual' : 'package');
      const settings = (manifest.contributes && manifest.contributes.settings) || {};
      list.push({
        id: entry.id,
        name: manifest.name || entry.id,
        version: manifest.version || '',
        description: manifest.description || '',
        author: manifest.author || '',
        apiVersion: manifest.apiVersion || PLUGIN_API_VERSION,
        origin,
        dir: entry.dir,
        active: !!entry.active,
        enabled: entry.enabled === true,
        locked: !!entry.locked,
        status: entry.status || 'disabled',
        error: entry.error || '',
        hasSettings: !!(settings.fields && settings.fields.length) || !!(settings.actions && settings.actions.length),
        installedAt: stateInfo.installedAt || null
      });
    }
    return list.sort((a, b) => {
      if (a.origin !== b.origin) return a.origin === 'builtin' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  }

  async function runCommand(pluginId, command, payload) {
    const record = records.get(String(pluginId || ''));
    if (!record) return { success: false, error: `插件 ${pluginId} 未加载` };
    if (!record.active) return { success: false, error: `插件 ${pluginId} 未启用` };
    if (!record.commandHandlers.length) return { success: false, error: `插件 ${pluginId} 未注册命令处理器` };
    try {
      for (const handler of record.commandHandlers) {
        await handler(String(command || ''), payload && typeof payload === 'object' ? payload : {});
      }
      return { success: true };
    } catch (e) {
      log.warn(tag(record.id), `命令 ${command} 执行失败:`, e.message);
      return { success: false, error: e.message };
    }
  }

  function getPluginSettings(pluginId) {
    const record = records.get(String(pluginId || ''));
    if (!record || !record.active) return {};
    return record.ctx.settings.get();
  }

  function setPluginSettings(pluginId, values) {
    const record = records.get(String(pluginId || ''));
    if (!record || !record.active) return { success: false, error: `插件 ${pluginId} 未加载` };
    try {
      return { success: true, values: record.ctx.settings.set(values) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async function runSettingsAction(pluginId, actionId, values) {
    const record = records.get(String(pluginId || ''));
    if (!record || !record.active) return { success: false, error: `插件 ${pluginId} 未加载` };

    const settings = (record.manifest.contributes || {}).settings || {};
    const declared = sanitizeActions(settings.actions);
    if (!declared.some((a) => a.id === actionId)) {
      return { success: false, error: `未声明的设置动作: ${actionId}` };
    }
    if (!record.settingsActions.length) {
      return { success: false, error: `插件 ${pluginId} 未注册设置动作处理器` };
    }
    try {
      for (const handler of record.settingsActions) {
        const result = await handler(String(actionId), values && typeof values === 'object' ? values : record.ctx.settings.get());
        if (result && typeof result === 'object') {
          return { success: result.success !== false, message: result.message || '', error: result.error };
        }
        if (result !== undefined) return { success: true, message: String(result) };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ---------- 安装 / 卸载 / 启用 ----------

  function errorResult(e) {
    return {
      success: false,
      code: (e && e.code) || 'INSTALL_FAILED',
      error: (e && e.message) || String(e)
    };
  }

  function installedInfoForUi(id) {
    if (!installer) return null;
    const info = installer.getInstalledInfo(userPluginsDir, id);
    if (!info) return null;
    return { version: info.version, dir: info.dir };
  }

  function inspectForUi(packagePath) {
    if (!installer) {
      return { ok: false, code: 'INSTALLER_UNAVAILABLE', error: '插件安装组件不可用（缺少 adm-zip）' };
    }
    try {
      const inspection = installer.inspectPackage(packagePath);
      const installed = installedInfoForUi(inspection.manifest.id);
      const builtinConflict = collectBuiltinIds().has(inspection.manifest.id.toLowerCase());
      const downgrade = !!(installed && compareVersions(inspection.manifest.version, installed.version) < 0);
      return {
        ...inspection,
        installed,
        conflict: builtinConflict ? { builtin: true } : null,
        downgrade
      };
    } catch (e) {
      return { ok: false, code: (e && e.code) || 'INVALID_PACKAGE', error: (e && e.message) || String(e) };
    }
  }

  async function installFromPackage(packagePath, options = {}) {
    if (!installer) return { success: false, code: 'INSTALLER_UNAVAILABLE', error: '插件安装组件不可用（缺少 adm-zip）' };
    const overwrite = options.overwrite === true;
    const inspection = inspectForUi(packagePath);
    if (!inspection.ok) return { success: false, code: inspection.code, error: inspection.error };
    if (inspection.conflict) {
      return { success: false, code: 'ID_CONFLICT', error: `插件 id 与内置插件冲突: ${inspection.manifest.id}` };
    }
    if (inspection.installed && !overwrite) {
      return {
        success: false,
        code: 'ALREADY_INSTALLED',
        error: `已安装 v${inspection.installed.version}，请确认覆盖`,
        installed: inspection.installed
      };
    }

    const id = inspection.manifest.id;
    await deactivatePlugin(id);

    const dirname = path.dirname(path.resolve(packagePath));
    const moveSource = path.resolve(dirname) === path.resolve(userPluginsDir);

    try {
      const result = installer.installPackage(packagePath, {
        userPluginsDir,
        builtinIds: [...collectBuiltinIds()],
        overwrite: true,
        moveSource
      });

      const installed = readInstalled();
      installed[result.id] = {
        version: result.version,
        installedAt: new Date().toISOString(),
        packageHash: result.packageHash || '',
        archive: result.archivePath ? path.relative(userPluginsDir, result.archivePath) : '',
        source: 'package'
      };
      writeState(readDisabled(), installed);

      const reload = await reloadAll();
      const plugin = listPlugins().find((item) => item.id === result.id) || null;
      return {
        success: true,
        plugin,
        warnings: [...(inspection.warnings || []), ...(result.warnings || [])],
        scan: reload.scan
      };
    } catch (e) {
      try { await reloadAll(); } catch (err) { /* 忽略 */ }
      return errorResult(e);
    }
  }

  async function uninstallPlugin(id, options = {}) {
    if (!installer) return { success: false, code: 'INSTALLER_UNAVAILABLE', error: '插件安装组件不可用（缺少 adm-zip）' };
    const entry = catalog.get(String(id || ''));
    if (!entry) return { success: false, code: 'NOT_FOUND', error: `插件 ${id} 不存在` };
    if (entry.origin === 'builtin') {
      return { success: false, code: 'BUILTIN_READONLY', error: '内置插件不能卸载，只能禁用' };
    }

    await deactivatePlugin(entry.id);
    try {
      const result = installer.uninstallPackage({
        userPluginsDir,
        pluginDir: entry.dir,
        dataDir: pluginDataDir,
        id: entry.id,
        deleteData: options.deleteData === true
      });
      const installed = readInstalled();
      delete installed[entry.id];
      const disabled = readDisabled();
      disabled.delete(entry.id);
      writeState(disabled, installed);

      const reload = await reloadAll();
      return { success: true, ...result, scan: reload.scan };
    } catch (e) {
      try { await reloadAll(); } catch (err) { /* 忽略 */ }
      return errorResult(e);
    }
  }

  async function setPluginEnabled(id, enabled) {
    const entry = catalog.get(String(id || ''));
    if (!entry) return { success: false, code: 'NOT_FOUND', error: `插件 ${id} 不存在` };
    if (enabled === true && entry.locked) {
      return { success: false, code: 'LOCKED', error: '该插件在 plugin.json 中被作者禁用，不能在应用内开启' };
    }

    const disabled = readDisabled();
    if (enabled === true) disabled.delete(entry.id);
    else disabled.add(entry.id);
    writeState(disabled, readInstalled());

    const reload = await reloadAll();
    const plugin = listPlugins().find((item) => item.id === entry.id) || null;
    return { success: true, enabled: !!enabled, plugin, scan: reload.scan };
  }

  async function pickPluginPackage() {
    if (!dialog || typeof dialog.showOpenDialog !== 'function') {
      return { canceled: true, error: '文件选择对话框不可用' };
    }
    const openOptions = {
      title: '选择 DeskLLMPet 插件包',
      properties: ['openFile'],
      filters: [
        { name: 'DeskLLMPet 插件包', extensions: ['dlmpet', 'zip'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    };
    try {
      const win = BrowserWindow && typeof BrowserWindow.getFocusedWindow === 'function'
        ? BrowserWindow.getFocusedWindow()
        : null;
      const result = win
        ? await dialog.showOpenDialog(win, openOptions)
        : await dialog.showOpenDialog(openOptions);
      return {
        canceled: !!(result && result.canceled),
        filePath: (result && result.filePaths && result.filePaths[0]) || ''
      };
    } catch (e) {
      return { canceled: true, error: e.message };
    }
  }

  async function openPluginsDir() {
    ensureDir(userPluginsDir);
    try {
      if (!shell || typeof shell.openPath !== 'function') {
        return { success: false, path: userPluginsDir, error: '当前环境不支持打开目录' };
      }
      const error = await shell.openPath(userPluginsDir);
      return error ? { success: false, path: userPluginsDir, error } : { success: true, path: userPluginsDir };
    } catch (e) {
      return { success: false, path: userPluginsDir, error: e.message };
    }
  }

  async function openPluginDir(id) {
    const entry = catalog.get(String(id || ''));
    if (!entry) return { success: false, error: `插件 ${id} 不存在` };
    if (entry.origin === 'builtin') return { success: false, error: '内置插件位于应用安装目录，不能在文件管理器中打开' };
    try {
      if (!shell || typeof shell.openPath !== 'function') return { success: false, error: '当前环境不支持打开目录' };
      const error = await shell.openPath(entry.dir);
      return error ? { success: false, error } : { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function getPluginPaths() {
    return {
      userPluginsDir,
      pluginDataDir,
      builtinPluginsDir
    };
  }

  // ---------- 宿主注册表 IPC ----------

  function broadcastChanged(reason = 'change') {
    if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return;
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send(`${CHANNEL_PREFIX}changed`, { reason });
      } catch (e) { /* 忽略 */ }
    }
  }

  /** 管理操作只允许设置窗口调用（防御性检查） */
  function isSettingsSender(event) {
    try {
      const sender = event && event.sender;
      const url = sender && typeof sender.getURL === 'function' ? sender.getURL() : '';
      return /\/renderer\/settings\/settings\.html(?:[?#].*)?$/.test(String(url));
    } catch (e) {
      return false;
    }
  }

  function requireSettings(event) {
    if (!isSettingsSender(event)) throw new Error('该操作只允许在设置窗口执行');
  }

  function registerRegistryIpc() {
    if (registryRegistered) return;
    registryRegistered = true;

    // 命名空间统一为 plugins:*，与插件自身的 plugin:<id>:* 区分，避免撞车
    ipcMain.handle(`${CHANNEL_PREFIX}list`, () => listPlugins());
    ipcMain.handle(`${CHANNEL_PREFIX}get-paths`, () => getPluginPaths());
    ipcMain.handle(`${CHANNEL_PREFIX}get-pet-menu`, () => collectMenu('petMenu'));
    ipcMain.handle(`${CHANNEL_PREFIX}get-tray-menu`, () => collectMenu('trayMenu'));
    ipcMain.handle(`${CHANNEL_PREFIX}get-settings-sections`, () => getSettingsSections());
    ipcMain.handle(`${CHANNEL_PREFIX}get-settings`, (event, pluginId) => getPluginSettings(pluginId));
    ipcMain.handle(`${CHANNEL_PREFIX}set-settings`, (event, pluginId, values) => setPluginSettings(pluginId, values));
    ipcMain.handle(`${CHANNEL_PREFIX}run-settings-action`, (event, pluginId, actionId, values) =>
      runSettingsAction(pluginId, actionId, values));
    ipcMain.handle(`${CHANNEL_PREFIX}run-command`, (event, pluginId, command, payload) =>
      runCommand(pluginId, command, payload));

    // 插件管理（仅设置窗口）
    ipcMain.handle(`${CHANNEL_PREFIX}pick-package`, (event) => {
      requireSettings(event);
      return pickPluginPackage();
    });
    ipcMain.handle(`${CHANNEL_PREFIX}inspect-package`, (event, filePath) => {
      requireSettings(event);
      return inspectForUi(filePath);
    });
    ipcMain.handle(`${CHANNEL_PREFIX}install-package`, (event, filePath, options) => {
      requireSettings(event);
      return installFromPackage(filePath, options);
    });
    ipcMain.handle(`${CHANNEL_PREFIX}uninstall`, (event, id, options) => {
      requireSettings(event);
      return uninstallPlugin(id, options);
    });
    ipcMain.handle(`${CHANNEL_PREFIX}set-enabled`, (event, id, enabled) => {
      requireSettings(event);
      return setPluginEnabled(id, enabled);
    });
    ipcMain.handle(`${CHANNEL_PREFIX}reload`, (event) => {
      requireSettings(event);
      return reloadAll()
        .then((result) => ({ success: true, reports: result.reports, scan: result.scan }))
        .catch((e) => errorResult(e));
    });
    ipcMain.handle(`${CHANNEL_PREFIX}open-dir`, (event) => {
      requireSettings(event);
      return openPluginsDir();
    });
    ipcMain.handle(`${CHANNEL_PREFIX}open-plugin-dir`, (event, id) => {
      requireSettings(event);
      return openPluginDir(id);
    });
  }

  return {
    builtinPluginsDir,
    userPluginsDir,
    pluginDataDir,
    pluginsDir: builtinPluginsDir,
    loadAll,
    deactivateAll,
    reloadAll,
    getReports: () => [...reports],
    listPlugins,
    getPluginPaths,
    getPetMenuItems: () => collectMenu('petMenu'),
    getTrayMenuItems: () => collectMenu('trayMenu'),
    getSettingsSections,
    getPluginSettings,
    setPluginSettings,
    runSettingsAction,
    runCommand,
    installFromPackage,
    uninstallPlugin,
    setPluginEnabled,
    inspectPackage: inspectForUi,
    pickPluginPackage,
    openPluginsDir,
    openPluginDir
  };
}

/**
 * 初始化全局插件宿主（幂等）
 * @param {{electron: Object, logger?: Object, builtinPluginsDir?: string, pluginsDir?: string,
 *   userPluginsDir?: string, dataDir?: string, storeFactory?: Function, hostServices?: Object,
 *   onPluginsChanged?: Function}} options
 */
function initPluginHost(options = {}) {
  if (!currentHost) currentHost = createPluginManager(options);
  return currentHost;
}

/** 获取当前插件宿主（未初始化时返回 null，调用方必须兜底） */
function getPluginHost() {
  return currentHost;
}

module.exports = {
  PLUGINS_DIR,
  PLUGIN_API_VERSION,
  CHANNEL_PREFIX,
  PLUGIN_CHANNEL_PREFIX,
  createPluginManager,
  initPluginHost,
  getPluginHost,
  // 导出纯函数便于自检
  sanitizeFields,
  sanitizeActions,
  sanitizeMenuItems
};
