/**
 * 设置窗口逻辑
 * 处理 API 余额配置、动画选择、宠物设置等的可视化配置
 * 插件设置面板（contributes.settings）由插件系统动态追加
 */

// ====== 状态管理 ======
const state = {
  config: {
    llm: {},
    animations: {},
    balance: {},
    pet: {}
  },
  availableAnimations: { idle: [], click: [] },
  selectedIdle: [],
  selectedClick: []
};

// ====== DOM 元素 ======
const elements = {};

// ====== 初始化 ======
async function init() {
  // 平台检测
  const isMac = navigator.userAgent.includes('Mac');
  document.body.className = isMac ? 'platform-mac' : 'platform-win';

  cacheElements();
  await loadAllConfig();
  setupTabNavigation();
  setupEventListeners();
  populateForms();

  // 显示当前运行的代码目录与版本，方便确认「跑的是哪份代码」
  try {
    const paths = await window.settingsAPI.getAppPath();
    const el = document.getElementById('about-code-root');
    if (el && paths && paths.projectRoot) el.textContent = paths.projectRoot;
    const versionEl = document.querySelector('#tab-about .version');
    if (versionEl && paths && paths.version) versionEl.textContent = `v${paths.version}`;
  } catch (e) { /* 忽略 */ }

  // 插件设置面板（没有插件时什么都不做）
  await renderPluginSections();
  // 插件安装/管理页
  await initPluginManagement();

  console.log('⚙️ 设置窗口已就绪');
}

/**
 * 缓存所有 DOM 元素
 */
function cacheElements() {
  elements.btnClose = document.getElementById('btn-close');

  // API 配置
  elements.apiEndpoint = document.getElementById('api-endpoint');
  elements.apiKey = document.getElementById('api-key');
  elements.balanceEndpoint = document.getElementById('balance-endpoint');
  elements.toggleApiKey = document.getElementById('toggle-api-key');
  elements.btnTestApi = document.getElementById('btn-test-api');
  elements.btnSaveApi = document.getElementById('btn-save-api');
  elements.apiTestResult = document.getElementById('api-test-result');

  // 动画配置
  elements.idleAnimList = document.getElementById('idle-anim-list');
  elements.clickAnimList = document.getElementById('click-anim-list');
  elements.btnSelectAllIdle = document.getElementById('btn-select-all-idle');
  elements.btnSelectAllClick = document.getElementById('btn-select-all-click');
  elements.btnSaveAnimations = document.getElementById('btn-save-animations');

  // 宠物设置
  elements.petOpacity = document.getElementById('pet-opacity');
  elements.opacityValue = document.getElementById('opacity-value');
  elements.petScale = document.getElementById('pet-scale');
  elements.scaleValue = document.getElementById('scale-value');
  elements.petAutoStart = document.getElementById('pet-auto-start');
  elements.btnSavePet = document.getElementById('btn-save-pet');

  // 窗口裁剪
  elements.crop = document.getElementById('pet-crop');
  elements.cropValue = document.getElementById('crop-value');
  elements.cropX = document.getElementById('pet-crop-x');
  elements.cropXValue = document.getElementById('crop-x-value');
  elements.cropY = document.getElementById('pet-crop-y');
  elements.cropYValue = document.getElementById('crop-y-value');
  elements.btnResetCrop = document.getElementById('btn-reset-crop');

  // 气泡
  elements.bubbleScale = document.getElementById('bubble-scale');
  elements.bubbleScaleValue = document.getElementById('bubble-scale-value');
  elements.bubbleOffsetX = document.getElementById('bubble-offset-x');
  elements.bubbleXValue = document.getElementById('bubble-x-value');
  elements.bubbleOffsetY = document.getElementById('bubble-offset-y');
  elements.bubbleYValue = document.getElementById('bubble-y-value');
  elements.btnPreviewBubble = document.getElementById('btn-preview-bubble');
  elements.btnResetBubble = document.getElementById('btn-reset-bubble');

  // 余额气泡
  elements.balanceEnabled = document.getElementById('balance-enabled');
  elements.balanceInterval = document.getElementById('balance-interval');
  elements.balancePhrases = document.getElementById('balance-phrases');
  elements.balancePhrasesHint = document.getElementById('balance-phrases-hint');
  elements.btnPreviewPhrase = document.getElementById('btn-preview-phrase');

  // 插件管理
  elements.pluginDropzone = document.getElementById('plugin-dropzone');
  elements.pluginUserDir = document.getElementById('plugin-user-dir');
  elements.btnInstallPlugin = document.getElementById('btn-install-plugin');
  elements.btnOpenPluginDir = document.getElementById('btn-open-plugin-dir');
  elements.btnReloadPlugins = document.getElementById('btn-reload-plugins');
  elements.pluginInstallProgress = document.getElementById('plugin-install-progress');
  elements.pluginList = document.getElementById('plugin-list');
  elements.pluginCount = document.getElementById('plugin-count');
  elements.pluginModal = document.getElementById('plugin-modal');
  elements.pluginModalTitle = document.getElementById('plugin-modal-title');
  elements.pluginModalBody = document.getElementById('plugin-modal-body');
  elements.pluginTrustRow = document.getElementById('plugin-trust-row');
  elements.pluginTrustCheck = document.getElementById('plugin-trust-check');
  elements.pluginModalCancel = document.getElementById('plugin-modal-cancel');
  elements.pluginModalConfirm = document.getElementById('plugin-modal-confirm');
}

/**
 * 加载所有配置
 */
async function loadAllConfig() {
  try {
    const [config, animations] = await Promise.all([
      window.settingsAPI.getAllConfig(),
      window.settingsAPI.getAvailableAnimations()
    ]);

    state.config = config;
    state.availableAnimations = animations;
    state.selectedIdle = config.animations.idlePool || [];
    state.selectedClick = config.animations.clickPool || [];
  } catch (e) {
    console.error('加载配置失败:', e);
  }
}

/**
 * 设置标签导航
 * 用事件委托实现：插件可以在初始化后动态追加标签页，无需重新绑定
 */
function setupTabNavigation() {
  const nav = document.getElementById('tab-nav');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn || !btn.dataset.tab) return;
    switchTab(btn.dataset.tab);
  });
}

