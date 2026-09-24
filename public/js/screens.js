/* ==========================================================================
   screens.js — экраны приложения
   ========================================================================== */

const Screens = {};
const _cleanups = [];
function onCleanup(fn) { _cleanups.push(fn); }
function runCleanups() { while (_cleanups.length) { try { _cleanups.pop()(); } catch {} } }

/* ==========================================================================
   Обёртки над ИИ + демо-режим
   ========================================================================== */

function demoNotice(err) {
  if (err) console.warn('[duo-ai] ИИ недоступен:', err && (err.message || err));
  toast(err && err.code === 'NO_KEY'
    ? 'Ключ ИИ не задан — работает демо-режим. Ключ можно добавить в «Настройках».'
    : `ИИ недоступен (${err && err.message ? String(err.message).slice(0, 90) : 'ошибка'}) — включён демо-режим.`, 'err');
}

async function aiInterview(topic, profile) {
  if (!AI.isConfigured()) { demoNotice({ code: 'NO_KEY' }); return Mock.interview(topic); }
  try {
    const raw = await AI.json({
      system: Prompts.interview(topic, profile),
      user: `Сформулируй 3 уточняющих вопроса по теме «${topic}».`,
      temperature: 0.6, maxTokens: 1200,
    });
    const questions = (raw.questions || []).slice(0, 4).map((q) => ({
      q: String(q.q || q.question || '').slice(0, 300),
      options: (Array.isArray(q.options) ? q.options : []).slice(0, 5).map((o) => String(o).slice(0, 90)),
      allow_custom: q.allow_custom !== false,
    })).filter((q) => q.q);
    if (!questions.length) throw new Error('пустой список вопросов');
    return { questions };
  } catch (err) { demoNotice(err); return Mock.interview(topic); }
}

async function aiPlan(topic, profile, interview) {
  if (!AI.isConfigured()) { demoNotice({ code: 'NO_KEY' }); return { plan: Mock.plan(topic, profile), demo: true }; }
  try {
    const raw = await AI.json({
      system: Prompts.plan(topic, profile, interview),
      user: `Составь персональный курс по теме «${topic}».`,
      temperature: 0.55, maxTokens: 12288,
    });
    return { plan: raw, demo: false };
  } catch (err) { demoNotice(err); return { plan: Mock.plan(topic, profile), demo: true }; }
}

async function aiTopicContent(course, topic) {
  if (!AI.isConfigured()) return { demo: true, content: { theory: [], quiz: [] } };
  try {
    const raw = await AI.json({
      system: Prompts.topic(course.topic, topic.title, course.profile),
      user: `Сделай материал по теме «${topic.title}».`,
      temperature: 0.6, maxTokens: 3072,
    });
    return {
      demo: false,
      content: {
        theory: (Array.isArray(raw.theory) ? raw.theory : [])
          .map((b) => ({ h: String(b.h || b.title || 'Объяснение').slice(0, 90), body: String(b.body || '') }))
          .filter((b) => b.body),
        quiz: (Array.isArray(raw.quiz) ? raw.quiz : []).map((q) => Store.normalizeQuestion(q)).filter(Boolean),
      },
    };
  } catch (err) { demoNotice(err); return { demo: true, content: { theory: [], quiz: [] } }; }
}

async function aiExtra(course, topic, mistakes) {
  if (!AI.isConfigured()) return { demo: true, data: Mock.extra(course.topic, topic.title) };
  try {
    const data = await AI.json({
      system: Prompts.extra(course.topic, topic.title, mistakes, course.profile),
      user: 'Разбери ошибки и дай 3 новых вопроса.',
      temperature: 0.7, maxTokens: 2048,
    });
    data.quiz = (data.quiz || []).map((q) => Store.normalizeQuestion(q)).filter(Boolean);
    if (!data.quiz.length) throw new Error('нет вопросов в ответе');
    return { demo: false, data };
  } catch (err) { demoNotice(err); return { demo: true, data: Mock.extra(course.topic, topic.title) }; }
}

async function aiBonus(course) {
  if (!AI.isConfigured()) return { demo: true, data: Mock.bonus(course.topic) };
  try {
    const data = await AI.json({
      system: Prompts.bonus(course.topic, course.profile),
      user: 'Придумай практическое задание.',
      temperature: 0.8, maxTokens: 1600,
    });
    if (!data.title) throw new Error('пустое задание');
    return { demo: false, data };
  } catch (err) { demoNotice(err); return { demo: true, data: Mock.bonus(course.topic) }; }
}

async function aiReport(course, stats) {
  const topicStats = stats.topicStats || stats.topics || [];
  const payload = {
    doneCount: stats.doneCount,
    totalCount: stats.total,
    avg: stats.avg,
    xp: course.xp || 0,
    sessions: stats.sessions,
    minutes: stats.minutes,
    topics: topicStats.map((t) => ({ тема: t.title, статус: t.status, лучшийРезультат: t.best, попыток: t.attempts })),
  };
  if (!AI.isConfigured()) return { demo: true, data: Mock.report(payload) };
  try {
    const data = await AI.json({
      system: Prompts.report(course.topic, course.profile, payload),
      user: 'Составь отчёт об успеваемости.',
      temperature: 0.5, maxTokens: 2048,
    });
    if (!data.verdict) throw new Error('пустой отчёт');
    return { demo: false, data };
  } catch (err) { demoNotice(err); return { demo: true, data: Mock.report(payload) }; }
}

/* ==========================================================================
   Карта курса: узлы, тропы, бонус
   ========================================================================== */

const NODE_OFFSETS = [0.5, 0.78, 0.22, 0.62, 0.34, 0.9, 0.06, 0.7];

function topicNode(row, index) {
  const { status, topic, best } = row;
  const node = h('button.node', { dataset: { state: status }, onClick: () => onNodeClick(row) },
    status === 'current' ? h('span.node-teeth', { html: zigzag(110, '#1cb0f6', 18) }) : null,
    h('div.node-circle', {}, status === 'locked' ? '🔒' : (status === 'done' ? '✔' : (topic.emoji || '📘'))),
    status === 'done' && best ? h('span.node-xp', `+${Math.round(20 + best * 15)}`) : null,
    status === 'current' ? h('span.node-tip', 'СТАРТ') : null);
  if (status === 'current') node.appendChild(h('span.node-mascot', '🐸'));
  return node;
}

function onNodeClick(row) {
  if (row.status === 'locked') { toast('Тема закрыта: сначала пройди предыдущую'); return; }
  const cid = Store.active().id;
  App.go(`#/lesson/${cid}/${row.topic.id}${row.status === 'done' ? '?mode=review' : ''}`);
}

function nodeActions(row, courseId) {
  const { status, topic } = row;
  if (status === 'locked') {
    return [h('button.btn.sm.ghost', { onClick: () => toast('Сначала пройди предыдущую тему — темы открываются по порядку') }, '🔒 Откроется дальше')];
  }
  if (status === 'done') {
    return [
      h('button.btn.sm.blue', { onClick: () => App.go(`#/lesson/${courseId}/${topic.id}?mode=review`) }, '↻ Повторить'),
      h('button.btn.sm.ghost', { onClick: () => App.go(`#/report/${courseId}/${topic.id}`) }, 'Отчёт'),
    ];
  }
  return [
    h('button.btn.sm', { onClick: () => App.go(`#/lesson/${courseId}/${topic.id}`) }, 'Начать урок'),
    h('button.btn.sm.ghost', { onClick: () => App.go(`#/test/${courseId}/${topic.id}`) }, 'Сразу тест'),
  ];
}

/** Линии-тропы между узлами (рисуем после раскладки). */
function drawLines(wrap, svg) {
  const nodes = [...wrap.querySelectorAll('.node .node-circle')];
  const box = wrap.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.setAttribute('width', box.width);
  svg.setAttribute('height', box.height);
  if (nodes.length < 2) { svg.innerHTML = ''; return; }
  const pts = nodes.map((c) => {
    const r = c.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2, r: r.width / 2 };
  });
  let out = '';
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i]; const b = pts[i + 1];
    const dx = b.x - a.x; const dy = b.y - a.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len; const uy = dy / len;
    const p1 = { x: a.x + ux * (a.r + 4), y: a.y + uy * (a.r + 4) };
    const p2 = { x: b.x - ux * (b.r + 4), y: b.y - uy * (b.r + 4) };
    out += `<path d="M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}" stroke="#1d5a78" stroke-width="13" stroke-linecap="round" fill="none"/>`;
  }
  svg.innerHTML = out;
}

function layoutNodes(wrap) {
  const rowWidth = wrap.clientWidth || 0;
  const blocks = [...wrap.querySelectorAll('[data-node-block]')];
  blocks.forEach((block) => {
    const w = block.offsetWidth || 240;
    const max = Math.max(0, rowWidth - w - 4);
    const raw = Number(block.dataset.offset) || 0.5;
    block.style.marginLeft = `${Math.round(Math.min(max, Math.max(0, raw * rowWidth - w / 2)))}px`;
  });
}

function coursePathNode(course, courseId) {
  const data = Store.path(course);
  const stats = Store.stats(course);
  const wrap = h('div.path-wrap');
  const svg = h('svg.path-svg');
  wrap.appendChild(svg);

  let gi = 0;
  course.sections.forEach((section, si) => {
    const rows = data.rows.filter((r) => r.sectionIndex === si);
    const doneInSection = rows.filter((r) => r.status === 'done').length;

    wrap.appendChild(h(`div.path-section.${section.color || 'blue'}`, { style: { marginTop: si === 0 ? '0' : '30px' } },
      h('div.ps-body',
        h('div', {},
          h('div.ps-num', `Раздел ${si + 1}`),
          h('div.ps-title', section.title),
          section.subtitle ? h('div.ps-sub', section.subtitle) : null),
        h('button.ps-burger', { title: 'Что внутри раздела', onClick: () => sectionInfo(section, rows) }, '≡')),
      h('div.ps-bar', pbar(rows.length ? doneInSection / rows.length : 0, { thin: true })),
      h('div', { style: { fontSize: '12px', fontWeight: '800', marginTop: '6px', opacity: '.92' } },
        `${doneInSection}/${rows.length} ${plural(rows.length, 'тема', 'темы', 'тем')}`)));

    rows.forEach((row) => {
      const offset = NODE_OFFSETS[gi % NODE_OFFSETS.length];
      const block = h('div.node-block', { dataset: { nodeBlock: '', offset: String(offset) } },
        topicNode(row, gi),
        h('div.node-title', row.topic.title),
        row.topic.subtitle ? h('div.node-desc', row.topic.subtitle) : null,
        h('div.chip-row', { style: { justifyContent: 'center', marginTop: '8px' } },
          h('span.chip', `ур. ${'●'.repeat(row.topic.level)}${'○'.repeat(Math.max(0, 3 - row.topic.level))}`),
          h('span.chip', `✅ ${(row.topic.quiz || []).length}`),
          row.status === 'done' ? h('span.chip.green', `лучший ${Math.round((row.best || 0) * 100)}%`) : null),
        row.status === 'done' ? h('div', { style: { marginTop: '6px' } }, stars(Store.starsFor(row.best))) : null,
        h('div.node-actions', { style: { justifyContent: 'center' } }, nodeActions(row, courseId)));

      wrap.appendChild(h('div.node-row', { dataset: { i: String(gi) } }, block));
      gi += 1;
    });
  });

  wrap.appendChild(h('div.node-row', { style: { justifyContent: 'center', paddingTop: '26px' } },
    h('div.bonus-node', {},
      h('button.bonus-box', {
        style: data.allDone ? null : { filter: 'grayscale(.65)', opacity: '.7' },
        onClick: () => bonusOpen(course, data),
        title: data.allDone ? 'Бонусное задание' : 'Откроется после всех тем',
      }, '🏆'),
      h('div.bonus-label', data.allDone ? 'Бонус' : 'Бонус (закрыт)'))));

  let raf = 0;
  const relayout = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { layoutNodes(wrap); drawLines(wrap, svg); });
  };
  relayout();
  setTimeout(relayout, 120);
  setTimeout(relayout, 600);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout).catch(() => {});
  let ro = null;
  if (window.ResizeObserver) {
    ro = new ResizeObserver(relayout);
    ro.observe(wrap);
  }
  window.addEventListener('resize', relayout);
  onCleanup(() => {
    window.removeEventListener('resize', relayout);
    cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
  });

  return { node: wrap, data, stats, relayout };
}

