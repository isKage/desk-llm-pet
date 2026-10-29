/**
 * 桌宠窗口管理
 * 透明、无边框、置顶、所有桌面显示
 *
 * 窗口尺寸 = 300 * 宠物大小(scale) * 窗口裁剪(crop)
 * 动画本身按 300 * scale 渲染，窗口只裁剪掉周围背景，所以裁剪越小窗口越小、宠物大小不变
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { getWindowPosition, saveWindowPosition, getPetConfig } = require('../shared/store');

let petWindow = null;

/** 宠物几何变化（移动 / 缩放 / 显示隐藏）时的回调，用于同步气泡位置 */
let geometryListener = null;

function setPetGeometryListener(fn) { geometryListener = fn; }
function notifyGeometryChange() {
  if (typeof geometryListener === 'function') {
    try { geometryListener(); } catch (e) { /* 忽略 */ }
  }
}

/** 根据配置计算窗口边长 */
function calcWindowSize(petConfig) {
  const scale = Number(petConfig.scale) || 1;
  const crop = Number(petConfig.crop);
  const safeCrop = Number.isFinite(crop) ? Math.min(1, Math.max(0.25, crop)) : 0.55;
  return Math.max(80, Math.round(300 * scale * safeCrop));
}

async function createPetWindow(isDev = false) {
  const savedPosition = getWindowPosition();
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea;
  const petConfig = getPetConfig();
  const windowSize = calcWindowSize(petConfig);
  const isMac = process.platform === 'darwin';

  const defaultX = savedPosition?.petX ?? screenWidth - windowSize - 40;
  const defaultY = savedPosition?.petY ?? screenHeight - windowSize - 40;

  petWindow = new BrowserWindow({
    width: windowSize,
    height: windowSize,
    x: defaultX,
    y: defaultY,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // 窗口在后台（未激活）时也接受第一次鼠标/拖拽操作
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'pet-preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
      nodeIntegration: false
    }
  });

  await petWindow.loadFile(path.join(__dirname, '..', 'renderer', 'pet', 'pet.html'));

  // macOS: screen-saver 级别置顶，覆盖全屏应用；Windows: floating 级别
  petWindow.setAlwaysOnTop(true, isMac ? 'screen-saver' : 'floating');
  // 所有桌面可见（放在创建之后调用，避免构造参数在 macOS 上的已知怪异行为）
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 启动时应用保存的透明度
  const savedOpacity = Number(petConfig.opacity);
  if (!isNaN(savedOpacity) && savedOpacity > 0) {
    petWindow.setOpacity(savedOpacity);
  }

  // 开发模式不再自动打开调试器（那个窗口会去 Google 的 devtools 前端地址加载页面）
  if (isDev) {
    console.log('🛠  开发模式：如需调试按 ⌥⌘I，或使用 npm run dev:tools');
  }
  if (process.argv.includes('--devtools')) {
    petWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 安全网：任何情况下都不允许桌宠窗口跳转（例如把文件拖进来时浏览器默认的导航行为）
  const petPagePath = path.join(__dirname, '..', 'renderer', 'pet', 'pet.html');
  const petPageUrl = require('url').pathToFileURL(petPagePath).href;
  petWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== petPageUrl) {
      event.preventDefault();
      console.warn('⚠️ 已阻止桌宠窗口跳转到:', url);
    }
  });

  petWindow.on('move', notifyGeometryChange);
  petWindow.on('moved', () => {
    if (petWindow) {
      const [x, y] = petWindow.getPosition();
      saveWindowPosition(x, y);
    }
  });

  petWindow.on('show', notifyGeometryChange);
  petWindow.on('hide', notifyGeometryChange);
  petWindow.on('closed', () => { petWindow = null; notifyGeometryChange(); });

  return petWindow;
}

function getPetWindow() { return petWindow; }

function togglePetWindow() {
  if (!petWindow) return;
  if (petWindow.isVisible()) petWindow.hide();
  else petWindow.show();
}

/**
 * 应用宠物大小 / 窗口裁剪：改变窗口边长
 */
function setPetSize(scale, crop) {
  if (!petWindow) return;
  const size = calcWindowSize({ scale, crop });
  const [x, y] = petWindow.getPosition();
  petWindow.setBounds({ x, y, width: size, height: size });
  notifyGeometryChange();
}

function setPetOpacity(opacity) {
  if (!petWindow) return;
  petWindow.setOpacity(Number(opacity) || 1);
}

function isCursorNearPet(point, bounds, padding = 32) {
  const dx = Math.max(bounds.x - point.x, 0, point.x - bounds.x - bounds.width);
  const dy = Math.max(bounds.y - point.y, 0, point.y - bounds.y - bounds.height);
  return dx * dx + dy * dy <= padding * padding;
}

module.exports = {
  createPetWindow, getPetWindow, togglePetWindow,
  setPetSize, setPetOpacity,
  isCursorNearPet,
  setPetGeometryListener, notifyGeometryChange
};
