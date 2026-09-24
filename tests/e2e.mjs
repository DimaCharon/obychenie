/**
 * tests/e2e.mjs — сквозной тест в реальном браузере (Playwright).
 *
 * Проходит весь пользовательский путь на живом приложении с локальным мок-ИИ:
 * главная → мастер (тема, профиль) → уточняющие вопросы ИИ → план → карта пути →
 * урок (теория + тест) → результат → разбор ошибок → отчёты → профиль → настройки.
 * Дополнительно проверяет мобильную вёрстку и клиентский парсер JSON.
 *
 * Запуск:  npm run test:e2e      (если Playwright не установлен — тест пропускается)
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnNode, waitForHealth, freePort, sleep, ROOT } from './helpers.mjs';

let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    console.log('⚠️  Playwright не установлен — E2E-тест пропущен.');
    console.log('    Установка:  npx playwright install chromium && npm i -D playwright');
    process.exit(0);
  }
}

const results = [];
const failures = [];
function check(name, condition, extra = '') {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!condition) failures.push(name);
}

const shotDir = process.env.E2E_SHOTS || path.join(os.tmpdir(), 'duoai-e2e');
fs.mkdirSync(shotDir, { recursive: true });

const mockPort = await freePort(8800);
const appPort = await freePort(8830);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duoai-e2e-data-'));

const mock = spawnNode('tools/mock-ai.js', { env: { MOCK_PORT: String(mockPort) } });
const app = spawnNode('server.js', {
  env: {
    PORT: String(appPort),
    DATA_DIR: dataDir,
    AI_API_KEY: 'mock-key-e2e',
    AI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    AI_MODEL: 'mock-model',
  },
});

const base = `http://127.0.0.1:${appPort}`;
const errors = [];
let browser = null;

try {
  const health = await waitForHealth(base);
  console.log(`\n[E2E] приложение на ${base} (порт из PORT=${appPort}), ИИ: ${health.ai.model}\n`);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  const shot = async (name, opts = {}) => {
    await sleep(opts.wait ?? 500);
    await page.screenshot({ path: path.join(shotDir, `${name}.png`), full_page: Boolean(opts.full) });
  };

  /* 1. главная */
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle' });
  await sleep(800);
  check('главная открылась и видит ключ ИИ из окружения',
    (await page.locator('.key-pill').first().innerText()).includes('ИИ подключён'));
  await shot('01-home');

  /* 2. клиентский парсер JSON */
  const parser = await page.evaluate(() => {
    const cases = [
      '```json\n{"a":1}\n```',
      'Вот план:\n{"a":1,}\nГотово.',
      "{'a':1}",
      '{"a":"он сказал \'да\'"}',
      'никакого json',
    ];
    return cases.map((c) => {
      const r = AI.extractJson(c);
      return r ? JSON.stringify(r) : null;
    });
  });
  check('парсер JSON терпит ```-обёртку, висячие запятые, одинарные кавычки',
    parser[0] === '{"a":1}' && parser[1] === '{"a":1}' && parser[2] === '{"a":1}' && parser[4] === null,
    parser.join(' | '));

  /* 3. мастер: тема */
  await page.fill('#app .card input.input', 'Проценты и скидки');
  await page.click('button:has-text("Составить план")');
  await sleep(500);
  for (let i = 0; i < 4; i += 1) {
    await page.click('button:has-text("Далее →")');
    await sleep(220);
  }
  await shot('02-wizard');

  /* 4. уточняющие вопросы от ИИ */
  await page.click('button:has-text("Получить вопросы от ИИ")');
  await sleep(1500);
  const questionCount = await page.locator('.pill-row').count();
  check('ИИ задал уточняющие вопросы', questionCount >= 3, `вопросов: ${questionCount}`);
  await page.locator('.pill').first().click();
  await shot('03-interview', { full: true });

  /* 5. план */
  await page.click('button:has-text("Составить план обучения")');
  await sleep(2500);
  const course = await page.evaluate(() => {
    const s = JSON.parse(localStorage['duoai.state.v1']);
    return s.courses[s.activeCourseId];
  });
  const topicCount = course.sections.reduce((a, s) => a + s.topics.length, 0);
  check('курс создан по ответу ИИ (не демо-план)', course.source === 'ai', `источник: ${course.source}`);
  check('в плане 3 раздела и 9 тем', course.sections.length === 3 && topicCount === 9,
    `разделов ${course.sections.length}, тем ${topicCount}`);
  check('у каждой темы есть теория и тест',
    course.sections.every((s) => s.topics.every((t) => t.theory.length > 0 && t.quiz.length === 4)));
  const courseId = course.id;
  await shot('04-path', { full: true, wait: 1200 });

  /* 6. урок: теория → тест */
  await page.goto(`${base}/#/course/${courseId}`, { waitUntil: 'networkidle' });
  await sleep(800);
  const lockedHint = await page.locator('button:has-text("Откроется дальше")').count();
  check('последующие темы закрыты (как в Duolingo)', lockedHint >= 8, `замков: ${lockedHint}`);

  await page.click('button:has-text("Начать урок")');
  await sleep(700);
  check('первый шаг урока — теория', await page.locator('.theory-card').count() > 0);
  await shot('05-lesson');

  for (let i = 0; i < 12; i += 1) {
    if (await page.locator('.answer').count()) break;
    await page.locator('button:has-text("Дальше"), button:has-text("Перейти к тесту")').last().click();
    await sleep(320);
  }
  check('дошли до теста', await page.locator('.answer').count() === 4);

  for (let i = 0; i < 5; i += 1) {
    const answers = page.locator('.answer');
    if (!(await answers.count())) break;
    await answers.nth(0).click();          // в мок-ИИ верный вариант — первый
    await sleep(250);
    if (i === 0) check('после ответа показывается объяснение', await page.locator('.explain').count() > 0);
    await page.locator('.btn-row button').last().click();
    await sleep(400);
  }
  await shot('06-lesson-result', { full: true });
  const resultText = await page.locator('.card').first().innerText();
  check('показан результат теста со звёздами', /верно/.test(resultText));

  const progress = await page.evaluate(() => {
    const s = JSON.parse(localStorage['duoai.state.v1']);
    const c = s.courses[s.activeCourseId];
    return { xp: s.xpByDay, attempts: c.progress };
  });
  check('прогресс сохранён и начислен XP',
    Object.keys(progress.attempts).length >= 1 && Object.values(progress.xp).some((v) => v > 0));

  /* 7. чат с ИИ-учителем (кнопка «Спроси ИИ» внутри урока) */
  await page.goto(`${base}/#/lesson/${courseId}/t1`, { waitUntil: 'networkidle' });
  await sleep(800);
  await page.click('button:has-text("Спроси ИИ")');
  await sleep(600);
  await page.fill('#modal-host textarea', 'Объясни проще, что такое процент');
  await page.click('#modal-host button:has-text("Отправить")');
  await sleep(1500);
  check('ИИ-чат отвечает', await page.locator('#modal-host .msg.ai').count() >= 1);
  await shot('07-chat');
  await page.click('#modal-host .icon-btn');
  await sleep(300);

  /* 8. отчёты */
  await page.goto(`${base}/#/report/${courseId}`, { waitUntil: 'networkidle' });
  await sleep(900);
  await page.click('button:has-text("Получить разбор")');
  await sleep(2500);
  const aiReport = await page.evaluate(() => {
    const s = JSON.parse(localStorage['duoai.state.v1']);
    const c = s.courses[s.activeCourseId];
    return c.aiReport || null;
  });
  const reportScreenText = await page.locator('#app').innerText();
  check('разбор от ИИ по курсу получен и сохранён в прогрессе',
    Boolean(aiReport && aiReport.verdict) && /Сильные стороны/.test(reportScreenText),
    aiReport && aiReport.verdict ? aiReport.verdictSlice || 'есть verdict' : 'нет данных');
  check('в разборе есть рекомендации и зоны роста',
    Array.isArray(aiReport?.recommendations) && aiReport.recommendations.length >= 1
      && Array.isArray(aiReport?.weak) && aiReport.weak.length >= 1);
  await shot('08-report', { full: true });

  await page.locator('table.table tbody tr').first().click();
  await sleep(900);
  await page.click('button:has-text("Получить разбор")');
  await sleep(2500);
  check('отчёт по конкретной теме открылся', (await page.locator('.topbar-title').innerText()).length > 3);
  await shot('09-topic-report', { full: true });

  /* 9. настройки и профиль */
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle' });
  await sleep(1200);
  check('в настройках видно, что ключ пришёл из переменных окружения',
    (await page.locator('#app').innerText()).includes('AI_API_KEY'));
  await shot('10-settings', { full: true });

  await page.goto(`${base}/#/profile`, { waitUntil: 'networkidle' });
  await sleep(900);
  check('профиль показывает уровни/достижения', (await page.locator('#app').innerText()).includes('Достижения'));
  await shot('11-profile', { full: true });

  /* 9.1 профиль: имя и аватар редактируются и сохраняются */
  await page.click('button:has-text("Изменить")');
  await sleep(400);
  await page.fill('#modal-host input.input', 'Тестовый Ученик');
  await page.locator('#modal-host button.opt').nth(5).click();
  await page.click('#modal-host button:has-text("Сохранить")');
  await sleep(700);

  const profileSaved = await page.evaluate(() => JSON.parse(localStorage['duoai.state.v1']).user);
  check('имя ученика сохраняется в профиле', profileSaved.name === 'Тестовый Ученик', profileSaved.name);
  check('аватар ученика сохраняется в профиле', Boolean(profileSaved.avatar) && profileSaved.avatar !== '🐸', profileSaved.avatar);
  check('имя видно в оболочке приложения',
    (await page.locator('.brand').innerText()).includes('Тестовый Ученик')
    && (await page.locator('.rail').innerText()).includes('Тестовый Ученик'));
  check('профиль показывает дату регистрации', /ученик с/i.test(await page.locator('#app').innerText()));
  await shot('11b-profile-edited', { full: true });

  /* 9.2 ключ: вставка чистится, одно нажатие = один запрос, кнопка не дублирует */
  const apiCalls = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) apiCalls.push(`${r.method()} ${new URL(r.url()).pathname}`); });

  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle' });
  await sleep(1200);
  check('кнопка сохранения и проверки одна', await page.locator('button:has-text("Сохранить и проверить")').count() === 1);

  // вставка с пробелами и переводом строки должна обрезаться
  await page.evaluate(() => {
    const el = document.querySelector('input[type=password]');
    const dt = new DataTransfer();
    dt.setData('text', '  key-s-lishnimi-probelami\n ');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(300);
  check('вставленный ключ обрезается от пробелов',
    (await page.locator('input[type=password]').inputValue()) === 'key-s-lishnimi-probelami');

  apiCalls.length = 0;
  await page.click('button:has-text("Сохранить и проверить")');
  await sleep(2200);
  const posts = apiCalls.filter((c) => c === 'POST /api/config').length;
  const pings = apiCalls.filter((c) => c === 'POST /api/ping').length;
  check('одно нажатие = один запрос сохранения и один запрос проверки',
    posts === 1 && pings === 1, `config POST=${posts}, ping=${pings}`);
  check('после сохранения показывается результат проверки',
    /Подключение работает|ИИ не ответил|Ключ не задан/.test(await page.locator('#app').innerText()));
  check('поле ключа очищается только после успешного сохранения',
    (await page.locator('input[type=password]').inputValue()) === '');

  // повторное нажатие «Проверить подключение» — ровно один запрос
  apiCalls.length = 0;
  await page.click('button:has-text("Проверить подключение")');
  await sleep(2000);
  check('повторная проверка подключения — тоже один запрос',
    apiCalls.filter((c) => c === 'POST /api/ping').length === 1);

  // двойной клик не должен отправлять два запроса
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle' });
  await sleep(1100);
  apiCalls.length = 0;
  const saveBtn = page.locator('button:has-text("Сохранить и проверить")');
  await saveBtn.click();
  await saveBtn.click({ force: true });
  await sleep(2200);
  check('двойной клик не дублирует запросы',
    apiCalls.filter((c) => c === 'POST /api/config').length === 1
    && apiCalls.filter((c) => c === 'POST /api/ping').length === 1,
    apiCalls.join(', '));

  // ключ остался в настройках (не «пропал»)
  const cfgAfter = await (await fetch(`${base}/api/config`)).json();
  check('ключ остаётся сохранённым на сервере', cfgAfter.keySet === true, `источник: ${cfgAfter.keySource}`);

  /* 9.3 вёрстка: нет наложения и горизонтального переполнения */
  const overflow = await page.evaluate(`(() => {
    const bad = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push('страница шире окна');
    for (const c of document.querySelectorAll('.card, .grid, .path-section, .node-block')) {
      const cr = c.getBoundingClientRect();
      if (!cr.width) continue;
      for (const ch of c.children) {
        const r = ch.getBoundingClientRect();
        if (r.width && (r.right - cr.right > 2 || cr.left - r.left > 2)) bad.push(c.className.split(' ')[0] + ' → ' + ch.className.split(' ')[0]);
      }
    }
    return bad.slice(0, 5);
  })()`);
  check('вёрстка: карточки не наезжают друг на друга', overflow.length === 0, overflow.join('; '));

  /* 10. мобильная вёрстка */
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.on('pageerror', (e) => errors.push(`mobile: ${e.message}`));
  mobile.on('console', (m) => { if (m.type() === 'error') errors.push(`mobile console: ${m.text()}`); });
  await mobile.goto(`${base}/#/course/${courseId}`, { waitUntil: 'networkidle' });
  await sleep(900);
  const bottomNavVisible = await mobile.locator('.bottom-nav').isVisible();
  check('на мобильном видна нижняя навигация', bottomNavVisible);
  await mobile.screenshot({ path: path.join(shotDir, '12-mobile.png') });

  // ни один экран не должен «расползаться» по горизонтали на телефоне
  const mobileOverflow = [];
  for (const [w, h, tag] of [[390, 844, 'iphone'], [320, 700, 'small']]) {
    await mobile.setViewportSize({ width: w, height: h });
    for (const route of ['#/', '#/new?topic=Дроби', '#/reviews', '#/profile', '#/settings', `#/course/${courseId}`, `#/report/${courseId}`]) {
      await mobile.goto(`${base}/${route}`, { waitUntil: 'networkidle' });
      await sleep(600);
      const wide = await mobile.evaluate(`(() => {
        if (document.documentElement.scrollWidth <= window.innerWidth + 1) return null;
        return document.documentElement.scrollWidth + ' > ' + window.innerWidth;
      })()`);
      if (wide) mobileOverflow.push(`${tag} ${route}: ${wide}`);
    }
  }
  check('на телефоне (390 и 320 px) нет горизонтального переполнения',
    mobileOverflow.length === 0, mobileOverflow.join('; '));
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(`${base}/#/profile`, { waitUntil: 'networkidle' });
  await sleep(700);
  await mobile.screenshot({ path: path.join(shotDir, '13-mobile-profile.png'), full_page: true });

  // кнопки на телефоне должны быть удобного размера для пальца
  await mobile.goto(`${base}/#/course/${courseId}`, { waitUntil: 'networkidle' });
  await sleep(800);
  const tiny = await mobile.evaluate(`(() => [...document.querySelectorAll('button, .node-btn, a.btn')]
    .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 32; })
    .map((b) => (b.textContent || '').trim().slice(0, 20)).slice(0, 5))()`);
  check('на телефоне нет слишком мелких кнопок', tiny.length === 0, tiny.join(' | '));

  await browser.close();

  check('нет ошибок в консоли и необработанных исключений', errors.length === 0,
    errors.slice(0, 3).join(' / '));

  console.log(`\n[E2E] скриншоты: ${shotDir}`);
  console.log(`[E2E] пройдено ${results.filter((r) => r.ok).length} из ${results.length}`);

  if (failures.length) {
    console.error(`\n❌ Провалено: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ E2E-тест пройден полностью');
  }
} catch (err) {
  console.error('\n❌ E2E упал:', err.message);
  console.error(app.logs().slice(-3000));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  await app.stop();
  await mock.stop();
}
