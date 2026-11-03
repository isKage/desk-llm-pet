/**
 * DeepSeek 开放平台 API 客户端（仅余额查询）
 *
 * 官方余额接口：GET https://api.deepseek.com/user/balance
 * 响应示例：
 * {
 *   "is_available": true,
 *   "balance_infos": [
 *     { "currency": "CNY", "total_balance": "110.00",
 *       "granted_balance": "10.00", "topped_up_balance": "100.00" }
 *   ]
 * }
 */

const https = require('https');
const http = require('http');

/** DeepSeek 官方余额查询地址（默认值） */
const DEFAULT_BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance';

/**
 * 补全协议前缀
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return 'https://' + trimmed;
  return trimmed;
}

/**
 * 解析余额查询地址
 * 优先级：配置的 balanceEndpoint > 由 apiEndpoint 推导（域名 + /user/balance）> 官方默认地址
 * @param {Object} config - LLM 配置 { apiEndpoint, balanceEndpoint }
 * @returns {string}
 */
function resolveBalanceEndpoint(config) {
  const override = normalizeUrl(config && config.balanceEndpoint);
  if (override) return override;

  const apiEndpoint = normalizeUrl(config && config.apiEndpoint);
  if (apiEndpoint) {
    try {
      const parsed = new URL(apiEndpoint);
      return `${parsed.origin}/user/balance`;
    } catch (e) {
      // 地址无效时回退到官方默认地址
    }
  }
  return DEFAULT_BALANCE_ENDPOINT;
}

/**
 * 查询 API 余额
 * @param {Object} config - LLM 配置 { apiKey, apiEndpoint, balanceEndpoint }
 * @returns {Promise<Object>} { isAvailable, balances: [{ currency, totalBalance, grantedBalance, toppedUpBalance }] }
 */
function fetchBalance(config) {
  return new Promise((resolve, reject) => {
    const apiKey = String((config && config.apiKey) || '').trim();
    if (!apiKey) {
      reject(new Error('尚未配置 API Key，请在设置中填写'));
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(resolveBalanceEndpoint(config));
    } catch (e) {
      reject(new Error('余额查询地址格式无效'));
      return;
    }

    const isHttps = targetUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'DeskLLMPet',
        'Accept': 'application/json'
      },
      timeout: 15000
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          let message = `余额查询失败 (HTTP ${res.statusCode})`;
          try {
            const parsed = JSON.parse(raw);
            message = parsed.error?.message || parsed.message || message;
          } catch (e) { /* 忽略解析错误 */ }
          if (res.statusCode === 401) message = 'API Key 无效或已过期 (401)';
          if (res.statusCode === 404) message = '余额接口不存在 (404)，请检查余额查询地址';
          reject(new Error(message));
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          reject(new Error('余额响应解析失败'));
          return;
        }

        const infos = Array.isArray(parsed.balance_infos) ? parsed.balance_infos : [];
        if (infos.length === 0) {
          reject(new Error('余额信息为空'));
          return;
        }

        resolve({
          isAvailable: parsed.is_available !== false,
          balances: infos.map((info) => ({
            currency: info.currency || '',
            totalBalance: String(info.total_balance ?? '0'),
            grantedBalance: String(info.granted_balance ?? '0'),
            toppedUpBalance: String(info.topped_up_balance ?? '0')
          }))
        });
      });
      res.on('error', (e) => reject(new Error(`余额响应错误: ${e.message}`)));
    });

    req.on('error', (e) => reject(new Error(`网络请求失败: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('余额查询超时（15 秒）'));
    });

    req.end();
  });
}

/**
 * 把余额结果格式化为气泡文案
 * @param {Object} result - fetchBalance 的返回值
 * @returns {string}
 */
function formatBalanceText(result) {
  if (!result || !Array.isArray(result.balances) || result.balances.length === 0) {
    return '💰 暂无余额信息';
  }

  const lines = result.balances.map((b) => {
    const symbol = b.currency === 'CNY' ? '¥' : (b.currency === 'USD' ? '$' : `${b.currency} `);
    const granted = Number(b.grantedBalance) > 0 ? `（含赠送 ${symbol}${b.grantedBalance}）` : '';
    return `${symbol}${b.totalBalance}${granted}`;
  });

  const head = result.isAvailable ? '💰 API 余额' : '⚠️ 余额不足';
  return `${head}\n${lines.join('\n')}`;
}

module.exports = {
  DEFAULT_BALANCE_ENDPOINT,
  resolveBalanceEndpoint,
  fetchBalance,
  formatBalanceText
};
