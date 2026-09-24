/**
 * Duo-AI — backend.
 *
 * Статика + маленький прокси к OpenAI-совместимому API чата
 * (по умолчанию: https://inference.dahl.global/v1).
 * API-ключ живёт только на сервере и в браузер не попадает.
 *
 * Учтены требования хостинга RelaxDev (https://relaxdev.ru/docs):
 *   1. Порт читается из окружения (PORT → SERVER_PORT → 8080), привязка к 0.0.0.0.
 *   2. Платформа подставляет заглушку `auto-generated-stub-for-build` во все
 *      найденные `process.env.X`, которых нет в переменных проекта. Поэтому все
 *      обращения к окружению идут через envStr()/envInt(), которые отбрасывают
 *      пустые значения и заглушку (иначе `process.env.X || 'дефолт'` не сработает).
 *   3. Встроенный fetch (undici) не читает HTTP_PROXY/HTTPS_PROXY. Если прокси
 *      задан, подключаем диспетчер undici (EnvHttpProxyAgent/ProxyAgent) — пакет
 *      стоит в optionalDependencies, поэтому при его отсутствии приложение просто
 *      работает напрямую.
 *   4. Секреты — через переменные окружения (AI_API_KEY, AI_BASE_URL, AI_MODEL).
 *      Файл config.json остаётся как локальный/резервный вариант хранения.
 *
 * Маршруты:
 *   GET  /health|/api/health -> статус, порт, режим ИИ, прокси
 *   GET  /api/config         -> { keySet, keyHint, model, baseUrl, … }
 *   POST /api/config         -> сохранить ключ/модель/baseUrl (или { clear: true })
 *   POST /api/ai             -> { system, user, json?, temperature?, maxTokens? } -> { text }
 *   POST /api/ping           -> проверка ключа коротким запросом к модели
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* ======================================================================== env */
/* Заглушка, которой платформа RelaxDev заменяет отсутствующие переменные. */
const ENV_STUB = 'auto-generated-stub-for-build';

/** Значение переменной окружения или '' (пусто / заглушка / пробелы отбрасываются). */
function envStr(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value) return '';
  if (value.includes(ENV_STUB)) return '';
  return value;
}

/** Число из переменной окружения или fallback (защита от «NaN» из заглушки). */
function envInt(name, fallback) {
  const value = envStr(name);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PORT = envInt('PORT', envInt('SERVER_PORT', 8080));
const HOST = envStr('HOST') || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_BASE_URL = envStr('AI_BASE_URL') || 'https://inference.dahl.global/v1';
const DEFAULT_MODEL = envStr('AI_MODEL') || 'deepseek-ai/DeepSeek-V4-Flash-0731';
const ENV_API_KEY = envStr('AI_API_KEY');

// Каталог для файла настроек: /data (постоянный том, если есть) → ./data
const DATA_DIR = envStr('DATA_DIR') || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/* ====================================================================== proxy */

let PROXY = { enabled: false, mode: 'direct', note: '' };

function setupProxy() {
  // Платформа отдаёт адрес прокси в RELAXDEV_PROXY_URL и обычно дублирует его
  // в HTTP_PROXY/HTTPS_PROXY. EnvHttpProxyAgent читает только стандартные переменные,
  // поэтому при наличии RELAXDEV_PROXY_URL прописываем их сами (если ещё не заданы).
  const relaxProxy = envStr('RELAXDEV_PROXY_URL');
  let derivedFromRelaxdev = false;

  if (relaxProxy && !envStr('HTTPS_PROXY') && !envStr('HTTP_PROXY')) {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
      process.env[name] = relaxProxy;
    }
    derivedFromRelaxdev = true;
  }

  const proxyUrl = relaxProxy
    || envStr('HTTPS_PROXY') || envStr('https_proxy')
    || envStr('HTTP_PROXY') || envStr('http_proxy');

  if (!proxyUrl) {
    PROXY = { enabled: false, mode: 'direct', note: 'прокси не задан — запросы идут напрямую' };
    return;
  }

  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const undici = require('undici');
    if (typeof undici.EnvHttpProxyAgent === 'function') {
      // EnvHttpProxyAgent сам читает HTTP_PROXY/HTTPS_PROXY/NO_PROXY (в обоих регистрах)
      undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
      PROXY = {
        enabled: true,
        mode: derivedFromRelaxdev ? 'relaxdev' : 'env',
        note: `исходящие через прокси платформы (EnvHttpProxyAgent${derivedFromRelaxdev ? ', адрес из RELAXDEV_PROXY_URL' : ''})`,
      };
    } else {
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl));
      PROXY = { enabled: true, mode: 'explicit', note: 'исходящие через прокси платформы (ProxyAgent)' };
    }
  } catch (err) {
    PROXY = {
      enabled: false,
      mode: 'unavailable',
      note: 'прокси задан, но пакет undici не установлен — запросы идут напрямую. '
        + 'Добавьте undici в зависимости или запустите: npm i undici',
    };
    console.warn('[duo-ai] proxy:', err.code || err.message);
  }
}

