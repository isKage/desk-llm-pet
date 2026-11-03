#!/usr/bin/env node
/**
 * 项目自检（不需要启动 Electron GUI）
 * ============================================================================
 *   1. 语法检查：对 src 下所有 .js 逐个执行 node --check
 *   2. 插件系统：用「假 Electron + 内存存储」跑一遍宿主的发现/校验/激活/卸载
 *   3. 扩展点：桌宠菜单、托盘菜单、设置面板、命令、设置动作是否都能拿到
 *   4. 独立性：本体核心文件不得引用任何具体插件
 *   5. 回归：已删除的「文件移入回收站」不应残留
 *
 * 用法：npm run check
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
  }
}

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listFiles(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

// ============================================================================
// 假 Electron / 内存存储（让宿主可以脱离 GUI 运行）
// ============================================================================

function createFakeElectron() {
  const windows = [];

  class FakeWebContents {
    constructor() {
      this.sent = [];
      this.destroyed = false;
      this.navigationsBlocked = [];
    }
    send(channel, payload) { this.sent.push({ channel, payload }); }
    isDestroyed() { return this.destroyed; }
    on(event, cb) { (this._events = this._events || {})[event] = cb; return this; }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  }

  class FakeBrowserWindow {
    constructor(options = {}) {
      this.options = options;
      this.webContents = new FakeWebContents();
      this.destroyed = false;
      this.visible = false;
      this.handlers = {};
      windows.push(this);
    }
    static fromWebContents(webContents) {
      return windows.find((win) => win.webContents === webContents) || null;
    }
    static getAllWindows() { return windows.slice(); }
    loadFile(file) { this.loadedFile = file; return Promise.resolve(); }
    on(event, cb) { (this.handlers[event] = this.handlers[event] || []).push(cb); return this; }
    once(event, cb) { return this.on(event, cb); }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    minimize() { this.minimized = true; }
    close() { this.destroy(); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.destroyed = true;
      (this.handlers.closed || []).forEach((cb) => cb());
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
  }

  const handlers = new Map();
  const listeners = new Map();

  const ipcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
    on(channel, fn) { listeners.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    removeAllListeners(channel) { listeners.delete(channel); },
    // 供自检使用
    _invoke: (channel, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`未注册的 invoke 通道: ${channel}`);
      const sender = {
        getURL: () => 'file:///self-check/src/renderer/settings/settings.html'
      };
      return fn({ sender }, ...args);
    },
    _invokeWithUrl: (channel, url, ...args) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`未注册的 invoke 通道: ${channel}`);
      return fn({ sender: { getURL: () => url } }, ...args);
    },
    _emit: (channel, event, ...args) => {
      const fn = listeners.get(channel);
      if (!fn) throw new Error(`未注册的 on 通道: ${channel}`);
      return fn(event, ...args);
    },
    _channels: () => [...handlers.keys()],
    _listenerChannels: () => [...listeners.keys()]
  };

  return {
    app: {
      getPath: () => path.join(ROOT, '.tmp-selfcheck'),
      getVersion: () => '0.0.0-self-check'
    },
    ipcMain,
    BrowserWindow: FakeBrowserWindow,
    shell: {
      openExternal() {},
      openPath: async () => ''
    },
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] })
    },
    _windows: windows
  };
}

function createMemoryStoreFactory() {
  const stores = new Map();
  return ({ name, cwd, defaults }) => {
    const key = `${cwd}::${name}`;
    if (!stores.has(key)) stores.set(key, JSON.parse(JSON.stringify(defaults || {})));
    const data = stores.get(key);
    return {
      get(key2) { return key2 === undefined ? data : data[key2]; },
      set(key2, value) { data[key2] = value; },
      has(key2) { return Object.prototype.hasOwnProperty.call(data, key2); }
    };
  };
}

async function main() {
// ============================================================================
// 1. 语法检查
// ============================================================================

console.log('\n[1/6] 语法检查 (node --check)');
const jsFiles = listFiles(SRC, (f) => f.endsWith('.js'));
check(`共 ${jsFiles.length} 个 JS 文件语法正确`, () => {
  const broken = [];
  for (const file of jsFiles) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (e) {
      broken.push(`${path.relative(ROOT, file)}: ${String(e.stderr || e.message).split('\n')[0]}`);
    }
  }
  assert(broken.length === 0, broken.join('; '));
});

// ============================================================================
// 2. 插件宿主
// ============================================================================

console.log('\n[2/6] 插件宿主');

const { createPluginManager, sanitizeFields, sanitizeMenuItems } = require('../src/plugins/plugin-manager');

const electron = createFakeElectron();
const CHECK_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskllmpet-self-check-'));
const CHECK_USER_PLUGINS = path.join(CHECK_TMP, 'plugins');
const CHECK_PLUGIN_DATA = path.join(CHECK_TMP, 'plugin-data');
const host = createPluginManager({
  electron,
  logger: { log() {}, warn() {} },
  storeFactory: createMemoryStoreFactory(),
  userPluginsDir: CHECK_USER_PLUGINS,
  dataDir: CHECK_PLUGIN_DATA,
  hostServices: {
    getSharedLLMConfig: () => null,
    openSettings: () => true
  }
});

check('sanitizeFields 过滤非法字段并补默认值', () => {
  const fields = sanitizeFields([
    { key: 'ok', type: 'number', default: 5, min: 0, max: 10 },
    { key: 'bad key!', type: 'text' },
    { key: 'stream', type: 'boolean' },
    { key: 'unknown', type: 'nope', default: 'x' },
    null
  ]);
  assertEqual(fields.length, 3, '字段数量');
  assertEqual(fields[0].type, 'number', 'number 类型保留');
  assertEqual(fields[0].default, 5, 'number 默认值');
  assertEqual(fields[2].type, 'text', '未知类型回退为 text');
  assertEqual(fields[1].default, false, 'boolean 默认值强制为布尔');
});

check('sanitizeMenuItems 过滤缺少 command 的项', () => {
  const items = sanitizeMenuItems([{ command: 'a', label: 'A' }, { label: '无命令' }, null]);
  assertEqual(items.length, 1, '菜单项数量');
  assertEqual(items[0].icon, '🧩', '默认图标');
});

let reports = [];
await checkAsync('loadAll 能加载本仓库全部插件', async () => {
  reports = await host.loadAll();
  const errors = reports.filter((r) => r.status === 'error');
  assert(errors.length === 0, `存在加载失败的插件: ${errors.map((e) => `${e.id}(${e.error})`).join(', ')}`);
  const active = reports.filter((r) => r.status === 'active');
  assert(active.length >= 1, '至少应加载 1 个插件');
});

await checkAsync('重复 loadAll 幂等', async () => {
  const again = await host.loadAll();
  assertEqual(again.length, reports.length, '报告数量');
});

check('llm-chat 贡献了桌宠菜单与托盘菜单', () => {
  const pet = host.getPetMenuItems();
  const tray = host.getTrayMenuItems();
  assert(pet.some((i) => i.pluginId === 'llm-chat' && i.command === 'open-chat'), '缺少桌宠菜单项');
  assert(tray.some((i) => i.pluginId === 'llm-chat' && i.command === 'open-chat'), '缺少托盘菜单项');
});

check('设置面板包含字段与动作', () => {
  const sections = host.getSettingsSections();
  const section = sections.find((s) => s.pluginId === 'llm-chat');
  assert(section, '缺少 llm-chat 设置面板');
  assert(section.fields.length >= 5, `字段过少: ${section.fields.length}`);
  assert(section.actions.some((a) => a.id === 'test'), '缺少测试连接动作');
});

check('插件 IPC 通道已命名空间化注册', () => {
  const channels = electron.ipcMain._channels();
  assert(channels.includes('plugin:llm-chat:get-config'), '缺少 plugin:llm-chat:get-config');
  assert(channels.includes('plugins:get-pet-menu'), '缺少宿主注册表通道 plugins:get-pet-menu');
  assert(channels.includes('plugins:run-command'), '缺少宿主注册表通道 plugins:run-command');
  // 不允许出现未命名空间化的裸通道
  const bare = channels.filter((c) => !c.startsWith('plugin:') && !c.startsWith('plugins:'));
  assertEqual(bare.length, 0, `存在未命名空间化的插件通道: ${bare.join(', ')}`);
});

check('插件设置可读写并按类型裁剪', () => {
  const saved = host.setPluginSettings('llm-chat', { temperature: 99, stream: false, model: 'deepseek-reasoner' });
  assert(saved.success, '保存失败');
  assertEqual(saved.values.temperature, 2, 'temperature 应被裁剪到上限 2');
  assertEqual(saved.values.stream, false, 'stream 应保存为 false');
  assertEqual(host.getPluginSettings('llm-chat').model, 'deepseek-reasoner', 'model 读取不一致');
  assertEqual(host.getPluginSettings('llm-chat').maxTokens, 2048, '未提供的字段应保留默认值');
});

await checkAsync('设置动作：未声明动作被拒绝，缺 Key 时给出明确提示', async () => {
  const unknown = await host.runSettingsAction('llm-chat', 'nope', {});
  assertEqual(unknown.success, false, '未声明动作应失败');

  const noKey = await host.runSettingsAction('llm-chat', 'test', { apiKey: '' });
  assertEqual(noKey.success, false, '缺少 API Key 时应失败');
  assert(/API Key/.test(noKey.error || ''), `错误文案不明确: ${noKey.error}`);
});

await checkAsync('命令 open-chat 创建插件窗口并注入 preload', async () => {
  const before = electron._windows.length;
  const result = await host.runCommand('llm-chat', 'open-chat', { source: 'self-check' });
  assert(result.success, `命令执行失败: ${result.error}`);
  assertEqual(electron._windows.length, before + 1, '窗口数量');
  const win = electron._windows[electron._windows.length - 1];
  assert(win.options.webPreferences.preload.endsWith('preload.js'), '未注入插件 preload');
  assertEqual(win.options.webPreferences.contextIsolation, true, 'contextIsolation 必须为 true');
  assertEqual(win.options.webPreferences.nodeIntegration, false, 'nodeIntegration 必须为 false');
  assert(win.loadedFile && win.loadedFile.endsWith('chat.html'), `窗口页面错误: ${win.loadedFile}`);
  // 再次触发应复用同一个窗口
  await host.runCommand('llm-chat', 'open-chat', {});
  assertEqual(electron._windows.length, before + 1, '重复打开不应创建新窗口');
});

await checkAsync('缺失 API Key 时发送消息走错误事件（不发起网络请求）', async () => {
  const win = electron._windows[electron._windows.length - 1];
  win.webContents.sent.length = 0;

  electron.ipcMain._emit('plugin:llm-chat:send-message', { sender: win.webContents }, {
    requestId: 'test-req',
    content: '你好',
    conversationId: ''
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const sent = win.webContents.sent.map((m) => m.channel);
  assert(sent.includes('plugin:llm-chat:conversation-updated'), `缺少会话更新事件: ${sent.join(',')}`);
  const errorEvent = win.webContents.sent.find((m) => m.channel === 'plugin:llm-chat:stream-error');
  assert(errorEvent, `缺少错误事件: ${sent.join(',')}`);
  assert(/API Key/.test(errorEvent.payload.error || ''), '错误文案未提示配置 API Key');
});

check('未注册命令返回失败而不是抛异常', async () => {
  const result = await host.runCommand('llm-chat', '不存在的命令', {});
  assertEqual(result.success, true, '未知命令应由插件自行忽略');
  const missing = await host.runCommand('not-exist', 'x', {});
  assertEqual(missing.success, false, '不存在的插件应返回失败');
});

check('会话列表已持久化到插件私有存储', () => {
  const list = electron.ipcMain._invoke('plugin:llm-chat:list-conversations');
  assert(Array.isArray(list), '会话列表不是数组');
  assert(list.length >= 1, '上一步发送消息应创建一个会话');
  assert(list[0].messageCount >= 1, '会话中应包含用户消息');
});

await checkAsync('deactivateAll 注销通道并关闭插件窗口', async () => {
  await host.deactivateAll();
  const channels = electron.ipcMain._channels();
  const leftover = channels.filter((c) => c.startsWith('plugin:llm-chat:'));
  assertEqual(leftover.length, 0, `仍有残留通道: ${leftover.join(', ')}`);
  assert(electron._windows.every((w) => w.isDestroyed()), '插件窗口未关闭');
  // 注册表通道属于宿主，应当保留
  assert(channels.includes('plugins:get-pet-menu'), '宿主注册表通道被误删');
});

// ============================================================================
// 2b. 插件管理（目录 / 安装 / 卸载 / 重载 / 安全）
// ============================================================================

const AdmZip = require('adm-zip');

function writeSelfCheckPackage(name, manifest, mainSource) {
  const packagePath = path.join(CHECK_TMP, `${name}.dlmpet`);
  const zip = new AdmZip();
  zip.addFile('plugin.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('main.js', Buffer.from(mainSource));
  zip.writeZip(packagePath);
  return packagePath;
}

await checkAsync('插件目录包含内置插件与来源信息', async () => {
  await host.reloadAll();
  const list = host.listPlugins();
  const chat = list.find((item) => item.id === 'llm-chat');
  assert(chat, '列表里缺少内置插件 llm-chat');
  assertEqual(chat.origin, 'builtin', '内置插件来源');
  assertEqual(chat.status, 'active', '内置插件状态');
  assert(chat.hasSettings === true, '内置插件应有设置面板');
});

await checkAsync('旧版插件数据会迁移到 plugin-data', async () => {
  const legacyDir = path.join(CHECK_USER_PLUGINS, 'legacy-demo');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'settings.json'), '{"settings":{"x":1}}');
  await host.reloadAll();
  assert(!fs.existsSync(legacyDir), '旧数据目录应被移走');
  const moved = path.join(CHECK_PLUGIN_DATA, 'legacy-demo', 'settings.json');
  assert(fs.existsSync(moved), '旧数据未迁移到 plugin-data');
});

await checkAsync('安装插件包 → 加载 → 卸载 → 注销 IPC', async () => {
  const fixturePath = writeSelfCheckPackage(
    'self-check-fixture-1.0.0',
    {
      id: 'self-check-fixture',
      name: '自检夹具',
      version: '1.0.0',
      description: 'self-check fixture',
      author: 'self-check',
      apiVersion: 1,
      main: 'main.js'
    },
    "module.exports = { activate(ctx) { ctx.ipc.handle('ping', () => ({ ok: true })); } };"
  );

  const inspected = host.inspectPackage(fixturePath);
  assert(inspected.ok === true, `预览失败: ${inspected.error}`);

  const result = await host.installFromPackage(fixturePath);
  assert(result.success === true, `安装失败: ${result.error}`);

  const installed = host.listPlugins().find((item) => item.id === 'self-check-fixture');
  assert(installed, '安装后列表里没有插件');
  assertEqual(installed.origin, 'package', '安装来源');
  assertEqual(installed.status, 'active', '安装后状态');
  assert(electron.ipcMain._channels().includes('plugin:self-check-fixture:ping'), '插件 IPC 未注册');
  assertEqual(electron.ipcMain._invoke('plugin:self-check-fixture:ping').ok, true, '插件 IPC 调用失败');

  const uninstalled = await host.uninstallPlugin('self-check-fixture');
  assert(uninstalled.success === true, `卸载失败: ${uninstalled.error}`);
  assert(!host.listPlugins().some((item) => item.id === 'self-check-fixture'), '卸载后列表仍有插件');
  assert(!electron.ipcMain._channels().includes('plugin:self-check-fixture:ping'), '卸载后插件 IPC 未注销');
});

await checkAsync('放入插件目录的 .dlmpet 会在重载时自动安装', async () => {
  const packagePath = writeSelfCheckPackage(
    'auto-scan-1.0.0',
    {
      id: 'auto-scan-check',
      name: '自动扫描夹具',
      version: '1.0.0',
      description: 'auto scan fixture',
      author: 'self-check',
      apiVersion: 1,
      main: 'main.js'
    },
    'module.exports = { activate() {} };'
  );
  const dropped = path.join(CHECK_USER_PLUGINS, 'auto-scan-check.dlmpet');
  fs.copyFileSync(packagePath, dropped);

  await host.reloadAll();
  const entry = host.listPlugins().find((item) => item.id === 'auto-scan-check');
  assert(entry, '放入插件目录的包没有被自动安装');
  assertEqual(entry.status, 'active', '自动安装后状态');
  assert(!fs.existsSync(dropped), '自动安装后包应移入 .packages/.failed');

  const removed = await host.uninstallPlugin('auto-scan-check');
  assert(removed.success === true, `清理自动安装夹具失败: ${removed.error}`);
});

await checkAsync('启用 / 禁用插件会重载菜单与状态', async () => {
  const disabled = await host.setPluginEnabled('llm-chat', false);
  assert(disabled.success === true, `禁用失败: ${disabled.error}`);
  assertEqual(host.listPlugins().find((item) => item.id === 'llm-chat').status, 'disabled', '禁用状态');
  assert(!host.getPetMenuItems().some((item) => item.pluginId === 'llm-chat'), '禁用后菜单应移除');

  const enabled = await host.setPluginEnabled('llm-chat', true);
  assert(enabled.success === true, `启用失败: ${enabled.error}`);
  assertEqual(host.listPlugins().find((item) => item.id === 'llm-chat').status, 'active', '启用状态');
  assert(host.getPetMenuItems().some((item) => item.pluginId === 'llm-chat'), '启用后菜单应恢复');
});

await check('插件管理 IPC 只允许设置窗口调用', () => {
  const denied = { message: '' };
  try {
    electron.ipcMain._invokeWithUrl('plugins:inspect-package', 'file:///tmp/evil.html', '/tmp/x.dlmpet');
  } catch (e) {
    denied.message = e.message;
  }
  assert(/设置窗口/.test(denied.message), `非设置窗口未被拒绝: ${denied.message}`);

  const list = electron.ipcMain._invokeWithUrl(
    'plugins:list',
    'file:///self-check/src/renderer/settings/settings.html'
  );
  assert(Array.isArray(list) && list.some((item) => item.id === 'llm-chat'), '设置窗口读取列表失败');
});

// ============================================================================
// 3. 插件内部纯逻辑（对话客户端 / 会话仓库）
// ============================================================================

console.log('\n[3/6] 插件内部逻辑');

const { resolveChatEndpoint, parseSseLine, createSseParser, requestChat } = require('../src/plugins/llm-chat/chat-client');
const { createConversationStore } = require('../src/plugins/llm-chat/conversations');

check('resolveChatEndpoint 规范化各种写法', () => {
  assertEqual(resolveChatEndpoint(''), 'https://api.deepseek.com/v1/chat/completions', '空地址');
  assertEqual(resolveChatEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions', 'base 地址');
  assertEqual(resolveChatEndpoint('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions', '带 /v1');
  assertEqual(resolveChatEndpoint('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions', '完整端点');
  assertEqual(resolveChatEndpoint('localhost:11434/v1'), 'https://localhost:11434/v1/chat/completions', '自动补协议');
});

await checkAsync('对话请求会带 User-Agent（避免 API 边缘节点 ECONNRESET）', async () => {
  const http = require('http');
  let userAgent = '';
  const server = http.createServer((req, res) => {
    userAgent = req.headers['user-agent'] || '';
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const result = await requestChat(
      { apiKey: 'test-key', apiEndpoint: `http://127.0.0.1:${server.address().port}` },
      [{ role: 'user', content: '你好' }],
      { stream: false }
    ).promise;
    assertEqual(result, 'ok', '本地对话响应解析');
    assert(/DeskLLMPet/.test(userAgent), `请求缺少 User-Agent（${userAgent || '空'}）`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

check('SSE 解析：跨 chunk 拼接 + 忽略噪声行', () => {
  const chunks = [];
  const parser = createSseParser((t) => chunks.push(t));
  parser.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"cont');
  parser.push('ent":"好"}}]}\n');
  parser.push('data: [DONE]\n');
  parser.flush();
  assertEqual(chunks.join(''), '你好', '增量内容拼接错误');
  assertEqual(parseSseLine('data: [DONE]').done, true, '[DONE] 未识别');
  assertEqual(parseSseLine(': keep-alive'), null, '注释行应被忽略');
  assertEqual(parseSseLine('event: ping'), null, '非 data 行应被忽略');
});

check('会话仓库：创建 / 追加 / 自动标题 / 删除', () => {
  const store = createMemoryStoreFactory()({ name: 'data', cwd: '/tmp/x', defaults: { conversations: [], activeConversationId: null } });
  const repo = createConversationStore(store);

  const created = repo.create('新对话');
  assert(created && created.id, '创建会话失败');
  assertEqual(repo.getActiveId(), created.id, '活跃会话未切换');

  const first = repo.addMessage(created.id, { role: 'user', content: '帮我写一个冒泡排序，要带注释的' });
  assert(/冒泡排序/.test(first.conversation.title), `标题未自动生成: ${first.conversation.title}`);
  assert(first.conversation.title.length <= 25, '标题过长未截断');

  repo.addMessage(created.id, { role: 'assistant', content: '好的' });
  assertEqual(repo.get(created.id).messages.length, 2, '消息数量');

  const renamed = repo.rename(created.id, '排序算法');
  assertEqual(renamed.title, '排序算法', '重命名失败');

  const second = repo.create('第二个会话');
  assertEqual(repo.list().length, 2, '会话列表数量');
  assertEqual(repo.list()[0].id, second.id, '最近更新的会话应排在最前');

  repo.remove(created.id);
  assertEqual(repo.list().length, 1, '删除后数量');
  assertEqual(repo.getActiveId(), second.id, '删除活跃会话后应切到剩余会话');
});

// ============================================================================
// 4. 右键菜单 & 双击气泡
// ============================================================================

console.log('\n[4/6] 右键菜单与双击气泡');

const { computeMenuBounds, MAX_WIDTH } = require('../src/main/menu-window');
const { normalizeCustomPhrases, MAX_PHRASE_LENGTH, MAX_PHRASE_COUNT } = require('../src/shared/store');

check('自定义语句写盘前会被清洗（去空行 / 折叠换行 / 去重 / 限长限量）', () => {
  assertEqual(normalizeCustomPhrases(null).length, 0, '非数组应回退为空');
  assertEqual(normalizeCustomPhrases('你好').length, 0, '非数组字符串应被忽略');
  assertEqual(normalizeCustomPhrases([' 你好 ', '', '   ', '你好', 42, 'a\nb']).join('|'), '你好|a b', '清洗结果不一致');
  assertEqual(normalizeCustomPhrases(['x'.repeat(500)])[0].length, MAX_PHRASE_LENGTH, '超长语句未截断');
  const many = Array.from({ length: MAX_PHRASE_COUNT + 20 }, (_, i) => `第 ${i} 句`);
  assertEqual(normalizeCustomPhrases(many).length, MAX_PHRASE_COUNT, '条数未限制');
});

check('右键菜单：贴着鼠标展开，且任何情况下都完整落在屏幕内', () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  const size = { width: 200, height: 260 };

  const normal = computeMenuBounds({ anchor: { x: 300, y: 200 }, size, workArea });
  assertEqual(`${normal.x},${normal.y},${normal.width},${normal.height}`, '302,202,200,260', '常规展开位置不对');

  // 屏幕右下角：翻到鼠标左上侧，仍然完整可见
  const corner = computeMenuBounds({ anchor: { x: 1436, y: 896 }, size, workArea });
  assert(corner.x >= workArea.x && corner.x + corner.width <= workArea.width, `横向越界: ${JSON.stringify(corner)}`);
  assert(corner.y >= workArea.y && corner.y + corner.height <= workArea.height, `纵向越界: ${JSON.stringify(corner)}`);

  // 插件菜单项特别多：高度收敛在屏幕内（菜单内部滚动），不会被裁掉
  const manyItems = computeMenuBounds({ anchor: { x: 100, y: 100 }, size: { width: 200, height: 5000 }, workArea });
  assert(manyItems.height <= workArea.height - 8, `高度未收敛: ${manyItems.height}`);
  assert(manyItems.y + manyItems.height <= workArea.height, `纵向越界: ${JSON.stringify(manyItems)}`);

  // 超长插件名：宽度有上限（菜单内用省略号）
  const wide = computeMenuBounds({ anchor: { x: 100, y: 100 }, size: { width: 3000, height: 120 }, workArea });
  assert(wide.width <= MAX_WIDTH, `宽度未收敛: ${wide.width}`);

  // 任务栏在顶部（可用区域 y 不为 0）时同样不能越界
  const shifted = { x: 0, y: 40, width: 1440, height: 860 };
  const onShifted = computeMenuBounds({ anchor: { x: 1000, y: 880 }, size, workArea: shifted });
  assert(onShifted.y + onShifted.height <= shifted.y + shifted.height, `越界: ${JSON.stringify(onShifted)}`);
});

check('右键菜单：主进程与渲染进程的通道已经连线', () => {
  const petPreload = readFile('src/preload/pet-preload.js');
  const menuPreload = readFile('src/preload/menu-preload.js');
  const menuMain = readFile('src/main/menu-window.js');
  const ipc = readFile('src/main/ipc-handlers.js');

  assert(/ipcRenderer\.invoke\('open-pet-menu'/.test(petPreload), 'pet-preload 未暴露 openPetMenu');
  assert(/ipcRenderer\.on\('pet-menu-action'/.test(petPreload), 'pet-preload 未监听 pet-menu-action');
  assert(/ipcMain\.handle\('open-pet-menu'/.test(ipc), '未注册 open-pet-menu');
  assert(/webContents\.send\('pet-menu-action'/.test(menuMain), 'menu-window 未发送 pet-menu-action');

  assert(/ipcRenderer\.on\('menu-show'/.test(menuPreload), 'menu-preload 未监听 menu-show');
  assert(/webContents\.send\('menu-show'\)/.test(menuMain), 'menu-window 未发送 menu-show');
  assert(/ipcRenderer\.send\('menu-size'/.test(menuPreload), 'menu-preload 未上报 menu-size');
  assert(/ipcMain\.on\('menu-size'/.test(ipc), '未注册 menu-size');
  assert(/ipcMain\.on\('menu-select'/.test(ipc), '未注册 menu-select');
  assert(/ipcMain\.on\('menu-close'/.test(ipc), '未注册 menu-close');
  assert(/'renderer',\s*'menu',\s*'menu\.html'/.test(menuMain), '菜单窗口未加载 menu.html');
});

check('桌宠页面不再自带会被窗口裁掉的右键菜单', () => {
  assert(!/context-menu/.test(readFile('src/renderer/pet/pet.html')), 'pet.html 仍在页面内渲染菜单');
  assert(!/context-menu/.test(readFile('src/renderer/pet/pet.css')), 'pet.css 仍残留页面内菜单样式');
  assert(!/context-menu/.test(readFile('src/renderer/pet/pet.js')), 'pet.js 仍残留页面内菜单逻辑');
  assert(/openPetMenu/.test(readFile('src/renderer/pet/pet.js')), 'pet.js 未改为请求独立菜单窗口');
});

check('桌宠：单击只播动画，双击才弹气泡（余额或自定义语句）', () => {
  const pet = readFile('src/renderer/pet/pet.js');
  assert(/const DOUBLE_CLICK_MS\s*=\s*\d+/.test(pet), '缺少双击判定阈值');
  assert(/function handlePetClick\(/.test(pet), '缺少单击 / 双击分发入口');
  assert(/\} else \{\s*playClickReaction\(\);\s*\}/.test(pet), '单击分支应当只播放点击反应动画');
  assert(/if \(isDoubleClick\) \{\s*triggerBubble\(\);/.test(pet), '双击分支未触发气泡');
  const randomBubble = pet.slice(pet.indexOf('function showRandomBubble()'));
  assert(/customPhrases/.test(randomBubble.slice(0, 400)), '随机气泡未接入自定义语句');

  const settingsHtml = readFile('src/renderer/settings/settings.html');
  assert(/id="balance-phrases"/.test(settingsHtml), '设置页缺少自定义语句输入框');
  assert(/id="btn-preview-phrase"/.test(settingsHtml), '设置页缺少自定义语句预览按钮');
  assert(/previewPhrase/.test(readFile('src/preload/settings-preload.js')), 'settings-preload 未暴露 previewPhrase');
});

check('设置页包含插件管理入口与静态元素', () => {
  const html = readFile('src/renderer/settings/settings.html');
  for (const id of [
    'tab-plugins', 'plugin-dropzone', 'plugin-user-dir',
    'btn-install-plugin', 'btn-open-plugin-dir', 'btn-reload-plugins',
    'plugin-install-progress', 'plugin-list', 'plugin-count',
    'plugin-modal', 'plugin-modal-title', 'plugin-modal-body',
    'plugin-trust-row', 'plugin-trust-check', 'plugin-modal-cancel', 'plugin-modal-confirm'
  ]) {
    assert(html.includes(`id="${id}"`), `设置页缺少 #${id}`);
  }
  assert(/data-tab="plugins"/.test(html), '设置页缺少插件标签');
  const preload = readFile('src/preload/settings-preload.js');
  for (const name of [
    'getPlugins', 'getPluginPaths', 'pickPluginPackage', 'inspectPluginPackage',
    'installPluginPackage', 'uninstallPlugin', 'setPluginEnabled', 'reloadPlugins',
    'openPluginsDir', 'openPluginDir', 'onPluginsChanged'
  ]) {
    assert(preload.includes(`${name}:`), `settings-preload 缺少 ${name}`);
  }
});

check('版本信息单一来源：package.json / package-lock / CHANGELOG', () => {
  const pkg = JSON.parse(readFile('package.json'));
  assert(/^\d+\.\d+\.\d+$/.test(pkg.version), `package.json 版本号格式异常: ${pkg.version}`);

  const lock = JSON.parse(readFile('package-lock.json'));
  assertEqual(lock.version, pkg.version, 'package-lock.json 根版本号');
  assertEqual(lock.packages && lock.packages[''] && lock.packages[''].version, pkg.version,
    'package-lock.json packages[""] 版本号');

  const changelog = readFile('CHANGELOG.md');
  const { extractSection } = require('./release-notes');
  const section = extractSection(changelog, pkg.version);
  assert(section && section.includes(pkg.version), `CHANGELOG.md 缺少当前版本 ${pkg.version} 的段落`);

  // README / 设置页不再写死当前版本号
  const readme = readFile('README.md');
  assert(!readme.includes(`v${pkg.version}`), `README.md 不应写死当前版本 v${pkg.version}`);
  const about = readFile('src/renderer/settings/settings.html');
  assert(!about.includes(`v${pkg.version}`), `设置页不应写死当前版本 v${pkg.version}`);
  assert(/getAppPath/.test(readFile('src/renderer/settings/settings.js')), '设置页版本号应动态注入');

  // GitHub Release 正文由 CHANGELOG 提取，不能再依赖逐版本 RELEASE 文件
  const workflow = readFile('.github/workflows/release.yml');
  assert(/release-notes\.js/.test(workflow), 'release workflow 未使用 scripts/release-notes.js');
  assert(!/RELEASE_v/.test(workflow), 'release workflow 仍引用旧 RELEASE_v*.md');
  const legacy = fs.readdirSync(ROOT).filter((name) => /^RELEASE_v.*\.md$/.test(name));
  assertEqual(legacy.length, 0, `仍存在旧发布说明文件: ${legacy.join(', ')}`);
});

// ============================================================================
// 5. 独立性 & 回归
// ============================================================================

console.log('\n[5/6] 独立性与回归');

check('本体核心文件不引用任何具体插件（插件化隔离）', () => {
  const coreFiles = [
    'src/main/main.js',
    'src/main/tray.js',
    'src/main/ipc-handlers.js',
    'src/main/pet-window.js',
    'src/main/settings-window.js',
    'src/preload/pet-preload.js',
    'src/preload/settings-preload.js',
    'src/renderer/pet/pet.js',
    'src/renderer/settings/settings.js'
  ];
  const offenders = [];
  for (const file of coreFiles) {
    const content = readFile(file);
    if (/llm-chat|src\/plugins\/(?!plugin-manager)/.test(content)) offenders.push(file);
  }
  assertEqual(offenders.length, 0, `以下文件引用了具体插件: ${offenders.join(', ')}`);
});

check('本体只通过 plugin-manager 访问插件系统', () => {
  const files = [
    'src/main/main.js',
    'src/main/tray.js',
    'src/preload/pet-preload.js',
    'src/preload/settings-preload.js',
    'src/renderer/pet/pet.js',
    'src/renderer/settings/settings.js'
  ];
  const offenders = files.filter((file) => !/plugin/i.test(readFile(file)));
  assertEqual(offenders.length, 0, `以下文件未接入插件扩展点: ${offenders.join(', ')}`);
});

check('「文件移入回收站」功能已彻底移除', () => {
  const offenders = [];
  const patterns = [/trash-items/, /trashItem/, /trashItems/, /confirmTrash/, /文件拖拽/, /移到回收站/, /\[DnD\]/];
  for (const file of listFiles(SRC, (f) => /\.(js|html|css)$/.test(f))) {
    const content = fs.readFileSync(file, 'utf8');
    if (patterns.some((re) => re.test(content))) offenders.push(path.relative(ROOT, file));
  }
  assertEqual(offenders.length, 0, `仍残留回收站相关代码: ${offenders.join(', ')}`);
});

check('LLM 对话能力已迁入插件目录', () => {
  const required = [
    'src/plugins/llm-chat/plugin.json',
    'src/plugins/llm-chat/main.js',
    'src/plugins/llm-chat/preload.js',
    'src/plugins/llm-chat/chat-client.js',
    'src/plugins/llm-chat/conversations.js',
    'src/plugins/llm-chat/chat-window.js',
    'src/plugins/llm-chat/renderer/chat.html',
    'src/plugins/llm-chat/renderer/chat.js',
    'src/plugins/llm-chat/renderer/chat.css'
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  assertEqual(missing.length, 0, `缺少文件: ${missing.join(', ')}`);
  // 旧的 chat 目录不应复活
  assert(!fs.existsSync(path.join(SRC, 'renderer', 'chat')), '旧的 src/renderer/chat 不应存在');
  assert(!fs.existsSync(path.join(SRC, 'shared', 'llm-client.js')), '旧的 src/shared/llm-client.js 不应存在');
});

check('IPC 处理器与预加载脚本暴露的通道一一对应', () => {
  // 本体通道由 ipc-handlers.js 注册；插件注册表通道由 plugin-manager.js 注册
  const declared = new Set();
  for (const file of ['src/main/ipc-handlers.js', 'src/plugins/plugin-manager.js']) {
    for (const m of readFile(file).matchAll(/ipcMain\.(?:handle|on)\(\s*(?:`([^`]+)`|'([^']+)')/g)) {
      if (m[1]) {
        // 形如 `${CHANNEL_PREFIX}list` 的模板通道，还原成 plugins:list
        declared.add(m[1].replace('${CHANNEL_PREFIX}', 'plugins:').replace('${PLUGIN_CHANNEL_PREFIX}', 'plugin:'));
      } else {
        declared.add(m[2]);
      }
    }
  }
  const preloads = ['src/preload/pet-preload.js', 'src/preload/settings-preload.js', 'src/preload/menu-preload.js'];
  const used = new Set();
  for (const file of preloads) {
    for (const m of readFile(file).matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)) used.add(m[1]);
  }
  const missing = [...used].filter((channel) => !declared.has(channel));
  assertEqual(missing.length, 0, `预加载脚本调用了未注册的通道: ${missing.join(', ')}`);
});

// ============================================================================
// 6. 结构一致性
// ============================================================================

console.log('\n[6/6] 结构一致性');

check('插件清单与宿主校验规则一致', () => {
  for (const dir of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name !== 'plugins') continue;
    const pluginsRoot = path.join(SRC, 'plugins');
    for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const manifestPath = path.join(pluginsRoot, entry.name, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assertEqual(manifest.id, entry.name, `${entry.name}/plugin.json 的 id 建议与目录名一致`);
      for (const key of ['name', 'version', 'description']) {
        assert(manifest[key], `${entry.name}/plugin.json 缺少 ${key}`);
      }
    }
  }
});

check('渲染进程页面的资源引用存在', () => {
  const pages = listFiles(SRC, (f) => f.endsWith('.html'));
  const problems = [];
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
      const target = path.join(path.dirname(page), m[1]);
      if (!fs.existsSync(target)) problems.push(`${path.relative(ROOT, page)} -> ${m[1]}`);
    }
  }
  assertEqual(problems.length, 0, `引用缺失: ${problems.join(', ')}`);
});

check('渲染进程 getElementById 的 id 都真实存在', () => {
  // JS 与页面一一对应；动态创建的节点（canvas / 流式气泡）单独放行
  const DYNAMIC_IDS = new Set(['placeholder-canvas', 'streaming-message']);
  const pairs = [
    ['src/renderer/pet/pet.js', 'src/renderer/pet/pet.html'],
    ['src/renderer/menu/menu.js', 'src/renderer/menu/menu.html'],
    ['src/renderer/settings/settings.js', 'src/renderer/settings/settings.html'],
    ['src/renderer/bubble/bubble.js', 'src/renderer/bubble/bubble.html'],
    ['src/plugins/llm-chat/renderer/chat.js', 'src/plugins/llm-chat/renderer/chat.html']
  ];
  const problems = [];
  for (const [jsRel, htmlRel] of pairs) {
    const js = readFile(jsRel);
    const html = readFile(htmlRel);
    const ids = new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
    for (const id of ids) {
      if (DYNAMIC_IDS.has(id)) continue;
      if (html.includes(`id="${id}"`)) continue;
      if (new RegExp(`\\.id\\s*=\\s*['"]${id}['"]`).test(js)) continue;
      problems.push(`${jsRel} -> #${id}`);
    }
  }
  assertEqual(problems.length, 0, `引用了不存在的元素: ${problems.join(', ')}`);
});

check('插件声明的设置项与插件代码使用的一致', () => {
  const manifest = JSON.parse(readFile('src/plugins/llm-chat/plugin.json'));
  const declared = new Set(manifest.contributes.settings.fields.map((f) => f.key));
  const code = readFile('src/plugins/llm-chat/main.js');
  const used = new Set([...code.matchAll(/merged\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));

  const missing = [...used].filter((key) => !declared.has(key));
  assertEqual(missing.length, 0, `代码使用但未声明的设置项: ${missing.join(', ')}`);
  const unused = [...declared].filter((key) => !used.has(key));
  assertEqual(unused.length, 0, `已声明但代码未使用的设置项: ${unused.join(', ')}`);
});

check('用户可见文案中不出现「回收站」', () => {
  const files = [
    ...listFiles(SRC, (f) => /\.(js|html|json)$/.test(f)),
    path.join(ROOT, 'package.json')
  ];
  const offenders = files.filter((file) => fs.readFileSync(file, 'utf8').includes('回收站'));
  assertEqual(offenders.length, 0, `仍有文案提到回收站: ${offenders.map((f) => path.relative(ROOT, f)).join(', ')}`);
});

try {
  fs.rmSync(CHECK_TMP, { recursive: true, force: true });
} catch (e) { /* 临时目录清理失败不影响结果 */ }

}

// ============================================================================
// 结果
// ============================================================================

main().then(() => {
console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ 自检通过：${passed} 项全部通过`);
  process.exit(0);
} else {
  console.log(`❌ 自检失败：${passed} 项通过，${failures.length} 项失败`);
  for (const f of failures) console.log(`   - ${f.name}: ${f.error}`);
  process.exit(1);
}
});
