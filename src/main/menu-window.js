/**
 * 桌宠右键菜单窗口
 *
 * 为什么单独开一个窗口：
 *   宠物窗口会按「窗口裁剪」收紧到只剩动画主体（默认只有 165×165 像素），
 *   菜单放在宠物窗口里就会被窗口裁掉——插件越加越多，靠下的「退出」就看不见了。
 *   所以菜单用独立的透明置顶窗口：窗口尺寸由菜单内容决定，
 *   再按屏幕可用区域收敛；菜单项多到屏幕都放不下时，在菜单内部滚动，
 *   无论加多少个插件和功能都不会被遮挡。
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { getPetWindow } = require('./pet-window');

/** 菜单窗口宽度上限（含 body 为阴影预留的内边距，与 menu.css 的 max-width 对应） */
const MAX_WIDTH = 320;
/** 距离屏幕边缘的最小留白 */
const SCREEN_MARGIN = 4;
/** 鼠标位置与菜单之间的间距 */
const ANCHOR_GAP = 2;
/** 内容尺寸还没回报时的兜底尺寸 */
const FALLBACK_SIZE = { width: 180, height: 260 };

let menuWindow = null;
/** 菜单内容尺寸（由菜单渲染进程测量后回传） */
let contentSize = { ...FALLBACK_SIZE };
/** 本次打开的锚点（屏幕坐标）；为 null 表示这次打开不再需要显示 */
let pendingAnchor = null;
/** 打开序号：收起菜单 / 重新打开都会自增，用来作废还没走完的异步流程 */
let openToken = 0;

const isMac = process.platform === 'darwin';

/** 创建（或复用）菜单窗口 */
function createMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed()) return menuWindow;

  menuWindow = new BrowserWindow({
    width: contentSize.width,
    height: contentSize.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // 菜单需要拿到焦点：这样点到别处时会自动收起（与系统右键菜单一致）
    focusable: true,
    // 应用还没激活时，第一次点击也要能选中菜单项
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'menu-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  menuWindow.setAlwaysOnTop(true, isMac ? 'screen-saver' : 'floating');
  menuWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  menuWindow.loadFile(path.join(__dirname, '..', 'renderer', 'menu', 'menu.html'));

  // 失去焦点说明用户点到别处了 → 收起菜单
  menuWindow.on('blur', () => hideMenuWindow());
  menuWindow.on('closed', () => { menuWindow = null; });
  // 页面加载失败时不显示空菜单
  menuWindow.webContents.on('did-fail-load', () => { pendingAnchor = null; });

  return menuWindow;
}

/** 获取可用（未销毁）的菜单窗口 */
function getMenuWindow() {
  return menuWindow && !menuWindow.isDestroyed() ? menuWindow : null;
}

/**
 * 计算菜单窗口的位置与尺寸：贴着鼠标展开，并整体收敛在屏幕可用区域内
 * 纯函数（不依赖 Electron），方便自检直接覆盖各种边界情况
 *
 * @param {Object} params
 * @param {{x:number,y:number}} params.anchor 鼠标位置（屏幕坐标）
 * @param {{width:number,height:number}} params.size 菜单内容尺寸
 * @param {{x:number,y:number,width:number,height:number}} params.workArea 屏幕可用区域
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function computeMenuBounds({ anchor, size, workArea }) {
  const maxWidth = Math.max(1, workArea.width - SCREEN_MARGIN * 2);
  const maxHeight = Math.max(1, workArea.height - SCREEN_MARGIN * 2);
  const width = Math.min(Math.max(1, Math.round(Number(size && size.width) || 0)), MAX_WIDTH, maxWidth);
  const height = Math.min(Math.max(1, Math.round(Number(size && size.height) || 0)), maxHeight);

  const anchorX = Math.round(Number(anchor && anchor.x) || 0);
  const anchorY = Math.round(Number(anchor && anchor.y) || 0);

  // 默认在鼠标右下方展开；右边 / 下边放不下就翻到鼠标的左侧 / 上方
  let x = anchorX + ANCHOR_GAP;
  let y = anchorY + ANCHOR_GAP;
  if (x + width > workArea.x + workArea.width - SCREEN_MARGIN) x = anchorX - width - ANCHOR_GAP;
  if (y + height > workArea.y + workArea.height - SCREEN_MARGIN) y = anchorY - height - ANCHOR_GAP;

  // 最后再收敛一次：无论鼠标在哪，菜单都完整落在屏幕内
  x = Math.min(Math.max(x, workArea.x + SCREEN_MARGIN), workArea.x + workArea.width - width - SCREEN_MARGIN);
  y = Math.min(Math.max(y, workArea.y + SCREEN_MARGIN), workArea.y + workArea.height - height - SCREEN_MARGIN);

  return { x, y, width, height };
}

/**
 * 打开右键菜单（贴在锚点处）
 * @param {{anchor?: {x:number, y:number}}} [payload] 锚点为屏幕坐标，由 ipc-handlers 把鼠标位置换算好
 * @returns {{success: boolean, error?: string}}
 */
function openMenuWindow(payload = {}) {
  const anchor = payload.anchor || {};
  const anchorX = Number(anchor.x);
  const anchorY = Number(anchor.y);
  if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) {
    return { success: false, error: '缺少菜单锚点' };
  }

  const win = createMenuWindow();
  if (!win) return { success: false, error: '菜单窗口不可用' };

  pendingAnchor = { x: Math.round(anchorX), y: Math.round(anchorY) };
  const token = ++openToken;

  // 渲染进程加载完成后再让它渲染菜单项并测量尺寸
  const dispatch = () => {
    if (token !== openToken || !pendingAnchor) return;
    const target = getMenuWindow();
    if (target) target.webContents.send('menu-show');
  };

  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', dispatch);
  else dispatch();

  // 兜底：渲染进程万一没回报尺寸，也要按上次的尺寸把菜单显示出来
  setTimeout(() => {
    if (token !== openToken || !pendingAnchor) return;
    applyMenuSize(contentSize);
  }, 250);

  return { success: true };
}

