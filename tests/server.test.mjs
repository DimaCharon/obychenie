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
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  ROOT, STUB, spawnNode, waitForHealth, isPortFree, freePort, req, tempDataDir, sleep,
} from './helpers.mjs';

const require = createRequire(import.meta.url);
const { checkDockerContext } = require(path.join(ROOT, 'tools/docker-context-check.js'));

/** Копия проекта без node_modules/.git — как контекст сборки. */
function copyProject(dest) {
  const skip = new Set(['node_modules', '.git', 'data', 'screenshots', 'tests', 'dist']);
  (function copy(rel) {
    const from = path.join(ROOT, rel);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        fs.mkdirSync(path.join(dest, child), { recursive: true });
        copy(child);
      } else {
        fs.copyFileSync(path.join(ROOT, child), path.join(dest, child));
      }
    }
  })('');
}
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

describe('сборка и запуск (требования хостинга)', () => {
  test('в package.json есть скрипты build и start, которые хостинг вызывает сам', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts, 'нет раздела scripts');
    assert.ok(pkg.scripts.build, 'платформа запускает `npm run build` — скрипт обязателен');
    assert.ok(pkg.scripts.start, 'платформа запускает `npm start` — скрипт обязателен');
    assert.match(pkg.scripts.start, /server\.js/, 'npm start должен запускать server.js');
    assert.ok(pkg.scripts['test:e2e'], 'должен быть скрипт E2E-тестов');
  });

  test('npm run build проходит успешно (код возврата 0)', () => {
    const res = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(res.status, 0, `сборка упала:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /Сборка успешна/);
  });

  test('npm run build находит поломку (негативная проверка)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoai-broken-'));
    // копируем проект без node_modules/.git, ломаем подключение скрипта
    fs.cpSync(ROOT, dir, {
      recursive: true,
      filter: (src) => !/(node_modules|\.git|data|screenshots)$/.test(path.basename(src)),
    });
    const index = path.join(dir, 'public/index.html');
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(/<script src="js\/store\.js"><\/script>/, ''));

    const res = spawnSync('npm', ['run', 'build'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(res.status, 0, 'сборка должна падать при потерянном скрипте');
    assert.match(`${res.stdout}${res.stderr}`, /подключает только|отсутств/i);
    fs.rmSync(dir, { recursive: true, force: true });
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

  /* --- контекст Docker-сборки: ошибки «Docker не нашёл файл, указанный в COPY» --- */

  test('Dockerfile и .dockerignore согласованы: все источники COPY попадают в образ', () => {
    const r = checkDockerContext({ root: ROOT });
    assert.deepEqual(r.errors, [], `контекст сборки неполный: ${r.errors.join('; ')}`);
    assert.ok(r.checked >= 1, 'должен быть хотя бы один источник COPY (package.json)');
  });

  test('проверка контекста ловит файл, которого нет в репозитории', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoai-ctx-missing-'));
    try {
      copyProject(dir);
      fs.appendFileSync(path.join(dir, 'Dockerfile'), '\nCOPY yarn.lock ./\n');
      const r = checkDockerContext({ root: dir });
      assert.ok(r.errors.some((e) => e.includes('yarn.lock')), `ожидали ошибку про yarn.lock, получено: ${r.errors.join('; ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('проверка контекста ловит файл, вырезанный .dockerignore', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoai-ctx-ignored-'));
    try {
      copyProject(dir);
      fs.appendFileSync(path.join(dir, '.dockerignore'), '\npublic/index.html\n');
      const r = checkDockerContext({ root: dir });
      assert.ok(r.errors.some((e) => e.includes('public/index.html')),
        `ожидали ошибку про исключённый public/index.html, получено: ${r.errors.join('; ')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('npm run build создаёт запускаемый артефакт dist/ (его копируют шаблоны хостинга)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoai-dist-'));
    try {
      copyProject(dir);
      const run = spawnSync(process.execPath, ['tools/build-check.js'], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 0, `сборка упала: ${run.stderr || run.stdout}`);

      ['dist/server.js', 'dist/package.json', 'dist/index.html', 'dist/css/styles.css', 'dist/js/app.js']
        .forEach((rel) => {
          assert.ok(fs.existsSync(path.join(dir, rel)), `в артефакте сборки нет ${rel}`);
        });

      // артефакт должен запускаться сам по себе
      const src = fs.readFileSync(path.join(dir, 'dist/server.js'), 'utf8');
      assert.ok(src.includes('http'), 'dist/server.js должен быть настоящим сервером, а не заглушкой');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('сборка чужим шаблоном (усечённое окружение) не падает: нет Dockerfile — это не ошибка', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoai-partial-'));
    try {
      copyProject(dir);
      fs.rmSync(path.join(dir, 'Dockerfile'), { force: true });          // шаблон хостинга Dockerfile не использует
      const run = spawnSync(process.execPath, ['tools/build-check.js'], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 0, `сборка не должна падать без Dockerfile: ${run.stdout} ${run.stderr}`);
      assert.match(run.stdout, /Dockerfile в этом окружении отсутствует/);
      assert.match(run.stdout, /Сборка успешна/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('стадия билдера чужого шаблона (только package.json) собирается без ошибок', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoai-builder-'));
    try {
      fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
      fs.copyFileSync(path.join(ROOT, 'tools/build-check.js'), path.join(dir, 'tools/build-check.js'));
      fs.copyFileSync(path.join(ROOT, 'tools/docker-context-check.js'), path.join(dir, 'tools/docker-context-check.js'));

      const run = spawnSync(process.execPath, ['tools/build-check.js'], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 0, `усечённая копия должна собираться с кодом 0: ${run.stdout} ${run.stderr}`);
      assert.match(run.stdout, /усечённое окружение/);
      assert.match(run.stdout, /замечания \(в усечённом окружении не считаются ошибкой\)|Сборка успешна/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('сборка под шаблон «next»: .next/standalone и .next/static на месте', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoai-next-'));
    try {
      copyProject(dir);
      const run = spawnSync(process.execPath, ['tools/build-check.js'], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 0, `сборка упала: ${run.stderr || run.stdout}`);

      // Ровно те пути, которые копирует сгенерированный шаблон Next.js
      ['public', '.next/standalone', '.next/static'].forEach((rel) => {
        assert.ok(fs.existsSync(path.join(dir, rel)), `шаблон next ждёт ${rel} — его нет`);
      });
      ['.next/standalone/server.js', '.next/standalone/package.json', '.next/standalone/public/index.html',
        '.next/static/css/styles.css'].forEach((rel) => {
        assert.ok(fs.existsSync(path.join(dir, rel)), `в standalone нет ${rel}`);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('образ, собранный шаблоном «next», запускается и отвечает', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoai-nextrun-'));
    let child = null;
    try {
      copyProject(dir);
      assert.equal(spawnSync(process.execPath, ['tools/build-check.js'], { cwd: dir, encoding: 'utf8' }).status, 0);

      // Финальная стадия шаблона: public/, содержимое .next/standalone, .next/static
      const app = path.join(dir, 'app');
      fs.mkdirSync(path.join(app, '.next'), { recursive: true });
      fs.cpSync(path.join(dir, 'public'), path.join(app, 'public'), { recursive: true });
      fs.cpSync(path.join(dir, '.next/standalone'), app, { recursive: true });
      fs.cpSync(path.join(dir, '.next/static'), path.join(app, '.next/static'), { recursive: true });

      const port = await freePort(8620);
      child = spawnNode('server.js', { env: { PORT: String(port), DATA_DIR: tempDataDir() }, cwd: app });
      running.push(child);

      const baseUrl = `http://127.0.0.1:${port}`;
      const health = await waitForHealth(baseUrl);
      assert.equal(health.ok, true, 'сервер из standalone должен подниматься');

      const page = await req(`${baseUrl}/`);
      assert.equal(page.status, 200, 'главная страница должна отдаваться');
      const css = await req(`${baseUrl}/css/styles.css`);
      assert.equal(css.status, 200, 'статика должна отдаваться');
    } finally {
      if (child) await child.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Dockerfile не копирует файлы шаблонами (ломаются на «COPY file*»)', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const copyLines = dockerfile.split(/\r?\n/).filter((l) => /^\s*COPY\b/i.test(l) && !/^\s*COPY\s+--from=/i.test(l));
    copyLines.forEach((line) => {
      assert.ok(!/[*?]/.test(line), `в COPY не должно быть шаблонов: ${line.trim()}`);
    });
    assert.ok(dockerfile.includes('EXPOSE 8080'), 'образ должен открывать порт 8080 (требование хостинга)');
    assert.ok(/CMD\s*\[\s*"node",\s*"server\.js"\s*\]/.test(dockerfile), 'CMD должен запускать node server.js');
  });
});
