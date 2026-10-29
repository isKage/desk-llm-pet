/**
 * Electron 主进程入口
 * 管理应用生命周期、窗口创建和 IPC 通信
 * 插件（src/plugins）通过插件宿主按需加载，加载失败不影响本体
 */

const electron = require('electron');
const { app, BrowserWindow, ipcMain, nativeTheme, nativeImage } = electron;
const path = require('path');
const {
  createPetWindow, getPetWindow, setPetGeometryListener
} = require('./pet-window');
const { createSettingsWindow, getSettingsWindow } = require('./settings-window');
const { createBubbleWindow, positionBubble, hideBubble } = require('./bubble-window');
const { createMenuWindow, hideMenuWindow } = require('./menu-window');
const { createTray } = require('./tray');
const { registerIpcHandlers } = require('./ipc-handlers');
const { getLLMConfig } = require('../shared/store');
const { startBalanceHover } = require('./balance-hover');


// 插件宿主按需加载：即使 src/plugins 缺失或损坏，本体也能照常启动
let pluginManager = null;
try {
  pluginManager = require('../plugins/plugin-manager');
} catch (e) {
  console.warn('⚠️ 插件系统加载失败（本体功能不受影响）:', e.message);
}

// 开发模式标记
const isDev = process.argv.includes('--dev');
// 代码目录与启动参数，方便确认「跑的是哪份代码」
const CODE_ROOT = path.join(__dirname, '..', '..');

// 设置应用名称（开发模式下 Dock/任务栏显示的名称）
app.setName('DeskLLMPet');

// macOS: 修复 secure coding 警告
if (process.platform === 'darwin') {
  app.setAboutPanelOptions({
    applicationName: 'DeskLLMPet',
    applicationVersion: app.getVersion(),
    credits: '基于 Electron 构建的桌面宠物应用'
  });
}

// 禁止应用多开
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户尝试打开第二个实例时，聚焦已有窗口
    console.warn('');
    console.warn('⚠️  已经有一个 DeskLLMPet 在运行，本次启动被单实例锁拦截并已退出。');
    console.warn('    如果你刚改了代码，请先在托盘菜单点「退出」关掉旧实例，再重新启动，');
    console.warn('    否则跑的还是旧代码，改动不会生效。');
    console.warn('');
    const petWin = getPetWindow();
    if (petWin) {
      petWin.show();
      petWin.focus();
    }
  });
}

/**
 * 应用初始化
 */
async function initApp() {
  console.log(`🚀 DeskLLMPet 启动 v${app.getVersion()} | 代码目录: ${CODE_ROOT} | 参数: ${process.argv.slice(1).join(' ') || '(无)'}`);

  // 注册所有 IPC 处理器
  registerIpcHandlers();

  // 加载插件（贡献桌宠/托盘菜单、设置页、独立 IPC 与窗口）
  // 任何插件出错都只跳过该插件，不影响本体
  await loadPlugins();

  // 创建桌宠窗口
  await createPetWindow(isDev);

  // 气泡窗口（隐藏，用到时才显示）
  createBubbleWindow();

  // 右键菜单窗口（隐藏，用到时才显示；独立窗口才能按菜单内容自适应大小）
  createMenuWindow();
  const stopBalanceHover = startBalanceHover();
  app.once('before-quit', stopBalanceHover);

  // 桌宠移动 / 缩放 / 显隐时，气泡跟着走，菜单先收起来
  setPetGeometryListener(() => {
    hideMenuWindow();
    const petWin = getPetWindow();
    if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) {
      hideBubble();
      return;
    }
    positionBubble();
  });

  // 创建系统托盘（Windows 和 macOS 都可用）
  createTray();

  // macOS: 设置 Dock 图标并确保可见
  if (process.platform === 'darwin') {
    // 设置 Dock 图标（开发模式用 PNG，打包后用 icns）
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
    try {
      const dockIcon = nativeImage.createFromPath(iconPath);
      if (!dockIcon.isEmpty()) {
        app.dock?.setIcon(dockIcon);
      }
    } catch (e) {
      // 图标文件不存在时静默忽略，使用默认图标
    }
    app.dock?.show();
  }

  // 监听主题变化
  nativeTheme.on('updated', () => {
    const petWin = getPetWindow();
    if (petWin) {
      petWin.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    }
  });
}

// 应用就绪
app.whenReady().then(initApp);

/**
 * 加载插件系统
 * 插件宿主只拿到「显式注入」的能力：Electron 对象 + 两个只读宿主服务，
 * 因此插件无法反向修改本体的内部状态，本体也不依赖任何具体插件
 */
async function loadPlugins() {
  if (!pluginManager) return;
  try {
    const host = pluginManager.initPluginHost({
      electron,
      logger: console,
      hostServices: {
        // 只读共享配置：插件缺省时可回退使用本体的 API 配置
        getSharedLLMConfig: () => getLLMConfig(),
        // 打开本体的设置窗口
        openSettings: () => { createSettingsWindow(); return true; }
      }
    });
    const reports = await host.loadAll();
    const active = reports.filter((r) => r.status === 'active').length;
    const failed = reports.filter((r) => r.status === 'error').length;
    console.log(`🧩 插件系统就绪：${active} 个已加载${failed ? `，${failed} 个失败` : ''}`);
  } catch (e) {
    console.error('⚠️ 插件系统初始化失败（本体功能不受影响）:', e.message);
  }
}

// 所有窗口关闭时（macOS 不退出）
app.on('window-all-closed', () => {
  // macOS 下保持应用在 Dock 中运行
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// macOS 激活应用时（点击 Dock 图标）
app.on('activate', () => {
  const petWin = getPetWindow();
  if (petWin) {
    petWin.show();
  } else {
    createPetWindow(isDev);
  }
});

// 应用退出前清理
app.on('before-quit', () => {
  hideMenuWindow();
  const host = pluginManager && typeof pluginManager.getPluginHost === 'function'
    ? pluginManager.getPluginHost()
    : null;
  if (!host) return;
  // 卸载插件：注销其 IPC 通道、关闭其窗口
  Promise.resolve()
    .then(() => host.deactivateAll())
    .catch(() => { /* 退出流程中不阻塞 */ });
});
