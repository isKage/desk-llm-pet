#!/usr/bin/env node
/**
 * 渲染进程冒烟测试（真实 Electron，不带界面）
 * ============================================================================
 * 用真实的 preload / IPC / 插件宿主把四个页面各加载一次，确认：
 *   1. 桌宠页面：右键改为请求独立菜单窗口（页面内不再有会被裁掉的菜单），
 *      双击判定与自定义语句状态都已就绪
 *   2. 右键菜单页面：本体菜单项 + 插件菜单项都渲染，并按内容回报自适应尺寸
 *   3. 设置页面能动态渲染插件设置面板，插件管理页可安装/卸载 .dlmpet
 *   4. AI 对话插件窗口能打开，preload 桥可用，且「未配置 API Key」能在
 *      「渲染进程 → 主进程 → 渲染进程」整条链路上正确回报
 *   5. 插件安装后热重载、设置面板出现；卸载后列表与面板同步移除
 *   6. 全程没有渲染进程报错（console.error / preload 异常 / 加载失败）
 *
 * 用法：npm run check:renderer
 * 若所在环境的 Chromium 沙箱不可用，可追加 --no-sandbox
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');

// 把 userData 放到工作区内，避免污染真实配置；每次运行前清空，保证结果可复现
const SMOKE_USER_DATA = path.join(__dirname, '..', '.smoke-userdata');
fs.rmSync(SMOKE_USER_DATA, { recursive: true, force: true });
app.setPath('userData', SMOKE_USER_DATA);

const ROOT = path.join(__dirname, '..');
const results = [];

/** 生成一个最小夹具插件包（无窗口、无 IPC，仅用于安装/卸载链路测试） */
function createSmokePluginPackage() {
  const fixturesDir = path.join(SMOKE_USER_DATA, 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });
  const packagePath = path.join(fixturesDir, 'smoke-fixture-1.0.0.dlmpet');
  const zip = new AdmZip();
  zip.addFile('plugin.json', Buffer.from(JSON.stringify({
    id: 'smoke-fixture',
    name: '冒烟夹具插件',
    version: '1.0.0',
    description: '仅用于冒烟测试',
    author: 'smoke',
    apiVersion: 1,
    main: 'main.js',
    contributes: {
      settings: {
        title: '冒烟夹具',
        icon: '🧪',
        fields: [{ key: 'value', label: '值', type: 'text', default: 'x' }]
      }
    }
  })));
  zip.addFile('main.js', Buffer.from('module.exports = { activate() {} };'));
  zip.writeZip(packagePath);
  return packagePath;
}

function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `\n     ${detail}` : ''}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 收集页面错误（console.error / preload 异常 / 加载失败） */
function watchPage(win, label) {
  const errors = [];
  win.webContents.on('console-message', (event, level, message) => {
    if (Number(level) >= 3) errors.push(`${label} console.error: ${message}`);
  });
  win.webContents.on('preload-error', (event, preloadPath, error) => {
    errors.push(`${label} preload 异常 (${path.basename(preloadPath)}): ${error.message}`);
  });
  win.webContents.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
    if (isMainFrame) errors.push(`${label} 加载失败 ${code} ${desc}: ${url}`);
  });
  win.webContents.on('render-process-gone', (event, details) => {
    errors.push(`${label} 渲染进程退出: ${details.reason}`);
  });
  return errors;
}

/**
 * 等待页面加载完成
 * 用轮询而不是事件：插件窗口是在命令里同步开始加载的，
 * 事件可能在监听器挂上之前就已经触发过
 */