/** 切换到指定标签页（tabName 与面板 id 的 tab- 前缀对应） */
function switchTab(tabName) {
  document.querySelectorAll('#tab-nav .tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('#tab-content .tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
}

/**
 * 设置事件监听器
 */
function setupEventListeners() {
  // 标题栏
  elements.btnClose.addEventListener('click', () => window.settingsAPI.closeWindow());

  // 显示/隐藏 API Key
  elements.toggleApiKey.addEventListener('click', () => {
    const input = elements.apiKey;
    if (input.type === 'password') {
      input.type = 'text';
      elements.toggleApiKey.textContent = '🙈';
    } else {
      input.type = 'password';
      elements.toggleApiKey.textContent = '👁️';
    }
  });

  // 保存 API 配置
  elements.btnSaveApi.addEventListener('click', () => saveApiConfig(true));

  // 测试 API 连接（查询余额）
  elements.btnTestApi.addEventListener('click', testApiConnection);

  // 宠物透明度
  elements.petOpacity.addEventListener('input', () => {
    elements.opacityValue.textContent = Math.round(elements.petOpacity.value * 100) + '%';
  });

  // 宠物大小
  elements.petScale.addEventListener('input', () => {
    elements.scaleValue.textContent = parseFloat(elements.petScale.value).toFixed(1) + 'x';
  });

  // 窗口裁剪：拖动即时预览（防抖写盘）
  elements.crop.addEventListener('input', () => {
    elements.cropValue.textContent = Math.round(parseFloat(elements.crop.value) * 100) + '%';
    queueCropPreview();
  });
  elements.cropX.addEventListener('input', () => {
    elements.cropXValue.textContent = Math.round(elements.cropX.value) + '%';
    queueCropPreview();
  });
  elements.cropY.addEventListener('input', () => {
    elements.cropYValue.textContent = Math.round(elements.cropY.value) + '%';
    queueCropPreview();
  });
  elements.btnResetCrop.addEventListener('click', () => {
    elements.crop.value = '0.55';
    elements.cropValue.textContent = '55%';
    elements.cropX.value = '0';
    elements.cropXValue.textContent = '0%';
    elements.cropY.value = '0';
    elements.cropYValue.textContent = '0%';
    queueCropPreview(0);
  });

  // 气泡大小 / 位置：即时生效（防抖写盘）
  elements.bubbleScale.addEventListener('input', () => {
    elements.bubbleScaleValue.textContent = parseFloat(elements.bubbleScale.value).toFixed(2) + 'x';
    queueBubblePreview();
  });
  elements.bubbleOffsetX.addEventListener('input', () => {
    elements.bubbleXValue.textContent = Math.round(elements.bubbleOffsetX.value) + 'px';
    queueBubblePreview();
  });
  elements.bubbleOffsetY.addEventListener('input', () => {
    elements.bubbleYValue.textContent = Math.round(elements.bubbleOffsetY.value) + 'px';
    queueBubblePreview();
  });
  elements.btnPreviewBubble.addEventListener('click', () => {
    window.settingsAPI.previewBubble();
  });
  elements.btnResetBubble.addEventListener('click', () => {
    elements.bubbleScale.value = '1';
    elements.bubbleScaleValue.textContent = '1.00x';
    elements.bubbleOffsetX.value = '0';
    elements.bubbleXValue.textContent = '0px';
    elements.bubbleOffsetY.value = '0';
    elements.bubbleYValue.textContent = '0px';
    queueBubblePreview(0);
  });

  // 保存宠物设置
  elements.btnSavePet.addEventListener('click', savePetConfig);

  // 双击自定义语句：开关联动提示 + 预览
  elements.balanceEnabled.addEventListener('change', updatePhraseHint);
  elements.btnPreviewPhrase.addEventListener('click', previewPhrase);

  // 关于页面 GitHub 链接
  const githubLink = document.getElementById('about-github-link');
  if (githubLink) {
    githubLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.settingsAPI.openExternal?.('https://github.com/isKage/desk-llm-pet');
    });
  }

  // 动画配置按钮
  elements.btnSaveAnimations.addEventListener('click', saveAnimationConfig);
  if (elements.btnSelectAllIdle) elements.btnSelectAllIdle.addEventListener('click', () => selectAllAnimations('idle'));
  if (elements.btnSelectAllClick) elements.btnSelectAllClick.addEventListener('click', () => selectAllAnimations('click'));
}

/**
 * 填充表单
 */
function populateForms() {
  const { llm = {}, balance = {}, pet = {} } = state.config || {};

  // API 配置
  elements.apiEndpoint.value = llm.apiEndpoint || '';
  elements.apiKey.value = llm.apiKey || '';
  elements.balanceEndpoint.value = llm.balanceEndpoint || '';

  // 余额气泡
  elements.balanceEnabled.checked = balance.enabled !== false;
  elements.balanceInterval.value = Number.isFinite(Number(balance.intervalMinutes))
    ? Number(balance.intervalMinutes) : 30;
  // 双击自定义语句（每行一句）
  elements.balancePhrases.value = Array.isArray(balance.customPhrases)
    ? balance.customPhrases.join('\n')
    : '';
  updatePhraseHint();

  // 宠物设置
  elements.petOpacity.value = pet.opacity || 1;
  elements.opacityValue.textContent = Math.round((pet.opacity || 1) * 100) + '%';
  elements.petScale.value = pet.scale || 1;
  elements.scaleValue.textContent = (pet.scale || 1).toFixed(1) + 'x';
  elements.petAutoStart.checked = pet.autoStart === true;

  // 窗口裁剪
  const crop = Number.isFinite(Number(pet.crop)) ? Number(pet.crop) : 0.55;
  elements.crop.value = String(crop);
  elements.cropValue.textContent = Math.round(crop * 100) + '%';
  const offsetX = Number.isFinite(Number(pet.cropOffsetX)) ? Number(pet.cropOffsetX) : 0;
  elements.cropX.value = String(offsetX);
  elements.cropXValue.textContent = Math.round(offsetX) + '%';
  const offsetY = Number.isFinite(Number(pet.cropOffsetY)) ? Number(pet.cropOffsetY) : 0;
  elements.cropY.value = String(offsetY);
  elements.cropYValue.textContent = Math.round(offsetY) + '%';

  // 气泡
  const bubble = state.config.bubble || {};
  const bubbleScale = Number.isFinite(Number(bubble.scale)) ? Number(bubble.scale) : 1;
  elements.bubbleScale.value = String(bubbleScale);
  elements.bubbleScaleValue.textContent = bubbleScale.toFixed(2) + 'x';
  const bubbleX = Number.isFinite(Number(bubble.offsetX)) ? Number(bubble.offsetX) : 0;
  elements.bubbleOffsetX.value = String(bubbleX);
  elements.bubbleXValue.textContent = Math.round(bubbleX) + 'px';
  const bubbleY = Number.isFinite(Number(bubble.offsetY)) ? Number(bubble.offsetY) : 0;
  elements.bubbleOffsetY.value = String(bubbleY);
  elements.bubbleYValue.textContent = Math.round(bubbleY) + 'px';

  // 动画列表
  renderAnimationList('idle');
  renderAnimationList('click');
}

