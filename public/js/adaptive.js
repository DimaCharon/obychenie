/* ==========================================================================
   adaptive.js — адаптация под ученика: уровень знания → сложность заданий,
   накопление статистики и «модель ученика» для промптов ИИ.

   Работает и без ключа ИИ: уровень пересчитывается по результатам тестов
   детерминированно, поэтому задания меняются даже в демо-режиме.
   ========================================================================== */

const Adaptive = (() => {
  const MIN = 1;
  const MAX = 5;

  const LEVEL_NOTES = ['', 'слышу впервые', 'что-то слышал(а)', 'немного разбираюсь', 'уверенно, но с пробелами', 'знаю хорошо, хочу углубить'];
  const DIFF_NAMES = { 1: 'базовый', 2: 'средний', 3: 'продвинутый' };
  const DIFF_DESC = {
    1: 'простые вопросы на понимание сути, простые формулировки, подсказки в объяснении',
    2: 'вопросы на применение: разобрать пример, выбрать верный способ, объяснить причину',
    3: 'задачи посложнее: перенос знания в новую ситуацию, разбор типичных ловушек, вопрос «а если…»',
  };

  const clampLevel = (n) => Math.min(MAX, Math.max(MIN, Math.round(Number(n) * 2) / 2));

  /** Стартовое состояние адаптации для нового курса (по ответам из опроса). */
  function blank(profile) {
    const start = clampLevel((profile && Number(profile.level)) || 3);
    return {
      startLevel: start,
      level: start,
      confidence: 0.3,           // 0..1 — насколько уверены в оценке уровня
      attempts: 0,
      history: [],               // [{ at, topicId, score, seconds, level, difficulty }]
      errorTags: [],             // типичные ошибки (из разборов ИИ и из тестов)
      pace: null,                // секунд на вопрос
      analysis: null,            // подробный анализ (ИИ или локальный)
      analysisAt: null,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Для старых курсов, созданных до этой версии. */
  function ensure(course) {
    if (!course) return null;
    if (!course.adaptive || typeof course.adaptive !== 'object') {
      course.adaptive = blank(course.profile);
    }
    const a = course.adaptive;
    if (!Array.isArray(a.history)) a.history = [];
    if (!Array.isArray(a.errorTags)) a.errorTags = [];
    if (typeof a.confidence !== 'number') a.confidence = 0.3;
    if (typeof a.attempts !== 'number') a.attempts = 0;
    if (typeof a.level !== 'number') a.level = clampLevel(a.startLevel || 3);
    return a;
  }

  const difficultyFor = (level) => (level <= 2 ? 1 : level < 4 ? 2 : 3);
  const difficultyName = (d) => DIFF_NAMES[d] || DIFF_NAMES[2];
  const levelName = (l) => LEVEL_NOTES[Math.min(MAX, Math.max(MIN, Math.round(l)))] || '';

  /**
   * Пересчёт уровня после теста.
   * Чем меньше уверенность в оценке (мало попыток) — тем крупнее шаг: ученик,
   * который «сказал 3, а решает всё на 5», быстро получит уровень 4–5.
   */
  function nextLevel(level, score, confidence) {
    let delta = 0;
    if (score >= 0.9) delta = 0.5;
    else if (score >= 0.75) delta = 0.25;
    else if (score < 0.5) delta = -0.5;
    else if (score < 0.65) delta = -0.25;
    if (confidence >= 0.7) delta /= 2;          // оценка уже устойчива — двигаем аккуратно
    return clampLevel(level + delta);
  }

  /**
   * Записывает попытку и возвращает, что изменилось.
   * @returns {{levelBefore:number, levelAfter:number, difficultyBefore:number, difficultyAfter:number,
   *            direction:'up'|'down'|'same', message:string, pace:number|null}}
   */
  function record(adaptive, { score = 0, seconds = 0, questions = 0, topicId = null, errorTags = [] } = {}) {
    const a = adaptive;
    const levelBefore = a.level;
    const difficultyBefore = difficultyFor(levelBefore);
    const levelAfter = nextLevel(levelBefore, score, a.confidence);

    a.level = levelAfter;
    a.attempts += 1;
    a.confidence = Math.min(1, a.confidence + 0.12);
    a.history = [...a.history, {
      at: new Date().toISOString(),
      topicId,
      score: Math.round(score * 100) / 100,
      seconds,
      level: levelAfter,
      difficulty: difficultyFor(levelAfter),
    }].slice(-40);
    if (questions > 0) {
      const pace = Math.round(seconds / questions);
      a.pace = a.pace ? Math.round((a.pace * 2 + pace) / 3) : pace;
    }
    if (Array.isArray(errorTags) && errorTags.length) {
      a.errorTags = [...new Set([...errorTags.map((t) => String(t).slice(0, 60)), ...a.errorTags])].slice(0, 8);
    }
    a.updatedAt = new Date().toISOString();

    const difficultyAfter = difficultyFor(levelAfter);
    const direction = levelAfter > levelBefore ? 'up' : levelAfter < levelBefore ? 'down' : 'same';

    let message;
    if (direction === 'up') {
      message = difficultyAfter > difficultyBefore
        ? `Отличный результат — поднимаю сложность заданий до ${difficultyName(difficultyAfter)}!`
        : 'Отличный результат — держу сложность и готовлю более хитрые вопросы.';
    } else if (direction === 'down') {
      message = 'Разберу тему проще и дам задания полегче, чтобы закрепить базу.';
    } else {
      message = 'Уровень пока оставляю: закрепим тему ещё парой заданий.';
    }

    return { levelBefore, levelAfter, difficultyBefore, difficultyAfter, direction, message, pace: a.pace };
  }

  /** Текстовое описание модели ученика — уходит в промпты ИИ. */
  function text(course, extra = {}) {
    const a = ensure(course);
    if (!a) return '';
    const recent = a.history.slice(-4);
    const paceText = !a.pace
      ? 'темп пока неизвестен'
      : a.pace < 15
        ? `отвечает очень быстро (~${a.pace} с на вопрос) — вероятна спешка`
        : a.pace > 60
          ? `отвечает медленно (~${a.pace} с на вопрос) — нужно время подумать`
          : `уверенный темп (~${a.pace} с на вопрос)`;

    return [
      `Текущий уровень по теме: ${a.level}/5 (стартовая самооценка ${a.startLevel}/5, ${levelName(a.level)})`,
      `Сложность заданий: ${difficultyName(difficultyFor(a.level))} — ${DIFF_DESC[difficultyFor(a.level)]}`,
      a.attempts ? `Пройдено тестов: ${a.attempts}, последние результаты: ${recent.map((h) => `${Math.round(h.score * 100)}%`).join(', ') || '—'}` : 'Тестов пока не было',
      `Темп: ${paceText}`,
      a.errorTags.length ? `Типичные ошибки: ${a.errorTags.slice(0, 4).join('; ')}` : '',
      extra.weak ? `Слабые темы (повторить): ${extra.weak}` : '',
    ].filter(Boolean).join('. ');
  }

  /** Темы курса, которые стоит повторить (результат ниже порога). */
  function weakTopics(course) {
    if (!course) return [];
    const out = [];
    Object.entries(course.progress || {}).forEach(([topicId, p]) => {
      const best = Number(p.best || 0);
      if (best > 0 && best < 0.8) {
        const found = course.sections.flatMap((s) => s.topics).find((t) => t.id === topicId);
        if (found) out.push({ id: topicId, title: found.title, best });
      }
    });
    return out.sort((a, b) => a.best - b.best).slice(0, 4);
  }

  /** Средние показатели по истории попыток. */
  function metrics(course) {
    const a = ensure(course);
    const h = a ? a.history : [];
    const scored = h.length ? h.reduce((sum, x) => sum + x.score, 0) / h.length : 0;
    return {
      level: a ? a.level : 3,
      startLevel: a ? a.startLevel : 3,
      difficulty: a ? difficultyFor(a.level) : 2,
      attempts: h.length,
      avg: Math.round(scored * 100),
      trend: h.length >= 2
        ? Math.round((h[h.length - 1].score - h[0].score) * 100)
        : 0,
      pace: a ? a.pace : null,
      confidence: a ? a.confidence : 0,
    };
  }

  /**
   * Локальный (демо) анализ ученика: работает без ключа ИИ и всегда показывает,
   * как приложение «понимает» человека.
   */
  function localAnalysis(course, stats = {}) {
    const m = metrics(course);
    const weak = weakTopics(course);
    const levelWord = m.level >= 4 ? 'уверенный' : m.level >= 3 ? 'средний' : 'начальный';
    const direction = m.level > m.startLevel ? 'выше стартовой самооценки' : m.level < m.startLevel ? 'ниже стартовой самооценки' : 'как в самооценке';
    const low = m.avg > 0 && m.avg < 60;

    return {
      demo: true,
      summary: `Анализ по ${m.attempts || 0} тестам: текущий уровень ${m.level}/5 (${levelWord}), `
        + `средний результат ${m.avg || 0}% по курсу «${course.topic}». Уровень ${direction}.`
        + (low ? ' Пока материал даётся тяжело — снижаю сложность и буду разбирать каждую ошибку по шагам.' : ''),
      level: m.level,
      difficulty: m.difficulty,
      trend: `${m.trend > 0 ? '+' : ''}${m.trend} п.п. от первой попытки к последней`,
      strengths: low
        ? [
          'Ты дошёл до теста и видишь свои ошибки — это и есть точка роста',
          m.pace && m.pace < 15
            ? 'Отвечаешь очень быстро — значит, база есть, но нужна внимательность'
            : 'Не бросаешь тему после первой неудачи',
        ]
        : [
          m.avg >= 80 ? 'Высокая точность ответов — задания текущей сложности даются легко' : 'Есть прогресс: темы проходятся, база закрепляется',
          m.pace && m.pace < 15
            ? `Отвечаешь быстро (~${m.pace} с на вопрос) — на сложных заданиях стоит перечитывать условие`
            : m.pace && m.pace > 60 ? `Вдумываешься в вопрос (~${m.pace} с) — это про понимание, а не про скорость`
              : `Уверенный темп: ~${m.pace || '—'} с на вопрос, без застреваний`,
        ],
      weaknesses: (low && m.attempts ? ['Пока ни одна тема не сдана на 70%+ — начнём с самой первой темы и самых простых заданий'] : [])
        .concat(weak.length
          ? weak.map((w) => `Тема «${w.title}» — лучший результат ${Math.round(w.best * 100)}%, нужно закрепить`)
          : ['Пока нет тем с низким результатом — можно брать задания сложнее']),
      patterns: (course.progress && Object.values(course.progress).some((p) => (p.attempts || 0) > 1))
        ? ['Есть темы, которые ты пересдавал — ошибки разбираются, а не игнорируются',
          m.trend > 0 ? `От первой попытки к последней результат вырос на ${m.trend} п.п.` : 'Результат держится примерно на одном уровне',
          'После разбора ошибок отвечаешь точнее — это видно по повторным попыткам']
        : [m.attempts ? 'Темы проходятся с первой попытки — пересдач пока не было' : 'Пока нет данных о поведении в учёбе',
          m.pace && m.pace < 15 ? 'Отвечаешь очень быстро: стоит перечитывать условие до конца'
            : m.pace && m.pace > 60 ? 'Долго думаешь над вопросами — значит, читаешь внимательно' : 'Темп ответов спокойный',
          m.confidence > 0.7 ? 'Оценка уровня уже устойчивая' : 'Оценка уровня уточняется по мере прохождения тестов'],
      nextSteps: [
        low
          ? 'Пересдать первую тему на «базовом» уровне — я уже упростил задания'
          : weak.length ? `Пересдать «${weak[0].title}» с новым разбором ошибок` : 'Взять практику сложнее по пройденной теме',
        `Следующие задания готовлю на ${difficultyName(m.difficulty)} уровень`,
        'Разобрать ошибки кнопкой «🤖 Разобрать ошибки» — задания соберу по ним',
      ],
      difficultyAdvice: low
        ? `Опускаю сложность до «${difficultyName(m.difficulty)}» и даю разбор каждой ошибки — вернусь к «продвинутому» после двух тестов на 80%+.`
        : m.difficulty >= 3
          ? 'Уровень позволяет держать продвинутую сложность — оставляю её.'
          : `Держу «${difficultyName(m.difficulty)}»: подниму сложность, когда результат будет 80%+ стабильно.`,
      grade: `${levelWord} уровень по этой теме`,
    };
  }

  return {
    MIN, MAX,
    LEVEL_NOTES, DIFF_NAMES, DIFF_DESC,
    blank, ensure, clampLevel,
    difficultyFor, difficultyName, levelName, nextLevel,
    record, text, weakTopics, metrics, localAnalysis,
  };
})();

/* Доступно и в браузере, и в node-тестах */
if (typeof module !== 'undefined' && module.exports) module.exports = Adaptive;