async function waitUntilLoaded(win, label, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (win.isDestroyed()) throw new Error(`${label} 窗口已关闭`);
    if (!win.webContents.isLoading() && win.webContents.getURL()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} 加载超时`);
}

function createPage(htmlRel, preloadRel, label) {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, preloadRel),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const errors = watchPage(win, label);
  return { win, errors, load: () => win.loadFile(path.join(ROOT, htmlRel)) };
}

async function main() {
  const { registerIpcHandlers } = require('../src/main/ipc-handlers');
  const { createPluginManager } = require('../src/plugins/plugin-manager');

  registerIpcHandlers();

  const host = createPluginManager({
    electron: { app, ipcMain, BrowserWindow, shell, dialog },
    logger: console,
    userPluginsDir: path.join(SMOKE_USER_DATA, 'plugins'),
    dataDir: path.join(SMOKE_USER_DATA, 'plugin-data'),
    hostServices: {
      getSharedLLMConfig: () => null,   // 保证「未配置」分支可复现
      openSettings: () => true
    }
  });
  const reports = await host.loadAll();
  record('插件加载', reports.every((r) => r.status !== 'error'),
    reports.map((r) => `${r.id}:${r.status}`).join(', '));

  const allErrors = [];

  // ---------- 1. 桌宠页面 ----------
  const pet = createPage('src/renderer/pet/pet.html', 'src/preload/pet-preload.js', '桌宠');
  await pet.load();
  await new Promise((r) => setTimeout(r, 800));   // 等 init() 完成

  const petPage = await pet.win.webContents.executeJavaScript(
    `({
       openPetMenu: typeof window.petAPI.openPetMenu,
       onMenuAction: typeof window.petAPI.onMenuAction,
       inlineMenu: !!document.getElementById('context-menu') || !!document.getElementById('plugin-menu-items'),
       doubleClickReady: !!(window.petState && typeof window.petState.lastClickAt === 'number'),
       phrasesReady: !!(window.petState && Array.isArray(window.petState.balance.customPhrases))
     })`
  ).catch((e) => ({ error: e.message }));

  record('桌宠页面：右键菜单改由独立窗口负责（页面内不再有会被裁掉的菜单）',
    petPage.openPetMenu === 'function' && petPage.onMenuAction === 'function' &&
    petPage.inlineMenu === false && petPage.doubleClickReady === true && petPage.phrasesReady === true,
    JSON.stringify(petPage));

  // 桌宠窗口不存在（或已隐藏）时，右键请求必须安全失败而不是抛异常
  const petMenuOffline = await pet.win.webContents.executeJavaScript(
    `window.petAPI.openPetMenu({ x: 5, y: 5 })`
  ).catch((e) => ({ error: e.message }));
  record('桌宠页面：没有桌宠窗口时右键请求安全失败',
    petMenuOffline && petMenuOffline.success === false,
    JSON.stringify(petMenuOffline));

  // ---------- 2. 右键菜单页面 ----------
  const menu = createPage('src/renderer/menu/menu.html', 'src/preload/menu-preload.js', '菜单');
  let reportedMenuSize = null;
  ipcMain.on('menu-size', (event, size) => { reportedMenuSize = size; });
  await menu.load();
  await new Promise((r) => setTimeout(r, 300));

  // 模拟主进程展开菜单（真实路径：open-pet-menu → menu-show）
  menu.win.webContents.send('menu-show');
  for (let i = 0; i < 30 && !reportedMenuSize; i += 1) await new Promise((r) => setTimeout(r, 100));

  const menuDom = await menu.win.webContents.executeJavaScript(
    `({
       labels: [...document.querySelectorAll('#menu .menu-item .menu-label')].map((el) => el.textContent.trim()),
       items: document.querySelectorAll('#menu .menu-item').length,
       separators: document.querySelectorAll('#menu .menu-separator').length
     })`
  ).catch((e) => ({ error: e.message }));

  record('右键菜单页面：本体项 + 插件项都渲染，并按内容回报自适应尺寸',
    menuDom.items === 5 && menuDom.labels.includes('AI 对话') && menuDom.labels.includes('退出') &&
    reportedMenuSize && reportedMenuSize.width > 60 && reportedMenuSize.height > 100,
    `items=${menuDom.items} size=${JSON.stringify(reportedMenuSize)} labels=${JSON.stringify(menuDom.labels)}`);

  // ---------- 3. 设置页面 ----------
  const settings = createPage('src/renderer/settings/settings.html', 'src/preload/settings-preload.js', '设置');
  await settings.load();
  await new Promise((r) => setTimeout(r, 800));   // 等插件面板渲染

  const settingsPanel = await settings.win.webContents.executeJavaScript(
    `(() => {
       const btn = document.querySelector('#tab-nav .tab-btn[data-tab="plugin-llm-chat"]');
       const panel = document.getElementById('tab-plugin-llm-chat');
       const group = panel && panel.querySelector('[data-plugin-id="llm-chat"]');
       return {
         tab: !!btn,
         tabText: btn ? btn.textContent.trim() : '',
         panel: !!panel,
         fields: group ? group.querySelectorAll('[data-field-key]').length : 0,
         saveBtn: group ? !!group.querySelector('[data-plugin-save]') : false,
         actions: group ? group.querySelectorAll('[data-plugin-action]').length : 0,
         modelValue: group ? (group.querySelector('[data-field-key="model"]') || {}).value : ''
       };
     })()`
  ).catch((e) => ({ error: e.message }));

  record('设置页面：插件设置面板已动态生成',
    settingsPanel.tab && settingsPanel.panel && settingsPanel.fields >= 7 &&
    settingsPanel.saveBtn && settingsPanel.actions >= 1 && settingsPanel.modelValue === 'deepseek-chat',
    JSON.stringify(settingsPanel));

  const pluginUi = await settings.win.webContents.executeJavaScript(
    `(async () => {
       const list = await window.settingsAPI.getPlugins();
       const paths = await window.settingsAPI.getPluginPaths();
       return {
         tab: !!document.querySelector('#tab-nav .tab-btn[data-tab="plugins"]'),
         dropzone: !!document.getElementById('plugin-dropzone'),
         listEl: !!document.getElementById('plugin-list'),
         api: typeof window.settingsAPI.installPluginPackage,
         listHasChat: Array.isArray(list) && list.some((p) => p.id === 'llm-chat' && p.origin === 'builtin'),
         userDir: paths && paths.userPluginsDir
       };
     })()`
  ).catch((e) => ({ error: e.message }));

  record('设置页面：插件管理页与内置插件列表可用',
    pluginUi.tab === true && pluginUi.dropzone === true && pluginUi.listEl === true &&
    pluginUi.api === 'function' && pluginUi.listHasChat === true && !!pluginUi.userDir,
    JSON.stringify(pluginUi));

  const phraseUi = await settings.win.webContents.executeJavaScript(
    `(() => {
       const hint = document.getElementById('balance-phrases-hint');
       return {
         box: !!document.getElementById('balance-phrases'),
         preview: !!document.getElementById('btn-preview-phrase'),
         hint: hint ? hint.textContent : ''
       };
     })()`
  ).catch((e) => ({ error: e.message }));

  record('设置页面：双击自定义语句可编辑、可预览、有状态提示',
    phraseUi.box === true && phraseUi.preview === true && /余额/.test(phraseUi.hint || ''),
    JSON.stringify(phraseUi));

  // 关于页版本号应当来自主进程（真实应用里 = package.json 的 version；
  // 冒烟测试是 `electron script.js` 直接跑脚本，主进程只能报到 Electron 自己的版本）
  const aboutVersion = await settings.win.webContents.executeJavaScript(
    `(async () => ({
       shown: ((document.querySelector('#tab-about .version') || {}).textContent || '').trim(),
       reported: (await window.settingsAPI.getAppPath()).version
     }))()`
  ).catch(() => ({}));
  record('设置页面：关于页版本号动态跟随主进程（不再写死）',
    !!aboutVersion.reported && aboutVersion.shown === `v${aboutVersion.reported}`,
    JSON.stringify(aboutVersion));

  // ---------- 4. AI 对话插件窗口 ----------
  const before = BrowserWindow.getAllWindows().length;
  const command = await host.runCommand('llm-chat', 'open-chat', { source: 'smoke' });
  const chatWin = BrowserWindow.getAllWindows().find(
    (w) => w !== pet.win && w !== settings.win && w !== menu.win && !w.isDestroyed()
  );
  chatWin?.hide();   // 冒烟测试不打扰桌面

  const chatWindowOk = command.success && !!chatWin && BrowserWindow.getAllWindows().length === before + 1;
  record('AI 对话窗口由插件命令创建', chatWindowOk, command.error || '');

  let chatResult = { error: '窗口未创建' };
  if (chatWin) {
    const errors = watchPage(chatWin, '对话');
    try {
      await waitUntilLoaded(chatWin, '对话');
      chatWin.hide();
      await new Promise((r) => setTimeout(r, 600));
      chatResult = await chatWin.webContents.executeJavaScript(
        `(async () => {
           const config = await window.chatAPI.getConfig();
           const list = await window.chatAPI.listConversations();

           // 走真实 UI 路径：填输入框 → 点发送按钮
           document.getElementById('message-input').value = '你好';
           document.getElementById('btn-send').click();

           // 等错误气泡出现（未配置 API Key）
           const start = Date.now();
           while (Date.now() - start < 8000) {
             if (document.querySelector('.message.assistant.error')) break;
             await new Promise((resolve) => setTimeout(resolve, 100));
           }

           return {
             bridge: typeof window.chatAPI.sendMessage === 'function',
             modal: config.model,
             endpoint: config.endpoint,
             hasApiKey: config.hasApiKey,
             listCount: Array.isArray(list) ? list.length : -1,
             welcomeGone: !document.querySelector('.welcome-message'),
             userBubbles: document.querySelectorAll('.message.user').length,
             errorBubbles: document.querySelectorAll('.message.assistant.error').length,
             errorText: (document.querySelector('.message.assistant.error .message-content') || {}).textContent || '',
             sendButtonReset: !document.getElementById('btn-send').classList.contains('stop'),
             sidebarItems: document.querySelectorAll('.conv-item').length
           };
         })()`
      );
    } catch (e) {
      chatResult = { error: e.message };
    }
    allErrors.push(...errors);
  }

  record('对话页面：preload 桥与首屏渲染正常',
    chatResult.bridge === true && chatResult.modal === 'deepseek-chat' && chatResult.listCount === 0,
    JSON.stringify({ bridge: chatResult.bridge, model: chatResult.modal, endpoint: chatResult.endpoint }));

  record('对话页面：点击发送后 UI 与错误链路都正确',
    chatResult.welcomeGone === true && chatResult.userBubbles === 1 && chatResult.errorBubbles === 1 &&
    /API Key/.test(chatResult.errorText || '') && chatResult.sendButtonReset === true,
    JSON.stringify({
      welcomeGone: chatResult.welcomeGone,
      userBubbles: chatResult.userBubbles,
      errorBubbles: chatResult.errorBubbles,
      errorText: chatResult.errorText,
      sendButtonReset: chatResult.sendButtonReset
    }));

  // 会话应当已落库
  const persisted = await chatWin?.webContents.executeJavaScript('window.chatAPI.listConversations()').catch(() => null);
  record('对话页面：发送后会话已持久化',
    Array.isArray(persisted) && persisted.length === 1 && persisted[0].messageCount === 1,
    JSON.stringify(persisted));

  // ---------- 4b. 插件安装 / 卸载（真实 UI 链路） ----------
  const fixturePath = createSmokePluginPackage();
  const installResult = await settings.win.webContents.executeJavaScript(
    `window.settingsAPI.installPluginPackage(${JSON.stringify(fixturePath)}, { overwrite: true })`
  ).catch((e) => ({ success: false, error: e.message }));

  const readFixtureState = () => settings.win.webContents.executeJavaScript(
    `(async () => {
       const list = await window.settingsAPI.getPlugins();
       return {
         installed: list.some((p) => p.id === 'smoke-fixture' && p.status === 'active'),
         tab: !!document.querySelector('#tab-nav .tab-btn[data-tab="plugin-smoke-fixture"]'),
         listText: (document.getElementById('plugin-list') || {}).textContent || ''
       };
     })()`
  ).catch((e) => ({ error: e.message }));

  let fixtureState = await readFixtureState();
  for (let i = 0; i < 30 && !(fixtureState.installed && fixtureState.tab); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    fixtureState = await readFixtureState();
  }

  record('插件安装：设置页安装 .dlmpet 后热重载并出现设置面板',
    !!(installResult && installResult.success) && fixtureState.installed === true &&
    fixtureState.tab === true && /冒烟夹具插件/.test(fixtureState.listText || ''),
    JSON.stringify({ install: installResult, state: fixtureState }));

  const uninstallResult = await settings.win.webContents.executeJavaScript(
    `window.settingsAPI.uninstallPlugin('smoke-fixture', { deleteData: true })`
  ).catch((e) => ({ success: false, error: e.message }));

  let afterUninstall = await readFixtureState();
  for (let i = 0; i < 30 && (afterUninstall.installed || afterUninstall.tab); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    afterUninstall = await readFixtureState();
  }

  record('插件卸载：列表与设置面板同步移除',
    !!(uninstallResult && uninstallResult.success) && afterUninstall.installed === false &&
    afterUninstall.tab === false &&
    !/冒烟夹具插件/.test(afterUninstall.listText || ''),
    JSON.stringify({ uninstall: uninstallResult, state: afterUninstall }));

  // ---------- 5. 右键菜单窗口（真实窗口，全程不显示到桌面） ----------
  const {
    createMenuWindow, getMenuWindow, openMenuWindow, hideMenuWindow, computeMenuBounds
  } = require('../src/main/menu-window');

  let realMenuError = '';
  const realMenuErrors = [];
  try {
    createMenuWindow();
    const realMenuWin = getMenuWindow();
    realMenuErrors.push(...watchPage(realMenuWin, '菜单窗口'));

    // 冒烟测试不打扰桌面：拦下 show()，只验证「按内容自适应尺寸 + 位置收敛 + 渲染」
    let menuShown = 0;
    realMenuWin.show = () => { menuShown += 1; };
    realMenuWin.focus = () => {};

    let reportedSize = null;
    ipcMain.on('menu-size', (event, size) => { reportedSize = size; });
    const waitForSize = async () => {
      for (let i = 0; i < 30 && !reportedSize; i += 1) await new Promise((r) => setTimeout(r, 100));
      return reportedSize;
    };
    const inWorkArea = (bounds, area) =>
      bounds.x >= area.x && bounds.y >= area.y &&
      bounds.x + bounds.width <= area.x + area.width &&
      bounds.y + bounds.height <= area.y + area.height;

    await waitUntilLoaded(realMenuWin, '菜单窗口');

    // (1) 常规位置：窗口尺寸 = 菜单内容尺寸，位置贴在鼠标处
    const anchor = { x: 60, y: 60 };
    const workArea = screen.getDisplayNearestPoint(anchor).workArea;
    const opened = openMenuWindow({ anchor });
    const normalSize = await waitForSize();
    const normalBounds = realMenuWin.getBounds();
    const expected = normalSize
      ? computeMenuBounds({ anchor, size: normalSize, workArea })
      : null;
    const itemCount = await realMenuWin.webContents.executeJavaScript(
      `document.querySelectorAll('#menu .menu-item').length`
    ).catch(() => 0);

    record('右键菜单窗口：按菜单内容自适应尺寸，并贴在鼠标位置',
      opened.success === true && !!expected && itemCount === 5 && menuShown === 1 &&
      normalBounds.width === expected.width && normalBounds.height === expected.height &&
      normalBounds.x === expected.x && normalBounds.y === expected.y,
      `size=${JSON.stringify(normalSize)} bounds=${JSON.stringify(normalBounds)} items=${itemCount}`);

    // (2) 屏幕右下角：整块翻到鼠标左上侧，不会跑出屏幕
    reportedSize = null;
    openMenuWindow({ anchor: { x: workArea.x + workArea.width - 2, y: workArea.y + workArea.height - 2 } });
    const cornerSize = await waitForSize();
    const cornerBounds = realMenuWin.getBounds();
    record('右键菜单窗口：贴着屏幕角落时整体翻转，不会超出屏幕',
      !!cornerSize && inWorkArea(cornerBounds, workArea) &&
      cornerBounds.width === normalBounds.width && cornerBounds.height === normalBounds.height,
      `bounds=${JSON.stringify(cornerBounds)} workArea=${JSON.stringify(workArea)}`);

    // (3) 菜单项多到超过一屏：窗口收敛在屏幕内，菜单内部滚动到底也能点到「退出」
    const hugeHeight = workArea.height * 3;
    await realMenuWin.webContents.executeJavaScript(
      `(() => {
         const host = document.getElementById('plugin-menu-items');
         host.classList.remove('hidden');
         host.innerHTML = Array.from({ length: 80 }, (_, i) =>
           '<div class="menu-item" data-action="fake"><span class="menu-icon">🧩</span><span class="menu-label">插件菜单项 ' + i + '</span></div>').join('');
         window.menuAPI.reportSize({ width: 220, height: ${hugeHeight} });
       })()`
    );
    await waitForSize();
    const hugeBounds = realMenuWin.getBounds();
    const scrollState = await realMenuWin.webContents.executeJavaScript(
      `(() => {
         const menu = document.getElementById('menu');
         return {
           overflowY: getComputedStyle(menu).overflowY,
           scrollable: menu.scrollHeight > menu.clientHeight + 1,
           items: menu.querySelectorAll('.menu-item').length
         };
       })()`
    );
    record('右键菜单窗口：菜单项超过一屏时收敛在屏幕内，且可以滚动看完最后一项',
      hugeBounds.height <= workArea.height - 8 && inWorkArea(hugeBounds, workArea) &&
      scrollState.scrollable === true && scrollState.overflowY === 'auto' && scrollState.items >= 80,
      `bounds=${JSON.stringify(hugeBounds)} scroll=${JSON.stringify(scrollState)}`);
  } catch (e) {
    realMenuError = e.message;
    record('右键菜单窗口：按菜单内容自适应尺寸，且完整落在屏幕可用区域内', false, e.message);
  } finally {
    hideMenuWindow();
  }
  if (realMenuError) console.log(`     ⚠️ 菜单窗口用例异常: ${realMenuError}`);
  allErrors.push(...realMenuErrors);

  // ---------- 6. 页面错误 ----------
  allErrors.push(...pet.errors, ...menu.errors, ...settings.errors);
  record('四个页面均无渲染错误', allErrors.length === 0, allErrors.join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(failed.length === 0
    ? `✅ 渲染进程冒烟测试通过：${results.length} 项`
    : `❌ 渲染进程冒烟测试失败：${failed.length}/${results.length} 项`);
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady()
  .then(main)
  .catch((e) => {
    console.error('❌ 冒烟测试异常:', e && e.stack ? e.stack : e);
    app.exit(1);
  });