function sectionInfo(section, rows) {
  modal({
    title: section.title,
    body: h('div', {},
      h('p.muted', section.subtitle || ''),
      h('div.hr'),
      h('div.stack', {}, rows.map((r) => h('div.inline', { style: { alignItems: 'flex-start' } },
        h('span', { style: { fontSize: '20px' } }, r.status === 'done' ? '✅' : r.status === 'current' ? '▶️' : '🔒'),
        h('div', {},
          h('div', { style: { fontWeight: '800' } }, r.topic.title),
          h('div.muted.tiny', (r.topic.teaches || []).join(' · ') || r.topic.subtitle || '')))))),
    actions: [{ label: 'Понятно' }],
  });
}

function courseMenu(course) {
  modal({
    title: 'Курс',
    body: h('div.stack',
      h('button.btn.ghost.block', { onClick: (close) => { close(); App.go(`#/report/${course.id}`); } }, '📊 Открыть отчёт'),
      h('button.btn.ghost.block', {
        onClick: (close) => { close(); rebuildPlan(course); },
      }, '↻ Пересобрать план через ИИ'),
      h('button.btn.ghost.block', {
        onClick: (close) => {
          close();
          App.go(`#/new?topic=${encodeURIComponent(course.topic)}`);
        },
      }, '🆕 Пройти похожий курс заново'),
      h('button.btn.ghost.block', {
        onClick: (close) => {
          close();
          const text = [course.title, course.summary, ''].concat(course.sections.map((s) =>
            `${s.title}:\n` + s.topics.map((t) => `  - ${t.title}`).join('\n'))).join('\n');
          navigator.clipboard?.writeText(text).then(
            () => toast('План курса скопирован', 'ok'),
            () => toast('Не удалось скопировать', 'err'));
        },
      }, '📋 Скопировать план'),
      h('button.btn.ghost.block', {
        onClick: async (close) => {
          close();
          if (await confirmDialog('Удалить курс?', 'Прогресс по курсу будет удалён безвозвратно.', 'Удалить', true)) {
            Store.removeCourse(course.id);
            toast('Курс удалён');
            App.go('#/');
          }
        },
      }, '🗑 Удалить курс')),
    actions: [{ label: 'Закрыть', style: 'ghost' }],
  });
}

let bonusBusy = false;

async function bonusOpen(course, data) {
  if (!data.allDone) { toast('Бонус откроется, когда пройдёшь все темы курса'); return; }
  if (bonusBusy) return;
  bonusBusy = true;
  const bodyHost = h('div', {}, loader('ИИ придумывает практическое задание…', ['Смотрю на пройденные темы…', 'Подбираю задачу под твою цель…']));
  const m = modal({ title: '🏆 Бонусное задание', wide: true, body: bodyHost, actions: [{ label: 'Закрыть', style: 'ghost' }] });

  const { data: task, demo } = await aiBonus(course);
  bonusBusy = false;
  const saved = course.bonus || {};
  const done = new Set(saved.doneChecklist || []);
  const checklist = task.checklist || [];

  const persist = (extra = {}) => Store.updateCourse(course.id, {
    bonus: {
      title: task.title, task: task.task, checklist, doneChecklist: [...done], demo, ...saved,
      ...extra,
    },
  });

  function render() {
    mount(bodyHost,
      h('h3', { style: { marginBottom: '8px' } }, task.title),
      h('p', { style: { whiteSpace: 'pre-wrap' } }, task.task),
      h('div.hr'),
      h('h4', { style: { marginBottom: '8px' } }, 'Критерии готовности'),
      h('ul.kp-list.check', {}, checklist.map((c, i) => h('li', {},
        h('label.inline', { style: { cursor: 'pointer', gap: '10px' } },
          h('input', {
            type: 'checkbox',
            checked: done.has(i),
            onChange: (e) => { if (e.target.checked) done.add(i); else done.delete(i); persist(); render(); },
          }),
          h('span', c))))),
      demo ? h('div.hint', { style: { marginTop: '10px' } }, 'Демо-режим: подключи ключ ИИ, чтобы получить персональное задание.') : null,
      done.size === checklist.length && checklist.length
        ? h('button.btn.block', {
          style: { marginTop: '16px' },
          onClick: () => {
            persist({ completedAt: new Date().toISOString() });
            Store.addXp(60);
            confetti(60);
            toast('Бонус выполнен! +60 XP', 'ok');
            m.close();
            App.render();
          },
        }, 'Завершить бонус (+60 XP)')
        : h('div.hint', { style: { marginTop: '12px' } }, 'Отметь все критерии, чтобы завершить задание.'));
  }
  render();
}

/* ==========================================================================
   Главная
   ========================================================================== */

function courseCard(course) {
  const stats = Store.stats(course);
  return h('div.card', {},
    h('div.inline', { style: { alignItems: 'flex-start' } },
      h('div', { style: { fontSize: '36px' } }, course.emoji || '🎯'),
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('h3', course.title),
        h('div.muted.small', { style: { marginTop: '4px' } }, course.summary ? String(course.summary).slice(0, 160) : course.topic),
        h('div.chip-row', { style: { marginTop: '10px' } },
          h('span.chip.green', `★ ${stats.doneCount}/${stats.total}`),
          h('span.chip.blue', `⚡ ${course.xp || 0} XP`),
          h('span.chip.gold', `🎯 ${stats.avg}%`),
          h('span.chip', `⏱ ${fmtMinutes(stats.minutes)}`)))),
    h('div', { style: { marginTop: '14px' } }, pbar(stats.progress)),
    h('div.btn-row', { style: { marginTop: '14px' } },
      h('button.btn.sm.blue', { onClick: () => App.go(`#/course/${course.id}`) }, stats.doneCount ? 'Продолжить' : 'Начать'),
      h('button.btn.sm.ghost', { onClick: () => App.go(`#/report/${course.id}`) }, '📊 Отчёт')));
}

Screens.home = () => {
  const courses = Store.courses().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const xp = Store.totalXp();
  const lvl = Store.level(xp);
  const st = Store.getState();

  const input = h('input.input', {
    placeholder: 'Например: дроби, фотосинтез, Python, проценты, законы Ньютона…',
    onKeydown: (e) => { if (e.key === 'Enter') go(e.target.value); },
  });
  const go = (topic) => {
    const t = String(topic || '').trim();
    if (t.length < 2) { toast('Введи тему (минимум 2 символа)', 'err'); return; }
    App.go(`#/new?topic=${encodeURIComponent(t)}`);
  };

  const me = Store.user();
  const named = Boolean(String(me.name || '').trim());

  const profileNudge = named ? null
    : h('div.card', { style: { borderColor: '#1d4f68', background: '#142a35' } },
      h('div.inline', {},
        h('span', { style: { fontSize: '26px' } }, me.avatar || '🐸'),
        h('div', { style: { flex: '1 1 240px' } },
          h('div', { style: { fontWeight: '900' } }, 'Давай познакомимся'),
          h('div.muted.small', 'Укажи имя и аватар — ИИ-учитель будет обращаться к тебе по имени, а отчёты станут персональными.')),
        h('button.btn.sm.blue', { onClick: () => editProfileDialog(() => App.render()) }, 'Заполнить профиль')));

  const keyBanner = (AppShell.cfg && AppShell.cfg.keySet) ? null
    : h('div.card', { style: { borderColor: '#5a4a12', background: '#241f14' } },
      h('div.inline', {},
        h('span', { style: { fontSize: '26px' } }, '🔑'),
        h('div', { style: { flex: '1 1 240px' } },
          h('div', { style: { fontWeight: '900' } }, 'Демо-режим: ИИ ещё не подключён'),
          h('div.muted.small', 'Планы и объяснения сейчас шаблонные. Вставь API-ключ — и учитель начнёт работать по-настоящему: персональные планы, объяснения под твой уровень и разбор ошибок.')),
        h('button.btn.sm.orange', { onClick: () => App.go('#/settings') }, 'Ввести ключ ИИ')));

  return {
    title: 'Duo-AI',
    subtitle: 'Персональный ИИ-учитель по любой теме',
    node: h('div.stack', {},
      profileNudge,
      keyBanner,
      h('div.card', { style: { padding: '26px', background: 'linear-gradient(160deg,#20343c,#16262c)' } },
        h('div.inline', { style: { alignItems: 'center', gap: '18px' } },
          h('div', { style: { fontSize: '62px' } }, me.avatar || '🐸'),
          h('div', { style: { flex: '1 1 280px' } },
            h('h1', { style: { fontSize: '26px' } }, named ? `${Store.userName()}, чему учимся?` : 'Чему хочешь научиться?'),
            h('p.muted', { style: { marginTop: '6px' } }, 'Введи тему — ИИ-учитель расспросит про твой уровень, соберёт персональный план, объяснит материал, проверит тестом и покажет отчёт о прогрессе.'))),
        h('div.inline', { style: { marginTop: '18px', gap: '10px' } },
          h('div', { style: { flex: '1 1 280px' } }, input),
          h('button.btn.orange', { onClick: () => go(input.value) }, 'Составить план')),
        h('div.chip-row', { style: { marginTop: '14px' } },
          ['Обыкновенные дроби', 'Фотосинтез', 'Python: циклы', 'Проценты', 'Законы Ньютона'].map((t) =>
            h('button.chip', { onClick: () => go(t) }, t)))),
      h('div.grid.four', {},
        statCard(`${xp}`, 'Всего XP', '#ffc800'),
        statCard(`Ур. ${lvl}`, LEVEL_TITLES[Math.min(LEVEL_TITLES.length - 1, lvl - 1)], '#58cc02'),
        statCard(`${st.streak.count || 0} 🔥`, 'Дней подряд', '#ff9600'),
        statCard(`${st.sessions}`, 'Тестов пройдено', '#1cb0f6')),
      h('h2', { style: { marginTop: '8px' } }, 'Мои курсы'),
      courses.length
        ? h('div.grid.two', {}, courses.map(courseCard))
        : h('div.card.muted.center', { style: { padding: '26px' } }, 'Пока нет ни одного курса — введи тему выше и нажми «Составить план».')),
  };
};

/* ==========================================================================
   Мастер нового курса
   ========================================================================== */

