// Global cursor polling and requests must keep working while another app is maximized.
const { screen } = require('electron');
const { getPetWindow, isCursorNearPet } = require('./pet-window');
const { getMenuWindow } = require('./menu-window');
const { showBubble, hideBubble } = require('./bubble-window');
const { getBalanceConfig, getLLMConfig } = require('../shared/store');
const { fetchBalance } = require('../shared/deepseek-api');

let cached = null;
let lastFetchAt = null;
let inFlight = null;
let revision = 0;

function invalidateBalanceCache() {
  revision++;
  cached = null;
  lastFetchAt = null;
}

async function getBalance() {
  if (cached && lastFetchAt !== null && Date.now() - lastFetchAt < 30000) return cached;
  if (inFlight) return inFlight;
  const currentRevision = revision;
  inFlight = (async () => {
    let result;
    try { result = { kind: 'balance', data: await fetchBalance(getLLMConfig()), duration: 0 }; }
    catch (error) { result = { kind: 'text', text: `⚠️ 余额查询失败：${error.message}`, duration: 0 }; }
    if (revision === currentRevision) {
      cached = { result, revision: currentRevision };
      lastFetchAt = Date.now();
    }
    return { result, revision: currentRevision };
  })();
  try { return await inFlight; }
  finally { inFlight = null; }
}

function startBalanceHover() {
  let nearSince = null;
  let active = false;
  let entry = 0;
  let observedRevision = revision;
  const timer = setInterval(() => {
    const pet = getPetWindow();
    const menu = getMenuWindow();
    const config = getBalanceConfig();
    const near = !!(config.enabled && config.hoverEnabled && pet && !pet.isDestroyed() && pet.isVisible() &&
      !(menu && menu.isVisible()) && isCursorNearPet(screen.getCursorScreenPoint(), pet.getBounds()));
    if (!near) nearSince = null;
    else if (nearSince === null) nearSince = Date.now();
    const next = near && Date.now() - nearSince >= 250;
    if (next === active && observedRevision === revision) return;
    observedRevision = revision;
    const wasActive = active;
    active = next;
    const token = ++entry;
    if (!active) {
      if (wasActive) hideBubble();
      return;
    }
    pet.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'floating');
    pet.moveTop();
    if (!cached) showBubble({ kind: 'text', text: '💰 查询余额中...', duration: 0 });
    getBalance().then(payload => {
      if (!active || token !== entry) return;
      if (payload.revision !== revision) { observedRevision = -1; return; }
      showBubble(payload.result);
    }).catch(() => { /* A closing window must not cause an unhandled rejection. */ });
  }, 100);
  timer.unref();
  return () => { active = false; entry++; clearInterval(timer); };
}

module.exports = { startBalanceHover, invalidateBalanceCache };
