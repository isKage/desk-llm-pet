/**
 * AI 对话窗口逻辑（插件自带渲染进程）
 * 会话管理、流式回复、复制、重命名/删除
 *
 * 数据落库完全由插件主进程负责：本地只做渲染与事件响应，
 * 因此流式/非流式、取消生成三种情况的表现保持一致。
 */

const SEND_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
const STOP_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

const state = {
  conversations: [],
  activeConvId: null,
  messages: [],
  config: null,
  isStreaming: false,
  requestId: null,
  streamingText: '',
  renameTargetId: null
};

const elements = {};

// ====== 初始化 ======
async function init() {
  cacheElements();
  const isMac = navigator.userAgent.includes('Mac');
  document.body.className = isMac ? 'platform-mac' : 'platform-win';

  setupEventListeners();
  setupStreamListeners();

  await loadConfig();
  await loadConversations();

  renderConfigInfo();
  renderConvList();
  renderMessages();
  console.log('💬 AI 对话插件窗口已就绪');
}

function cacheElements() {
  elements.messagesContainer = document.getElementById('messages-container');
  elements.messageInput = document.getElementById('message-input');
  elements.btnSend = document.getElementById('btn-send');
  elements.btnNewConv = document.getElementById('btn-new-conv');
  elements.btnMinimize = document.getElementById('btn-minimize');
  elements.btnClose = document.getElementById('btn-close');
  elements.convList = document.getElementById('conv-list');
  elements.currentModel = document.getElementById('current-model');
  elements.inputTip = document.getElementById('input-tip');
  elements.keyWarning = document.getElementById('key-warning');
  elements.btnOpenSettings = document.getElementById('btn-open-settings');
  elements.renameModal = document.getElementById('rename-modal');
  elements.renameInput = document.getElementById('rename-input');
  elements.btnRenameCancel = document.getElementById('btn-rename-cancel');
  elements.btnRenameConfirm = document.getElementById('btn-rename-confirm');
}

async function loadConfig() {
  try {
    state.config = await window.chatAPI.getConfig();
  } catch (e) {
    console.error('加载配置失败:', e);
    state.config = null;
  }
}

async function loadConversations() {
  try {
    state.conversations = (await window.chatAPI.listConversations()) || [];
    const active = await window.chatAPI.getActiveConversation();
    if (active) {
      state.activeConvId = active.id;
      state.messages = active.messages || [];
    } else if (state.conversations.length > 0) {
      await switchConversation(state.conversations[0].id);
    }
  } catch (e) {
    console.error('加载对话失败:', e);
  }
}

// ====== 事件监听 ======
function setupEventListeners() {
  elements.btnMinimize?.addEventListener('click', () => window.chatAPI.minimizeWindow());
  elements.btnClose?.addEventListener('click', () => window.chatAPI.closeWindow());
  elements.btnNewConv?.addEventListener('click', newConversation);
  elements.btnSend.addEventListener('click', sendMessage);
  elements.btnOpenSettings?.addEventListener('click', async () => {
    const result = await window.chatAPI.openHostSettings();
    if (!result || !result.success) alert('请右键点击桌宠 → 设置 → AI 对话');
  });

  elements.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  elements.messageInput.addEventListener('input', autoResizeInput);

  elements.btnRenameCancel.addEventListener('click', closeRenameModal);
  elements.btnRenameConfirm.addEventListener('click', confirmRename);
  elements.renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmRename();
    if (e.key === 'Escape') closeRenameModal();
  });

  // 事件委托：快速提问 / 复制 / 会话项操作
  document.addEventListener('click', (e) => {
    const quickBtn = e.target.closest('.quick-btn');
    if (quickBtn) {
      elements.messageInput.value = quickBtn.dataset.prompt || '';
      sendMessage();
      return;
    }
    const copyBtn = e.target.closest('.message-action-btn');
    if (copyBtn) { copyMessageContent(copyBtn); return; }

    const renameBtn = e.target.closest('.conv-action-btn.rename');
    if (renameBtn) { openRenameModal(renameBtn.closest('.conv-item').dataset.id); return; }

    const delBtn = e.target.closest('.conv-action-btn.delete');
    if (delBtn) { deleteConversation(delBtn.closest('.conv-item').dataset.id); return; }

    const convItem = e.target.closest('.conv-item');
    if (convItem) { switchConversation(convItem.dataset.id); }
  });
}

function setupStreamListeners() {
  window.chatAPI.onStreamChunk((data) => {
    if (!data || data.requestId !== state.requestId) return;
    state.streamingText += data.chunk || '';
    updateStreamingMessage();
  });

  window.chatAPI.onStreamDone((data) => {
    if (!data || data.requestId !== state.requestId) return;
    finishStreaming(data);
  });

  window.chatAPI.onStreamError((data) => {
    if (!data || data.requestId !== state.requestId) return;
    handleStreamError(data.error);
  });

  window.chatAPI.onConversationUpdated((data) => {
    if (data && data.conversation) {
      upsertConversation(data.conversation);
      renderConvList();
    }
  });

  window.chatAPI.onConfigChanged((config) => {
    state.config = config;
    renderConfigInfo();
  });
}