Screens.newCourse = (params = {}) => {
  const stepTitles = ['Тема', 'Кто ты', 'О тебе', 'Твои знания', 'Уточнения ИИ'];
  let step = 0;
  let busy = false;              // одно нажатие = один запрос, пока не придёт ответ
  let lastQuestions = null;

  const profile = {
    studentName: Store.userName(),
    role: 'school', grade: '7', course: '1', age: '', hours: '', level: 3,
    known: '', unknown: '', goal: '', style: [], deadline: '', interview: null, topic: params.topic || '',
  };

  const bar = h('div.pbar.thin', {}, h('i'));
  const stepLabel = h('div.muted.small');
  const body = h('div');
  const node = h('div.stack', {},
    h('div.card', { style: { background: 'linear-gradient(160deg,#20343c,#16262c)' } },
      h('div.between', h('h2', 'Новый курс с ИИ-учителем'), h('span.chip.blue', 'персональный план')),
      h('p.muted.small', { style: { marginTop: '8px' } }, 'Ответь на несколько вопросов — от возраста и уровня зависят объяснения, примеры и сложность тестов.'),
      h('div', { style: { marginTop: '12px' } }, stepLabel, h('div', { style: { height: '6px' } }), bar)),
    body);

  function renderStep() {
    bar.firstChild.style.width = `${Math.round(((step + 1) / stepTitles.length) * 100)}%`;
    stepLabel.textContent = `Шаг ${step + 1} из ${stepTitles.length} · ${stepTitles[step]}`;
    const host = h('div.card.fade-in');

    if (step === 0) {
      const input = h('input.input', { value: profile.topic, placeholder: 'Что хочешь изучить?' });
      input.addEventListener('input', () => { profile.topic = input.value; });
      mount(host,
        h('div.field', h('span.lbl', 'Тема обучения'), input,
          h('div.hint', 'Чем конкретнее тема, тем точнее план. Вместо «математика» лучше «проценты и задачи на скидки».')),
        h('div.chip-row', ['Обыкновенные дроби', 'Проценты', 'Законы Ньютона', 'Фотосинтез', 'Python: списки', 'Кредитное плечо'].map((t) =>
          h('button.chip', { onClick: () => { profile.topic = t; input.value = t; } }, t))));
    }

    if (step === 1) {
      const roles = [
        { id: 'school', l: 'Школьник', d: '1–11 класс' },
        { id: 'student', l: 'Студент', d: 'курс вуза или колледжа' },
        { id: 'adult', l: 'Взрослый', d: 'учусь для себя или работы' },
      ];
      const extra = h('div', { style: { marginTop: '16px' } });
      if (profile.role === 'school') {
        const sel = h('select.select', { value: profile.grade, onChange: (e) => { profile.grade = e.target.value; } },
          Array.from({ length: 11 }).map((_, i) => h('option', { value: String(i + 1), selected: profile.grade === String(i + 1) }, `${i + 1} класс`)));
        mount(extra, h('div.field', h('span.lbl', 'Класс'), sel));
      }
      if (profile.role === 'student') {
        const sel = h('select.select', { value: profile.course, onChange: (e) => { profile.course = e.target.value; } },
          Array.from({ length: 6 }).map((_, i) => h('option', { value: String(i + 1), selected: profile.course === String(i + 1) }, `${i + 1} курс`)));
        mount(extra, h('div.field', h('span.lbl', 'Курс'), sel));
      }
      mount(host,
        h('div.field', h('span.lbl', 'Кто ты?'),
          h('div.opt-grid', roles.map((r) => h('button.opt' + (profile.role === r.id ? '.sel' : ''), {
            onClick: () => { profile.role = r.id; renderStep(); },
          }, r.l, h('span.opt-d', r.d))))),
        extra);
    }

    if (step === 2) {
      const ages = ['10–12', '13–15', '16–18', '19–25', '26+'];
      const hours = ['15 минут в день', '30 минут в день', '2–3 часа в неделю', 'Только по выходным'];
      const styles = ['С примерами', 'По шагам', 'Сначала теория', 'Больше практики', 'С картинками и схемами'];
      mount(host,
        h('div.field', h('span.lbl', 'Сколько тебе лет?'),
          h('div.pill-row', ages.map((t) => h('button.pill' + (profile.age === t ? '.sel' : ''), {
            onClick: () => { profile.age = profile.age === t ? '' : t; renderStep(); },
          }, t)))),
        h('div.field', h('span.lbl', 'Сколько времени готов(а) уделять?'),
          h('div.pill-row', hours.map((t) => h('button.pill' + (profile.hours === t ? '.sel' : ''), {
            onClick: () => { profile.hours = profile.hours === t ? '' : t; renderStep(); },
          }, t)))),
        h('div.field', h('span.lbl', 'Как удобнее учиться? (можно несколько)'),
          h('div.pill-row', styles.map((t) => h('button.pill' + (profile.style.includes(t) ? '.sel' : ''), {
            onClick: () => {
              profile.style = profile.style.includes(t) ? profile.style.filter((x) => x !== t) : [...profile.style, t];
              renderStep();
            },
          }, t)))),
        h('div.field', h('span.lbl', 'Срок (необязательно)'),
          h('div.pill-row', ['На этой неделе', 'Через месяц', 'Без спешки'].map((t) =>
            h('button.pill' + (profile.deadline === t ? '.sel' : ''), {
              onClick: () => { profile.deadline = profile.deadline === t ? '' : t; renderStep(); },
            }, t)))));
    }

    if (step === 3) {
      const levelNote = ['', 'слышу впервые', 'что-то слышал(а)', 'немного разбираюсь', 'уверенно, но с пробелами', 'знаю хорошо, хочу углубить'];
      const known = h('textarea.textarea', { placeholder: 'Например: понимаю, что такое числитель и знаменатель, складываю дроби с одинаковыми знаменателями' }, profile.known);
      known.addEventListener('input', () => { profile.known = known.value; });
      const unknown = h('textarea.textarea', { placeholder: 'Например: не понимаю, зачем приводить к общему знаменателю, путаюсь при вычитании' }, profile.unknown);
      unknown.addEventListener('input', () => { profile.unknown = unknown.value; });
      mount(host,
        h('div.field', h('span.lbl', 'Как ты оцениваешь свои знания по теме?'),
          h('div.pill-row', [1, 2, 3, 4, 5].map((n) => h('button.pill' + (profile.level === n ? '.sel' : ''), {
            onClick: () => { profile.level = n; renderStep(); },
          }, `${n} — ${levelNote[n]}`)))),
        h('div.field', h('span.lbl', 'Что уже знаешь?'), known),
        h('div.field', h('span.lbl', 'Что именно не понятно?'), unknown),
        h('div.field', h('span.lbl', 'Цель (необязательно)'),
          h('input.input', {
            value: profile.goal,
            placeholder: 'Например: сдать контрольную на 4, разобраться для себя, сделать проект',
            onInput: (e) => { profile.goal = e.target.value; },
          })));
    }

    if (step === 4) {
      mount(host,
        h('p', 'ИИ-учитель задаст уточняющие вопросы, чтобы план был точнее. Можно ответить, а можно сразу собрать план.'),
        h('div.btn-row', { style: { marginTop: '12px' } },
          h('button.btn.blue', { onClick: goInterview, disabled: busy }, 'Получить вопросы от ИИ'),
          h('button.btn.ghost', { onClick: () => generate(null), disabled: busy }, 'Пропустить и составить план')));
    }

    mount(body, host, h('div.btn-row', { style: { marginTop: '14px', justifyContent: 'space-between' } },
      step > 0 ? h('button.btn.ghost', { onClick: () => { step -= 1; renderStep(); } }, '← Назад') : h('span'),
      step < 4 ? h('button.btn', { onClick: next }, 'Далее →') : null));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function next() {
    if (step === 0) {
      profile.topic = profile.topic.trim();
      if (profile.topic.length < 2) { toast('Введи тему (минимум 2 символа)', 'err'); return; }
    }
    step += 1;
    renderStep();
  }

  async function goInterview() {
    if (busy) return;
    busy = true;
    mount(body, loader('ИИ готовит уточняющие вопросы…', ['Читаю твой профиль…', 'Ищу, чего не хватает для плана…', 'Формулирую вопросы…']));
    const { questions } = await aiInterview(profile.topic, profile);
    busy = false;
    lastQuestions = questions;
    const answers = {};

    const list = h('div.stack');
    questions.forEach((q, i) => {
      const pills = h('div.pill-row', (q.options || []).map((o) => h('button.pill', {
        onClick: () => {
          answers[i] = o;
          [...pills.children].forEach((c) => c.classList.remove('sel'));
        },
      }, o)));
      const custom = h('input.input', { placeholder: 'Свой ответ…', style: { marginTop: '8px' } });
      custom.addEventListener('input', () => { answers[i] = custom.value; });
      list.appendChild(h('div', {},
        h('div', { style: { fontWeight: '800', marginBottom: '8px' } }, `${i + 1}. ${q.q}`),
        pills,
        q.allow_custom === false ? null : custom));
    });

    mount(body, h('div.card.fade-in', {},
      h('h2', { style: { marginBottom: '4px' } }, 'Уточняющие вопросы'),
      h('p.muted.small', 'Можно выбрать вариант или написать свой ответ.'),
      list,
      h('div.btn-row', { style: { marginTop: '16px' } },
        h('button.btn', { onClick: () => generate(answers) }, 'Составить план обучения'),
        h('button.btn.ghost', { onClick: () => { step = 3; renderStep(); } }, '← Назад'))));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function generate(answers) {
    if (busy) return;
    busy = true;
    profile.interview = answersToText(answers);
    mount(body, loader('ИИ-учитель составляет твой план…', [
      'Разбираю твой уровень…',
      'Подбираю порядок тем от простого к сложному…',
      'Пишу объяснения простым языком…',
      'Составляю тесты по каждой теме…',
      'Проверяю, чтобы всё вело к твоей цели…',
    ]));
    const { plan, demo } = await aiPlan(profile.topic, profile, profile.interview);
    const course = Store.createCourse({ topic: profile.topic, profile, plan, interview: profile.interview });
    confetti(36);
    toast(demo ? 'План собран в демо-режиме: добавь ключ ИИ в «Настройках»' : `Курс «${course.title}» готов!`, demo ? 'err' : 'ok');
    App.go(`#/course/${course.id}`);
  }

  renderStep();
  return { title: 'Новое обучение', subtitle: 'Мастер персонального плана', node };
};

function answersToText(answers) {
  if (!answers) return '';
  const parts = Object.entries(answers).filter(([, v]) => String(v || '').trim());
  return parts.map(([k, v]) => `вопрос ${Number(k) + 1}: ${v}`).join('; ');
}

/** Пересобрать план курса через ИИ (например, если он собран в демо-режиме). */
async function rebuildPlan(course) {
  if (!AI.isConfigured()) {
    toast('Сначала добавь ключ ИИ — открою настройки', 'err');
    App.go('#/settings');
    return;
  }
  const ok = await confirmDialog(
    'Пересобрать план через ИИ?',
    'ИИ составит новый персональный план по этой теме с объяснениями и тестами. Прогресс по текущим темам сбросится.',
    'Пересобрать',
  );
  if (!ok) return;

  const host = h('div', {}, loader('ИИ составляет новый план…', [
    'Читаю твой профиль…', 'Подбираю порядок тем…', 'Пишу объяснения…', 'Составляю тесты…',
  ]));
  modal({ title: 'Обновление плана', body: host, actions: [] });

  const { plan, demo } = await aiPlan(course.topic, course.profile, course.interview);
  const normalized = Store.normalizePlan(plan, course.topic, course.profile);
  Store.updateCourse(course.id, {
    title: normalized.title,
    emoji: normalized.emoji,
    summary: normalized.summary,
    sections: normalized.sections,
    source: demo ? 'demo' : 'ai',
    progress: {},
    aiReport: null,
    topicReports: null,
  });
  toast(demo ? 'ИИ не ответил — план остался демонстрационным' : 'Новый план готов!', demo ? 'err' : 'ok');
  App.render();
}

/* ==========================================================================
   Экран курса (карта пути)
   ========================================================================== */

Screens.path = (params = {}) => {
  const course = Store.getCourse(params.id);
  if (!course) return screensNotFound('Курс не найден');
  Store.setActive(course.id);

  const built = coursePathNode(course, course.id);
  const stats = built.stats;
  const next = built.data.rows.find((r) => r.status === 'current');

  return {
    title: course.title,
    subtitle: `${stats.doneCount} из ${stats.total} тем · средний результат ${stats.avg}%`,
    actions: [
      next ? h('button.btn.sm', { onClick: () => App.go(`#/lesson/${course.id}/${next.topic.id}`) }, 'Продолжить') : null,
      h('button.btn.sm.ghost', { onClick: () => App.go(`#/report/${course.id}`) }, '📊 Отчёт'),
      h('button.btn.sm.ghost', { onClick: () => courseMenu(course) }, '⚙️'),
    ].filter(Boolean),
    node: h('div', {},
      course.source === 'demo'
        ? h('div.card', { style: { marginBottom: '14px', borderColor: '#5a4a12', background: '#241f14' } },
          h('div.inline', {},
            h('span', { style: { fontSize: '24px' } }, '⚠️'),
            h('div', { style: { flex: '1 1 240px' } },
              h('div', { style: { fontWeight: '900' } }, 'Этот план собран в демо-режиме'),
              h('div.muted.small', 'ИИ не ответил: ключ не задан или произошла ошибка. Темы, объяснения и тесты сейчас шаблонные.')),
            h('button.btn.sm.orange', { onClick: () => App.go('#/settings') }, 'Подключить ИИ'),
            h('button.btn.sm.ghost', { onClick: () => rebuildPlan(course) }, '↻ Пересобрать с ИИ')))
        : null,
      h('div.card', { style: { marginBottom: '18px' } },
        h('div.inline', { style: { alignItems: 'flex-start' } },
          h('div', { style: { fontSize: '40px' } }, course.emoji || '🎯'),
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: { fontWeight: '900', fontSize: '17px' } }, course.title),
            h('div.muted.small', { style: { marginTop: '4px' } }, course.summary),
            h('div.chip-row', { style: { marginTop: '10px' } },
              h('span.chip.blue', `⚡ ${course.xp || 0} XP`),
              h('span.chip.gold', `★ ${stats.stars}/${stats.maxStars}`),
              h('span.chip', `⏱ ${fmtMinutes(stats.minutes)}`),
              h('span.chip', course.source === 'demo' ? '' : 'green', course.source === 'demo' ? 'демо-план' : 'план от ИИ')))),
        h('div', { style: { marginTop: '12px' } }, pbar(stats.progress)),
        h('div.tiny.muted', { style: { marginTop: '8px' } }, `Профиль: ${Prompts.profileText(course.profile)}`)),
      built.node),
  };
};

