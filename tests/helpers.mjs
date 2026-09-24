/**
 * tests/helpers.mjs — утилиты для тестов: запуск процессов, ожидание /health, HTTP-запросы.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Запускает node-скрипт, собирает логи и умеет корректно останавливаться. */
export function spawnNode(script, { env = {}, cwd = ROOT } = {}) {
  const child = spawn(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  child.logs = () => logs.join('');

  child.stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const done = () => resolve();
    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* уже мёртв */ }
      resolve();
    }, 4000).unref();
  });

  return child;
}

/** Ждёт, пока приложение ответит на /health. */
export async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`/health не поднялся на ${baseUrl}: ${lastErr && lastErr.message}`);
}

/** Свободен ли TCP-порт на localhost. */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** Находит свободный порт. */
export async function freePort(start = 8300) {
  for (let port = start; port < start + 200; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) return port;
  }
  throw new Error('нет свободных портов');
}

/** fetch + разбор JSON с сохранением сырого текста. */
export async function req(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

/** Временный каталог для config.json, чтобы тесты не трогали рабочие данные. */
export function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duoai-test-'));
}

export const STUB = 'auto-generated-stub-for-build';