/**
 * 渲染动画列表
 */
function renderAnimationList(type) {
  const listEl = type === 'idle' ? elements.idleAnimList : elements.clickAnimList;
  const animations = state.availableAnimations[type] || [];
  const selected = type === 'idle' ? state.selectedIdle : state.selectedClick;

  if (animations.length === 0) {
    listEl.innerHTML = `<div class="anim-empty">
      📁 暂无动画文件<br>
      <small>添加 .webm 动画后重新打开设置页即可看到</small>
    </div>`;
    return;
  }

  listEl.innerHTML = animations.map(anim => {
    const isChecked = selected.length === 0 || selected.includes(anim.name);
    return `
      <div class="anim-item">
        <input type="checkbox"
               value="${escapeAttr(anim.name)}"
               data-type="${escapeAttr(type)}"
               ${isChecked ? 'checked' : ''}>
        <span class="anim-item-name">🎬 ${escapeHtml(anim.name)}</span>
        <button class="anim-item-preview" data-path="${escapeAttr(anim.path)}">预览</button>
      </div>
    `;
  }).join('');

  // 绑定复选框事件
  listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => updateSelectedAnimations(type));
  });
}

/**
 * 更新选中的动画列表
 */
function updateSelectedAnimations(type) {
  const listEl = type === 'idle' ? elements.idleAnimList : elements.clickAnimList;
  const checkboxes = listEl.querySelectorAll('input[type="checkbox"]:checked');
  const selected = Array.from(checkboxes).map(cb => cb.value);

  if (type === 'idle') {
    state.selectedIdle = selected;
  } else {
    state.selectedClick = selected;
  }
}

/**
 * 全选/取消全选
 */
function selectAllAnimations(type) {
  const listEl = type === 'idle' ? elements.idleAnimList : elements.clickAnimList;
  const checkboxes = listEl.querySelectorAll('input[type="checkbox"]');
  const allChecked = Array.from(checkboxes).every(cb => cb.checked);

  checkboxes.forEach(cb => {
    cb.checked = !allChecked;
  });

  updateSelectedAnimations(type);
}

/**
 * 添加动画文件
 */
async function addAnimationFile(type) {
  try {
    const result = await window.settingsAPI.selectAnimationFile();
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;

    // 这里只是通知用户需要手动复制文件
    alert('请把选中的 .webm 文件添加到动画目录，然后重新打开设置页。');
  } catch (e) {
    console.error('选择文件失败:', e);
  }
}

/**
 * 保存 API 配置
 * @param {boolean} [notify] 是否弹出保存成功提示
 * @returns {Promise<boolean>} 是否保存成功
 */
async function saveApiConfig(notify = true) {
  const config = {
    apiEndpoint: elements.apiEndpoint.value.trim(),
    balanceEndpoint: elements.balanceEndpoint.value.trim(),
    apiKey: elements.apiKey.value.trim()
  };

  try {
    await window.settingsAPI.setLLMConfig(config);
    if (notify) showToast('✅ API 配置已保存');
    return true;
  } catch (e) {
    showToast('❌ 保存失败: ' + e.message);
    return false;
  }
}

/**
 * 测试 API 连接（通过查询余额验证 Key 是否可用）
 */
async function testApiConnection() {
  const resultEl = elements.apiTestResult;
  resultEl.classList.remove('hidden', 'success', 'error');
  resultEl.textContent = '⏳ 正在测试连接...';
  resultEl.className = 'test-result';

  // 先保存配置，保证用最新参数测试
  const saved = await saveApiConfig(false);
  if (!saved) {
    resultEl.textContent = '❌ 保存配置失败，请重试';
    resultEl.className = 'test-result error';
    return;
  }

  try {
    const response = await window.settingsAPI.getApiBalance();
    if (response && response.success) {
      // response.text 形如 "💰 API 余额\n¥110.00"，这里只取余额明细
      const detail = String(response.text || '').split('\n').slice(1).join(' / ').trim();
      resultEl.textContent = detail ? `✅ 连接成功！当前余额：${detail}` : '✅ 连接成功！API Key 可用';
      resultEl.className = 'test-result success';
    } else {
      resultEl.textContent = '❌ 连接失败: ' + ((response && response.error) || '未知错误');
      resultEl.className = 'test-result error';
    }
  } catch (e) {
    resultEl.textContent = '❌ 连接失败: ' + e.message;
    resultEl.className = 'test-result error';
  }
}

/**
 * 保存动画配置
 */
async function saveAnimationConfig() {
  const config = {
    idlePool: state.selectedIdle,
    clickPool: state.selectedClick
  };

  try {
    await window.settingsAPI.setAnimationConfig(config);
    showToast('✅ 动画配置已保存');
  } catch (e) {
    showToast('❌ 保存失败: ' + e.message);
  }
}

/**
 * 画面裁剪即时预览（防抖，避免拖动滑块时频繁写盘）
 */
let cropPreviewTimer = null;
function queueCropPreview(delay = 120) {
  if (cropPreviewTimer) clearTimeout(cropPreviewTimer);
  cropPreviewTimer = setTimeout(async () => {
    cropPreviewTimer = null;
    try {
      await window.settingsAPI.setPetConfig(readCropConfig());
    } catch (e) {
      console.error('裁剪预览失败:', e);
    }
  }, delay);
}

/** 读取窗口裁剪表单值 */
function readCropConfig() {
  const crop = Math.min(1, Math.max(0.25, parseFloat(elements.crop.value) || 0.55));
  const offsetX = Math.min(40, Math.max(-40, parseFloat(elements.cropX.value) || 0));
  const offsetY = Math.min(40, Math.max(-40, parseFloat(elements.cropY.value) || 0));
  return { crop, cropOffsetX: offsetX, cropOffsetY: offsetY };
}

/**
 * 气泡大小 / 位置即时预览（防抖）
 */
