#!/usr/bin/env node
/**
 * tools/docker-context-check.js — проверка контекста Docker-сборки.
 *
 * Хостинг собирает образ из корня репозитория и складывает в контекст все файлы,
 * КРОМЕ перечисленных в .dockerignore. Ошибка «Docker не нашёл файл, указанный в COPY»
 * возникает ровно в двух случаях:
 *   1. файла нет в репозитории (или проект лежит в подпапке, которая не указана как rootDir);
 *   2. файл есть, но вырезан правилом из .dockerignore.
 *
 * Этот скрипт повторяет логику Docker: разбирает все инструкции COPY в Dockerfile,
 * применяет .dockerignore к файлам проекта и проверяет, что каждый источник COPY
 * остаётся в контексте сборки. Запускается из npm run build и падает с кодом 1,
 * если образ заведомо не соберётся.
 *
 * Запуск вручную:  node tools/docker-context-check.js
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------ .dockerignore */

/**
 * Разбирает .dockerignore в список правил.
 * Поддерживаются: комментарии (#), пустые строки, отрицания (!pattern),
 * шаблоны * ? ** и правила «без слэша — на любой глубине» (как в Docker).
 */
function parseIgnore(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      let pattern = (negated ? line.slice(1) : line).trim();
      pattern = pattern.replace(/^\.?\//, '').replace(/\/+$/, ''); // /foo/ и ./foo → foo
      return { negated, pattern };
    })
    .filter((rule) => rule.pattern);
}