// ====== 渲染：配置信息 ======
function renderConfigInfo() {
  const config = state.config || {};
  if (elements.currentModel) elements.currentModel.textContent = config.model || '未配置';
  const missing = !config.hasApiKey;
  elements.keyWarning?.classList.toggle('hidden', !missing);
}

// ====== 会话管理 ======
async function newConversation() {
  if (state.isStreaming) return;
  try {
    const { conversation, list } = await window.chatAPI.createConversation('新对话');
    state.conversations = list || [];
    state.activeConvId = conversation ? conversation.id : null;
    state.messages = [];
    renderConvList();
    renderMessages();
    elements.messageInput.focus();
  } catch (e) {
    console.error('创建对话失败:', e);
  }
}

async function switchConversation(id) {
  if (!id || state.isStreaming || id === state.activeConvId) return;
  try {
    const conversation = await window.chatAPI.setActiveConversation(id);
    state.activeConvId = conversation ? conversation.id : id;
    state.messages = (conversation && conversation.messages) || [];
    renderConvList();
    renderMessages();
  } catch (e) {
    console.error('切换对话失败:', e);
  }
}

async function deleteConversation(id) {
  if (state.isStreaming) return;
  try {
    const { list, conversation } = await window.chatAPI.deleteConversation(id);
    state.conversations = list || [];
    if (state.activeConvId === id) {
      state.activeConvId = conversation ? conversation.id : null;
      state.messages = (conversation && conversation.messages) || [];
    }
    renderConvList();
    renderMessages();
  } catch (e) {
    console.error('删除对话失败:', e);
  }
}

function openRenameModal(id) {
  state.renameTargetId = id;
  const conv = state.conversations.find((c) => c.id === id);
  if (conv) elements.renameInput.value = conv.title;
  elements.renameModal.classList.remove('hidden');
  elements.renameInput.focus();
  elements.renameInput.select();
}

function closeRenameModal() {
  elements.renameModal.classList.add('hidden');
  state.renameTargetId = null;
}

async function confirmRename() {
  const title = elements.renameInput.value.trim();
  const id = state.renameTargetId;
  if (!title || !id) { closeRenameModal(); return; }
  try {
    const { list } = await window.chatAPI.renameConversation(id, title);
    state.conversations = list || state.conversations;
  } catch (e) {
    console.error('重命名失败:', e);
  }
  closeRenameModal();
  renderConvList();
}