setupProxy();

/* ================================================================ настройки */

let fileStorage = true;      // удалось ли записать config.json (на хостинге FS может быть read-only)

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch (err) {
    console.warn('[duo-ai] cannot create data dir:', err.message);
    return false;
  }
}

/**
 * Конфигурация живёт в памяти и (по возможности) дублируется в config.json.
 * Если файловая система только для чтения, ключ всё равно продолжает работать
 * до перезапуска контейнера — иначе сохранённый ключ «пропадал» бы на глазах.
 */
let memoryConfig = readConfigFromDisk();

function readConfigFromDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readConfig() {
  return memoryConfig;
}

function writeConfig(cfg) {
  memoryConfig = cfg;
  if (!ensureDataDir()) return false;
  try {
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CONFIG_FILE);
    fileStorage = true;
    return true;
  } catch (err) {
    fileStorage = false;
    console.warn('[duo-ai] config не сохранён на диск (ключ остаётся в памяти до перезапуска):', err.message);
    return false;
  }
}

/** Ключ приходит из разных источников — нормализуем и объясняем проблемы. */
function inspectKey(raw) {
  const value = typeof raw === 'string' ? raw : '';
  const trimmed = value.trim();
  const warnings = [];
  if (trimmed !== value) warnings.push('лишние пробелы и переводы строк по краям ключа убраны');
  if (/\s/.test(trimmed)) warnings.push('в ключе есть пробелы внутри — проверь, что скопировал его целиком');
  if (/[^\x21-\x7e]/.test(trimmed)) warnings.push('в ключе есть непечатаемые или нелатинские символы — вероятно, скопировался не весь текст');
  if (trimmed.length < 12) warnings.push('ключ подозрительно короткий (меньше 12 символов)');
  return { key: trimmed, warnings };
}