/* ==========================================================================
   Урок (теория + тест)
   ========================================================================== */

Screens.lesson = (params = {}) => {
  const course = Store.getCourse(params.id);
  if (!course) return screensNotFound('Курс не найден');
  const found = Store.topicById(course, params.tid);
  if (!found) return screensNotFound('Тема не найдена');
  const { topic } = found;

  const state = { steps: [], index: 0, answers: {}, mistakes: [], startedAt: Date.now(), finished: false };
  const bar = h('div.pbar', {}, h('i'));
  const counter = h('span.muted.small');
  const stage = h('div', { style: { marginTop: '18px' } });

  const node = h('div', {},
    h('div.lesson-top',
      h('button.icon-btn', { title: 'Выйти', onClick: leave }, '✕'),
      bar,
      counter,
      h('button.btn.sm.purple', { onClick: () => chatModal(course, topic) }, '🤖 Спроси ИИ')),
    stage);

  function quizCount() { return state.steps.filter((s) => s.type === 'q').length; }

  function renderSteps() {
    const quiz = (topic.quiz || []).slice();
    state.steps = [
      ...(topic.theory || []).map((b) => ({ type: 'theory', block: b })),
      { type: 'points' },
      ...quiz.map((q) => ({ type: 'q', q })),
    ];
    const total = state.steps.length;
    bar.firstChild.style.width = `${Math.round((state.index / total) * 100)}%`;
    counter.textContent = `${Math.min(state.index + 1, total)}/${total}`;

    const step = state.steps[state.index];
    if (!step) { finish(); return; }

    const prevBtn = h('button.btn.ghost', { onClick: prev, disabled: state.index === 0 }, '← Назад');
    let card;
    let nav;

    if (step.type === 'theory') {
      card = h('div.fade-in', {},
        h('span.tag', 'ТЕОРИЯ'),
        h('div.theory-card', { style: { marginTop: '10px' } },
          h('h4', step.block.h),
          h('p', step.block.body)));
      nav = h('div.btn-row', { style: navStyle }, prevBtn,
        h('button.btn', { onClick: nextStep }, 'Дальше'));
    } else if (step.type === 'points') {
      const points = (topic.teaches && topic.teaches.length)
        ? topic.teaches
        : ['Разбери тему на своём примере', 'Объясни её своими словами', 'Проверь себя тестом'];
      card = h('div.fade-in', {},
        h('span.tag', 'ГЛАВНОЕ'),
        h('h2', { style: { margin: '10px 0 14px' } }, `Что важно запомнить: ${topic.title}`),
        h('ul.kp-list', {}, points.map((t) => h('li', {}, t))));
      nav = h('div.btn-row', { style: navStyle }, prevBtn,
        h('button.btn', { onClick: nextStep }, 'Перейти к тесту'));
    } else {
      const built = buildQuestion(step.q, prevBtn);
      card = built.card;
      nav = built.nav;
    }

    mount(stage, card, nav);
  }

  const navStyle = { marginTop: '18px', justifyContent: 'space-between' };

  /** Карточка вопроса + навигация. Возвращает { card, nav }. */
  function buildQuestion(q, prevBtn) {
    const idx = state.index;
    const answered = Object.prototype.hasOwnProperty.call(state.answers, idx);
    const chosen = state.answers[idx];
    const totalQ = quizCount();
    const qNumber = state.steps.slice(0, idx + 1).filter((s) => s.type === 'q').length;
    const isLast = idx === state.steps.length - 1;

    const answersHost = h('div');
    const feedback = h('div');
    const nextBtn = h('button.btn', {
      disabled: !answered,
      onClick: () => { state.index += 1; renderSteps(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
    }, isLast ? 'Завершить урок' : 'Дальше');

    function paint(selected) {
      [...answersHost.children].forEach((el, i) => {
        el.classList.add('locked');
        el.classList.toggle('correct', i === q.answer);
        el.classList.toggle('wrong', i === selected && i !== q.answer);
      });
      const ok = selected === q.answer;
      mount(feedback, h(`div.explain.${ok ? 'ok' : 'bad'}.fade-in`, {},
        h('b', ok ? '✅ Верно!' : '❌ Почти!'),
        h('div', q.explain || (ok ? 'Так и есть.' : `Правильный ответ: «${q.options[q.answer]}».`)),
        ok ? null : h('div', { style: { marginTop: '10px' } },
          h('button.btn.sm.purple', {
            onClick: () => chatModal(course, topic, `Не понял(а): ${q.q} — объясни, пожалуйста, почему верно «${q.options[q.answer]}»?`),
          }, '🤖 Объясни проще'))));
      nextBtn.disabled = false;
    }

    function choose(i) {
      state.answers[idx] = i;
      if (i !== q.answer) state.mistakes.push({ q: q.q, chosen: q.options[i], correct: q.options[q.answer] });
      paint(i);
    }

    answersHost.append(...q.options.map((opt, i) => h('button.answer', {
      onClick: () => { if (!Object.prototype.hasOwnProperty.call(state.answers, idx)) choose(i); },
    }, h('span.k', String.fromCharCode(1040 + i)), h('span', {}, opt))));

    const card = h('div.q-card.fade-in', {},
      h('div.muted.tiny', { style: { marginBottom: '8px', letterSpacing: '1px' } }, `ВОПРОС ${qNumber} ИЗ ${totalQ}`),
      h('div.q-text', q.q),
      answersHost,
      feedback);
    const nav = h('div.btn-row', { style: navStyle }, prevBtn, nextBtn);

    if (answered) paint(chosen);
    return { card, nav };
  }

  function nextStep() { state.index += 1; renderSteps(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function prev() { state.index = Math.max(0, state.index - 1); renderSteps(); }

  function leave() {
    if (state.finished) { App.go(`#/course/${course.id}`); return; }
    confirmDialog('Выйти из урока?', 'Прогресс по этой попытке не сохранится.', 'Выйти', true).then((ok) => {
      if (ok) App.go(`#/course/${course.id}`);
    });
  }

  function finish() {
    state.finished = true;
    const seconds = Math.round((Date.now() - state.startedAt) / 1000);
    const quizSteps = state.steps.filter((s) => s.type === 'q');
    const total = quizSteps.length || 1;
    let correct = 0;
    state.steps.forEach((s, i) => { if (s.type === 'q' && state.answers[i] === s.q.answer) correct += 1; });
    const score = correct / total;

    const before = (course.progress[topic.id] || {}).attempts || 0;
    const { gained } = Store.saveResult(course.id, topic.id, {
      score, correct, total, seconds, mistakes: state.mistakes,
    });
    const passed = score >= Store.PASS;
    if (passed) confetti(50);

    bar.firstChild.style.width = '100%';
    counter.textContent = 'готово';
    mount(stage, h('div.card.fade-in', { style: { textAlign: 'center', padding: '28px' } },
      h('div', { style: { fontSize: '56px' } }, score >= 1 ? '🏆' : passed ? '🎉' : '💪'),
      h('h1', { style: { margin: '10px 0 4px' } }, passed ? 'Тема пройдена!' : 'Почти получилось'),
      h('div', { style: { fontSize: '22px', fontWeight: '900', color: passed ? 'var(--green)' : 'var(--orange)' } },
        `${correct} из ${total} верно · ${Math.round(score * 100)}%`),
      h('div', { style: { margin: '12px 0' } }, stars(Store.starsFor(score))),
      h('div.chip-row', { style: { justifyContent: 'center' } },
        h('span.chip.gold', `+${gained} XP`),
        h('span.chip', `⏱ ${fmtMinutes(Math.max(1, Math.round(seconds / 60)))}`),
        before === 0 && passed ? h('span.chip.green', 'новая тема открыта') : null),
      state.mistakes.length
        ? h('div.card.card-soft', { style: { textAlign: 'left', marginTop: '18px' } },
          h('h4', { style: { marginBottom: '10px' } }, `Ошибки: ${state.mistakes.length}`),
          h('div.stack', {}, state.mistakes.map((m) => h('div', {},
            h('div.small', { style: { fontWeight: '800' } }, m.q),
            h('div.tiny', { style: { color: '#ffb3b3' } }, `твой ответ: ${m.chosen}`),
            h('div.tiny', { style: { color: '#b8f28a' } }, `верно: ${m.correct}`)))))
        : h('p.muted', { style: { marginTop: '14px' } }, 'Ни одной ошибки — отличная работа!'),
      h('div.btn-row', { style: { marginTop: '22px', justifyContent: 'center' } },
        state.mistakes.length ? h('button.btn.purple', { onClick: workoutMistakes }, '🤖 Разобрать ошибки') : null,
        h('button.btn', { onClick: () => App.go(`#/course/${course.id}`) }, 'К карте курса'),
        h('button.btn.ghost', { onClick: () => App.go(`#/report/${course.id}/${topic.id}`) }, 'Отчёт по теме'),
        !passed ? h('button.btn.ghost', { onClick: reset }, 'Пройти снова') : null)));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function reset() {
    state.index = 0; state.answers = {}; state.mistakes = []; state.finished = false; state.startedAt = Date.now();
    renderSteps();
  }

  let mistakesBusy = false;

  async function workoutMistakes() {
    if (mistakesBusy) return;
    mistakesBusy = true;
    const host = h('div', {}, loader('ИИ разбирает твои ошибки…', ['Смотрю, где ты ошибся…', 'Ищу причину ошибки…', 'Готовлю похожие вопросы…']));
    const m = modal({ title: '🤖 Разбор ошибок', wide: true, body: host, actions: [{ label: 'Закрыть', style: 'ghost' }] });
    const { data, demo } = await aiExtra(course, topic, state.mistakes);
    mistakesBusy = false;
    const runner = h('div');
    mount(host,
      h('p', { style: { whiteSpace: 'pre-wrap' } }, data.analysis),
      demo ? h('div.hint', 'Демо-режим: подключи ключ ИИ, чтобы получить персональный разбор.') : null,
      h('div.hr'),
      h('h4', { style: { marginBottom: '10px' } }, 'Похожие задания'),
      runner);
    QuizRunner(runner, data.quiz || [], {
      mode: 'extra',
      onFinish: (res) => {
        if (res.score >= 0.7) {
          Store.addXp(25);
          confetti(30);
          toast('Закреплено! +25 XP', 'ok');
          m.close();
          App.go(`#/report/${course.id}/${topic.id}`);
        } else {
          toast('Ошибок стало меньше — попробуй ещё раз');
        }
      },
    });
  }

  if (!(topic.theory || []).length || !(topic.quiz || []).length) {
    mount(stage, loader('ИИ готовит материал по теме…', ['Разбираю тему…', 'Пишу объяснение простым языком…', 'Составляю вопросы…']));
    aiTopicContent(course, topic).then(({ content }) => {
      if (content.theory.length) topic.theory = content.theory;
      if (content.quiz.length) topic.quiz = content.quiz;
      if (!(topic.theory || []).length) {
        topic.theory = (Mock.plan(course.topic, course.profile).sections[0].topics[0].theory);
      }
      if (!(topic.quiz || []).length) {
        topic.quiz = Mock.plan(course.topic, course.profile).sections[0].topics[0].quiz;
      }
      Store.updateCourse(course.id, { sections: course.sections });
      renderSteps();
    });
  } else {
    renderSteps();
  }

  return { title: topic.title, subtitle: course.title, node, fullscreen: true };
};

/* ------------------------------------------------ ИИ-чат по теме (модалка) */

function chatModal(course, topic, prefill) {
  const host = h('div');
  const log = h('div.chat-box');
  const input = h('textarea.textarea', { placeholder: 'Спроси что угодно по теме…', style: { minHeight: '64px' } });
  const send = h('button.btn.sm.blue', { onClick: submit }, 'Отправить');
  let busy = false;

  const history = (course.chat && course.chat[topic.id]) || [];
  history.forEach((m) => log.appendChild(bubble(m.role, m.text)));

  if (!history.length) {
    log.appendChild(bubble('sys', `Я вижу твой профиль и эту тему: «${topic.title}». Спрашивай как удобно — объясню проще, приведу пример или разберу ошибку.`));
  }

  function bubble(role, text) {
    return h(`div.msg.${role === 'user' ? 'me' : role === 'sys' ? 'sys' : 'ai'}`, text);
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    busy = true;
    log.appendChild(bubble('user', text));
    Store.addChat(course.id, topic.id, { role: 'user', text });
    const typing = h('div.msg.ai.typing', {}, h('span'), h('span'), h('span'));
    log.appendChild(typing);
    log.scrollTop = log.scrollHeight;

    const hist = (course.chat[topic.id] || []).slice(-8)
      .map((m) => `${m.role === 'user' ? 'Ученик' : 'Учитель'}: ${m.text}`).join('\n');

    let reply;
    if (!AI.isConfigured()) {
      reply = 'Сейчас работает демо-режим без ключа ИИ. Добавь ключ в «Настройках» — и я смогу объяснять материал '
        + 'под твой профиль: разбирать ошибки, приводить примеры и придумывать задачи.';
    } else {
      try {
        reply = await AI.chat({
          system: [
            TEACHER_RULES,
            '',
            `Ученик: ${Prompts.profileText(course.profile)}.`,
            `Курс: «${course.title}». Текущая тема: «${topic.title}».`,
            topic.theory && topic.theory.length ? `Материал темы: ${topic.theory.map((b) => b.body).join(' ').slice(0, 1200)}` : '',
            'Отвечай коротко (до 130 слов), по делу, с конкретным примером. Если ученик просит проще — упрощай до бытового сравнения.',
          ].filter(Boolean).join('\n'),
          user: `${hist ? `История диалога:\n${hist}\n\n` : ''}Новый вопрос ученика: ${text}`,
          temperature: 0.7,
          maxTokens: 900,
        });
      } catch (err) {
        reply = `Не получилось обратиться к ИИ: ${err.message}`;
      }
    }

    typing.remove();
    log.appendChild(bubble('ai', reply));
    log.scrollTop = log.scrollHeight;
    Store.addChat(course.id, topic.id, { role: 'assistant', text: reply });
    busy = false;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  mount(host,
    log,
    h('div.hr'),
    h('div.chip-row', {},
      ['Объясни проще', 'Дай пример из жизни', 'Зачем это нужно?', 'Дай задачу посложнее'].map((t) =>
        h('button.chip', { onClick: () => { input.value = t; submit(); } }, t))),
    input,
    h('div.btn-row', { style: { marginTop: '10px', justifyContent: 'flex-end' } }, send));

  const m = modal({ title: `🤖 ИИ-учитель · ${topic.title}`, wide: true, body: host, actions: [] });
  setTimeout(() => log.scrollTop = log.scrollHeight, 50);
  if (prefill) { input.value = prefill; submit(); }
  return m;
}

/* ==========================================================================
   Тест-раннер
   ========================================================================== */

function QuizRunner(host, questions, { onFinish } = {}) {
  const state = { index: 0, answers: {}, mistakes: [], startedAt: Date.now() };
  const total = questions.length;
  const bar = h('div.pbar.thin', { style: { marginBottom: '12px' } }, h('i'));
  const stage = h('div');

  function render() {
    bar.firstChild.style.width = `${Math.round((state.index / total) * 100)}%`;
    if (state.index >= total) { finish(); return; }
    const q = questions[state.index];
    const answersHost = h('div');
    const feedback = h('div');
    const nextBtn = h('button.btn', {
      disabled: true,
      onClick: () => { state.index += 1; render(); },
    }, state.index === total - 1 ? 'Показать результат' : 'Дальше');

    const paint = (i) => {
      state.answers[state.index] = i;
      const ok = i === q.answer;
      if (!ok) state.mistakes.push({ q: q.q, chosen: q.options[i], correct: q.options[q.answer] });
      [...answersHost.children].forEach((el, k) => {
        el.classList.add('locked');
        el.classList.toggle('correct', k === q.answer);
        el.classList.toggle('wrong', k === i && !ok);
      });
      mount(feedback, h(`div.explain.${ok ? 'ok' : 'bad'}.fade-in`,
        h('b', ok ? '✅ Верно!' : '❌ Почти!'),
        h('div', q.explain || `Правильный ответ: «${q.options[q.answer]}»`)));
      nextBtn.disabled = false;
    };

    answersHost.append(...q.options.map((opt, i) => h('button.answer', { onClick: () => paint(i) },
      h('span.k', String.fromCharCode(1040 + i)), h('span', {}, opt))));

    mount(stage, h('div.q-card', {},
      h('div.muted.tiny', { style: { marginBottom: '8px' } }, `ВОПРОС ${state.index + 1} ИЗ ${total}`),
      h('div.q-text', q.q), answersHost, feedback),
    h('div.btn-row', { style: { marginTop: '16px', justifyContent: 'flex-end' } }, nextBtn));
    mount(host, bar, stage);
  }

  function finish() {
    const correct = questions.filter((q, i) => state.answers[i] === q.answer).length;
    const score = correct / (total || 1);
    mount(stage, h('div.card.center', {},
      h('div', { style: { fontSize: '44px' } }, score >= 0.7 ? '🎉' : '💪'),
      h('h3', { style: { margin: '8px 0' } }, `${correct} из ${total} верно · ${Math.round(score * 100)}%`),
      stars(Store.starsFor(score))));
    if (onFinish) onFinish({ correct, total, score, mistakes: state.mistakes, seconds: Math.round((Date.now() - state.startedAt) / 1000) });
  }

  render();
}

/* ==========================================================================
   Отдельный тест по теме
   ========================================================================== */

Screens.test = (params = {}) => {
  const course = Store.getCourse(params.id);
  if (!course) return screensNotFound('Курс не найден');
  const found = Store.topicById(course, params.tid);
  if (!found) return screensNotFound('Тема не найдена');
  const { topic } = found;

  const stage = h('div', { style: { marginTop: '8px' } });
  const node = h('div', {},
    h('div.lesson-top',
      h('button.icon-btn', { title: 'Выйти', onClick: () => App.go(`#/course/${course.id}`) }, '✕'),
      h('div', { style: { flex: '1 1 auto' } }, h('div', { style: { fontWeight: '900' } }, `Тест: ${topic.title}`)),
      h('button.btn.sm.purple', { onClick: () => chatModal(course, topic) }, '🤖 Спроси ИИ')),
    stage);

  function run(questions) {
    if (!questions.length) {
      mount(stage, h('div.card.center', {}, 'Для этой темы пока нет вопросов — начни урок, и ИИ подготовит материал.'));
      return;
    }
    QuizRunner(stage, questions, {
      onFinish: (res) => {
        Store.saveResult(course.id, topic.id, res);
        if (res.score >= Store.PASS) { confetti(40); toast('Тест пройден!', 'ok'); } else { toast('Можно улучшить результат'); }
        mount(stage, h('div.card.center', { style: { padding: '28px' } },
          h('div', { style: { fontSize: '50px' } }, res.score >= Store.PASS ? '🏆' : '💪'),
          h('h2', { style: { margin: '8px 0' } }, res.score >= Store.PASS ? 'Тема зачтена!' : 'Пока не хватает баллов'),
          h('p.muted', `Верных ответов: ${res.correct} из ${res.total} (${Math.round(res.score * 100)}%)`),
          h('div.btn-row', { style: { justifyContent: 'center', marginTop: '16px' } },
            h('button.btn', { onClick: () => App.go(`#/course/${course.id}`) }, 'К карте курса'),
            h('button.btn.ghost', { onClick: () => App.go(`#/report/${course.id}/${topic.id}`) }, 'Отчёт по теме'),
            h('button.btn.purple', { onClick: () => fresh() }, '🤖 Новые вопросы от ИИ'))));
      },
    });
  }

  async function fresh() {
    mount(stage, loader('ИИ придумывает новые вопросы…', ['Смотрю, что уже спрашивали…', 'Составляю вопросы посложнее…']));
    const { content, demo } = await aiTopicContent(course, topic);
    if (content.quiz.length) { topic.quiz = content.quiz; Store.updateCourse(course.id, { sections: course.sections }); }
    if (demo) toast('Демо-режим: вопросы из плана курса', 'err');
    run(content.quiz.length ? content.quiz : (topic.quiz || []));
  }

  run((topic.quiz || []).slice());

  return { title: 'Тест', subtitle: topic.title, node, fullscreen: true };
};

/* ==========================================================================
   Отчёты
   ========================================================================== */

function xpChart(days) {
  const max = Math.max(10, ...days.map((d) => d.xp));
  const compact = days.length > 8;
  return h('div.bars-wrap', {},
    h('div.mini-bars', {}, days.map((d, i) => h('div.mb', { title: `${d.day}: ${d.xp} XP` },
      h('i', { style: { height: `${Math.round((d.xp / max) * 100)}%` } }),
      h('span.lbl', {
        style: compact && i % 2 === 1 ? { opacity: 0 } : null,
      }, compact
        ? String(Number(d.day.slice(8, 10)))
        : new Date(d.day).toLocaleDateString('ru-RU', { day: 'numeric', month: 'numeric' }))))));
}

function reportCard(course, stats, aiData, reload, isBusy) {
  const d = aiData || {};
  return h('div.card', {},
    h('div.between', {},
      h('h3', '🤖 Разбор от ИИ-учителя'),
      h('button.btn.sm.ghost', {
        onClick: reload,
        disabled: Boolean(isBusy && isBusy()),
      }, d.verdict ? 'Обновить' : 'Получить разбор')),
    d.verdict
      ? h('div', { style: { marginTop: '12px' } },
        h('p', { style: { fontWeight: '700' } }, d.verdict),
        d.grade ? h('div.chip-row', { style: { marginTop: '6px' } }, h('span.chip.gold', `уровень: ${d.grade}`)) : null,
        h('div.grid.two', { style: { marginTop: '14px' } },
          h('div.card.card-soft', {},
            h('h4', { style: { color: 'var(--green)', marginBottom: '8px' } }, '💪 Сильные стороны'),
            h('ul.kp-list', {}, (d.strengths || []).map((s) => h('li', {}, s)))),
          h('div.card.card-soft', {},
            h('h4', { style: { color: 'var(--orange)', marginBottom: '8px' } }, '🎯 Зоны роста'),
            h('ul.kp-list', {}, (d.weak || []).map((s) => h('li', {}, s))))),
        h('div.card.card-soft', { style: { marginTop: '12px' } },
          h('h4', { style: { color: 'var(--blue)', marginBottom: '8px' } }, '🚀 Что делать дальше'),
          h('ul.kp-list', {}, (d.recommendations || []).map((s) => h('li', {}, s)))),
        stats.weak.length
          ? h('div', { style: { marginTop: '12px' } },
            h('div.small.muted', 'Темы, которые стоит повторить:'),
            h('div.chip-row', { style: { marginTop: '6px' } }, stats.weak.slice(0, 6).map((t) =>
              h('button.chip', { onClick: () => App.go(`#/report/${course.id}/${t.id}`) }, `${t.title} · ${t.best}%`))))
          : null)
      : h('p.muted', { style: { marginTop: '10px' } }, 'Нажми «Получить разбор» — ИИ проанализирует результаты по темам и подскажет, что делать дальше.'));
}

Screens.report = (params = {}) => {
  if (!params.id) {
    const courses = Store.courses();

    if (!courses.length) {
      return {
        title: 'Отчёты',
        subtitle: 'Здесь появятся результаты обучения',
        node: emptyState('Отчётов пока нет',
          'Создай первый курс: после каждого теста здесь появится статистика по темам, ошибки, график активности и разбор от ИИ-учителя.',
          h('div.btn-row', { style: { justifyContent: 'center', marginTop: '14px' } },
            h('button.btn', { onClick: () => App.go('#/new') }, 'Создать курс'),
            h('button.btn.ghost', { onClick: () => App.go('#/') }, 'На главную'))),
      };
    }

    if (courses.length === 1) { setTimeout(() => App.go(`#/report/${courses[0].id}`)); }

    return {
      title: 'Отчёты',
      subtitle: `${courses.length} ${plural(courses.length, 'курс', 'курса', 'курсов')} · выбери, по какому смотреть успеваемость`,
      node: h('div.grid.two', {}, courses.map(courseCard)),
    };
  }

  const course = Store.getCourse(params.id);
  if (!course) return screensNotFound('Курс не найден');
  const stats = Store.stats(course);
  const holder = h('div');
  let loadingReport = false;

  const renderReport = () => {
    mount(holder, reportCard(course, stats, course.aiReport, getReport, () => loadingReport));
  };

  async function getReport() {
    if (loadingReport) return;
    loadingReport = true;
    mount(holder, loader('ИИ анализирует успеваемость…', ['Смотрю результаты по темам…', 'Ищу слабые места…', 'Подбираю рекомендации…']));
    const { data, demo } = await aiReport(course, stats);
    Store.updateCourse(course.id, { aiReport: { ...data, demo } });
    toast(demo ? 'Демо-разбор: подключи ключ ИИ для персонального анализа' : 'Разбор готов', demo ? 'err' : 'ok');
    loadingReport = false;
    renderReport();
  }

  renderReport();

  const copyText = () => {
    const lines = [
      `Отчёт по курсу «${course.title}»`,
      `Пройдено тем: ${stats.doneCount} из ${stats.total}`,
      `Средний результат: ${stats.avg}%`,
      `Звёзды: ${stats.stars} из ${stats.maxStars}`,
      `Время занятий: ${fmtMinutes(stats.minutes)}`,
      `XP по курсу: ${course.xp || 0}`,
      '',
      'Темы:',
      ...stats.topicStats.map((t) => `- ${t.title}: ${t.status === 'done' ? 'пройдено' : 'в процессе'} · лучший ${t.best}% · попыток ${t.attempts}`),
    ];
    if (course.aiReport && course.aiReport.verdict) {
      lines.push('', 'Разбор ИИ:', course.aiReport.verdict,
        'Сильные стороны: ' + (course.aiReport.strengths || []).join('; '),
        'Зоны роста: ' + (course.aiReport.weak || []).join('; '),
        'Рекомендации: ' + (course.aiReport.recommendations || []).join('; '));
    }
    navigator.clipboard?.writeText(lines.join('\n')).then(
      () => toast('Отчёт скопирован', 'ok'),
      () => toast('Не удалось скопировать', 'err'));
  };

  const rows = h('table.table', {},
    h('thead', {}, h('tr', {},
      h('th', 'Тема'), h('th', 'Раздел'), h('th', 'Статус'), h('th', 'Лучший'), h('th', 'Попыток'), h('th', 'Время'), h('th', '★'))),
    h('tbody', {}, stats.topicStats.map((t) => h('tr.clickable', { onClick: () => App.go(`#/report/${course.id}/${t.id}`) },
      h('td', {}, h('span', { style: { marginRight: '8px' } }, t.emoji), t.title),
      h('td.muted.small', t.section),
      h('td', {}, h('span.chip' + (t.status === 'done' ? '.green' : t.status === 'current' ? '.blue' : ''),
        t.status === 'done' ? 'пройдено' : t.status === 'current' ? 'текущая' : 'закрыта')),
      h('td', { style: { fontWeight: '800' } }, `${t.best}%`),
      h('td', `${t.attempts}`),
      h('td', `${t.minutes} мин`),
      h('td', {}, stars(t.stars))))));

  return {
    title: `Отчёт: ${course.title}`,
    subtitle: `${stats.doneCount}/${stats.total} тем · средний результат ${stats.avg}% · ${fmtMinutes(stats.minutes)}`,
    actions: [
      h('button.btn.sm.ghost', { onClick: () => App.go(`#/course/${course.id}`) }, 'К курсу'),
      h('button.btn.sm.ghost', { onClick: copyText }, '📋 Копировать'),
      h('button.btn.sm.blue', { onClick: () => window.print() }, '🖨 PDF'),
    ],
    node: h('div.stack', {},
      h('div.grid.four', {},
        statCard(`${stats.doneCount}/${stats.total}`, 'Тем пройдено', '#58cc02'),
        statCard(`${stats.avg}%`, 'Средний результат', '#1cb0f6'),
        statCard(`${stats.stars}/${stats.maxStars}`, 'Звёзд собрано', '#ffc800'),
        statCard(`${course.xp || 0}`, 'XP по курсу', '#ce82ff')),
      h('div.grid.two', {},
        h('div.card', {},
          h('h3', { style: { marginBottom: '12px' } }, 'Активность за 14 дней'),
          xpChart(Store.lastDays(14))),
        h('div.card.center', {},
          h('h3', { style: { marginBottom: '12px' } }, 'Освоение курса'),
          ring(stats.progress, { size: 132, stroke: 13, color: '#58cc02' }),
          h('p.muted.small', { style: { marginTop: '12px' } },
            `${stats.doneCount} из ${stats.total} тем · ${stats.sessions} ${plural(stats.sessions, 'попытка', 'попытки', 'попыток')} теста`))),
      holder,
      h('div.card', {}, h('h3', { style: { marginBottom: '10px' } }, 'Успеваемость по темам'),
        h('div.table-wrap', {}, rows),
        h('div.tiny.muted', { style: { marginTop: '10px' } }, 'Нажми на строку, чтобы открыть отчёт по конкретной теме.')),
      h('div.card', {},
        h('h3', { style: { marginBottom: '10px' } }, 'Профиль обучения'),
        h('div.stack', {},
          h('div', h('b', 'Тема запроса: '), course.topic),
          h('div', h('b', 'Кто: '), Prompts.profileText(course.profile)),
          h('div', h('b', 'Цель: '), (course.profile && course.profile.goal) || 'не указана'),
          course.interview ? h('div', h('b', 'Уточнения ИИ: '), course.interview) : null,
          h('div.muted.tiny', `Курс создан ${fmtDate(course.createdAt)} · последняя активность ${fmtDate(course.updatedAt)}`)))),
  };
};

/* ------------------------------------------------ Отчёт по отдельной теме */

Screens.topicReport = (params = {}) => {
  const course = Store.getCourse(params.id);
  if (!course) return screensNotFound('Курс не найден');
  const found = Store.topicById(course, params.tid);
  if (!found) return screensNotFound('Тема не найдена');
  const { topic, section } = found;
  const p = course.progress[topic.id] || {};
  const best = Math.round((p.best || 0) * 100);
  const attempts = p.attempts || 0;
  const history = p.history || [];
  const mistakes = p.mistakes || [];
  const starsN = Store.starsFor(p.best || 0);
  const holder = h('div');

  const historyChart = h('div.bars-wrap', { style: { marginTop: '10px' } },
    h('div.mini-bars', {}, (history.length ? history : [{ score: 0 }]).map((hrow, i) => h('div.mb', { title: `${Math.round((hrow.score || 0) * 100)}%` },
      h('i', {
        style: {
          height: `${Math.max(3, Math.round((hrow.score || 0) * 100))}%`,
          background: (hrow.score || 0) >= Store.PASS ? 'var(--green)' : 'var(--orange)',
        },
      }),
      h('span.lbl', `№${i + 1}`)))));

  function renderAi() {
    const ai = course.topicReports && course.topicReports[topic.id];
    mount(holder, ai
      ? h('div.card', {},
        h('h3', { style: { marginBottom: '10px' } }, '🤖 Комментарий ИИ-учителя'),
        h('p', { style: { fontWeight: '700' } }, ai.verdict),
        h('div.grid.two', { style: { marginTop: '12px' } },
          h('div.card.card-soft', {}, h('h4', { style: { color: 'var(--green)', marginBottom: '8px' } }, '💪 Получается'),
            h('ul.kp-list', {}, (ai.strengths || []).map((s) => h('li', {}, s)))),
          h('div.card.card-soft', {}, h('h4', { style: { color: 'var(--orange)', marginBottom: '8px' } }, '🎯 Над чем работать'),
            h('ul.kp-list', {}, (ai.weak || []).map((s) => h('li', {}, s))))),
        h('div.card.card-soft', { style: { marginTop: '12px' } },
          h('h4', { style: { color: 'var(--blue)', marginBottom: '8px' } }, '🚀 Следующие шаги'),
          h('ul.kp-list', {}, (ai.recommendations || []).map((s) => h('li', {}, s)))))
      : h('div.card', {},
        h('h3', { style: { marginBottom: '8px' } }, '🤖 Комментарий ИИ-учителя'),
        h('p.muted', 'ИИ разберёт именно эту тему: что получается, где пробел и как его закрыть за 15–30 минут.'),
        h('div.btn-row', { style: { marginTop: '12px' } },
          h('button.btn.sm', { onClick: getAi }, 'Получить разбор'))));
  }

  let topicReportBusy = false;

  async function getAi() {
    if (topicReportBusy) return;
    topicReportBusy = true;
    mount(holder, loader('ИИ разбирает тему…', ['Смотрю результаты попыток…', 'Анализирую ошибки…']));
    const single = {
      doneCount: (p.best || 0) >= Store.PASS ? 1 : 0,
      totalCount: 1,
      avg: best,
      xp: course.xp || 0,
      sessions: attempts,
      minutes: Math.round((p.seconds || 0) / 60),
      topics: [{ тема: topic.title, статус: (p.best || 0) >= Store.PASS ? 'пройдено' : 'в процессе', лучшийРезультат: best, попыток: attempts, ошибки: mistakes.map((m) => m.q).slice(0, 4) }],
    };
    const { data, demo } = await aiReport(course, single);
    const store = course.topicReports || {};
    store[topic.id] = { ...data, demo };
    Store.updateCourse(course.id, { topicReports: store });
    topicReportBusy = false;
    toast(demo ? 'Демо-разбор: подключи ключ ИИ' : 'Разбор готов', demo ? 'err' : 'ok');
    renderAi();
  }

  renderAi();

  return {
    title: topic.title,
    subtitle: `${course.title} · ${section.title}`,
    actions: [
      h('button.btn.sm.ghost', { onClick: () => App.go(`#/course/${course.id}`) }, 'К курсу'),
      h('button.btn.sm.ghost', { onClick: () => App.go(`#/report/${course.id}`) }, 'Весь отчёт'),
    ],
    node: h('div.stack', {},
      h('div.card', {},
        h('div.inline', { style: { alignItems: 'flex-start' } },
          h('div', { style: { fontSize: '36px' } }, topic.emoji || '📘'),
          h('div', { style: { flex: '1 1 auto' } },
            h('h3', topic.title),
            h('div.muted.small', topic.subtitle || ''),
            h('div.chip-row', { style: { marginTop: '10px' } },
              h('span.chip' + ((p.best || 0) >= Store.PASS ? '.green' : '.gold'), (p.best || 0) >= Store.PASS ? 'пройдено' : 'в процессе'),
              h('span.chip.blue', `лучший ${best}%`),
              h('span.chip', `попыток: ${attempts}`),
              h('span.chip', `⏱ ${Math.round((p.seconds || 0) / 60)} мин`),
              h('span.chip.gold', `★ ${starsN}`)))),
        h('div', { style: { marginTop: '12px' } }, stars(starsN))),
      h('div.grid.two', {},
        h('div.card', {}, h('h3', { style: { marginBottom: '6px' } }, 'История попыток'), historyChart),
        h('div.card', {},
          h('h3', { style: { marginBottom: '10px' } }, `Ошибки в тестах (${mistakes.length})`),
          mistakes.length
            ? h('div.stack', {}, mistakes.map((m) => h('div', {},
              h('div.small', { style: { fontWeight: '800' } }, m.q),
              h('div.tiny', { style: { color: '#ffb3b3' } }, `твой ответ: ${m.chosen}`),
              h('div.tiny', { style: { color: '#b8f28a' } }, `верно: ${m.correct}`))))
            : h('p.muted', 'Ошибок не зафиксировано — либо тест ещё не проходился, либо всё верно.'),
          h('div.btn-row', { style: { marginTop: '14px' } },
            h('button.btn.sm', { onClick: () => App.go(`#/lesson/${course.id}/${topic.id}?mode=review`) }, '↻ Повторить урок'),
            h('button.btn.sm.ghost', { onClick: () => App.go(`#/test/${course.id}/${topic.id}`) }, 'Пройти тест')))),
      holder,
      h('div.card', {},
        h('h3', { style: { marginBottom: '10px' } }, 'Материал темы'),
        h('ul.kp-list', {}, (topic.teaches || []).map((t) => h('li', {}, t))),
        (topic.theory || []).length
          ? h('div', { style: { marginTop: '12px' } }, topic.theory.map((b) => h('div.theory-card', { style: { marginBottom: '10px' } },
            h('h4', b.h), h('p', b.body))))
          : h('p.muted', { style: { marginTop: '10px' } }, 'Материал появится после открытия урока.'))),
  };
};

/* ==========================================================================
   Настройки (ключ ИИ)
   ========================================================================== */

Screens.settings = () => {
  const cfgHost = h('div.card', {}, loader('Читаю настройки…', ['Проверяю конфигурацию сервера…']));

  (async () => {
    let cfg = await AI.getConfig(true).catch(() => ({}));

    let busy = false;

    /* ---------------------------------------------------------- элементы */

    const baseUrl = h('input.input', {
      value: cfg.baseUrl || '',
      placeholder: 'https://inference.dahl.global/v1',
      autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      inputmode: 'url',
    });
    const model = h('input.input', {
      value: cfg.model || '',
      placeholder: 'deepseek-ai/DeepSeek-V4-Flash-0731',
      autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
    });

    // Ключ: поле видимое (можно проверить, что вставилось), с кнопкой «показать».
    const key = h('input.input', {
      type: 'password',
      placeholder: cfg.keySet ? 'ключ уже сохранён — вставь новый, чтобы заменить' : 'вставь ключ API (Ctrl+V)',
      autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      style: { paddingRight: '96px' },
    });
    // Вставка «как есть» не должна превращаться в кашу из пробелов и переводов строк
    key.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData)?.getData('text');
      if (!text) return;
      e.preventDefault();
      key.value = text.trim();
      key.dispatchEvent(new Event('input'));
    });
    key.addEventListener('input', () => {
      // мягкая подсветка: если в ключе что-то не так — скажем сразу, а не после сохранения
      const value = key.value.trim();
      hint.textContent = value
        ? (value.length < 12
          ? `⚠️ Ключ короткий: ${value.length} символов — обычно их 40+. Проверь, что скопировал целиком.`
          : `Готово к сохранению: ${value.length} символов, начинается на «${value.slice(0, 4)}…»`)
        : defaultHint;
      hint.style.color = value && value.length < 12 ? 'var(--orange)' : '';
      syncButtons();
    });

    const eye = h('button.btn.sm.ghost', {
      style: { position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)', minHeight: '34px' },
      onClick: () => {
        const hidden = key.type === 'password';
        key.type = hidden ? 'text' : 'password';
        eye.textContent = hidden ? '🙈 скрыть' : '👁 показать';
      },
    }, '👁 показать');
    const keyWrap = h('div', { style: { position: 'relative' } }, key, eye);

    const defaultHint = 'Ключ можно также задать переменной окружения AI_API_KEY — она имеет приоритет над полем.';
    const hint = h('div.hint', defaultHint);

    const status = h('div');

    const saveBtn = h('button.btn', { onClick: () => saveAndTest() }, '💾 Сохранить и проверить');
    const testBtn = h('button.btn.ghost', { onClick: () => runTest(), disabled: !cfg.keySet }, '⚡ Проверить подключение');
    const clearBtn = cfg.keyFromEnv
      ? h('button.btn.ghost', {
        onClick: () => toast('Ключ задан переменной окружения AI_API_KEY. Убери её в настройках проекта на хостинге и сделай редеплой.', 'err'),
      }, '🔒 Ключ из окружения')
      : h('button.btn.ghost', {
        onClick: async () => {
          if (busy) return;
          if (!await confirmDialog('Удалить ключ?', 'Приложение перейдёт в демо-режим: планы и объяснения станут шаблонными.', 'Удалить', true)) return;
          setBusy(true, 'Удаляю ключ…');
          await AI.saveConfig({ clear: true });
          key.value = '';
          setBusy(false);
          toast('Ключ удалён — включён демо-режим');
          App.refreshKeyPill();
          renderScreen(await AI.getConfig(true).catch(() => ({})));
        },
      }, '🗑 Удалить ключ');

    function syncButtons() {
      saveBtn.disabled = busy;
      testBtn.disabled = busy || !(cfg.keySet || key.value.trim());
      clearBtn.disabled = busy;
    }

    function setBusy(value, text) {
      busy = value;
      syncButtons();
      if (value) mount(status, h('div.inline', {}, h('div.spin.dark'), h('span.muted.small', text || 'Работаю…')));
    }

    /* -------------------------------------------------------- действия */

    /** Одно нажатие: сохранить ключ и сразу проверить его ответом модели. */
    async function saveAndTest() {
      if (busy) return;
      const pending = key.value.trim();
      setBusy(true, pending ? 'Сохраняю ключ…' : 'Сохраняю настройки…');

      const body = { baseUrl: baseUrl.value.trim(), model: model.value.trim() };
      if (pending) body.apiKey = pending;

      const saved = await AI.saveConfig(body);

      if (saved.error) {
        setBusy(false);
        mount(status, h('div.explain.bad', {},
          h('b', '❌ Не удалось сохранить'),
          h('div.small', saved.error)));
        return;                                    // ключ остаётся в поле — вводить заново не нужно
      }

      // Поле очищаем ТОЛЬКО после успешного сохранения, чтобы ключ не «пропадал» на глазах
      if (pending) key.value = '';
      hint.textContent = defaultHint;
      hint.style.color = '';

      (saved.keyWarnings || []).forEach((w) => toast(w, 'err'));
      App.refreshKeyPill();

      setBusy(true, 'Проверяю ключ запросом к модели…');
      const ping = await AI.ping();
      setBusy(false);

      const next = await AI.getConfig(true).catch(() => saved);
      renderStatus(next, ping);
      if (ping && ping.ok) {
        confetti(24);
        toast('Подключение работает — ИИ отвечает', 'ok');
      } else {
        toast('Ключ сохранён, но подключиться не удалось', 'err');
      }
    }

    async function runTest() {
      if (busy) return;
      setBusy(true, 'Отправляю тестовый запрос к модели…');
      const ping = await AI.ping();
      setBusy(false);
      renderStatus(await AI.getConfig(true).catch(() => cfg), ping);
      toast(ping && ping.ok ? `ИИ ответил: ${ping.reply || 'ok'} (${ping.ms} мс)` : 'ИИ не ответил — смотри подробности ниже',
        ping && ping.ok ? 'ok' : 'err');
    }

    /* ---------------------------------------------------------- вывод */

    function renderStatus(config, ping) {
      const blocks = [];

      if (ping) {
        if (ping.ok) {
          blocks.push(h('div.explain.ok', {},
            h('b', '✅ Подключение работает'),
            h('div.small', `Модель ответила «${ping.reply || 'ok'}» за ${ping.ms} мс. Планы, объяснения и разборы ошибок будут приходить от ИИ.`)));
        } else {
          blocks.push(h('div.explain.bad', {},
            h('b', `❌ ${ping.code === 'NO_KEY' ? 'Ключ не задан' : 'ИИ не ответил'}`),
            h('div.small', String(ping.error || 'неизвестная ошибка').slice(0, 400)),
            h('div.tiny.muted', { style: { marginTop: '6px' } },
              'Что проверить: ключ скопирован целиком, Base URL заканчивается на /v1, название модели существует, на хостинге открыт доступ в интернет.')));
        }
      }

      if (config && config.keySet) {
        blocks.push(h('div.chip-row', { style: { marginTop: '10px' } },
          h('span.chip.green', `🔑 ${config.keyHint}`),
          config.keyFromEnv ? h('span.chip.blue', 'из переменных окружения AI_API_KEY') : null,
          config.keySource === 'memory' ? h('span.chip.gold', 'ключ в памяти (до перезапуска)') : null,
          config.keySource === 'file+memory' ? h('span.chip', 'сохранён в файл на сервере') : null,
          h('span.chip.blue', `🧠 ${config.model}`),
          h('span.chip', `🌐 ${config.baseUrl}`)));
      } else {
        blocks.push(h('div.explain', { style: { marginTop: '10px' } },
          h('b', 'Сейчас демо-режим'),
          h('div.small', 'План и объяснения генерируются шаблонно. Вставь ключ выше и нажми «Сохранить и проверить».')));
      }

      if (config && config.fileStorage === false) {
        blocks.push(h('div.explain.bad', { style: { marginTop: '10px' } },
          h('b', '⚠️ Ключ сохранился только в память'),
          h('div.small', config.storageNote || 'Файловая система только для чтения: после перезапуска контейнера ключ нужно ввести снова. Надёжнее задать AI_API_KEY в переменных окружения проекта.')));
      }

      if (config && config.proxy && config.proxy.note) {
        blocks.push(h('div.tiny.muted', { style: { marginTop: '10px' } }, `Сеть: ${config.proxy.note}`));
      }

      mount(status, ...blocks);
    }

    function renderScreen(config) {
      cfg = config || cfg;
      mount(cfgHost,
        h('div.between', {},
          h('h3', '🔌 Подключение ИИ'),
          h('span.chip' + (cfg.keySet ? '.green' : ''), cfg.keySet ? 'ключ задан' : 'демо-режим')),
        h('p.muted.small', { style: { marginBottom: '14px' } },
          'Ключ хранится только на сервере приложения и не попадает в браузер: все запросы идут через прокси /api/ai.'),
        h('div.field', h('span.lbl', 'API-ключ'), keyWrap, hint),
        h('div.field', h('span.lbl', 'Base URL API'), baseUrl,
          h('div.hint', 'Адрес OpenAI-совместимого API. По умолчанию https://inference.dahl.global/v1')),
        h('div.field', h('span.lbl', 'Модель'), model,
          h('div.hint', 'Например: deepseek-ai/DeepSeek-V4-Flash-0731')),
        h('div.btn-row', {}, saveBtn, testBtn, clearBtn),
        h('div', { style: { marginTop: '14px' } }, status));

      renderStatus(cfg, null);
      syncButtons();
    }

    renderScreen(cfg);
  })();

  const dataHost = h('div.card', {},
    h('h3', { style: { marginBottom: '10px' } }, '📦 Данные и прогресс'),
    h('p.muted.small', 'Прогресс и профиль хранятся локально в браузере (localStorage). Их можно выгрузить в файл или очистить.'),
    h('div.btn-row', { style: { marginTop: '12px' } },
      h('button.btn.sm.ghost', {
        onClick: () => {
          const blob = new Blob([JSON.stringify(Store.getState(), null, 2)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: 'duo-ai-progress.json' });
          document.body.appendChild(a); a.click(); a.remove();
          toast('Файл прогресса сохранён', 'ok');
        },
      }, '⬇️ Скачать прогресс (JSON)'),
      h('button.btn.sm.ghost', {
        onClick: async () => {
          if (await confirmDialog('Сбросить прогресс?', 'Все курсы, профиль и результаты тестов будут удалены. Настройки ИИ останутся.', 'Сбросить', true)) {
            localStorage.removeItem('duoai.state.v1');
            location.hash = '#/';
            location.reload();
          }
        },
      }, '🗑 Сбросить весь прогресс')));

  return {
    title: 'Настройки',
    subtitle: 'Подключение API и данные',
    node: h('div.stack', {}, cfgHost, dataHost),
  };
};

/** Модалка редактирования профиля: имя + аватар. */
function editProfileDialog(reload) {
  const me = Store.user();
  const draft = { name: me.name || '', avatar: me.avatar || '🐸' };

  const nameInput = h('input.input', {
    value: draft.name,
    placeholder: 'Как тебя называть? Например, Дима',
    maxlength: '40',
    autofocus: true,
    onInput: (e) => { draft.name = e.target.value; },
  });

  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 62px), 1fr))', gap: '8px' } },
    Store.AVATARS.map((emoji) => {
      const btn = h('button.opt', {
        style: { fontSize: '28px', textAlign: 'center', padding: '10px 0', minHeight: '60px', justifyContent: 'center' },
        onClick: () => {
          draft.avatar = emoji;
          [...grid.children].forEach((c) => c.classList.remove('sel'));
          btn.classList.add('sel');
        },
      }, emoji);
      if (emoji === draft.avatar) btn.classList.add('sel');
      return btn;
    }));

  modal({
    title: '👤 Профиль',
    body: h('div', {},
      h('div.field', h('span.lbl', 'Имя'), nameInput,
        h('div.hint', 'Имя увидят отчёты — ИИ-учитель будет обращаться к тебе по нему.')),
      h('div.field', h('span.lbl', 'Аватар'), grid)),
    actions: [
      { label: 'Отмена', style: 'ghost' },
      {
        label: 'Сохранить',
        onClick: (close) => {
          Store.updateUser({ name: draft.name, avatar: draft.avatar });
          close();
          toast(`Сохранено. Привет, ${Store.userName()}!`, 'ok');
          if (reload) reload();
        },
      },
    ],
  });
}