/** 用主进程返回的最新摘要更新本地列表 */
function upsertConversation(summary) {
  if (!summary || !summary.id) return;
  const idx = state.conversations.findIndex((c) => c.id === summary.id);
  if (idx >= 0) state.conversations[idx] = { ...state.conversations[idx], ...summary };
  else state.conversations.unshift(summary);
  state.conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function renderConvList() {
  const list = elements.convList;
  if (state.conversations.length === 0) {
    list.innerHTML = '<div class="conv-empty">暂无对话<br><small>点击上方按钮创建</small></div>';
    return;
  }
  list.innerHTML = state.conversations.map((c) => `
    <div class="conv-item ${c.id === state.activeConvId ? 'active' : ''}" data-id="${escapeHtml(c.id)}">
      <span class="conv-item-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</span>
      <div class="conv-item-actions">
        <button class="conv-action-btn rename" title="重命名">✏️</button>
        <button class="conv-action-btn delete" title="删除">🗑️</button>
      </div>
    </div>
  `).join('');
}

// ====== 消息发送 ======
async function sendMessage() {
  // 回复中：发送按钮即「停止生成」
  if (state.isStreaming) {
    cancelStream();
    return;
  }

  const content = elements.messageInput.value.trim();
  if (!content) return;

  if (!state.activeConvId) await newConversation();
  if (!state.activeConvId) return;

  elements.messageInput.value = '';
  autoResizeInput();

  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  state.requestId = requestId;
  state.streamingText = '';

  // 首次发送时移除欢迎页，避免它把消息挤到屏幕外
  elements.messagesContainer.querySelector('.welcome-message')?.remove();

  // 乐观渲染用户消息（主进程负责落库并回推标题）
  appendMessage({ role: 'user', content, timestamp: Date.now() });
  appendAssistantPlaceholder();
  scrollToBottom();
  setSending(true);

  window.chatAPI.sendMessage({ conversationId: state.activeConvId, content, requestId });
}

function cancelStream() {
  if (!state.requestId) return;
  window.chatAPI.cancelStream(state.requestId);
}

function appendAssistantPlaceholder() {
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = 'streaming-message';
  div.innerHTML = '<div class="message-avatar">🤖</div><div class="message-content">' +
    '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>';
  elements.messagesContainer.appendChild(div);
}

function updateStreamingMessage() {
  const node = document.getElementById('streaming-message');
  if (!node) return;
  const content = node.querySelector('.message-content');
  if (content) content.innerHTML = renderMarkdown(state.streamingText);
  scrollToBottom();
}

function finishStreaming(data) {
  const node = document.getElementById('streaming-message');
  const text = state.streamingText || (data && data.message ? data.message.content : '');
  node?.remove();

  if (text) {
    appendMessage({ role: 'assistant', content: text, timestamp: Date.now() });
  } else if (data && data.canceled) {
    appendNotice('已停止生成');
  }

  if (data && data.conversation) {
    upsertConversation(data.conversation);
    renderConvList();
  }

  state.streamingText = '';
  state.requestId = null;
  setSending(false);
  scrollToBottom();
}

function handleStreamError(error) {
  document.getElementById('streaming-message')?.remove();
  const text = String(error || '未知错误');
  const isNetworkError = /网络请求失败|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|请求超时|流式响应中断/i.test(text);
  const hint = isNetworkError ? '请检查网络连接，或稍后重试' : '请检查「设置 → AI 对话」中的配置';
  const div = document.createElement('div');
  div.className = 'message assistant error';
  div.innerHTML = '<div class="message-avatar">⚠️</div><div class="message-content">' +
    `${escapeHtml(text)}<br><small>${hint}</small></div>`;
  elements.messagesContainer.appendChild(div);
  state.streamingText = '';
  state.requestId = null;
  setSending(false);
  scrollToBottom();
}

function appendNotice(text) {
  const div = document.createElement('div');
  div.className = 'message notice';
  div.innerHTML = `<span class="notice-text">${escapeHtml(text)}</span>`;
  elements.messagesContainer.appendChild(div);
}

// ====== 消息渲染 ======
function appendMessage(msg) {
  elements.messagesContainer.appendChild(buildMessageNode(msg));
}

function buildMessageNode(msg) {
  const div = document.createElement('div');
  div.className = `message ${msg.role}`;
  div.dataset.content = msg.content;
  const avatar = msg.role === 'user' ? '👤' : '🤖';
  const time = new Date(msg.timestamp || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  div.innerHTML =
    `<div class="message-avatar">${avatar}</div>` +
    '<div style="flex:1;min-width:0">' +
      `<div class="message-content">${renderMarkdown(msg.content)}</div>` +
      '<div class="message-actions">' +
        '<button class="message-action-btn" title="复制">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>' +
        `<span>复制</span></button><span class="message-time">${time}</span>` +
      '</div>' +
    '</div>';
  return div;
}

function renderMessages() {
  elements.messagesContainer.innerHTML = '';
  if (!state.messages.length) {
    elements.messagesContainer.innerHTML = `
      <div class="welcome-message">
        <div class="welcome-icon">🐾</div>
        <h2>欢迎使用 DeskLLMPet AI 对话</h2>
        <p>点击左侧「新对话」开始聊天，历史对话会自动保存在本地</p>
        <div class="quick-actions">
          <button class="quick-btn" data-prompt="用一句话介绍你自己">👋 自我介绍</button>
          <button class="quick-btn" data-prompt="写一首关于编程的短诗">✍️ 写首诗</button>
          <button class="quick-btn" data-prompt="解释什么是机器学习">🧠 机器学习</button>
          <button class="quick-btn" data-prompt="推荐一本好书">📚 推荐好书</button>
        </div>
      </div>`;
    return;
  }
  state.messages.forEach((msg) => elements.messagesContainer.appendChild(buildMessageNode(msg)));
  scrollToBottom();
}

function copyMessageContent(btn) {
  const content = btn.closest('.message')?.dataset.content || '';
  const done = () => {
    const label = btn.querySelector('span');
    btn.classList.add('copied');
    if (label) label.textContent = '已复制';
    setTimeout(() => {
      btn.classList.remove('copied');
      if (label) label.textContent = '复制';
    }, 2000);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(content).then(done).catch(() => fallbackCopy(content, done));
  } else {
    fallbackCopy(content, done);
  }
}

function fallbackCopy(content, done) {
  const ta = document.createElement('textarea');
  ta.value = content;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
  document.body.removeChild(ta);
  if (done) done();
}

// ====== 工具函数 ======
function setSending(sending) {
  state.isStreaming = sending;
  elements.btnSend.classList.toggle('stop', sending);
  elements.btnSend.title = sending ? '停止生成' : '发送消息';
  elements.btnSend.innerHTML = sending ? STOP_ICON : SEND_ICON;
  if (elements.inputTip) {
    elements.inputTip.textContent = sending ? '正在回复中 · Enter 停止生成' : 'Enter 发送 · Shift+Enter 换行';
  }
}

function autoResizeInput() {
  const input = elements.messageInput;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

function scrollToBottom() {
  setTimeout(() => {
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
  }, 50);
}

/** 轻量 Markdown 渲染（先转义，再处理代码块） */
function renderMarkdown(text) {
  if (!text) return '';
  const codeBlocks = [];
  let html = escapeHtml(text);

  html = html.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (match, code) => {
    const index = codeBlocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`) - 1;
    return `\u0000${index}\u0000`;
  });
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/\u0000(\d+)\u0000/g, (match, index) => codeBlocks[Number(index)] || '');
  return html;
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', init);
