/* ==========================================================================
   app.js — роутер и оболочка приложения
   ========================================================================== */

const App = (() => {
  const shell = document.getElementById('app');

  const NAV = [
    { hash: '#/', label: 'Учить', ico: '🏠', match: (p) => p.route === 'home' || p.route === 'path' },
    { hash: '#/new', label: 'Новая тема', ico: '➕', match: (p) => p.route === 'newCourse' },
    { hash: '#/reviews', label: 'Отчёты', ico: '📊', match: (p) => p.route === 'report' || p.route === 'topicReport' },
    { hash: '#/profile', label: 'Профиль', ico: '👤', match: (p) => p.route === 'profile' },
    { hash: '#/settings', label: 'Ключ ИИ', ico: '🔑', match: (p) => p.route === 'settings' },
  ];

  function parse() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [pathPart, queryPart] = raw.split('?');
    const parts = pathPart.split('/').filter(Boolean);
    const query = {};
    (queryPart || '').split('&').filter(Boolean).forEach((kv) => {
      const [k, v] = kv.split('=');
      query[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' '));
    });

    const p = parts[0] || '';
    if (!p) return { route: 'home', params: {}, query };
    if (p === 'new') return { route: 'newCourse', params: {}, query };
    if (p === 'course') return { route: 'path', params: { id: parts[1] }, query };
    if (p === 'lesson') return { route: 'lesson', params: { id: parts[1], tid: parts[2] }, query };
    if (p === 'test') return { route: 'test', params: { id: parts[1], tid: parts[2] }, query };
    if (p === 'reviews' || p === 'report') {
      if (parts[2]) return { route: 'topicReport', params: { id: parts[1], tid: parts[2] }, query };
      return { route: 'report', params: { id: parts[1] }, query };
    }
    if (p === 'profile') return { route: 'profile', params: {}, query };
    if (p === 'settings') return { route: 'settings', params: {}, query };
    return { route: 'home', params: {}, query };
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  /* ------------------------------------------------------------- кирпичики */

  function navBtn(item, page, mobile) {
    const active = item.match(page);
    return h(`button.nav-btn${active ? '.active' : ''}`, {
      onClick: () => go(item.hash),
      title: item.label,
    }, h('span.nav-ico', item.ico), h('span', {}, item.label));
  }

  function sidebar(page) {
    return h('aside.sidebar', {},
      h('div.brand', {},
        h('div.brand-mark', '🦉'),
        h('div', {}, h('div.brand-name', 'Duo-AI'), h('div.tiny.muted', 'учись с ИИ-учителем'))),
      h('div', { id: 'key-pill-host' }, keyPill()),
      NAV.map((item) => navBtn(item, page)),
      h('div.sidebar-foot', {},
        h('div.tiny', 'Планы, объяснения и разбор ошибок генерирует ИИ. Прогресс хранится в браузере.'),
        h('div.tiny.muted', { style: { marginTop: '6px' } }, '© Duo-AI')));
  }

  function keyPill() {
    const state = AppShell.cfg || {};
    return h('div.key-pill', {},
      h(`span.key-dot${state.keySet ? '.ok' : ''}`),
      h('span', {}, state.keySet ? `ИИ подключён · ${state.keyHint || ''}` : 'ИИ не подключён (демо)'));
  }

  function rail(page) {
    const course = Store.active();
    const xp = Store.totalXp();
    const lvl = Store.level(xp);
    const st = Store.getState();
    const next = course ? Store.nextTopic(course) : null;
    const days = Store.lastDays(7);
    const maxXp = Math.max(10, ...days.map((d) => d.xp));

    return h('aside.rail', {},
      h('div.card', {},
        h('div.inline', { style: { alignItems: 'center', gap: '14px' } },
          ring(Store.levelProgress(xp), { size: 76, stroke: 8, color: '#58cc02', label: `${lvl}` }),
          h('div', {},
            h('div', { style: { fontWeight: '900', fontSize: '17px' } }, `${xp} XP`),
            h('div.tiny.muted', `уровень ${lvl} · ${LEVEL_TITLES[Math.min(LEVEL_TITLES.length - 1, lvl - 1)]}`),
            h('div.tiny.muted', { style: { marginTop: '4px' } }, `🔥 ${st.streak.count || 0} ${plural(st.streak.count || 0, 'день', 'дня', 'дней')} подряд`))),
        h('div', { style: { marginTop: '12px' } },
          xpBars(days, maxXp))),

      course ? h('div.card', {},
        h('div.tiny.muted', { style: { letterSpacing: '1px' } }, 'СЛЕДУЮЩИЙ ШАГ'),
        h('div', { style: { fontWeight: '900', margin: '6px 0 4px' } }, next ? next.topic.title : 'Все темы пройдены!'),
        h('div.tiny.muted', next ? (next.topic.subtitle || next.section.title) : 'Открой бонусное задание на карте курса'),
        next
          ? h('button.btn.sm.block', { style: { marginTop: '12px' }, onClick: () => go(`#/lesson/${course.id}/${next.topic.id}`) }, 'Продолжить')
          : h('button.btn.sm.orange.block', { style: { marginTop: '12px' }, onClick: () => go(`#/course/${course.id}`) }, 'К карте курса'),
        h('button.btn.sm.ghost.block', { style: { marginTop: '8px' }, onClick: () => go(`#/report/${course.id}`) }, '📊 Отчёт по курсу'))
        : h('div.card', {},
          h('div', { style: { fontWeight: '900', marginBottom: '6px' } }, 'Начни первое обучение'),
          h('div.tiny.muted', 'Введи тему — ИИ составит план и проведёт тебя по шагам.'),
          h('button.btn.sm.block', { style: { marginTop: '12px' }, onClick: () => go('#/new') }, 'Новая тема')),

      h('div.card', {},
        h('div', { style: { fontWeight: '900', marginBottom: '8px' } }, 'Быстрые темы'),
        h('div.chip-row', {}, ['Проценты', 'Дроби', 'Английский: времена', 'Проценты по кредиту', 'Python: функции'].map((t) =>
          h('button.chip', { onClick: () => go(`#/new?topic=${encodeURIComponent(t)}`) }, t)))),

      h('div.card', {},
        h('div', { style: { fontWeight: '900', marginBottom: '8px' } }, 'Подсказка'),
        h('div.tiny.muted', 'Внутри урока нажми «🤖 Спроси ИИ» — учитель объяснит тему так, как понятно именно тебе, и разберёт ошибки теста.')));
  }

  function xpBars(days, maxXp) {
    return h('div.bars-wrap', {},
      h('div.mini-bars', { style: { height: '64px' } }, days.map((d) => h('div.mb', { title: `${d.day}: ${d.xp} XP` },
        h('i', { style: { height: `${Math.round((d.xp / maxXp) * 100)}%` } }),
        h('span.lbl', new Date(d.day).toLocaleDateString('ru-RU', { weekday: 'short' }))))));
  }

  function bottomNav(page) {
    return h('nav.bottom-nav', {}, NAV.map((item) => navBtn(item, page, true)));
  }

  /* ---------------------------------------------------------------- render */

  function screenFor(page) {
    switch (page.route) {
      case 'newCourse': return Screens.newCourse(page.query);
      case 'path': return Screens.path({ ...page.params, ...page.query });
      case 'lesson': return Screens.lesson({ ...page.params, ...page.query });
      case 'test': return Screens.test({ ...page.params, ...page.query });
      case 'report': return Screens.report({ ...page.params, ...page.query });
      case 'topicReport': return Screens.topicReport({ ...page.params, ...page.query });
      case 'profile': return Screens.profile();
      case 'settings': return Screens.settings();
      default: return Screens.home();
    }
  }

  function render() {
    runCleanups();
    closeModal();
    const page = parse();
    let view;
    try {
      view = screenFor(page) || Screens.home();
    } catch (err) {
      console.error(err);
      view = { title: 'Ошибка', subtitle: String(err.message || err), node: emptyState('Что-то сломалось', String(err.message || err)) };
    }

    document.title = `${view.title || 'Duo-AI'} · Duo-AI`;

    if (view.fullscreen) {
      document.body.classList.add('is-fullscreen');
      mount(shell,
        h('div.fullscreen-column', {},
          topbar(view, page),
          view.node),
        bottomNav(page));
      window.scrollTo({ top: 0 });
      return;
    }

    document.body.classList.remove('is-fullscreen');
    mount(shell,
      sidebar(page),
      h('main.main', {}, topbar(view, page), view.node),
      rail(page),
      bottomNav(page));
    window.scrollTo({ top: 0 });
  }

  function topbar(view, page) {
    return h('div.topbar', {},
      h('div', {},
        h('div.topbar-title', view.title || ''),
        view.subtitle ? h('div.topbar-sub', view.subtitle) : null),
      h('div.topbar-actions', {}, view.actions || []));
  }

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    mount(shell, h('div.loader-screen', {}, h('div', { style: { fontSize: '54px' } }, '🦉'), h('div.spin.dark', { style: { width: '26px', height: '26px', borderWidth: '4px' } }), h('div.muted', 'Загружаю Duo-AI…')));
    try {
      AppShell.cfg = await AI.getConfig(true);
    } catch (err) {
      AppShell.cfg = { keySet: false };
      console.warn('Не удалось получить настройки:', err);
    }
    window.addEventListener('hashchange', render);
    render();
  }

  return { go, render, boot, parse, refreshShell: () => { AI.getConfig(true).then((cfg) => { AppShell.cfg = cfg; render(); }); } };
})();

const AppShell = { cfg: null };

document.addEventListener('DOMContentLoaded', () => App.boot());
if (document.readyState !== 'loading') App.boot();
