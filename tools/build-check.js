#!/usr/bin/env node
/**
 * tools/build-check.js — шаг сборки проекта (npm run build).
 *
 * Проекту не нужна транспиляция: фронтенд — обычные ES-скрипты, бэкенд — Node.js
 * без внешних зависимостей. Но билдер хостинга (RelaxDev) вызывает `npm run build`,
 * поэтому здесь выполняется быстрая и полезная проверка «сборки»:
 *
 *   1. Синтаксис всех .js/.mjs файлов проекта (node --check).
 *   2. Наличие обязательных файлов и каталогов.
 *   3. Согласованность package.json: есть скрипты start/build, версия, движок Node.
 *   4. Проверка фронтенда: index.html подключает все свои скрипты и css,
 *      а каждый файл из HTML существует.
 *   5. Ключевые маршруты бэкенда объявлены (чтобы не выкатить поломанный прокси).
 *
 * Код возврата 0 — сборка успешна, 1 — есть ошибки (лог печатается в stderr).
 * Занимает меньше секунды, зависимостей не требует.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'coverage', 'dist', 'build', '.cache']);

const errors = [];
const notes = [];

function fail(message) { errors.push(message); }
function ok(message) { notes.push(message); }

/* ------------------------------------------------- 1. синтаксис исходников */

const syntaxChecked = [];

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(path.join(dir, entry.name));
    } else if (/\.m?js$/.test(entry.name)) {
      checkSyntax(path.join(dir, entry.name));
    }
  }
}

function checkSyntax(file) {
  const rel = path.relative(ROOT, file);
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    fail(`синтаксис ${rel}:\n${(res.stderr || res.stdout || '').trim().split('\n').slice(0, 6).join('\n')}`);
  } else {
    syntaxChecked.push(rel);
  }
}

walk(ROOT);
ok(`синтаксис проверен: ${syntaxChecked.length} файлов`);

/* ------------------------------------------------ 2. обязательные файлы */

const requiredFiles = [
  'server.js',
  'package.json',
  'public/index.html',
  'public/css/styles.css',
  'public/js/ai.js',
  'public/js/app.js',
  'public/js/screens.js',
  'public/js/store.js',
  'public/js/ui.js',
];

requiredFiles.forEach((rel) => {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) fail(`нет обязательного файла: ${rel}`);
});

/* ---------------------------------------------- 3. согласованность package.json */

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch (err) {
  fail(`package.json не читается: ${err.message}`);
}

if (pkg) {
  const scripts = pkg.scripts || {};
  // Платформа запускает контейнер командой `npm run build`, затем `npm start`
  ['build', 'start', 'test'].forEach((name) => {
    if (!scripts[name]) fail(`в package.json нет скрипта "${name}" (хостинг вызывает npm run ${name})`);
  });
  if (pkg.main && !fs.existsSync(path.join(ROOT, pkg.main))) fail(`package.json main указывает на отсутствующий ${pkg.main}`);
  if (!pkg.engines || !pkg.engines.node) notes.push('предупреждение: не указан engines.node');
  ok(`скрипты сборки на месте: ${Object.keys(scripts).join(', ')}`);
}

/* ------------------------------------------------------ 4. связность фронтенда */

const indexPath = path.join(ROOT, 'public/index.html');
if (fs.existsSync(indexPath)) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => !/^(https?:|data:|#|mailto:)/.test(src));

  refs.forEach((ref) => {
    const rel = ref.replace(/^\//, '');
    const file = path.join(ROOT, 'public', rel);
    if (!fs.existsSync(file)) fail(`index.html ссылается на отсутствующий файл: ${ref}`);
  });

  const jsRefs = refs.filter((r) => r.endsWith('.js'));
  if (jsRefs.length < 5) fail(`index.html подключает только ${jsRefs.length} скриптов — похоже, часть потерялась`);
  ok(`index.html: ${refs.length} подключений, все файлы на месте`);

  // порядок подключения важен: ui.js использует h(), screens.js использует Store/Prompts
  const order = jsRefs.map((r) => path.basename(r));
  const idx = (name) => order.indexOf(name);
  if (idx('ui.js') > idx('screens.js')) fail('порядок скриптов нарушен: ui.js должен подключаться до screens.js');
  if (idx('store.js') > idx('screens.js')) fail('порядок скриптов нарушен: store.js должен подключаться до screens.js');
  if (idx('ai.js') > idx('screens.js')) fail('порядок скриптов нарушен: ai.js должен подключаться до screens.js');
}

/* --------------------------------------------------- 5. маршруты бэкенда */

const serverPath = path.join(ROOT, 'server.js');
if (fs.existsSync(serverPath)) {
  const src = fs.readFileSync(serverPath, 'utf8');
  const routes = ['/api/ai', '/api/config', '/api/ping', '/health'];
  const missing = routes.filter((r) => !src.includes(`'${r}'`));
  if (missing.length) fail(`в server.js не найдены маршруты: ${missing.join(', ')}`);

  // правила хостинга: порт только из окружения, никаких захардкоженных listen(...)
  if (!/PORT/.test(src) || !/envInt\(|envStr\(/.test(src)) {
    fail('server.js должен читать порт и переменные окружения через envInt()/envStr()');
  }
  if (/\blisten\(\s*\d{2,5}\b/.test(src)) {
    fail('server.js: захардкоженный порт в listen() — на хостинге это даст 502');
  }
  ok('маршруты бэкенда и правила окружения на месте');
}

/* --------------------------------------------------------------- итог */

console.log('Duo-AI: проверка сборки');
console.log(`  корень: ${ROOT}`);
console.log(`  node:   ${process.version}`);
notes.forEach((n) => console.log(`  ✓ ${n}`));

if (errors.length) {
  console.error('\n✗ Сборка не прошла:');
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}

console.log('\n✓ Сборка успешна: транспиляция не требуется, файлы готовы к запуску (npm start).');