Screens.profile = () => {
  const st = Store.getState();
  const me = Store.user();
  const xp = Store.totalXp();
  const lvl = Store.level(xp);
  const courses = Store.courses();
  const totalTopics = courses.reduce((a, c) => a + Store.stats(c).total, 0);
  const doneTopics = courses.reduce((a, c) => a + Store.stats(c).doneCount, 0);
  const days = Store.lastDays(28);

  const achievements = [
    { icon: '🎓', title: 'Первый курс', got: courses.length > 0, hint: 'Создай первый курс с ИИ' },
    { icon: '✏️', title: 'Профиль заполнен', got: Boolean(String(me.name || '').trim()), hint: 'Укажи имя и аватар' },
    { icon: '✅', title: 'Первая тема', got: doneTopics > 0, hint: 'Пройди тему на 70%+' },
    { icon: '🔥', title: '3 дня подряд', got: (st.streak.count || 0) >= 3, hint: 'Занимайся три дня подряд' },
    { icon: '⚡', title: '500 XP', got: xp >= 500, hint: 'Набери 500 XP' },
    { icon: '🏆', title: 'Курс целиком', got: courses.some((c) => Store.stats(c).allDone), hint: 'Пройди все темы одного курса' },
    { icon: '🧠', title: '10 тем', got: doneTopics >= 10, hint: 'Пройди 10 тем' },
    { icon: '📊', title: '5 тестов', got: st.sessions >= 5, hint: 'Пройди 5 тестов' },
  ];
  const gotCount = achievements.filter((a) => a.got).length;

  const calendar = h('div.calendar', {
    style: { display: 'grid', gridTemplateColumns: 'repeat(14, 1fr)', gap: '5px', marginTop: '12px' },
  }, days.map((d) => h('div', {
    title: `${d.day}: ${d.xp} XP`,
    style: {
      aspectRatio: '1 / 1', borderRadius: '6px',
      background: d.xp > 0 ? (d.xp > 80 ? '#58cc02' : d.xp > 30 ? '#3f8f12' : '#2d5c14') : '#22333a',
    },
  })));

  const since = me.createdAt ? fmtDate(me.createdAt).split(',')[0] : '—';

  const hero = h('div.card', { style: { background: 'linear-gradient(160deg,#20343c,#16262c)' } },
    h('div.inline', { style: { alignItems: 'center', gap: '16px' } },
      h('button', {
        title: 'Сменить аватар',
        onClick: () => editProfileDialog(() => App.render()),
        style: {
          width: '84px', height: '84px', flex: '0 0 auto', fontSize: '46px', lineHeight: '1',
          background: '#132128', border: '2px solid var(--line)', borderBottomWidth: '5px',
          borderRadius: '24px', display: 'grid', placeItems: 'center', cursor: 'pointer',
        },
      }, me.avatar || '🐸'),
      h('div', { style: { flex: '1 1 200px', minWidth: 0 } },
        h('div', { style: { fontSize: '24px', fontWeight: '900' } }, Store.userName()),
        h('div.muted.small', { style: { marginTop: '2px' } },
          `${LEVEL_TITLES[Math.min(LEVEL_TITLES.length - 1, lvl - 1)]} · уровень ${lvl} · ${xp} XP`),
        h('div.chip-row', { style: { marginTop: '10px' } },
          h('span.chip.blue', `📚 ${courses.length} ${plural(courses.length, 'курс', 'курса', 'курсов')}`),
          h('span.chip.green', `✅ ${doneTopics} ${plural(doneTopics, 'тема', 'темы', 'тем')}`),
          h('span.chip.gold', `🏅 ${gotCount}/${achievements.length} достижений`),
          h('span.chip', `📅 ученик с ${since}`))),
      h('button.btn.sm.ghost', { onClick: () => editProfileDialog(() => App.render()) }, '✏️ Изменить')),
    h('div', { style: { marginTop: '14px' } }, pbar(Store.levelProgress(xp), { thin: true })),
    h('div.tiny.muted', { style: { marginTop: '6px' } },
      `До ${lvl + 1} уровня: ${120 - (xp % 120)} XP`));

  const statsGrid = h('div.grid.four', {},
    statCard(`${st.streak.count || 0} 🔥`, 'Дней подряд', '#ff9600'),
    statCard(`${st.sessions}`, 'Тестов пройдено', '#1cb0f6'),
    statCard(`${doneTopics}/${totalTopics}`, 'Тем пройдено', '#58cc02'),
    statCard(fmtMinutes(st.minutes), 'Времени в учёбе', '#ce82ff'));

  return {
    title: 'Профиль',
    subtitle: 'Твой прогресс и достижения',
    actions: [h('button.btn.sm.ghost', { onClick: () => editProfileDialog(() => App.render()) }, '✏️ Изменить профиль')],
    node: h('div.stack', {},
      hero,
      statsGrid,
      h('div.grid.two', {},
        h('div.card', {},
          h('div.between', h('h3', '🏅 Достижения'), h('span.tag', `${gotCount} из ${achievements.length}`)),
          h('div.stack', { style: { marginTop: '12px' } }, achievements.map((a) => h('div.inline', { style: { opacity: a.got ? 1 : .5, alignItems: 'flex-start' } },
            h('span', { style: { fontSize: '22px' } }, a.got ? a.icon : '🔒'),
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontWeight: '800', fontSize: '14px' } }, a.title),
              h('div.tiny.muted', a.hint)))))),
        h('div.card', {},
          h('h3', { style: { marginBottom: '10px' } }, '🎯 Цель обучения'),
          h('div.stack', {},
            h('div',
              h('div.tiny.muted', 'Текущий фокус'),
              h('div', { style: { fontWeight: '800' } }, (Store.active() && Store.active().topic) || 'курс пока не выбран')),
            h('div',
              h('div.tiny.muted', 'Что дальше'),
              h('div', { style: { fontWeight: '800' } },
                Store.active() ? ((Store.nextTopic(Store.active()) || {}).topic?.title || 'все темы пройдены') : 'создай первый курс')),
            h('div.btn-row', { style: { marginTop: '6px' } },
              h('button.btn.sm', { onClick: () => App.go('#/new') }, '➕ Новая тема'),
              Store.active() ? h('button.btn.sm.ghost', { onClick: () => App.go(`#/report/${Store.active().id}`) }, '📊 Отчёт') : null)))),
      h('div.card', {},
        h('h3', { style: { marginBottom: '4px' } }, 'Активность за 4 недели'),
        h('div.tiny.muted', 'Чем зеленее клетка — тем больше XP за день.'),
        calendar),
      h('h2', { style: { marginTop: '8px' } }, 'Мои курсы'),
      courses.length ? h('div.grid.two', {}, courses.map(courseCard)) : h('div.card.muted', 'Курсов пока нет.')),
  };
};

/* ==========================================================================
   404
   ========================================================================== */

function emptyState(title, text, action) {
  return h('div.card.center', { style: { padding: '38px 22px' } },
    h('div', { style: { fontSize: '58px' } }, '🐸'),
    h('h2', { style: { margin: '12px 0 6px' } }, title),
    h('p.muted', text),
    action || null);
}

function screensNotFound(text) {
  return {
    title: 'Не найдено',
    subtitle: 'Проверь ссылку',
    node: emptyState(text || 'Ничего не найдено', 'Похоже, этой страницы или курса больше нет — вернись на главную.', 
      h('div.btn-row', { style: { justifyContent: 'center', marginTop: '14px' } },
        h('button.btn', { onClick: () => App.go('#/') }, 'На главную'))),
  };
}