/** Шаблон Docker/glob → регулярное выражение. */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {           // ** — любая вложенность (в т.ч. пустая)
        out += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += pattern[i + 2] === '/' ? 2 : 1;
      } else {
        out += '[^/]*';                       // * — в пределах одного уровня
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function isGlob(pattern) {
  return /[*?]/.test(pattern);
}

/** Совпадает ли относительный путь с одним правилом .dockerignore. */
function matchPattern(rule, relPath, isDir) {
  const pattern = rule.pattern;
  const test = globToRegExp(pattern);

  if (pattern.includes('/')) return test.test(relPath);

  // Правило без слэша Docker применяет к любому уровню: node_modules, *.md и т.п.
  const parts = relPath.split('/');
  if (pattern.startsWith('**/')) return test.test(relPath) || test.test(parts[parts.length - 1]);
  return parts.some((part, idx) => test.test(part) && (!isDir || idx === parts.length - 1 || true));
}

/** Исключён ли путь (с учётом порядка правил и отрицаний). */
function isIgnored(rules, relPath, isDir) {
  let ignored = false;
  for (const rule of rules) {
    if (matchPattern(rule, relPath, isDir)) ignored = !rule.negated;
  }
  return ignored;
}

/* ------------------------------------------------------- обход файлов проекта */

const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', '.venv', 'dist', 'build', 'coverage']);

function walk(root, rel = '') {
  const out = [];
  const full = path.join(root, rel);
  let entries = [];
  try {
    entries = fs.readdirSync(full, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push({ path: childRel, dir: true });
      out.push(...walk(root, childRel));
    } else {
      out.push({ path: childRel, dir: false });
    }
  }
  return out;
}

/* --------------------------------------------------------------- проверка COPY */

const COPY_RE = /^\s*COPY\s+(?!--from=)(.+)$/i;

/** Достаёт источники и назначение из инструкции COPY. */
function parseCopyLine(line) {
  const clean = line.replace(/\\\s*$/, '').trim();
  const jsonMatch = clean.match(/^COPY\s+(\[.*\])\s*$/i);
  let parts;
  if (jsonMatch) {
    try {
      parts = JSON.parse(jsonMatch[1]);
    } catch {
      return null;
    }
  } else {
    parts = clean.replace(/^COPY\s+/i, '').split(/\s+/).filter(Boolean);
  }
  if (!parts || parts.length < 2) return null;
  return { sources: parts.slice(0, -1), dest: parts[parts.length - 1], line: clean };
}

/**
 * Проверяет контекст сборки.
 * @returns {{errors: string[], warnings: string[], checked: number, contextFiles: number}}
 */
function checkDockerContext(options = {}) {
  const root = options.root || path.join(__dirname, '..');
  const dockerfilePath = path.join(root, options.dockerfile || 'Dockerfile');
  const ignorePath = path.join(root, options.dockerignore || '.dockerignore');
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(dockerfilePath)) {
    return { errors: ['в корне репозитория нет Dockerfile (хостинг не сможет собрать образ)'], warnings, checked: 0, contextFiles: 0 };
  }

  const rules = fs.existsSync(ignorePath) ? parseIgnore(fs.readFileSync(ignorePath, 'utf8')) : [];
  const entries = walk(root);

  // Контекст сборки: всё, что не вырезано .dockerignore
  const context = new Set();
  for (const item of entries) {
    const parts = item.path.split('/');
    let ignored = false;
    for (let i = 1; i <= parts.length; i += 1) {
      const sub = parts.slice(0, i).join('/');
      const isDir = i < parts.length || item.dir;
      if (isIgnored(rules, sub, isDir)) { ignored = true; break; }
    }
    if (!ignored && !item.dir) context.add(item.path);
  }

  const lines = fs.readFileSync(dockerfilePath, 'utf8').split(/\r?\n/);
  let checked = 0;

  lines.forEach((raw) => {
    if (!/^\s*COPY\b/i.test(raw) || /^\s*COPY\s+--from=/i.test(raw)) return;
    if (COPY_RE.test(raw) === false) return;
    const parsed = parseCopyLine(raw);
    if (!parsed) return;

    parsed.sources.forEach((rawSource) => {
      const source = rawSource.replace(/^\.?\//, '');
      if (source === '.') return;                       // «COPY . .» — весь контекст
      checked += 1;

      // Источник может быть шаблоном (package-lock.json*, public/*.js) — тогда достаточно
      // одного совпадения; без шаблона путь должен существовать точно.
      const matches = (p) => (isGlob(source)
        ? globToRegExp(source).test(p) || globToRegExp(source).test(p.split('/').pop())
        : p === source || p.startsWith(`${source}/`));

      const existsOnDisk = entries.some((e) => matches(e.path)) || (!isGlob(source) && fs.existsSync(path.join(root, source)));
      const inContext = [...context].some((p) => matches(p));

      if (!existsOnDisk) {
        errors.push(`COPY указывает на «${source}», но такого файла/папки нет в репозитории (${parsed.line})`);
      } else if (!inContext) {
        errors.push(`COPY указывает на «${source}», но этот путь исключён .dockerignore и не попадёт в образ (${parsed.line})`);
      }
    });
  });

  if (checked === 0) {
    warnings.push('в Dockerfile нет явных источников COPY кроме «COPY . .» — это нормально, но проверять нечего');
  }

  // Полезные предупреждения: важные для запуска файлы не должны быть в игноре
  ['server.js', 'package.json', 'public/index.html'].forEach((rel) => {
    const exists = entries.some((e) => e.path === rel);
    const ignored = isIgnored(rules, rel, false);
    if (exists && ignored) errors.push(`${rel} исключён .dockerignore — приложение не сможет запуститься`);
  });

  return { errors, warnings, checked, contextFiles: context.size };
}

/* ------------------------------------------------------------------- CLI */

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const { errors, warnings, checked, contextFiles } = checkDockerContext({ root });

  warnings.forEach((w) => console.log(`  ! ${w}`));
  if (errors.length) {
    console.error('\n❌ Контекст Docker-сборки неполный:');
    errors.forEach((e) => console.error(`   - ${e}`));
    console.error('\nЧто проверить на хостинге:');
    console.error('   1. Настройки проекта → Сборка → «Свой Dockerfile» (файл Dockerfile лежит в корне репозитория).');
    console.error('   2. Root Directory (папка проекта) должен быть пустым — проект лежит в корне репозитория.');
    console.error('   3. Редеплой с галкой «Без кэша Docker».');
    process.exit(1);
  }
  console.log(`  ✓ контекст сборки полный: ${checked} источник(ов) COPY, ${contextFiles} файлов попадут в образ`);
}

module.exports = { checkDockerContext, parseIgnore, isIgnored, globToRegExp, parseCopyLine };
