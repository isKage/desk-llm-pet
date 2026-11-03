/**
 * 系统托盘管理
 * - 单击：直接显示/隐藏桌宠
 * - 右键/Ctrl+单击：弹出菜单
 * - 双击：显示桌宠
 * - 插件可通过 contributes.trayMenu 往菜单里加条目
 */

const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');
const { togglePetWindow, getPetWindow } = require('./pet-window');
const { createSettingsWindow } = require('./settings-window');

// 插件宿主按需加载：插件系统不可用时托盘菜单保持原样
let pluginManager = null;
try {
  pluginManager = require('../plugins/plugin-manager');
} catch (e) {
  pluginManager = null;
}

let tray = null;
const isMac = process.platform === 'darwin';

/** 安全获取插件贡献的托盘菜单项（插件系统不可用时返回空数组） */
function pluginTrayItems() {
  try {
    if (!pluginManager || typeof pluginManager.getPluginHost !== 'function') return [];
    const host = pluginManager.getPluginHost();
    return host ? host.getTrayMenuItems() : [];
  } catch (e) {
    return [];
  }
}

/** 触发插件命令，失败只打日志，不影响托盘本身 */
function runPluginCommand(pluginId, command) {
  if (!pluginManager || typeof pluginManager.getPluginHost !== 'function') return;
  const host = pluginManager.getPluginHost();
  if (!host) return;
  Promise.resolve(host.runCommand(pluginId, command, { source: 'tray-menu' }))
    .then((result) => {
      if (result && result.success === false) {
        console.warn('⚠️ 插件命令执行失败:', result.error);
      }
    })
    .catch((e) => console.warn('⚠️ 插件命令异常:', e.message));
}

/**
 * 构建菜单（用于右键弹出）
 */
function buildMenu() {
  const template = [
    {
      label: '显示/隐藏桌宠',
      click: () => togglePetWindow()
    },
    {
      label: '立即查看 API 余额',
      click: () => {
        const petWin = getPetWindow();
        if (!petWin) return;
        if (!petWin.isVisible()) petWin.show();
        petWin.webContents.send('show-balance');
      }
    }
  ];

  // 插件贡献的菜单项
  const items = pluginTrayItems();
  if (items.length > 0) {
    template.push({ type: 'separator' });
    for (const item of items) {
      template.push({
        label: `${item.icon} ${item.label}`,
        click: () => runPluginCommand(item.pluginId, item.command)
      });
    }
  }

  template.push(
    { type: 'separator' },
    {
      label: '设置',
      click: () => createSettingsWindow()
    },
    { type: 'separator' },
    {
      label: '关于 DeskLLMPet',
      click: () => {
        const { dialog, shell } = require('electron');
        dialog.showMessageBox({
          type: 'info',
          title: '关于 DeskLLMPet',
          message: `DeskLLMPet v${app.getVersion()}`,
          detail: '一款支持 API 余额气泡、可插件化扩展的桌面宠物应用。\n\n基于 Electron 构建，支持 Windows 和 macOS。\n\n🔗 GitHub: https://github.com/isKage/desk-llm-pet',
          buttons: ['确定', '访问 GitHub'],
          defaultId: 0,
          cancelId: 0
        }).then(({ response }) => {
          if (response === 1) {
            shell.openExternal('https://github.com/isKage/desk-llm-pet');
          }
        });
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit()
    }
  );

  return Menu.buildFromTemplate(template);
}

/**
 * 创建系统托盘
 */
function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');
  const fs = require('fs');

  if (fs.existsSync(iconPath)) {
    tray = new Tray(iconPath);
  } else {
    tray = new Tray(createDefaultIcon());
  }

  tray.setToolTip('DeskLLMPet - 桌面宠物 | 单击切换 | 右键菜单');

  if (isMac) {
    // macOS：左键单击 → 切换桌宠显示
    tray.on('click', () => {
      const petWin = getPetWindow();
      if (petWin && petWin.isVisible()) {
        petWin.hide();
      } else if (petWin) {
        petWin.show();
      }
    });
    // 右键 → 弹出菜单
    tray.on('right-click', () => {
      tray.popUpContextMenu(buildMenu());
    });
  } else {
    // Windows/Linux：设置右键菜单，左键单击切换
    tray.setContextMenu(buildMenu());
    tray.on('click', () => {
      const petWin = getPetWindow();
      if (petWin && petWin.isVisible()) {
        petWin.hide();
      } else if (petWin) {
        petWin.show();
      }
    });
  }

  // 双击托盘 → 显示桌宠
  tray.on('double-click', () => {
    const petWin = getPetWindow();
    if (petWin && !petWin.isVisible()) {
      petWin.show();
    }
  });

  return tray;
}

/**
 * 生成默认托盘图标
 */
function createDefaultIcon() {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const cx = size / 2, cy = size / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist < size / 2 - 1) {
        buffer[idx] = 138;
        buffer[idx + 1] = 43;
        buffer[idx + 2] = 226;
        buffer[idx + 3] = 255;
      } else {
        buffer[idx + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

function getTray() { return tray; }

/**
 * 刷新托盘菜单（插件安装/卸载/启用后调用）。
 * macOS 的右键菜单每次都是 popUpContextMenu(buildMenu())，无需刷新；
 * Windows 需要重新 setContextMenu。
 */
function refreshTrayMenu() {
  if (!tray || isMac) return;
  try {
    tray.setContextMenu(buildMenu());
  } catch (e) {
    // 托盘已销毁时忽略
  }
}

module.exports = { createTray, getTray, refreshTrayMenu };