let bubblePreviewTimer = null;
function queueBubblePreview(delay = 120) {
  if (bubblePreviewTimer) clearTimeout(bubblePreviewTimer);
  bubblePreviewTimer = setTimeout(async () => {
    bubblePreviewTimer = null;
    try {
      await window.settingsAPI.setBubbleConfig(readBubbleConfig());
    } catch (e) {
      console.error('气泡预览失败:', e);
    }
  }, delay);
}

/** 读取气泡表单值 */
function readBubbleConfig() {
  const scale = Math.min(1.6, Math.max(0.6, parseFloat(elements.bubbleScale.value) || 1));
  const offsetX = Math.min(200, Math.max(-200, parseFloat(elements.bubbleOffsetX.value) || 0));
  const offsetY = Math.min(200, Math.max(-120, parseFloat(elements.bubbleOffsetY.value) || 0));
  return { scale, offsetX, offsetY };
}

/**
 * 读取「双击自定义语句」输入框（每行一句，忽略空行）
 * @returns {string[]}
 */
function readCustomPhrases() {
  return String(elements.balancePhrases.value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 根据余额气泡开关更新自定义语句的提示与样式 */
function updatePhraseHint() {
  const enabled = elements.balanceEnabled.checked;
  elements.balancePhrases.classList.toggle('inactive', enabled);
  elements.balancePhrasesHint.textContent = enabled
    ? '启用余额气泡时，这些语句暂不生效。'
    : '双击桌宠时随机展示其中一句；留空则使用内置语句。';
}

/** 预览一句自定义语句（随机挑一句，未保存也能看效果） */
function previewPhrase() {
  const phrases = readCustomPhrases();
  if (phrases.length === 0) {
    showToast('先写一句自定义语句再预览吧');
    return;
  }
  const text = phrases[Math.floor(Math.random() * phrases.length)];
  window.settingsAPI.previewPhrase(text).then((result) => {
    if (result && result.success === false) {
      showToast(result.reason === 'pet-hidden' ? '桌宠已隐藏，先显示桌宠再预览' : '预览失败，请稍后再试');
    }
  }).catch(() => { /* 预览失败不影响保存 */ });
}

/**
 * 保存宠物设置 + 余额气泡设置
 */
async function savePetConfig() {
  const config = {
    opacity: parseFloat(elements.petOpacity.value),
    scale: parseFloat(elements.petScale.value),
    autoStart: elements.petAutoStart.checked,
    ...readCropConfig()
  };

  const rawInterval = Number(elements.balanceInterval.value);
  const intervalMinutes = Number.isFinite(rawInterval) ? Math.min(1440, Math.max(0, Math.round(rawInterval))) : 30;
  const balanceConfig = {
    enabled: elements.balanceEnabled.checked,
    intervalMinutes,
    customPhrases: readCustomPhrases()
  };

  try {
    await window.settingsAPI.setPetConfig(config);
    await window.settingsAPI.setBalanceConfig(balanceConfig);
    await window.settingsAPI.setBubbleConfig(readBubbleConfig());
    elements.balanceInterval.value = intervalMinutes;
    updatePhraseHint();
    showToast('✅ 宠物设置已保存');
  } catch (e) {
    showToast('❌ 保存失败: ' + e.message);
  }
}

/**
 * 显示 Toast 提示
 */
function showToast(message) {
  // 移除已有的 toast
  const existing = document.querySelector('.settings-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'settings-toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    padding: 10px 20px;
    background: rgba(30, 30, 50, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: #e0e0e0;
    font-size: 13px;
    z-index: 1000;
    animation: toastIn 0.3s ease-out;
    backdrop-filter: blur(10px);
  `;

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

/** HTML 属性转义（转义引号，避免拼进属性时逃逸） */
function escapeAttr(text) {
  return escapeHtml(text)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================================
// 插件设置面板（contributes.settings）
// 插件通过在 plugin.json 里声明字段，由这里渲染成通用表单；
// 没有任何插件时，以下逻辑完全不执行，设置页与原来完全一致
// ============================================================================

const PLUGIN_FIELD_TYPES = ['text', 'password', 'number', 'boolean', 'textarea', 'select'];

/** 字段 id：只包含安全字符，可直接用于 getElementById */
function pluginFieldId(pluginId, key) {
  return `plugin-${pluginId}-${key}`;
}

// 清空动态插件设置标签/面板（卸载或重载后避免重复）
function clearPluginSections() {
  document.querySelectorAll('#tab-nav .tab-btn[data-plugin-tab="1"]').forEach((el) => el.remove());
  document.querySelectorAll('#tab-content .tab-panel[data-plugin-tab="1"]').forEach((el) => el.remove());
}

/** 拉取所有插件的设置面板并插入到标签栏（可重复调用，自动去重） */
async function renderPluginSections() {
  if (typeof window.settingsAPI.getPluginSettingsSections !== 'function') return;

  const activeTab = document.querySelector('#tab-nav .tab-btn.active')?.dataset.tab || '';
  clearPluginSections();

  let sections = [];
  try {
    sections = await window.settingsAPI.getPluginSettingsSections();
  } catch (e) {
    console.warn('插件设置加载失败（不影响本体）:', e.message);
    if (activeTab.startsWith('plugin-')) switchTab('plugins');
    return;
  }
  if (!Array.isArray(sections) || sections.length === 0) {
    if (activeTab.startsWith('plugin-')) switchTab('plugins');
    return;
  }

  const nav = document.getElementById('tab-nav');
  const content = document.getElementById('tab-content');
  if (!nav || !content) return;

  // 插件设置标签统一插到「关于」前面，保持使用类标签在前、插件配置在后
  const aboutBtn = nav.querySelector('.tab-btn[data-tab="about"]');
  const aboutPanel = document.getElementById('tab-about');

  for (const section of sections) {
    if (!section || !section.pluginId) continue;
    const tabName = `plugin-${section.pluginId}`;

    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = tabName;
    btn.dataset.pluginTab = '1';
    btn.textContent = `${section.icon || '🧩'} ${section.title || section.pluginId}`;
    nav.insertBefore(btn, aboutBtn || null);

    const panel = document.createElement('section');
    panel.className = 'tab-panel';
    panel.id = `tab-${tabName}`;
    panel.dataset.pluginTab = '1';
    panel.innerHTML = buildPluginPanelHtml(section);
    content.insertBefore(panel, aboutPanel || null);

    try {
      await bindPluginPanel(section, panel);
    } catch (e) {
      console.warn(`插件设置面板初始化失败 [${section.pluginId}]:`, e.message);
    }
  }

  // 之前停留的插件标签：还在就重新激活，被卸载了就回到插件管理页
  if (activeTab.startsWith('plugin-')) {
    if (document.getElementById(`tab-${activeTab}`)) switchTab(activeTab);
    else switchTab('plugins');
  }

  console.log(`🧩 已加载 ${sections.length} 个插件设置面板`);
}

/** 生成插件设置面板的 HTML */
function buildPluginPanelHtml(section) {
  const fields = (Array.isArray(section.fields) ? section.fields : [])
    .filter((field) => field && typeof field.key === 'string' && PLUGIN_FIELD_TYPES.includes(field.type))
    .map((field) => {
      const id = pluginFieldId(section.pluginId, field.key);
      const attrs = `id="${escapeAttr(id)}" data-field-key="${escapeAttr(field.key)}" data-field-type="${escapeAttr(field.type)}"`;
      const hint = field.hint ? `<span class="form-hint">${escapeHtml(field.hint)}</span>` : '';
      const placeholder = field.placeholder ? ` placeholder="${escapeAttr(field.placeholder)}"` : '';

      if (field.type === 'boolean') {
        return `<div class="form-group">
          <label class="switch-label">
            <span>${escapeHtml(field.label)}</span>
            <label class="switch">
              <input type="checkbox" ${attrs}>
              <span class="switch-slider"></span>
            </label>
          </label>
          ${hint}
        </div>`;
      }

      let control;
      switch (field.type) {
        case 'textarea':
          control = `<textarea ${attrs} rows="${Number.isFinite(Number(field.rows)) ? Number(field.rows) : 3}"${placeholder}></textarea>`;
          break;
        case 'select': {
          const options = (Array.isArray(field.options) ? field.options : [])
            .map((opt) => `<option value="${escapeAttr(opt.value)}">${escapeHtml(opt.label)}</option>`)
            .join('');
          control = `<select ${attrs}>${options}</select>`;
          break;
        }
        case 'number': {
          const min = Number.isFinite(Number(field.min)) ? ` min="${Number(field.min)}"` : '';
          const max = Number.isFinite(Number(field.max)) ? ` max="${Number(field.max)}"` : '';
          const step = Number.isFinite(Number(field.step)) ? ` step="${Number(field.step)}"` : '';
          control = `<input type="number" ${attrs}${min}${max}${step}${placeholder}>`;
          break;
        }
        case 'password':
          control = `<input type="password" ${attrs}${placeholder}>`;
          break;
        default:
          control = `<input type="text" ${attrs}${placeholder}>`;
      }

      return `<div class="form-group">
        <label for="${escapeAttr(id)}">${escapeHtml(field.label)}</label>
        ${control}
        ${hint}
      </div>`;
    })
    .join('');

  const actions = (Array.isArray(section.actions) ? section.actions : [])
    .map((action) => `<button class="btn ${action.style === 'primary' ? 'btn-primary' : 'btn-secondary'}" data-plugin-action="${escapeAttr(action.id)}">${escapeHtml(action.label)}</button>`)
    .join('');

  return `<div class="setting-group" data-plugin-id="${escapeAttr(section.pluginId)}">
    <h3>${escapeHtml(section.title || section.pluginId)}</h3>
    <p class="setting-desc">${escapeHtml(section.description || '')}</p>
    ${fields}
    <div class="form-actions">
      <button class="btn btn-primary" data-plugin-save="1">💾 保存</button>
      ${actions}
    </div>
    <div class="test-result hidden" data-plugin-result="1"></div>
  </div>`;
}

/** 填充已保存的值并绑定按钮 */
async function bindPluginPanel(section, panel) {
  let values = {};
  try {
    values = (await window.settingsAPI.getPluginSettings(section.pluginId)) || {};
  } catch (e) {
    console.warn(`读取插件设置失败 [${section.pluginId}]:`, e.message);
  }

  for (const field of section.fields || []) {
    const input = panel.querySelector(`[data-field-key="${field.key}"]`);
    if (!input) continue;
    if (field.type === 'boolean') {
      input.checked = values[field.key] === true;
    } else {
      const value = values[field.key];
      input.value = value === undefined || value === null ? '' : String(value);
    }
  }

  panel.querySelector('[data-plugin-save]')?.addEventListener('click', () => savePluginSettings(section, panel));
  panel.querySelectorAll('[data-plugin-action]').forEach((btn) => {
    btn.addEventListener('click', () => runPluginAction(section, panel, btn.dataset.pluginAction));
  });
}

/** 读取面板上的表单值 */
function collectPluginValues(section, panel) {
  const values = {};
  for (const field of section.fields || []) {
    const input = panel.querySelector(`[data-field-key="${field.key}"]`);
    if (!input) continue;
    if (field.type === 'boolean') {
      values[field.key] = input.checked;
    } else if (field.type === 'number') {
      const num = Number(input.value);
      if (Number.isFinite(num)) values[field.key] = num;
    } else {
      values[field.key] = input.value;
    }
  }
  return values;
}

async function savePluginSettings(section, panel) {
  try {
    const result = await window.settingsAPI.setPluginSettings(section.pluginId, collectPluginValues(section, panel));
    if (result && result.success) {
      showToast('✅ 插件设置已保存');
      showPluginResult(panel, true, '✅ 已保存');
    } else {
      showPluginResult(panel, false, `❌ 保存失败：${(result && result.error) || '未知错误'}`);
    }
  } catch (e) {
    showPluginResult(panel, false, `❌ 保存失败：${e.message}`);
  }
}

async function runPluginAction(section, panel, actionId) {
  showPluginResult(panel, true, '⏳ 执行中...');
  try {
    const result = await window.settingsAPI.runPluginSettingsAction(
      section.pluginId,
      actionId,
      collectPluginValues(section, panel)
    );
    const ok = !!(result && result.success);
    showPluginResult(panel, ok, (result && (result.message || result.error)) || (ok ? '✅ 完成' : '❌ 执行失败'));
  } catch (e) {
    showPluginResult(panel, false, `❌ 执行失败：${e.message}`);
  }
}

function showPluginResult(panel, ok, text) {
  const el = panel.querySelector('[data-plugin-result]');
  if (!el) return;
  el.className = `test-result ${ok ? 'success' : 'error'}`;
  el.textContent = text;
}


// ============================================================================
// 插件管理（安装 / 启用 / 卸载 / 重新扫描）
// ============================================================================

state.plugins = [];
state.pluginPaths = {};
state.pluginBusy = false;
state.pluginModalAction = null;
let pluginRefreshTimer = null;
let pluginRefreshSeq = 0;

/** 初始化插件管理页：绑定事件、加载列表、监听插件变化 */
async function initPluginManagement() {
  if (!elements.pluginList) return;
  bindPluginManagement();
  await refreshPluginUi();
  if (typeof window.settingsAPI.onPluginsChanged === 'function') {
    window.settingsAPI.onPluginsChanged(() => schedulePluginRefresh());
  }
}

/** 插件变化后防抖刷新，避免重载期间多次拉取 */
function schedulePluginRefresh() {
  if (pluginRefreshTimer) clearTimeout(pluginRefreshTimer);
  pluginRefreshTimer = setTimeout(() => {
    pluginRefreshTimer = null;
    refreshPluginUi().catch(() => { /* 页面关闭时忽略 */ });
  }, 200);
}

/** 刷新插件列表 + 插件设置标签（用序号丢弃过期的并发刷新） */
async function refreshPluginUi() {
  const seq = ++pluginRefreshSeq;
  await refreshPluginList(seq);
  if (seq !== pluginRefreshSeq) return;
  await renderPluginSections();
}

/** 拉取插件目录、路径并渲染列表 */
async function refreshPluginList(seq) {
  if (!elements.pluginList) return;
  try {
    const [plugins, paths] = await Promise.all([
      typeof window.settingsAPI.getPlugins === 'function' ? window.settingsAPI.getPlugins() : [],
      typeof window.settingsAPI.getPluginPaths === 'function' ? window.settingsAPI.getPluginPaths() : null
    ]);
    if (seq !== undefined && seq !== pluginRefreshSeq) return;
    state.plugins = Array.isArray(plugins) ? plugins : [];
    state.pluginPaths = paths || {};
    if (elements.pluginUserDir) {
      elements.pluginUserDir.textContent = `插件目录：${state.pluginPaths.userPluginsDir || '未知'}`;
    }
    renderPluginList();
  } catch (e) {
    console.warn('读取插件列表失败:', e.message);
    elements.pluginList.innerHTML = `<div class="plugin-empty">插件列表读取失败：${escapeHtml(e.message)}</div>`;
  }
}

/** 渲染插件卡片列表 */
function renderPluginList() {
  const list = elements.pluginList;
  if (!list) return;
  if (!state.plugins.length) {
    list.innerHTML = `<div class="plugin-empty">
      🧩 还没有插件<br>
      <small>下载 .dlmpet 后点「选择插件包」，或把文件放进插件目录再点「重新扫描」</small>
    </div>`;
    if (elements.pluginCount) elements.pluginCount.textContent = '0 个';
    return;
  }

  if (elements.pluginCount) elements.pluginCount.textContent = `${state.plugins.length} 个`;

  list.innerHTML = state.plugins.map((plugin) => {
    const origin = plugin.origin || 'package';
    const originText = origin === 'builtin' ? '内置' : origin === 'manual' ? '手动放入' : '已安装';
    const statusText = plugin.status === 'active' ? '已启用'
      : plugin.status === 'error' ? '加载失败' : '已禁用';
    const statusClass = plugin.status === 'active' ? 'active'
      : plugin.status === 'error' ? 'error' : 'disabled';
    const canUninstall = origin !== 'builtin';
    const canOpenFolder = origin !== 'builtin';
    const canSettings = plugin.hasSettings && plugin.status === 'active';
    const toggleDisabled = plugin.locked ? 'disabled' : '';
    const toggleTitle = plugin.locked ? '作者在 plugin.json 中禁用了该插件' : '';

    return `
      <div class="plugin-item" data-plugin-id="${escapeAttr(plugin.id)}">
        <div class="plugin-item-icon">🧩</div>
        <div class="plugin-item-main">
          <div class="plugin-item-head">
            <span class="plugin-item-name">${escapeHtml(plugin.name || plugin.id)}</span>
            ${plugin.version ? `<span class="plugin-version">v${escapeHtml(plugin.version)}</span>` : ''}
            <span class="plugin-badge ${escapeAttr(origin)}">${originText}</span>
            <span class="plugin-status ${escapeAttr(statusClass)}">${statusText}</span>
          </div>
          <div class="plugin-item-desc">${escapeHtml(plugin.description || '（没有填写描述）')}</div>
          <div class="plugin-item-meta">
            ${plugin.author ? `<span>作者: ${escapeHtml(plugin.author)}</span>` : ''}
            ${plugin.error ? `<span class="plugin-error" title="${escapeAttr(plugin.error)}">⚠ ${escapeHtml(plugin.error)}</span>` : ''}
          </div>
        </div>
        <div class="plugin-item-actions">
          <button class="plugin-action" data-plugin-action="toggle" ${toggleDisabled} title="${escapeAttr(toggleTitle)}">
            ${plugin.enabled ? '禁用' : '启用'}
          </button>
          <button class="plugin-action" data-plugin-action="settings" ${canSettings ? '' : 'disabled'} title="${canSettings ? '打开该插件的设置面板' : '该插件没有设置面板'}">设置</button>
          ${canOpenFolder ? '<button class="plugin-action" data-plugin-action="folder">目录</button>' : ''}
          ${canUninstall ? '<button class="plugin-action danger" data-plugin-action="uninstall">卸载</button>' : ''}
        </div>
      </div>`;
  }).join('');
}

/** 绑定插件管理页的所有事件（只绑定一次） */
function bindPluginManagement() {
  elements.btnInstallPlugin?.addEventListener('click', openPluginPicker);
  elements.btnOpenPluginDir?.addEventListener('click', openPluginsDirectory);
  elements.btnReloadPlugins?.addEventListener('click', reloadPluginsFromUi);

  if (elements.pluginDropzone) {
    elements.pluginDropzone.addEventListener('click', () => {
      if (!state.pluginBusy) openPluginPicker();
    });
    elements.pluginDropzone.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !state.pluginBusy) {
        e.preventDefault();
        openPluginPicker();
      }
    });
    elements.pluginDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      elements.pluginDropzone.classList.add('dragover');
    });
    elements.pluginDropzone.addEventListener('dragleave', () => {
      elements.pluginDropzone.classList.remove('dragover');
    });
    elements.pluginDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      elements.pluginDropzone.classList.remove('dragover');
      if (state.pluginBusy) return;
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length === 0) return;
      if (files.length > 1) {
        showToast('一次只能安装一个插件包');
        return;
      }
      const filePath = files[0].path;
      if (!filePath) {
        showToast('无法读取拖入文件路径，请用「选择插件包」按钮');
        return;
      }
      inspectAndPreview(filePath).catch((err) => showPluginProgress('error', `❌ 校验失败：${err.message}`));
    });
  }

  elements.pluginList?.addEventListener('click', onPluginListClick);
  elements.pluginModalCancel?.addEventListener('click', closePluginModal);
  elements.pluginModal?.querySelector('[data-modal-close]')?.addEventListener('click', closePluginModal);
  elements.pluginTrustCheck?.addEventListener('change', updatePluginModalConfirm);
  elements.pluginModalConfirm?.addEventListener('click', () => {
    const action = state.pluginModalAction;
    if (typeof action === 'function') action();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && elements.pluginModal && !elements.pluginModal.classList.contains('hidden')) {
      closePluginModal();
    }
  });

  // 防止文件拖到页面其他地方时浏览器直接打开文件
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

/** 插件卡片上的按钮点击 */
function onPluginListClick(e) {
  if (state.pluginBusy) return;
  const button = e.target.closest('button[data-plugin-action]');
  if (!button) return;
  const item = button.closest('[data-plugin-id]');
  if (!item) return;
  const plugin = state.plugins.find((p) => p.id === item.dataset.pluginId);
  if (!plugin) return;
  const action = button.dataset.pluginAction;

  if (action === 'toggle') togglePlugin(plugin);
  else if (action === 'settings') openPluginSettings(plugin);
  else if (action === 'folder') openPluginFolder(plugin);
  else if (action === 'uninstall') confirmUninstallPlugin(plugin);
}

/** 选择插件包 → 预览 */
async function openPluginPicker() {
  if (state.pluginBusy) return;
  if (typeof window.settingsAPI.pickPluginPackage !== 'function') {
    showToast('当前版本不支持插件安装');
    return;
  }
  try {
    const picked = await window.settingsAPI.pickPluginPackage();
    if (!picked || picked.canceled) return;
    if (picked.error) {
      showToast(`❌ ${picked.error}`);
      return;
    }
    if (picked.filePath) await inspectAndPreview(picked.filePath);
  } catch (e) {
    showPluginProgress('error', `❌ 选择文件失败：${e.message}`);
  }
}

/** 只读校验插件包并打开预览 */
async function inspectAndPreview(filePath) {
  showPluginProgress('info', '⏳ 正在校验插件包...');
  const info = await window.settingsAPI.inspectPluginPackage(filePath);
  if (!info || !info.ok) {
    showPluginProgress('error', `❌ 插件包校验失败：${(info && info.error) || '未知错误'}`);
    return;
  }
  clearPluginProgress();
  showInstallPreview(filePath, info);
}

/** 生成插件包信息行 */
function makeInfoRow(label, value) {
  const row = document.createElement('div');
  row.className = 'plugin-info-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'plugin-info-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'plugin-info-value';
  valueEl.textContent = value == null ? '' : String(value);
  row.append(labelEl, valueEl);
  return row;
}

/** 安装预览模态框 */
function showInstallPreview(filePath, info) {
  const manifest = info.manifest || {};
  const body = document.createElement('div');

  body.appendChild(makeInfoRow('名称', manifest.name || manifest.id || ''));
  body.appendChild(makeInfoRow('版本', manifest.version || ''));
  body.appendChild(makeInfoRow('作者', manifest.author || '（未填写）'));
  body.appendChild(makeInfoRow('说明', manifest.description || '（未填写）'));
  body.appendChild(makeInfoRow('文件', `${info.fileCount || 0} 个 / ${formatPluginBytes(info.totalBytes || 0)}`));

  const warnings = [];
  if (Array.isArray(info.warnings)) warnings.push(...info.warnings);
  if (info.installed) {
    warnings.push(`已安装 v${info.installed.version}，将覆盖旧版本，插件数据保留。`);
  }
  if (info.downgrade) {
    warnings.push('这是降级安装：新版本低于已安装版本');
  }
  if (info.conflict) {
    warnings.push('插件 id 与内置插件冲突，不能安装');
  }

  if (warnings.length) {
    const wrap = document.createElement('div');
    wrap.className = 'plugin-warnings';
    for (const text of warnings) {
      const p = document.createElement('div');
      p.className = 'plugin-warning-item';
      p.textContent = `⚠ ${text}`;
      wrap.appendChild(p);
    }
    body.appendChild(wrap);
  }

  openPluginModal({
    title: '安装插件',
    body,
    trust: !info.conflict,
    confirmLabel: '安装',
    confirmEnabled: !info.conflict,
    onConfirm: async () => {
      if (info.conflict) return;
      if (elements.pluginTrustCheck && !elements.pluginTrustCheck.checked) return;
      closePluginModal();
      setPluginBusy(true, '⏳ 正在安装插件...');
      try {
        const result = await window.settingsAPI.installPluginPackage(filePath, {
          overwrite: !!info.installed
        });
        if (result && result.success) {
          showPluginProgress('success', `✅ 已安装 ${result.plugin ? result.plugin.name : manifest.name || ''}`);
          showToast('✅ 插件已安装');
        } else {
          showPluginProgress('error', `❌ 安装失败：${(result && result.error) || '未知错误'}`);
        }
      } catch (e) {
        showPluginProgress('error', `❌ 安装失败：${e.message}`);
      } finally {
        setPluginBusy(false);
        await refreshPluginUi().catch(() => {});
      }
    }
  });
}

/** 打开统一模态框 */
function openPluginModal({ title, body, trust = false, confirmLabel = '确定', confirmEnabled = true, onConfirm }) {
  if (!elements.pluginModal) return;
  elements.pluginModalTitle.textContent = title || '';
  elements.pluginModalBody.innerHTML = '';
  if (body) elements.pluginModalBody.appendChild(body);
  elements.pluginTrustRow.classList.toggle('hidden', !trust);
  if (elements.pluginTrustCheck) elements.pluginTrustCheck.checked = false;
  elements.pluginModalConfirm.textContent = confirmLabel;
  elements.pluginModalConfirm.disabled = !confirmEnabled || (trust && !(elements.pluginTrustCheck && elements.pluginTrustCheck.checked));
  state.pluginModalAction = typeof onConfirm === 'function' ? onConfirm : null;
  elements.pluginModal.classList.remove('hidden');
  setTimeout(() => {
    (trust ? elements.pluginTrustCheck : elements.pluginModalConfirm)?.focus();
  }, 30);
}

/** 关闭模态框 */
function closePluginModal() {
  if (!elements.pluginModal) return;
  elements.pluginModal.classList.add('hidden');
  state.pluginModalAction = null;
}

/** 只有勾选「可信来源」后才允许安装 */
function updatePluginModalConfirm() {
  if (!elements.pluginModalConfirm) return;
  const trust = elements.pluginTrustRow && !elements.pluginTrustRow.classList.contains('hidden');
  elements.pluginModalConfirm.disabled = !!trust && !(elements.pluginTrustCheck && elements.pluginTrustCheck.checked);
}

/** 卸载确认 */
function confirmUninstallPlugin(plugin) {
  const body = document.createElement('div');
  const text = document.createElement('p');
  text.className = 'plugin-modal-text';
  text.textContent = `确定卸载「${plugin.name || plugin.id}」吗？插件窗口会被关闭。`;
  body.appendChild(text);

  const label = document.createElement('label');
  label.className = 'plugin-modal-check';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.dataset.pluginDeleteData = '1';
  const span = document.createElement('span');
  span.textContent = '同时删除插件数据（如对话历史，默认保留）';
  label.append(checkbox, span);
  body.appendChild(label);

  openPluginModal({
    title: '卸载插件',
    body,
    trust: false,
    confirmLabel: '卸载',
    onConfirm: async () => {
      const deleteData = !!(elements.pluginModalBody.querySelector('[data-plugin-delete-data]') || {}).checked;
      closePluginModal();
      setPluginBusy(true, '⏳ 正在卸载插件...');
      try {
        const result = await window.settingsAPI.uninstallPlugin(plugin.id, { deleteData });
        if (result && result.success) {
          showPluginProgress('success', `✅ 已卸载 ${plugin.name || plugin.id}`);
          showToast('✅ 插件已卸载');
        } else {
          showPluginProgress('error', `❌ 卸载失败：${(result && result.error) || '未知错误'}`);
        }
      } catch (e) {
        showPluginProgress('error', `❌ 卸载失败：${e.message}`);
      } finally {
        setPluginBusy(false);
        await refreshPluginUi().catch(() => {});
      }
    }
  });
}

/** 启用 / 禁用 */
async function togglePlugin(plugin) {
  if (state.pluginBusy || plugin.locked) return;
  const next = !plugin.enabled;
  setPluginBusy(true, next ? '⏳ 正在启用插件...' : '⏳ 正在禁用插件...');
  try {
    const result = await window.settingsAPI.setPluginEnabled(plugin.id, next);
    if (result && result.success) {
      showPluginProgress('success', next ? `✅ 已启用 ${plugin.name || plugin.id}` : `✅ 已禁用 ${plugin.name || plugin.id}`);
    } else {
      showPluginProgress('error', `❌ 操作失败：${(result && result.error) || '未知错误'}`);
    }
  } catch (e) {
    showPluginProgress('error', `❌ 操作失败：${e.message}`);
  } finally {
    setPluginBusy(false);
    await refreshPluginUi().catch(() => {});
  }
}

/** 跳到插件的设置面板 */
function openPluginSettings(plugin) {
  const tabName = `plugin-${plugin.id}`;
  const panel = document.getElementById(`tab-${tabName}`);
  if (panel) switchTab(tabName);
  else showToast('该插件没有可用的设置面板');
}

/** 打开某个插件的目录 */
async function openPluginFolder(plugin) {
  try {
    const result = await window.settingsAPI.openPluginDir(plugin.id);
    if (!result || !result.success) showToast(`❌ ${(result && result.error) || '无法打开目录'}`);
  } catch (e) {
    showToast(`❌ 无法打开目录：${e.message}`);
  }
}

/** 打开插件目录 */
async function openPluginsDirectory() {
  try {
    const result = await window.settingsAPI.openPluginsDir();
    if (!result || !result.success) showToast(`❌ ${(result && result.error) || '无法打开目录'}`);
  } catch (e) {
    showToast(`❌ 无法打开目录：${e.message}`);
  }
}

/** 重新扫描 + 热重载 */
async function reloadPluginsFromUi() {
  if (state.pluginBusy) return;
  setPluginBusy(true, '⏳ 正在重新扫描插件目录...');
  try {
    const result = await window.settingsAPI.reloadPlugins();
    if (result && result.success) {
      const scan = result.scan || {};
      const parts = [];
      if (scan.installed && scan.installed.length) parts.push(`安装 ${scan.installed.length} 个`);
      if (scan.failed && scan.failed.length) parts.push(`失败 ${scan.failed.length} 个`);
      showPluginProgress(
        scan.failed && scan.failed.length ? 'error' : 'success',
        `✅ 已重新扫描${parts.length ? `：${parts.join('，')}` : ''}`
      );
    } else {
      showPluginProgress('error', `❌ 重新扫描失败：${(result && result.error) || '未知错误'}`);
    }
  } catch (e) {
    showPluginProgress('error', `❌ 重新扫描失败：${e.message}`);
  } finally {
    setPluginBusy(false);
    await refreshPluginUi().catch(() => {});
  }
}

/** 安装/卸载期间禁用操作按钮 */
function setPluginBusy(busy, text = '') {
  state.pluginBusy = !!busy;
  for (const el of [elements.btnInstallPlugin, elements.btnOpenPluginDir, elements.btnReloadPlugins]) {
    if (el) el.disabled = !!busy;
  }
  if (elements.pluginDropzone) elements.pluginDropzone.classList.toggle('busy', !!busy);
  if (busy && text) showPluginProgress('info', text);
}

/** 显示安装/卸载进度 */
function showPluginProgress(kind, text) {
  if (!elements.pluginInstallProgress) return;
  elements.pluginInstallProgress.className = `test-result ${kind}`;
  elements.pluginInstallProgress.textContent = text;
}

/** 清空进度 */
function clearPluginProgress() {
  if (!elements.pluginInstallProgress) return;
  elements.pluginInstallProgress.className = 'test-result hidden';
  elements.pluginInstallProgress.textContent = '';
}

/** 插件包大小格式化 */
function formatPluginBytes(bytes) {
  const num = Number(bytes) || 0;
  if (num < 1024) return `${num}B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)}KB`;
  return `${(num / (1024 * 1024)).toFixed(1)}MB`;
}

// 添加 toast 动画样式
const style = document.createElement('style');
style.textContent = `
  @keyframes toastIn {
    from { opacity: 0; transform: translateX(-50%) translateY(10px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
`;
document.head.appendChild(style);

// ====== 应用启动 ======
document.addEventListener('DOMContentLoaded', init);