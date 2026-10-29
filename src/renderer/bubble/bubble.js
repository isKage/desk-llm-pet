/**
 * 气泡窗口渲染逻辑
 * 只负责显示内容、按设置缩放、回报尺寸，展示时长结束后通知主进程隐藏
 */

const elements = {
  root: document.getElementById('bubble-root'),
  card: document.getElementById('bubble-card'),
  title: document.getElementById('balance-title'),
  badge: document.getElementById('balance-badge'),
  value: document.getElementById('balance-value'),
  sub: document.getElementById('balance-sub'),
  text: document.getElementById('bubble-text')
};

let hideTimer = null;

/** 货币符号 */
function currencySymbol(currency) {
  if (currency === 'CNY') return '¥';
  if (currency === 'USD') return '$';
  return currency ? `${currency} ` : '';
}

/** 渲染普通文字气泡 */
function renderText(text) {
  elements.card.classList.add('hidden');
  elements.text.classList.remove('hidden');
  elements.text.textContent = text;
}

/** 渲染余额卡片 */
function renderCard(data) {
  const balances = (data && Array.isArray(data.balances)) ? data.balances : [];
  const available = !data || data.isAvailable !== false;
  const primary = balances[0] || { currency: 'CNY', totalBalance: '0.00' };

  elements.text.classList.add('hidden');
  elements.card.classList.remove('hidden');

  elements.value.innerHTML = '';
  const symbolEl = document.createElement('span');
  symbolEl.className = 'currency';
  symbolEl.textContent = currencySymbol(primary.currency);
  const amountEl = document.createElement('span');
  amountEl.className = 'amount';
  amountEl.textContent = primary.totalBalance;
  elements.value.appendChild(symbolEl);
  elements.value.appendChild(amountEl);

  elements.sub.innerHTML = '';
  const items = [];
  if (Number(primary.toppedUpBalance) > 0) items.push(`充值 ${currencySymbol(primary.currency)}${primary.toppedUpBalance}`);
  if (Number(primary.grantedBalance) > 0) items.push(`赠送 ${currencySymbol(primary.currency)}${primary.grantedBalance}`);
  for (const extra of balances.slice(1)) items.push(`${extra.currency} ${extra.totalBalance}`);
  for (const item of items) {
    const span = document.createElement('span');
    span.className = 'item';
    span.textContent = item;
    elements.sub.appendChild(span);
  }
  elements.sub.style.display = items.length ? '' : 'none';

  elements.title.textContent = available ? 'API 余额' : '余额不足';
  elements.badge.textContent = available ? 'DeepSeek' : '需充值';
  elements.card.classList.toggle('warn', !available);
}

/** 测量并回报内容尺寸（主进程据此调整窗口大小与位置） */
function reportSize() {
  const rect = elements.root.getBoundingClientRect();
  const style = getComputedStyle(document.body);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  // 尾巴与阴影已经在 body 的 padding 里预留
  window.bubbleAPI.reportSize({
    width: Math.ceil(rect.width + padX + 2),
    height: Math.ceil(rect.height + padY + 2)
  });
}

/** 收到主进程的气泡内容 */
window.bubbleAPI.onShow((payload) => {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

  const scale = Number(payload.scale) > 0 ? Number(payload.scale) : 1;
  document.documentElement.style.setProperty('--bubble-scale', String(scale));

  if (payload.kind === 'balance' && payload.data) {
    renderCard(payload.data);
  } else {
    renderText(payload.text || '');
  }

  elements.root.classList.remove('hidden');
  // 先测量（此时窗口还隐藏着），主进程拿到尺寸后定位再显示
  reportSize();
  if (payload.duration === 0) return;
  const duration = Number(payload.duration) || 2500;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    elements.root.classList.add('hidden');
    window.bubbleAPI.hide();
  }, duration);
});

// 窗口尺寸变化（例如用户改了气泡大小设置后重现）时重新测量
window.addEventListener('resize', () => {
  if (!elements.root.classList.contains('hidden')) reportSize();
});
