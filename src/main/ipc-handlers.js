/**
 * IPC 通信处理
 * 处理渲染进程与主进程之间的通信
 */

const { ipcMain, dialog, app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  getLLMConfig, setLLMConfig,
  getBalanceConfig, setBalanceConfig,
  getAnimationConfig, setAnimationConfig,
  getPetConfig, setPetConfig,
  getBubbleConfig, setBubbleConfig,
  normalizeCustomPhrases, MAX_PHRASE_LENGTH,
  getAllConfig
} = require('../shared/store');
const { fetchBalance, formatBalanceText } = require('../shared/deepseek-api');
const { invalidateBalanceCache } = require('./balance-hover');
const { createSettingsWindow } = require('./settings-window');
const {
  togglePetWindow, setPetSize, setPetOpacity,
  getPetWindow, notifyGeometryChange
} = require('./pet-window');
const { showBubble, hideBubble, applyBubbleSize, createBubbleWindow } = require('./bubble-window');
const {
  openMenuWindow, hideMenuWindow, applyMenuSize, sendMenuSelection
} = require('./menu-window');

/**
 * 向桌宠窗口发送消息（安全检查）
 */
function sendToPet(channel, data) {
  const win = getPetWindow();
  if (win && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

/**
 * 注册所有 IPC 处理器
 */
function registerIpcHandlers() {
  // ====== API 配置（仅用于余额查询） ======

  ipcMain.handle('get-llm-config', () => getLLMConfig());

  ipcMain.handle('set-llm-config', (event, config) => {
    if (config && typeof config === 'object') {
      const next = {};
      for (const key of ['apiEndpoint', 'balanceEndpoint', 'apiKey']) {
        if (typeof config[key] === 'string') next[key] = config[key].trim();
      }
      setLLMConfig(next);
      invalidateBalanceCache();
      // 通知桌宠：API 配置变化后刷新一次余额
      sendToPet('balance-config-changed', getBalanceConfig());
    }
    return { success: true };
  });

  // ====== API 余额 ======

  ipcMain.handle('get-api-balance', async () => {
    try {
      const result = await fetchBalance(getLLMConfig());
      return { success: true, data: result, text: formatBalanceText(result) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-balance-config', () => getBalanceConfig());

  ipcMain.handle('set-balance-config', (event, config) => {
    if (config && typeof config === 'object') {
      const next = {};
      if (config.enabled !== undefined) next.enabled = !!config.enabled;
      if (config.hoverEnabled !== undefined) next.hoverEnabled = !!config.hoverEnabled;
      if (config.intervalMinutes !== undefined) {
        const minutes = Number(config.intervalMinutes);
        // 0 表示只在双击时展示；其余限制在 1 ~ 1440 分钟之间
        next.intervalMinutes = Number.isFinite(minutes) ? Math.min(1440, Math.max(0, minutes)) : 30;
      }
      // 自定义语句：关闭余额气泡后，双击桌宠随机展示其中一句
      if (config.customPhrases !== undefined) {
        next.customPhrases = normalizeCustomPhrases(config.customPhrases);
      }
      setBalanceConfig(next);
      sendToPet('balance-config-changed', getBalanceConfig());
    }
    return { success: true };
  });

  // ====== 动画配置 ======

  ipcMain.handle('get-animation-config', () => getAnimationConfig());

  // 更新动画配置时，通知桌宠窗口实时重载动画
  ipcMain.handle('set-animation-config', (event, config) => {
    setAnimationConfig(config);
    // 通知桌宠窗口重载动画
    sendToPet('reload-animations', getAnimationConfig());
    return { success: true };
  });

  ipcMain.handle('get-available-animations', () => scanAnimationFiles());

  // ====== 宠物设置 ======

  ipcMain.handle('get-pet-config', () => getPetConfig());

  ipcMain.handle('set-pet-config', (event, config) => {
    if (config && typeof config === 'object') {
      setPetConfig(config);
      const pet = getPetConfig();
      // 宠物大小 / 窗口裁剪都会改变窗口尺寸
      if (config.scale !== undefined || config.crop !== undefined) {
        setPetSize(pet.scale, pet.crop);
      }
      if (config.opacity !== undefined) setPetOpacity(Number(config.opacity));
      // 通知桌宠配置变更（含裁剪参数）
      sendToPet('config-changed', pet);
    }
    return { success: true };
  });

  // ====== 气泡（独立悬浮窗口） ======

  ipcMain.handle('get-bubble-config', () => getBubbleConfig());

  ipcMain.handle('set-bubble-config', (event, config) => {
    if (config && typeof config === 'object') {
      const next = {};
      if (config.scale !== undefined) {
        const scale = Number(config.scale);
        next.scale = Number.isFinite(scale) ? Math.min(2, Math.max(0.5, scale)) : 1;
      }
      if (config.offsetX !== undefined) {
        const x = Number(config.offsetX);
        next.offsetX = Number.isFinite(x) ? Math.min(600, Math.max(-600, Math.round(x))) : 0;
      }
      if (config.offsetY !== undefined) {
        const y = Number(config.offsetY);
        next.offsetY = Number.isFinite(y) ? Math.min(600, Math.max(-600, Math.round(y))) : 0;
      }
      setBubbleConfig(next);
      // 位置变化时立刻把气泡挪过去（如果正在显示）
      notifyGeometryChange();
    }
    return { success: true };
  });

  // 桌宠渲染进程请求显示气泡
  ipcMain.handle('pet-show-bubble', (event, payload) => showBubble(payload || {}));

  // 预览气泡（设置页使用）
  ipcMain.handle('preview-bubble', () => showBubble({
    kind: 'balance',
    data: {
      isAvailable: true,
      balances: [{ currency: 'CNY', totalBalance: '128.00', grantedBalance: '8.00', toppedUpBalance: '120.00' }]
    },
    duration: 4000
  }));

  // 气泡渲染进程回报内容尺寸
  ipcMain.on('bubble-size', (event, size) => applyBubbleSize(size));
  // 气泡展示结束
  ipcMain.on('bubble-hide', () => hideBubble());

  // 预览双击自定义语句（设置页使用，未保存也能看效果）
  ipcMain.handle('preview-phrase', (event, payload) => {
    const raw = payload && typeof payload.text === 'string' ? payload.text : '';
    const text = raw.trim().slice(0, MAX_PHRASE_LENGTH);
    if (!text) return { success: false, error: '语句为空' };
    return showBubble({ kind: 'text', text, duration: 3200 });
  });

  // ====== 桌宠右键菜单（独立菜单窗口） ======
  // 桌宠渲染进程把鼠标位置（窗口内坐标）报上来，这里换算成屏幕坐标后展开菜单
  ipcMain.handle('open-pet-menu', (event, payload) => {
    const pet = getPetWindow();
    if (!pet || pet.isDestroyed() || !pet.isVisible()) return { success: false, reason: 'pet-hidden' };
    const [petX, petY] = pet.getPosition();
    const offsetX = Number(payload && payload.x) || 0;
    const offsetY = Number(payload && payload.y) || 0;
    return openMenuWindow({ anchor: { x: petX + offsetX, y: petY + offsetY } });
  });

  // 菜单渲染进程回报内容尺寸 → 自适应窗口大小并贴到鼠标位置
  ipcMain.on('menu-size', (event, size) => applyMenuSize(size));
  // 选中某一项 → 收起菜单并转交桌宠执行（本体动作 / 插件命令）
  ipcMain.on('menu-select', (event, payload) => sendMenuSelection(payload));
  // 请求收起菜单
  ipcMain.on('menu-close', () => hideMenuWindow());

  ipcMain.handle('get-all-config', () => getAllConfig());

  // ====== 窗口操作 ======

  ipcMain.handle('open-settings-window', () => { createSettingsWindow(); return { success: true }; });
  ipcMain.handle('hide-pet', () => { togglePetWindow(); return { success: true }; });

  // 移动桌宠窗口
  ipcMain.on('move-pet-window', (event, payload) => {
    const petWin = getPetWindow();
    if (!petWin) return;
    let deltaX, deltaY;
    if (payload && typeof payload === 'object') {
      deltaX = Math.round(Number(payload.deltaX) || 0);
      deltaY = Math.round(Number(payload.deltaY) || 0);
    }
    if (isNaN(deltaX) || isNaN(deltaY)) return;
    const [x, y] = petWin.getPosition();
    petWin.setPosition(x + deltaX, y + deltaY);
  });

  ipcMain.handle('quit-app', () => { app.quit(); return { success: true }; });

  // 窗口控制
  ipcMain.handle('close-settings-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });

  // 打开外部链接
  ipcMain.handle('open-external', (event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { success: true };
  });

  ipcMain.handle('select-animation-file', async () => {
    return await dialog.showOpenDialog({
      title: '选择动画文件',
      filters: [
        { name: 'WebM 视频', extensions: ['webm'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    });
  });

  ipcMain.handle('get-app-path', () => ({
    // 版本号取自 package.json，避免发布时忘记同步界面上的版本
    version: app.getVersion(),
    userData: app.getPath('userData'),
    appData: app.getPath('appData'),
    assets: path.join(__dirname, '..', '..', 'assets', 'animations'),
    projectRoot: path.join(__dirname, '..', '..')
  }));
}

/**
 * 扫描动画文件目录
 */
function scanAnimationFiles() {
  const projectRoot = path.join(__dirname, '..', '..');
  const result = { idle: [], click: [] };

  const scanDirs = [
    { idle: path.join(projectRoot, 'assets', 'animations', 'idle'), click: path.join(projectRoot, 'assets', 'animations', 'click') },
    { idle: path.join(projectRoot, 'assets', 'thumb'), click: null }
  ];

  for (const dirs of scanDirs) {
    if (dirs.idle && fs.existsSync(dirs.idle)) {
      const files = fs.readdirSync(dirs.idle).filter(f => f.endsWith('.webm'));
      for (const f of files) {
        const isClickReaction = /点击回应|被吓|被鼠标|拖拽|炸毛|害羞|生气|开心跃动|傲娇/i.test(f);
        const category = isClickReaction ? 'click' : 'idle';
        const relativePath = path.relative(projectRoot, path.join(dirs.idle, f));
        result[category].push({ name: f, path: relativePath.replace(/\\/g, '/') });
      }
    }
    if (dirs.click && fs.existsSync(dirs.click)) {
      const files = fs.readdirSync(dirs.click).filter(f => f.endsWith('.webm'));
      for (const f of files) {
        const relativePath = path.relative(projectRoot, path.join(dirs.click, f));
        result.click.push({ name: f, path: relativePath.replace(/\\/g, '/') });
      }
    }
  }

  result.idle = deduplicateByName(result.idle);
  result.click = deduplicateByName(result.click);
  console.log(`📁 扫描动画: ${result.idle.length} 个闲置, ${result.click.length} 个点击反应`);
  return result;
}

function deduplicateByName(list) {
  const seen = new Set();
  return list.filter(item => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

module.exports = { registerIpcHandlers };
