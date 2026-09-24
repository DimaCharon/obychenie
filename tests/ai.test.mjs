/**
 * tests/ai.test.mjs — сквозная проверка ИИ-прокси.
 *
 * Поднимаем локальный «OpenAI-совместимый» мок (tools/mock-ai.js) и проверяем,
 * что приложение реально проксирует к нему запросы, отдаёт текст модели,
 * корректно сообщает об ошибках upstream и работает с ключом из окружения.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  spawnNode, waitForHealth, freePort, req, tempDataDir,
} from './helpers.mjs';

let mockPort;
let appPort;
let app;
let baseUrl;
let mock;

before(async () => {
  mockPort = await freePort(8600);
  mock = spawnNode('tools/mock-ai.js', { env: { MOCK_PORT: String(mockPort) } });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${mockPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
      });
      ready = res.ok;
    } catch { /* мок ещё поднимается */ }
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, 'мок-ИИ не поднялся');

  appPort = await freePort(8620);
  app = spawnNode('server.js', {
    env: {
      PORT: String(appPort),
      DATA_DIR: tempDataDir(),
      AI_API_KEY: 'mock-key-123456',
      AI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      AI_MODEL: 'mock-model',
    },
  });
  baseUrl = `http://127.0.0.1:${appPort}`;
  await waitForHealth(baseUrl);
});

after(async () => {
  if (app) await app.stop();
  if (mock) await mock.stop();
});

describe('прокси к ИИ', () => {
  test('/api/config показывает ключ, модель и upstream из окружения', async () => {
    const cfg = await req(`${baseUrl}/api/config`);
    assert.equal(cfg.json.keySet, true);
    assert.equal(cfg.json.keyFromEnv, true);
    assert.equal(cfg.json.model, 'mock-model');
    assert.equal(cfg.json.baseUrl, `http://127.0.0.1:${mockPort}/v1`);
  });

  test('/api/ping отвечает ok (ключ рабочий)', async () => {
    const ping = await req(`${baseUrl}/api/ping`, { method: 'POST', body: '{}' });
    assert.equal(ping.status, 200);
    assert.equal(ping.json.ok, true, ping.json.error || '');
    assert.ok(ping.json.ms >= 0);
  });

  test('генерация плана: модель отдаёт JSON в ```-обёртке, текст доходит целиком', async () => {
    const res = await req(`${baseUrl}/api/ai`, {
      method: 'POST',
      body: JSON.stringify({
        system: 'Составь персональный курс по теме',
        user: 'тема «Проценты»',
        json: true,
        maxTokens: 2048,
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.text.length > 100, 'ожидали текст плана');
    assert.match(res.json.text, /sections/);

    // проверяем, что клиентский парсер справился бы с этим ответом
    const cleaned = res.json.text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const plan = JSON.parse(cleaned);
    assert.ok(Array.isArray(plan.sections) && plan.sections.length >= 1);
    assert.ok(plan.sections[0].topics[0].quiz.length >= 2);
  });

  test('обычный чат с учителем возвращает текст без JSON', async () => {
    const res = await req(`${baseUrl}/api/ai`, {
      method: 'POST',
      body: JSON.stringify({ system: 'Ты учитель', user: 'Объясни проценты', temperature: 0.7 }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.text.length > 10);
    assert.ok(!res.json.text.includes('```'));
  });

  test('ошибка upstream (401) отдаётся как 502 с текстом ошибки', async () => {
    const badPort = await freePort(8700);
    const badServer = http.createServer((r, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });
    await new Promise((r) => badServer.listen(badPort, '127.0.0.1', r));

    const port = await freePort(8720);
    const child = spawnNode('server.js', {
      env: {
        PORT: String(port),
        DATA_DIR: tempDataDir(),
        AI_API_KEY: 'bad-key',
        AI_BASE_URL: `http://127.0.0.1:${badPort}/v1`,
      },
    });
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(url);

    const res = await req(`${url}/api/ai`, { method: 'POST', body: JSON.stringify({ user: 'привет' }) });
    assert.equal(res.status, 502);
    assert.match(res.json.error, /401/);
    assert.match(res.json.error, /Invalid API key/);

    const ping = await req(`${url}/api/ping`, { method: 'POST', body: '{}' });
    assert.equal(ping.json.ok, false);
    assert.match(ping.json.error, /401/);

    await child.stop();
    await new Promise((r) => badServer.close(r));
  });

  test('недоступный upstream — понятная ошибка сети, а не зависание', async () => {
    const deadPort = await freePort(8740);            // порт свободен, никто не слушает
    const port = await freePort(8760);
    const child = spawnNode('server.js', {
      env: {
        PORT: String(port),
        DATA_DIR: tempDataDir(),
        AI_API_KEY: 'key',
        AI_BASE_URL: `http://127.0.0.1:${deadPort}/v1`,
      },
    });
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(url);

    const res = await req(`${url}/api/ai`, { method: 'POST', body: JSON.stringify({ user: 'привет' }) });
    assert.equal(res.status, 500);
    assert.match(res.json.error, /Не удалось подключиться/);

    await child.stop();
  });

  test('без поля user — 400, некорректный JSON — 500 без падения', async () => {
    const bad = await req(`${baseUrl}/api/ai`, { method: 'POST', body: JSON.stringify({ system: 'нет user' }) });
    assert.equal(bad.status, 400);

    const broken = await fetch(`${baseUrl}/api/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{это не json',
    });
    assert.ok(broken.status >= 400);
    const health = await req(`${baseUrl}/health`);
    assert.equal(health.json.ok, true, 'сервер должен остаться живым');
  });
});