/** Проверяем на старте, можно ли вообще писать в каталог данных. */
function probeStorage() {
  if (!ensureDataDir()) { fileStorage = false; return; }
  const probe = path.join(DATA_DIR, `.probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    fileStorage = true;
  } catch {
    fileStorage = false;
  }
}

/** Итоговая конфигурация: переменные окружения перекрывают файл. */
function activeConfig() {
  const cfg = readConfig();
  const fileKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  return {
    apiKey: ENV_API_KEY || fileKey,
    keyFromEnv: Boolean(ENV_API_KEY),
    baseUrl: (envStr('AI_BASE_URL') || cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: envStr('AI_MODEL') || cfg.model || DEFAULT_MODEL,
    savedAt: cfg.savedAt || null,
  };
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 2)}${'•'.repeat(6)}`;
  return `${key.slice(0, 6)}${'•'.repeat(8)}${key.slice(-4)}`;
}

/* ================================================================= http utils */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/* ================================================================= upstream */

async function callUpstream({ system, user, json, temperature, maxTokens }) {
  const { apiKey, baseUrl, model } = activeConfig();
  if (!apiKey) {
    const err = new Error('NO_KEY');
    err.code = 'NO_KEY';
    throw err;
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content: String(user ?? '') });

  const payload = {
    model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    max_tokens: typeof maxTokens === 'number' ? maxTokens : 4096,
  };
  if (json) payload.response_format = { type: 'json_object' };

  // fetch использует глобальный диспетчер: если задан прокси платформы, он уже подключён в setupProxy()
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error(
      err.name === 'AbortError'
        ? 'ИИ не ответил за 180 секунд (запрос прерван).'
        : `Не удалось подключиться к ${baseUrl}: ${err.message}`,
    );
    e.code = 'NETWORK';
    throw e;
  }
  clearTimeout(timer);

  const raw = await response.text();
  if (!response.ok) {
    const e = new Error(`API ${response.status}: ${raw.slice(0, 600)}`);
    e.code = 'UPSTREAM';
    e.status = response.status;
    throw e;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Некорректный ответ API: ${raw.slice(0, 300)}`);
  }

  const choice = (data.choices && data.choices[0]) || {};
  const text = choice.message?.content
    ?? choice.message?.reasoning_content
    ?? choice.text
    ?? '';
  return { text: String(text), usage: data.usage || null };
}

/* ==================================================================== routes */

function healthPayload() {
  const { apiKey, baseUrl, model, keyFromEnv } = activeConfig();
  return {
    ok: true,
    app: 'Duo-AI',
    version: require('./package.json').version,
    uptimeSec: Math.round(process.uptime()),
    port: PORT,
    host: HOST,
    node: process.version,
    ai: {
      configured: Boolean(apiKey),
      keyFromEnv,
      baseUrl,
      model,
    },
    storage: {
      dataDir: DATA_DIR,
      fileStorage,
      keySource: ENV_API_KEY ? 'env' : (readConfig().apiKey ? (fileStorage ? 'file+memory' : 'memory') : 'none'),
    },
    proxy: PROXY,
    now: new Date().toISOString(),
  };
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if ((route === '/health' || route === '/api/health') && req.method === 'GET') {
    return sendJson(res, 200, healthPayload());
  }

  if (route === '/api/config' && req.method === 'GET') {
    const { apiKey, baseUrl, model, keyFromEnv, savedAt } = activeConfig();
    return sendJson(res, 200, {
      keySet: Boolean(apiKey),
      keyHint: maskKey(apiKey),
      keyFromEnv,
      baseUrl,
      model,
      dataDir: DATA_DIR,
      fileStorage,
      keySource: keyFromEnv ? 'env' : (readConfig().apiKey ? (fileStorage ? 'file+memory' : 'memory') : 'none'),
      proxy: PROXY,
      savedAt,
    });
  }

  if (route === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = readConfig();

    if (body.clear) {
      if (ENV_API_KEY) {
        return sendJson(res, 409, {
          ok: false,
          error: 'Ключ задан переменной окружения AI_API_KEY — её нельзя удалить из приложения. '
            + 'Уберите переменную в настройках проекта и сделайте редеплой.',
        });
      }
      delete cfg.apiKey;
      cfg.savedAt = new Date().toISOString();
      const saved = writeConfig(cfg);
      return sendJson(res, 200, { ok: true, keySet: false, fileStorage: saved });
    }

    let keyWarnings = [];
    if (typeof body.apiKey === 'string') {
      const inspected = inspectKey(body.apiKey);
      keyWarnings = inspected.warnings;
      if (inspected.key) cfg.apiKey = inspected.key;
      else delete cfg.apiKey;
    }
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
      cfg.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
    }
    if (typeof body.model === 'string' && body.model.trim()) {
      cfg.model = body.model.trim();
    }
    cfg.savedAt = new Date().toISOString();

    const saved = writeConfig(cfg);
    const { apiKey, baseUrl, model, keyFromEnv } = activeConfig();
    return sendJson(res, 200, {
      ok: true,
      keySet: Boolean(apiKey),
      keyHint: maskKey(apiKey),
      keyFromEnv,
      baseUrl,
      model,
      fileStorage: saved,
      keyWarnings,
      storageNote: saved
        ? 'Ключ сохранён в файл на сервере'
        : 'Ключ работает, но сохранён только в памяти: файловая система только для чтения. '
          + 'Чтобы не потерять его после перезапуска, задайте AI_API_KEY в переменных проекта.',
      warning: saved ? null : 'Файловая система только для чтения: ключ работает до перезапуска. Надёжнее задать AI_API_KEY в переменных окружения проекта.',
    });
  }

  if (route === '/api/ai' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || typeof body.user !== 'string') {
      return sendJson(res, 400, { error: 'Нужно поле "user" (текст запроса).' });
    }
    const started = Date.now();
    try {
      const { text, usage } = await callUpstream(body);
      return sendJson(res, 200, { text, usage, ms: Date.now() - started });
    } catch (err) {
      const status = err.code === 'NO_KEY' ? 428 : err.code === 'UPSTREAM' ? 502 : 500;
      return sendJson(res, status, { error: err.message, code: err.code || 'ERROR' });
    }
  }

  if (route === '/api/ping' && req.method === 'POST') {
    const started = Date.now();
    try {
      const { text } = await callUpstream({
        system: 'Ты тестовый эхо-бот. Отвечай строго одним словом "pong".',
        user: 'ping',
        temperature: 0,
        maxTokens: 16,
      });
      return sendJson(res, 200, { ok: true, ms: Date.now() - started, reply: text.trim().slice(0, 40) });
    } catch (err) {
      return sendJson(res, 200, {
        ok: false,
        code: err.code || 'ERROR',
        error: err.message,
        ms: Date.now() - started,
      });
    }
  }

  return sendJson(res, 404, { error: 'Неизвестный API-маршрут.' });
}

/* ============================================================ static files */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA-fallback: любой неизвестный путь отдаёт index.html
      const index = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(index, (e2, buf) => {
        if (e2) {
          res.writeHead(404).end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
      return;
    }

    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* ====================================================================== boot */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    console.error('[duo-ai] handler error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || 'Внутренняя ошибка.' });
    else res.end();
  }
});

// Держим keep-alive чуть выше, чем у прокси платформы (Traefik), чтобы не ловить 502
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

probeStorage();

server.listen(PORT, HOST, () => {
  const { apiKey, baseUrl, model, keyFromEnv } = activeConfig();
  console.log(`[duo-ai] listening on http://${HOST}:${PORT}`);
  console.log(`[duo-ai] node ${process.version} · host ${os.hostname()} · data dir ${DATA_DIR} (запись: ${fileStorage ? 'да' : 'нет'})`);
  console.log(`[duo-ai] upstream: ${baseUrl} | model: ${model}`);
  console.log(`[duo-ai] ключ: ${apiKey ? `${maskKey(apiKey)}${keyFromEnv ? ' (из переменной окружения)' : ' (из файла)'}` : 'НЕ ЗАДАН — демо-режим'}`);
  console.log(`[duo-ai] прокси: ${PROXY.note}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[duo-ai] порт ${PORT} занят. Если это хостинг — читайте PORT из окружения (сейчас PORT=${process.env.PORT || 'не задан'}).`);
  } else {
    console.error('[duo-ai] server error:', err);
  }
  process.exit(1);
});

function shutdown(signal) {
  console.log(`[duo-ai] ${signal}: останавливаюсь…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('[duo-ai] unhandledRejection:', reason));

module.exports = { server };