/**
 * 菜单渲染进程回报内容尺寸 → 调整窗口大小、贴到锚点并显示
 * @param {{width:number,height:number}} size
 */
function applyMenuSize(size) {
  const width = Number(size && size.width);
  const height = Number(size && size.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    contentSize = { width: Math.round(width), height: Math.round(height) };
  }

  const win = getMenuWindow();
  if (!win || !pendingAnchor) return;

  const anchor = pendingAnchor;
  const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
  win.setBounds(computeMenuBounds({ anchor, size: contentSize, workArea: display.workArea }));

  if (!win.isVisible()) {
    win.show();
    win.focus();
  }
}

/** 收起菜单（点击别处 / 选中菜单项 / 宠物隐藏时调用，可重复调用） */
function hideMenuWindow() {
  pendingAnchor = null;
  openToken += 1;
  const win = getMenuWindow();
  if (win && win.isVisible()) win.hide();
}

/**
 * 菜单渲染进程选中了某一项 → 收起菜单并转交桌宠执行
 * （动作语义只在 pet.js 里实现一份，避免两处逻辑不一致）
 * @param {{action?: string, pluginId?: string, command?: string}} payload
 */
function sendMenuSelection(payload) {
  hideMenuWindow();
  const pet = getPetWindow();
  if (!pet || pet.isDestroyed()) return;
  pet.webContents.send('pet-menu-action', payload && typeof payload === 'object' ? payload : {});
}

module.exports = {
  createMenuWindow,
  getMenuWindow,
  openMenuWindow,
  hideMenuWindow,
  applyMenuSize,
  sendMenuSelection,
  computeMenuBounds,
  MAX_WIDTH
};
