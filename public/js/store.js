/* ==========================================================================
   store.js — состояние приложения, прогресс, XP, стрик, статистика
   ========================================================================== */

const Store = (() => {
  const KEY = 'duoai.state.v1';
  const PASS = 0.7;                       // порог прохождения темы
  const today = () => new Date().toISOString().slice(0, 10);

  let state = load();

  function blank() {
    return {
      version: 1,
      user: { name: '', avatar: '🐸', createdAt: new Date().toISOString() },
      courses: {},
      activeCourseId: null,
      xpByDay: {},
      streak: { count: 0, lastDay: null },
      sessions: 0,
      minutes: 0,
    };
  }

  const AVATARS = ['🐸', '🐼', '🦉', '🦊', '🐧', '🐨', '🐯', '🦁', '🐙', '🦄', '🐢', '🐳'];

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      const parsed = JSON.parse(raw);
      return { ...blank(), ...parsed };
    } catch {
      return blank();
    }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (err) { console.warn('Не удалось сохранить прогресс:', err); }
  }

  /* ------------------------------------------------------------- запросы */

  function getState() { return state; }

  /* ---------------------------------------------------------- профиль */

  function user() {
    if (!state.user || typeof state.user !== 'object') {
      state.user = { name: '', avatar: '🐸', createdAt: new Date().toISOString() };
    }
    if (!state.user.avatar) state.user.avatar = '🐸';
    return state.user;
  }

  function userName() {
    const name = String(user().name || '').trim();
    return name || 'Ученик';
  }

  function updateUser(patch) {
    const next = { ...user(), ...patch };
    next.name = String(next.name || '').slice(0, 40).trim();
    state.user = next;
    save();
    return state.user;
  }

  function isNewUser() {
    return !String(user().name || '').trim() && courses().length === 0;
  }
  function courses() { return Object.values(state.courses); }
  function getCourse(id) { return state.courses[id || state.activeCourseId] || null; }
  function active() { return getCourse(state.activeCourseId); }

  function uid(prefix = 'c') {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function normalizePlan(raw, topic, profile) {
    const plan = raw && typeof raw === 'object' ? raw : {};
    const sectionsIn = Array.isArray(plan.sections) && plan.sections.length ? plan.sections : null;
    const src = sectionsIn || Mock.plan(topic, profile).sections;

    const colors = ['blue', 'orange', 'purple', 'green', 'red'];
    let counter = 0;

    const sections = src.slice(0, 5).map((s, si) => ({
      id: s.id || `s${si + 1}`,
      title: trim(s.title, `Раздел ${si + 1}`, 60),
      subtitle: trim(s.subtitle || s.sub || '', '', 90),
      color: colors.includes(s.color) ? s.color : colors[si % colors.length],
      topics: (Array.isArray(s.topics) && s.topics.length ? s.topics : []).slice(0, 6).map((t) => {
        counter += 1;
        return {
          id: t.id || `t${counter}`,
          title: trim(t.title, `Тема ${counter}`, 70),
          subtitle: trim(t.subtitle || '', '', 120),
          emoji: (t.emoji || '📘').slice(0, 4),
          level: Math.min(3, Math.max(1, Number(t.level) || Math.ceil(counter / 3))),
          teaches: (Array.isArray(t.teaches) ? t.teaches : []).slice(0, 5).map((x) => trim(x, '', 120)),
          theory: (Array.isArray(t.theory) ? t.theory : []).slice(0, 4).map((b) => ({
            h: trim(b.h || b.title, 'Объяснение', 90),
            body: String(b.body || b.text || '').slice(0, 1400),
          })).filter((b) => b.body),
          quiz: (Array.isArray(t.quiz) ? t.quiz : []).slice(0, 8).map((q) => normalizeQuestion(q)).filter(Boolean),
        };
      }).filter((t) => t.quiz.length >= 2),
    })).filter((s) => s.topics.length);

    const safeSections = sections.length ? sections : Mock.plan(topic, profile).sections.map((s, si) => ({
      ...s, color: colors[si % colors.length],
    }));

    return {
      title: trim(plan.title, `Курс: ${topic}`, 70),
      emoji: (plan.emoji || '🎯').slice(0, 4),
      summary: String(plan.summary || '').slice(0, 600),
      sections: safeSections,
      source: raw && sectionsIn ? 'ai' : 'demo',
    };
  }

  function normalizeQuestion(q) {
    if (!q || typeof q !== 'object') return null;
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => String(o).slice(0, 220)).filter(Boolean).slice(0, 5);
    if (options.length < 2) return null;
    let answer = Number(q.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) {
      const idx = options.findIndex((o) => String(q.correct || q.answer || '').trim() === o.trim());
      answer = idx >= 0 ? idx : 0;
    }
    return {
      q: trim(q.q || q.question, 'Вопрос', 400),
      options,
      answer,
      explain: String(q.explain || q.explanation || '').slice(0, 500),
    };
  }

  function trim(value, fallback, max) {
    const s = String(value == null ? '' : value).trim();
    const out = s || fallback;
    return max && out.length > max ? `${out.slice(0, max - 1)}…` : out;
  }

  function createCourse({ topic, profile, plan, interview }) {
    const normalized = normalizePlan(plan, topic, profile);
    const course = {
      id: uid(),
      topic,
      title: normalized.title,
      emoji: normalized.emoji,
      summary: normalized.summary,
      source: normalized.source,
      profile: { studentName: userName(), ...profile },
      interview: interview || null,
      sections: normalized.sections,
      progress: {},
      chat: {},
      bonus: null,
      xp: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.courses[course.id] = course;
    state.activeCourseId = course.id;
    save();
    return course;
  }

  function updateCourse(id, patch) {
    const course = getCourse(id);
    if (!course) return null;
    Object.assign(course, patch, { updatedAt: new Date().toISOString() });
    save();
    return course;
  }

  function setActive(id) { state.activeCourseId = id; save(); }

  function removeCourse(id) {
    delete state.courses[id];
    if (state.activeCourseId === id) {
      const rest = courses();
      state.activeCourseId = rest.length ? rest[0].id : null;
    }
    save();
  }

  /* ------------------------------------------------------- структура пути */

  /** Плоский список тем по порядку + статусы. */
  function path(course) {
    const out = [];
    let prevDone = true;                 // первая тема всегда открыта

    course.sections.forEach((section, si) => {
      section.topics.forEach((topic) => {
        const p = course.progress[topic.id] || {};
        const best = Number(p.best || 0);
        const done = best >= PASS;
        let status;
        if (done) status = 'done';
        else if (prevDone) status = 'current';
        else status = 'locked';
        const row = { topic, sectionIndex: si, section, status, best, attempts: p.attempts || 0, seconds: p.seconds || 0, lastAt: p.lastAt || null };
        out.push(row);
        prevDone = done;
      });
    });

    // все темы пройдены -> текущей становится бонусная
    const allDone = out.every((r) => r.status === 'done');
    const bonusLocked = !allDone;
    return { rows: out, allDone, bonusLocked };
  }

  function topicById(course, id) {
    for (const s of course.sections) {
      const t = s.topics.find((x) => x.id === id);
      if (t) return { topic: t, section: s };
    }
    return null;
  }

  function nextTopic(course) {
    const { rows } = path(course);
    return rows.find((r) => r.status === 'current') || null;
  }

  /* --------------------------------------------------------------- XP/стрик */

  function level(xp) { return Math.floor(xp / 120) + 1; }
  function levelProgress(xp) { return (xp % 120) / 120; }

  function addXp(amount) {
    const day = today();
    state.xpByDay[day] = (state.xpByDay[day] || 0) + amount;
    const st = state.streak;
    if (st.lastDay !== day) {
      const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      st.count = st.lastDay === y ? st.count + 1 : 1;
      st.lastDay = day;
    }
    save();
  }

  function totalXp() {
    return Object.values(state.xpByDay).reduce((a, b) => a + b, 0);
  }

  /** Сохраняем результат теста темы. */
  function saveResult(courseId, topicId, { score, correct, total, seconds, mistakes }) {
    const course = getCourse(courseId);
    if (!course) return null;
    const p = course.progress[topicId] || { best: 0, attempts: 0, seconds: 0, history: [] };
    const passed = score >= PASS;
    const gained = passed ? Math.round(20 + score * 15) : 5;
    p.attempts += 1;
    p.seconds = (p.seconds || 0) + (seconds || 0);
    p.lastAt = new Date().toISOString();
    p.history = [...(p.history || []), { at: p.lastAt, score }].slice(-12);
    p.lastScore = score;
    p.best = Math.max(p.best || 0, score);
    p.mistakes = (mistakes || []).slice(0, 6);
    course.progress[topicId] = p;
    course.xp = (course.xp || 0) + gained;
    course.updatedAt = p.lastAt;
    state.sessions += 1;
    state.minutes += Math.max(1, Math.round((seconds || 0) / 60));
    save();
    addXp(gained);
    return { gained, passed };
  }

  function addChat(courseId, topicId, msg) {
    const course = getCourse(courseId);
    if (!course) return;
    course.chat[topicId] = course.chat[topicId] || [];
    course.chat[topicId].push(msg);
    save();
  }

  /* ------------------------------------------------------------- статистика */

  function stats(course) {
    const { rows, allDone } = path(course);
    const done = rows.filter((r) => r.status === 'done');
    const scored = rows.filter((r) => (r.attempts || 0) > 0);
    const avg = scored.length ? Math.round(scored.reduce((a, r) => a + r.best, 0) / scored.length * 100) : 0;
    const seconds = rows.reduce((a, r) => a + (r.seconds || 0), 0);
    const stars = rows.reduce((a, r) => a + starsFor(r.best), 0);

    const topicStats = rows.map((r) => ({
      id: r.topic.id,
      title: r.topic.title,
      emoji: r.topic.emoji,
      section: r.section.title,
      status: r.status,
      best: Math.round((r.best || 0) * 100),
      attempts: r.attempts || 0,
      minutes: Math.round((r.seconds || 0) / 60 * 10) / 10,
      stars: starsFor(r.best),
      lastAt: r.lastAt,
      mistakes: (course.progress[r.topic.id] || {}).mistakes || [],
    }));

    return {
      total: rows.length,
      doneCount: done.length,
      progress: rows.length ? done.length / rows.length : 0,
      avg,
      stars,
      maxStars: rows.length * 3,
      minutes: Math.round(seconds / 60),
      sessions: topicStats.reduce((a, t) => a + t.attempts, 0),
      allDone,
      topicStats,
      weak: topicStats.filter((t) => t.attempts > 0 && t.best < 80).sort((a, b) => a.best - b.best),
      strong: topicStats.filter((t) => t.best >= 80).sort((a, b) => b.best - a.best),
    };
  }

  function starsFor(score) {
    if (!score) return 0;
    if (score >= 1) return 3;
    if (score >= 0.8) return 2;
    if (score >= 0.6) return 1;
    return score >= PASS ? 1 : 0;
  }

  function lastDays(n) {
    const out = [];
    for (let i = n - 1; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      out.push({ day: d, xp: state.xpByDay[d] || 0 });
    }
    return out;
  }

  return {
    PASS, AVATARS,
    getState, courses, getCourse, active, createCourse, updateCourse, setActive, removeCourse,
    user, userName, updateUser, isNewUser,
    path, topicById, nextTopic, stats, starsFor, saveResult, addChat, addXp, totalXp,
    level, levelProgress, lastDays, uid, save, normalizePlan, normalizeQuestion, today,
  };
})();
