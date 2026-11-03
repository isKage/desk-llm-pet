/**
 * LLM 对话客户端（OpenAI 兼容 /chat/completions）
 * 仅依赖 Node 内置模块，不依赖 Electron，可单独测试
 *
 * 支持：
 *   - 流式（SSE）与非流式两种模式
 *   - 中途取消（cancel）
 *   - 自定义 endpoint / model / temperature / max_tokens
 */

const https = require('https');
const http = require('http');

/** 默认对话接口地址（DeepSeek 与 OpenAI 兼容） */
const DEFAULT_CHAT_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 120000;

/** 构造「已取消」错误 */
function canceledError() {
  const err = new Error('已取消生成');
  err.canceled = true;
  return err;
}

/** 补全协议前缀 */
function normalizeBaseUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/**
 * 把用户填写的地址规范成 chat/completions 端点
 *   ''                                   -> https://api.deepseek.com/v1/chat/completions
 *   https://api.deepseek.com             -> https://api.deepseek.com/v1/chat/completions
 *   https://api.deepseek.com/v1          -> https://api.deepseek.com/v1/chat/completions
 *   https://api.openai.com/v1/chat/completions -> 原样使用
 *   http://localhost:11434/v1            -> http://localhost:11434/v1/chat/completions
 * @param {string} endpoint
 * @returns {string}
 */
function resolveChatEndpoint(endpoint) {
  const raw = normalizeBaseUrl(endpoint);
  if (!raw) return DEFAULT_CHAT_ENDPOINT;

  const parsed = new URL(raw);
  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(pathname)) {
    // 已经是完整端点
  } else if (!pathname) {
    pathname = '/v1/chat/completions';
  } else {
    pathname = `${pathname}/chat/completions`;
  }
  return `${parsed.origin}${pathname}`;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * 解析一行 SSE 数据
 * @returns {null | { done: boolean, content: string }}
 */
function parseSseLine(line) {
  const trimmed = String(line == null ? '' : line).trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return { done: true, content: '' };
  try {
    const parsed = JSON.parse(data);
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const content = (choice && choice.delta && choice.delta.content) || '';
    return { done: false, content: String(content) };
  } catch (e) {
    return null;
  }
}

/** SSE 增量解析器（按行切分，跨 chunk 保留残行） */
function createSseParser(onDelta) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const event = parseSseLine(line);
        if (!event) continue;
        if (!event.done && event.content) onDelta(event.content);
      }
    },
    flush() {
      if (!buffer) return;
      const event = parseSseLine(buffer);
      buffer = '';
      if (event && !event.done && event.content) onDelta(event.content);
    }
  };
}

/**
 * 发起一次对话请求
 * @param {Object} config { apiKey, apiEndpoint, model, maxTokens, temperature }
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} [options] { stream?: boolean, onChunk?: (text: string) => void }
 * @returns {{ promise: Promise<string>, cancel: () => void }}
 */
function requestChat(config, messages, options = {}) {
  const stream = options.stream !== false;
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null;

  let canceled = false;
  let req = null;
  let settled = false;

  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    fn(value);
  };

  const promise = new Promise((resolve, reject) => {
    const apiKey = String((config && config.apiKey) || '').trim();
    if (!apiKey) {
      reject(new Error('尚未配置 API Key，请在「设置 → AI 对话」中填写'));
      return;
    }

    let target;
    try {
      target = new URL(resolveChatEndpoint(config && config.apiEndpoint));
    } catch (e) {
      reject(new Error(`API 地址格式无效: ${(config && config.apiEndpoint) || ''}`));
      return;
    }

    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const model = String((config && config.model) || 'deepseek-chat').trim() || 'deepseek-chat';
    const maxTokens = Math.round(clampNumber(config && config.maxTokens, 1, 200000, 2048));
    const temperature = clampNumber(config && config.temperature, 0, 2, 0.7);

    const body = JSON.stringify({
      model,
      messages: Array.isArray(messages) ? messages : [],
      max_tokens: maxTokens,
      temperature,
      stream: !!stream
    });

    req = transport.request({
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // DeepSeek 的边缘节点会重置「没有 User-Agent」的 POST 请求（read ECONNRESET），
        // 这里显式带上客户端标识，避免被误判为异常流量。
        'User-Agent': 'DeskLLMPet',
        Accept: stream ? 'text/event-stream' : 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: REQUEST_TIMEOUT
    }, (res) => {
      if (res.statusCode !== 200) {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (canceled) { finish(reject, canceledError()); return; }
          let message = `请求失败 (HTTP ${res.statusCode})`;
          try {
            const parsed = JSON.parse(raw);
            message = (parsed.error && parsed.error.message) || parsed.message || message;
          } catch (e) { /* 保留默认文案 */ }
          if (res.statusCode === 401) message = 'API Key 无效或已过期 (401)';
          if (res.statusCode === 402) message = '账户余额不足 (402)';
          if (res.statusCode === 404) message = '接口不存在 (404)，请检查 API 地址';
          if (res.statusCode === 429) message = '请求过于频繁或额度不足 (429)';
          finish(reject, new Error(message));
        });
        res.on('error', (e) => finish(reject, new Error(`响应错误: ${e.message}`)));
        return;
      }

      if (stream) {
        let full = '';
        const parser = createSseParser((text) => {
          full += text;
          if (onChunk) {
            try { onChunk(text); } catch (e) { /* 忽略渲染回调异常 */ }
          }
        });
        res.setEncoding('utf8');
        res.on('data', (chunk) => parser.push(chunk));
        res.on('end', () => {
          if (canceled) { finish(reject, canceledError()); return; }
          parser.flush();
          finish(resolve, full);
        });
        res.on('error', (e) => {
          if (canceled) { finish(reject, canceledError()); return; }
          finish(reject, new Error(`流式响应中断: ${e.message}`));
        });
        return;
      }

      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (canceled) { finish(reject, canceledError()); return; }
        try {
          const parsed = JSON.parse(raw);
          const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
          const content = (choice && choice.message && choice.message.content) || '';
          finish(resolve, String(content));
        } catch (e) {
          finish(reject, new Error('解析响应失败'));
        }
      });
      res.on('error', (e) => finish(reject, new Error(`响应错误: ${e.message}`)));
    });

    req.on('error', (e) => {
      if (canceled) { finish(reject, canceledError()); return; }
      finish(reject, new Error(`网络请求失败: ${e.message}`));
    });

    req.on('timeout', () => {
      try { req.destroy(); } catch (e) { /* 忽略 */ }
      finish(reject, new Error('请求超时（120 秒）'));
    });

    req.write(body);
    req.end();
  });

  return {
    promise,
    cancel() {
      canceled = true;
      try { if (req) req.destroy(); } catch (e) { /* 忽略 */ }
    }
  };
}

/**
 * 测试连接：发一条极短的对话，返回模型回复
 * @param {Object} config
 * @returns {Promise<string>}
 */
function testConnection(config) {
  return requestChat(config, [
    { role: 'user', content: '你好，请只回复四个字：连接成功' }
  ], { stream: false }).promise;
}

module.exports = {
  DEFAULT_CHAT_ENDPOINT,
  resolveChatEndpoint,
  parseSseLine,
  createSseParser,
  requestChat,
  testConnection
};
