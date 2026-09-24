/**
 * tests/server.test.mjs — проверка правил хостинга RelaxDev и базовых маршрутов.
 *
 * Что проверяем:
 *   1. Порт читается из PORT/SERVER_PORT, при заглушке и мусоре — 8080.
 *   2. Значения-заглушки `auto-generated-stub-for-build` игнорируются (иначе
 *      `process.env.X || 'дефолт'` на хостинге не работает).
 *   3. /health отдаёт статус, порт, режим ИИ, хранилище и прокси.
 *   4. Статика, SPA-fallback, 404 для неизвестного API.
 *   5. Сохранение/очистка ключа в файле; приоритет переменной окружения.
 *   6. Приложение стартует и работает, когда задан прокси, а undici не установлен.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  ROOT, STUB, spawnNode, waitForHealth, isPortFree, freePort, req, tempDataDir, sleep,
} from './helpers.mjs';

const require = createRequire(import.meta.url);
const running = [];
async function startApp(env = {}, { port = null } = {}) {
  const dataDir = env.DATA_DIR || tempDataDir();
  const child = spawnNode('server.js', { env: { DATA_DIR: dataDir, ...env } });
  running.push(child);
  const baseUrl = `http://127.0.0.1:${port ?? 8080}`;
  const health = await waitForHealth(baseUrl);
  return { child, baseUrl, health, dataDir };
}

after(async () => {
  await Promise.all(running.map((c) => c.stop()));
});

describe('хостинг RelaxDev: порт и переменные окружения', () => {
  test('слушает порт из PORT (контейнер хостинга отдаёт только 8080)', async () => {
    const port = await freePort(8400);
    const { baseUrl, health } = await startApp({ PORT: String(port) }, { port });
    assert.equal(health.ok, true);
    assert.equal(health.port, port, '/health должен сообщать реальный порт');
  });

  test('заглушка в PORT не ломает старт — падаем на 8080', async (t) => {
    if (!(await isPortFree(8080))) return t.skip('порт 8080 занят другим процессом');
    const { child, health } = await startApp({ PORT: STUB }, { port: 8080 });
    try {
      assert.equal(health.port, 8080, 'при заглушке PORT должен использоваться дефолтный 8080');
    } finally {
      await child.stop();                 // освобождаем 8080 для следующего теста
      for (let i = 0; i < 40 && !(await isPortFree(8080)); i += 1) await sleep(100);
    }
  });

  test('мусор в PORT тоже приводит к 8080, а не к NaN', async (t) => {
    if (!(await isPortFree(8080))) return t.skip('порт 8080 занят другим процессом');
    const { child, health } = await startApp({ PORT: 'не-число' }, { port: 8080 });
    try {
      assert.equal(health.port, 8080);
    } finally {
      await child.stop();
    }
  });

  test('заглушки в AI_* переменных игнорируются: демо-режим и дефолтный upstream', async () => {
    const port = await freePort(8420);
    const { baseUrl, health } = await startApp({
      PORT: String(port),
      AI_API_KEY: STUB,
      AI_BASE_URL: STUB,
      AI_MODEL: STUB,
    }, { port });

    assert.equal(health.ai.configured, false, 'заглушка не должна считаться ключом');
    assert.equal(health.ai.baseUrl, 'https://inference.dahl.global/v1');
    assert.equal(health.ai.model, 'deepseek-ai/DeepSeek-V4-Flash-0731');

    const cfg = await req(`${baseUrl}/api/config`);
    assert.equal(cfg.json.keySet, false);
    assert.equal(cfg.json.baseUrl, 'https://inference.dahl.global/v1');

    const ai = await req(`${baseUrl}/api/ai`, { method: 'POST', body: JSON.stringify({ user: 'привет' }) });
    assert.equal(ai.status, 428);
    assert.equal(ai.json.code, 'NO_KEY');
  });
});

describe('служебные маршруты и статика', () => {
  test('/health содержит всё нужное для мониторинга', async () => {
    const port = await freePort(8440);
    const { health } = await startApp({ PORT: String(port) }, { port });
    for (const field of ['ok', 'version', 'uptimeSec', 'port', 'node', 'ai', 'storage', 'proxy', 'now']) {
      assert.ok(Object.hasOwn(health, field), `нет поля ${field}`);
    }
    assert.equal(typeof health.storage.fileStorage, 'boolean');
    assert.ok(Array.isArray(health.node === undefined) || typeof health.node === 'string');
  });

  test('статика отдаётся, неизвестный путь — SPA-fallback, неизвестный API — 404', async () => {
    const port = await freePort(8460);
    const { baseUrl } = await startApp({ PORT: String(port) }, { port });

    const index = await req(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(index.text, /Duo-AI/);

    const css = await req(`${baseUrl}/css/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const js = await req(`${baseUrl}/js/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    const spa = await req(`${baseUrl}/какой-то/внутренний/путь`);
    assert.equal(spa.status, 200);
    assert.match(spa.text, /<div id="app"/);

    const api404 = await req(`${baseUrl}/api/неизвестный`);
    assert.equal(api404.status, 404);
    assert.ok(api404.json.error);
  });

  test('ключ сохраняется в файл, маскируется и удаляется', async () => {
    const port = await freePort(8480);
    const { baseUrl, dataDir } = await startApp({ PORT: String(port) }, { port });

    const save = await req(`${baseUrl}/api/config`, {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'sk-test-1234567890abcdef', model: 'my-model', baseUrl: 'https://example.com/v1/' }),
    });
    assert.equal(save.status, 200);
    assert.equal(save.json.keySet, true);
    assert.equal(save.json.model, 'my-model');
    assert.equal(save.json.baseUrl, 'https://example.com/v1', 'хвостовой слэш должен срезаться');
    assert.match(save.json.keyHint, /•/, 'ключ должен маскироваться');
    assert.ok(!save.json.keyHint.includes('1234567890abcdef'), 'ключ не должен утекать в открытом виде');
    assert.ok(fs.existsSync(path.join(dataDir, 'config.json')), 'config.json должен появиться в каталоге данных');

    const cleared = await req(`${baseUrl}/api/config`, { method: 'POST', body: JSON.stringify({ clear: true }) });
    assert.equal(cleared.json.keySet, false);
  });

  test('ключ из окружения приоритетнее файла и не удаляется из приложения', async () => {
    const port = await freePort(8500);
    const dataDir = tempDataDir();
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ apiKey: 'file-key-000000' }));

    const { baseUrl } = await startApp({
      PORT: String(port),
      DATA_DIR: dataDir,
      AI_API_KEY: 'env-key-1234567890',
    }, { port });

    const cfg = await req(`${baseUrl}/api/config`);
    assert.equal(cfg.json.keyFromEnv, true);
    assert.match(cfg.json.keyHint, /^env-ke/);

    const clear = await req(`${baseUrl}/api/config`, { method: 'POST', body: JSON.stringify({ clear: true }) });
    assert.equal(clear.status, 409, 'нельзя удалить ключ, пришедший из переменных окружения');
    assert.match(clear.json.error, /AI_API_KEY/);
  });

  test('задан RELAXDEV_PROXY_URL — сервер стартует, режим прокси виден в /health', async () => {
    const port = await freePort(8520);
    const { baseUrl, health } = await startApp({
      PORT: String(port),
      RELAXDEV_PROXY_URL: 'http://proxy.example:3128',
    }, { port });

    assert.equal(health.ok, true);
    assert.ok(['env', 'explicit', 'relaxdev', 'unavailable'].includes(health.proxy.mode),
      `неожиданный режим прокси: ${health.proxy.mode}`);
    assert.ok(health.proxy.note.length > 0, 'в /health должно быть человекочитаемое пояснение');

    // без ключа — понятная ошибка, а не падение
    const ai = await req(`${baseUrl}/api/ai`, { method: 'POST', body: JSON.stringify({ user: 'x' }) });
    assert.equal(ai.status, 428);
  });

  test('прокси реально применяется к исходящим запросам (undici + CONNECT)', { timeout: 30000 }, async (t) => {
    let undiciInstalled = true;
    try { require.resolve('undici'); } catch { undiciInstalled = false; }
    if (!undiciInstalled) return t.skip('undici не установлен — режим прокси недоступен by design');

    // 1. «Upstream» — отвечает текстом, который мы ожидаем увидеть на выходе.
    const upstreamPort = await freePort(8560);
    const upstream = http.createServer((r, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ответ от upstream через туннель' } }] }));
    });
    await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

    // 2. Прокси-заглушка: как настоящий прокси принимает CONNECT и туннелирует трафик.
    const proxyPort = await freePort(8580);
    const connects = [];
    const proxy = http.createServer((req, res) => {
      res.writeHead(502).end('используйте CONNECT');
    });
    proxy.on('connect', (req, clientSocket, head) => {
      connects.push(req.url);
      const [host, port] = String(req.url).split(':');
      const target = net.connect(Number(port) || 80, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) target.write(head);
        target.pipe(clientSocket);
        clientSocket.pipe(target);
      });
      const kill = () => { target.destroy(); clientSocket.destroy(); };
      target.on('error', kill);
      clientSocket.on('error', kill);
    });
    await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));

    const port = await freePort(8590);
    const { child, baseUrl, health } = await startApp({
      PORT: String(port),
      DATA_DIR: tempDataDir(),
      AI_API_KEY: 'key-1234567890',
      AI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      RELAXDEV_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: '',
      no_proxy: '',                        // иначе localhost пойдёт мимо прокси
    }, { port });

    try {
      assert.ok(['env', 'explicit', 'relaxdev'].includes(health.proxy.mode),
        `прокси должен быть подключён, получено: ${health.proxy.mode}`);

      const res = await req(`${baseUrl}/api/ai`, {
        method: 'POST',
        body: JSON.stringify({ user: 'привет' }),
        signal: AbortSignal.timeout(15000),
      });

      assert.equal(res.status, 200, `ожидали ответ через прокси, получено ${res.status}: ${res.text.slice(0, 200)}`);
      assert.equal(res.json.text, 'ответ от upstream через туннель');
      assert.ok(connects.length >= 1,
        'прокси должен получить CONNECT — иначе трафик уходит напрямую (баг с RELAXDEV_PROXY_URL)');
      assert.ok(connects[0].includes(String(upstreamPort)), `CONNECT должен вести к upstream, получено: ${connects[0]}`);
    } finally {
      await child.stop();
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      await new Promise((r) => proxy.close(r));
      await new Promise((r) => upstream.close(r));
    }
  });

  test('SIGTERM завершает процесс (хостинг перезапускает контейнеры)', async () => {
    const port = await freePort(8540);
    const { child } = await startApp({ PORT: String(port) }, { port });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 6000))]);
    assert.notEqual(code, 'timeout', 'процесс должен завершиться по SIGTERM');
  });

  test('долгое соединение не обрывается: keep-alive больше, чем у прокси платформы', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const keepAlive = Number((src.match(/keepAliveTimeout\s*=\s*([\d_]+)/) || [])[1]?.replace(/_/g, ''));
    assert.ok(keepAlive >= 60000, `keepAliveTimeout должен быть ≥ 60с, сейчас ${keepAlive}`);
  });
});
