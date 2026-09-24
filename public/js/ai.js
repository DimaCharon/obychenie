/* ==========================================================================
   ai.js — клиент ИИ + промпты + демо-генератор
   --------------------------------------------------------------------------
   Все запросы идут через собственный бэкенд (/api/ai), чтобы ключ API
   не попадал в браузер. Если ключа нет или ИИ не ответил — включается
   демо-режим (Mock), чтобы приложение оставалось рабочим.
   ========================================================================== */

const AI = (() => {
  let cache = null;

  const TIMEOUTS = {
    config: 15000,     // чтение/запись настроек
    ping: 60000,       // проверка ключа: модель отвечает одним словом
    ai: 150000,        // генерация плана/темы/отчёта — это долгий запрос
  };

  /**
   * Запрос к своему бэкенду с жёстким таймаутом.
   * Без него кнопка могла «тупить»: запрос висел, а пользователь жал повторно.
   */
  async function api(path, options = {}) {
    const timeout = options.timeout || TIMEOUTS.ai;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        ...options,
      });
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
      return { status: res.status, data };
    } catch (err) {
      if (err.name === 'AbortError') {
        return {
          status: 0,
          data: {
            error: `Запрос прерван по таймауту (${Math.round(timeout / 1000)} с). ИИ не ответил вовремя — попробуй ещё раз или выбери модель быстрее.`,
            code: 'TIMEOUT',
          },
        };
      }
      return { status: 0, data: { error: `Нет связи с сервером приложения: ${err.message}`, code: 'OFFLINE' } };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getConfig(force) {
    if (cache && !force) return cache;
    const { data } = await api('/api/config', { timeout: TIMEOUTS.config });
    cache = data;
    return cache;
  }

  async function saveConfig(body) {
    const { data } = await api('/api/config', {
      method: 'POST', body: JSON.stringify(body), timeout: TIMEOUTS.config,
    });
    cache = null;
    return data;
  }

  async function ping() {
    const { data } = await api('/api/ping', { method: 'POST', body: '{}', timeout: TIMEOUTS.ping });
    return data;
  }

  function isConfigured() {
    return Boolean(cache && cache.keySet);
  }

  /** Один вызов чата. json:true — просим модель вернуть JSON-объект. */
  async function chat({ system, user, json, temperature = 0.7, maxTokens = 4096 }) {
    const { status, data } = await api('/api/ai', {
      method: 'POST',
      body: JSON.stringify({ system, user, json: !!json, temperature, maxTokens }),
      timeout: TIMEOUTS.ai,
    });
    if (status !== 200) {
      const err = new Error(data.error || `Ошибка API (${status})`);
      err.code = data.code;
      err.status = status;
      throw err;
    }
    return data.text || '';
  }

  /* -------------------------------------------------------- JSON-парсинг */

  function extractJson(text) {
    if (!text) return null;
    let s = String(text).trim();
    // убрать markdown-ограждение
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const first = s.indexOf('{');
    const firstArr = s.indexOf('[');
    let start = -1;
    if (first === -1) start = firstArr;
    else if (firstArr === -1) start = first;
    else start = Math.min(first, firstArr);
    if (start === -1) return null;
    const openChar = s[start];
    const closeChar = openChar === '{' ? '}' : ']';
    const end = s.lastIndexOf(closeChar);
    if (end <= start) return null;
    let body = s.slice(start, end + 1);
    for (const candidate of [body, repair(body)]) {
      try { return JSON.parse(candidate); } catch { /* next */ }
    }
    return null;
  }

  /** Мелкие «починки» типичных ошибок LLM. */
  function repair(body) {
    return body
      .replace(/,\s*([}\]])/g, '$1')                 // висячие запятые
      .replace(/([{,]\s*)([A-Za-zА-Яа-я_][\wА-Яа-я_]*)\s*:/g, '$1"$2":') // ключи без кавычек
      .replace(/'([^'\\]*)'/g, '"$1"')               // одинарные кавычки
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); // управляющие символы
  }

  async function json({ system, user, temperature = 0.6, maxTokens = 6144 }) {
    const attempt = async (extra) => {
      const raw = await chat({
        system: `${system}\n\nОтвечай ТОЛЬКО валидным JSON-объектом, без пояснений и markdown.${extra || ''}`,
        user,
        json: true,
        temperature,
        maxTokens,
      });
      return extractJson(raw);
    };
    let parsed = await attempt('');
    if (!parsed) parsed = await attempt('\nВНИМАНИЕ: предыдущий ответ не был валидным JSON. Верни строго JSON.');
    if (!parsed) throw new Error('ИИ вернул ответ, который не удалось разобрать как JSON.');
    return parsed;
  }

  return { getConfig, saveConfig, ping, isConfigured, chat, json, extractJson, TIMEOUTS };
})();

/* ==========================================================================
   Prompts — «личность» ИИ-учителя
   ========================================================================== */

const TEACHER_RULES = `
Ты — терпеливый персональный преподаватель в приложении Duo-AI.
Правила:
1. Объясняй простым живым языком, как человек, а не как учебник.
2. Обязательно подстраивайся под возраст, класс/курс, уровень знаний и цель ученика.
3. Любой термин объясняй сразу в скобках простыми словами.
4. Приводи конкретные примеры из быта или практики ученика; избегай абстракций.
5. Не осуждай за ошибки: ошибка — это шаг к пониманию. Хвали за конкретику, а не «молодец».
6. Пиши по-русски, дружелюбно, без воды и без обращения «уважаемый». Если знаешь имя ученика — иногда обращайся по имени.
7. Строго соблюдай структуру, которую просят.
`.trim();

function profileText(p) {
  if (!p) return 'профиль не указан';
  const name = String(p.studentName || '').trim();
  const namePart = name && name !== 'Ученик' ? `имя ученика: ${name}; ` : '';
  const role = p.role === 'school' ? 'школьник'
    : p.role === 'student' ? 'студент'
    : p.role === 'adult' ? 'взрослый, учится для себя'
    : 'учащийся';
  const grade = p.role === 'school' ? `${p.grade || '?'} класс`
    : p.role === 'student' ? `${p.course || '?'} курс` : 'вне школы';
  return namePart + [
    `роль: ${role} (${grade})`,
    p.age ? `возраст: ${p.age} лет` : '',
    p.hours ? `готов заниматься: ${p.hours}` : '',
    p.level ? `самооценка знаний по теме (1–5): ${p.level}` : '',
    p.known ? `уже знает: ${p.known}` : 'уже знает: ничего особенного',
    p.unknown ? `не понимает и хочет разобраться: ${p.unknown}` : '',
    p.goal ? `цель: ${p.goal}` : '',
    p.style ? `предпочитает формат: ${p.style}` : '',
    p.deadline ? `срок: ${p.deadline}` : '',
  ].filter(Boolean).join('; ');
}

const Prompts = {
  profileText,

  /** Уточняющие вопросы ИИ после анкеты — «живой» опрос. */
  interview: (topic, profile) => ([
    TEACHER_RULES,
    '',
    `Ученик выбрал тему: «${topic}». Вот что он рассказал о себе: ${profileText(profile)}.`,
    'Задай ровно 3 уточняющих вопроса, которые лучше всего помогут составить персональный план обучения именно для него.',
    'Вопросы должны быть конкретными и простыми: про опыт, пробелы, примеры из жизни, формат подачи.',
    'Верни JSON: {"questions":[{"q":"текст вопроса","options":["вариант 1","вариант 2","вариант 3"],"allow_custom":true}]}',
    'Варианты ответа — короткие (до 40 символов), 3–4 штуки. Формулируй на «ты».',
  ].join('\n')),

  /** Полный план курса. */
  plan: (topic, profile, interview) => ([
    TEACHER_RULES,
    '',
    `Составь персональный курс по теме «${topic}» для конкретного ученика.`,
    `Профиль ученика: ${profileText(profile)}.`,
    interview ? `Дополнительные ответы ученика: ${interview}` : '',
    '',
    'Требования:',
    '- Ровно 3 раздела (sections), в каждом 3–4 темы (topics), всего 9–12 тем. Порядок — от простого к сложному.',
    '- Темы должны закрывать именно то, что ученик не понимает, и вести к его цели. Названия — живые, понятные, до 42 символов.',
    '- Для каждой темы: teaches (2–4 пункта «что узнаешь»), level (1–3 — сложность), theory (2–3 блока теории) и quiz (4 вопроса теста).',
    '- theory.block: {"h":"подзаголовок","body":"3–5 предложений объяснения простым языком с примером"}.',
    '- quiz: ровно 4 вопроса на тему, у каждого 4 варианта ответа, ровно один правильный (answer — индекс 0..3), explain — 1–2 предложения, почему так.',
    '- Вопросы теста — на понимание и практику, не на зазубривание. Без варианта «все вышеперечисленное».',
    '- Пронумеруй темы с помощью поля id: "t1", "t2", ... по порядку.',
    '- Цвет каждого раздела выбери из массива: ["blue","orange","purple","green"].',
    '',
    'Формат ответа (строго):',
    '{"title":"название курса до 45 символов","emoji":"один эмодзи","summary":"2 предложения о том, чему научится ученик",',
    '"sections":[{"id":"s1","title":"Название раздела","subtitle":"1 короткая строка","color":"blue",',
    '"topics":[{"id":"t1","title":"Тема","subtitle":"1 строка — зачем это нужно","emoji":"эмодзи","level":1,',
    '"teaches":["...","..."],"theory":[{"h":"...","body":"..."}],',
    '"quiz":[{"q":"...","options":["A","B","C","D"],"answer":0,"explain":"..."}]}]}]}',
  ].join('\n')),

  /** Одиночная тема по запросу (когда нужно добрать/пересдать). */
  topic: (topic, courseTopic, profile) => ([
    TEACHER_RULES,
    `Ученик учится по курсу «${topic}» и сейчас разбирает тему «${courseTopic}». Профиль: ${profileText(profile)}.`,
    'Составь по этой теме: 2–3 блока теории (объяснение + пример) и 4 вопроса теста на понимание.',
    'Верни JSON: {"theory":[{"h":"...","body":"..."}],"quiz":[{"q":"...","options":["A","B","C","D"],"answer":0,"explain":"..."}]}',
  ].join('\n')),

  /** Дополнительные задания после ошибок. */
  extra: (topic, courseTopic, mistakes, profile) => ([
    TEACHER_RULES,
    `Ученик ошибся в теме «${courseTopic}» курса «${topic}». Профиль: ${profileText(profile)}.`,
    `Ошибки: ${mistakes.map((m) => `вопрос «${m.q}» — выбрал «${m.chosen}», верно «${m.correct}»`).join('; ')}.`,
    'Разбери ошибки и дай 3 новых вопроса, которые бьют точно в те же слабые места, но сформулированы иначе и проще.',
    'Верни JSON: {"analysis":"1–2 предложения — в чём корень ошибки","quiz":[{"q":"...","options":["A","B","C","D"],"answer":0,"explain":"..."}]}',
  ].join('\n')),

  /** Практическое задание-бонус. */
  bonus: (topic, profile) => ([
    TEACHER_RULES,
    `Ученик прошёл весь курс «${topic}». Профиль: ${profileText(profile)}.`,
    'Придумай одно практическое задание (проект/упражнение на 20–40 минут), которое закрепит навык.',
    'Верни JSON: {"title":"...","task":"5–8 предложений с шагами","checklist":["критерий 1","критерий 2","критерий 3"]}',
  ].join('\n')),

  /** Отчёт об успеваемости. */
  report: (topic, profile, data) => ([
    TEACHER_RULES,
    `Составь отчёт об успеваемости по курсу «${topic}». Профиль ученика: ${profileText(profile)}.`,
    'Данные по темам (JSON):',
    JSON.stringify(data.topics, null, 1),
    `Всего: ${data.doneCount} из ${data.totalCount} тем пройдено, средний результат ${data.avg}%, всего XP ${data.xp}, занятий ${data.sessions}, время ${data.minutes} мин.`,
    'Верни JSON:',
    '{"verdict":"2–3 предложения — честная оценка прогресса, что получилось",',
    '"strengths":["2–4 сильные стороны с опорой на цифры"],',
    '"weak":["2–4 зоны роста, конкретно"],',
    '"recommendations":["3–5 следующих шагов, каждый — действие на 15–30 минут"],',
    '"grade":"оценка уровня словами, например «уверенный уровень»"}',
  ].join('\n')),
};

/* ==========================================================================
   Mock — демо-генератор (когда нет API-ключа или ИИ недоступен)
   ========================================================================== */

const Mock = (() => {
  const colors = ['blue', 'orange', 'purple'];
  const emojis = ['📘', '🧩', '🔍', '⚙️', '🧠', '🚀', '🧪', '📊', '🏗️'];

  function plan(topic, profile) {
    const t = topic.trim() || 'Новая тема';
    const simple = profile && (profile.level || 3) <= 2;
    const sections = [
      { title: 'Основы', sub: 'разбираемся, из чего всё состоит' },
      { title: 'Как это работает', sub: 'переходим к главным механизмам' },
      { title: 'Практика', sub: 'применяем знания на реальных примерах' },
    ].map((s, si) => ({
      id: `s${si + 1}`,
      title: s.title,
      subtitle: `${t}: ${s.sub}`,
      color: colors[si % colors.length],
      topics: Array.from({ length: 3 }).map((_, ti) => {
        const n = si * 3 + ti + 1;
        const title = [
          `${t}: с чего начать`,
          `Ключевые понятия`,
          `Как это устроено`,
          `Типичные ошибки новичка`,
          `Разбираем пример`,
          `Инструменты и приёмы`,
          `Практический кейс`,
          `Самопроверка и разбор`,
          `Итоговый разбор`,
        ][n - 1] || `${t}: шаг ${n}`;
        const correct = n % 4;
        return {
          id: `t${n}`,
          title,
          subtitle: `Шаг ${n} из 9 — то, без чего не двигаться дальше`,
          emoji: emojis[(n - 1) % emojis.length],
          level: Math.min(3, Math.ceil(n / 3)),
          teaches: [
            `Главная идея темы «${title}»`,
            'Как объяснить это своими словами',
            'Где это пригодится на практике',
          ],
          theory: [
            {
              h: 'Объясняем по-простому',
              body: `Тема «${title}» нужна, чтобы уверенно двигаться дальше по курсу «${t}». `
                + `Начнём с самой сути: у любой сложной вещи есть простой каркас, и здесь он такой — `
                + `есть условие, есть действие, есть результат. Разбери это на своём примере: возьми знакомую ситуацию `
                + `и распиши её этими тремя шагами. ${simple ? 'Не спеши: понимание важнее скорости.' : 'Попробуй сразу применить к своей цели.'}`,
            },
            {
              h: 'Пример',
              body: `Представь, что ты объясняешь «${title}» другу за две минуты. Что скажешь в первую очередь? `
                + `Обычно это и есть главное: смысл, зачем нужно и один живой пример. Если получается объяснить без терминов — ты понял тему.`,
            },
          ],
          quiz: Array.from({ length: 4 }).map((_, qi) => ({
            q: [
              `Зачем в теме «${title}» сначала разбирают главную идею?`,
              `Что лучше всего проверить, чтобы понять «${title}»?`,
              `Как правильно действовать, если в теме «${title}» что-то непонятно?`,
              `Какой признак того, что тему «${title}» действительно освоили?`,
            ][qi],
            options: [
              ['Чтобы дальше опираться на неё, а не заучивать детали', 'Чтобы быстрее закрыть тему', 'Так требует учитель', 'Это просто формальность'][qi],
              ['Объяснить тему своими словами и привести пример', 'Прочитать заголовок', 'Запомнить определение', 'Посмотреть чужой ответ'][qi],
              ['Разобрать на маленьком примере и задать вопрос ИИ-учителю', 'Пропустить и идти дальше', 'Выучить наизусть', 'Отложить тему навсегда'][qi],
              ['Могу применить это в новой задаче и объяснить другому', 'Помню все слова наизусть', 'Прошёл тест на 50%', 'Прослушал объяснение'][qi],
            ],
            answer: correct,
            explain: 'Верный вариант — тот, где знание можно применить, а не просто вспомнить формулировку.',
          })),
        };
      }),
    }));

    return {
      title: `Курс: ${t}`,
      emoji: '🎯',
      summary: `Демо-план по теме «${t}». Он показывает работу приложения без подключённого ключа ИИ: `
        + `настоящий план ИИ-учитель строит под твой возраст, цель и уровень.`,
      sections,
    };
  }

  function interview(topic) {
    return {
      questions: [
        { q: `Что тебе уже приходилось слышать про «${topic}»?`, options: ['Ничего не знаю', 'Что-то слышал(а)', 'Немного разбираюсь'], allow_custom: true },
        { q: 'Что для тебя самое непонятное прямо сейчас?', options: ['Термины', 'Как это применять', 'Всё сразу'], allow_custom: true },
        { q: 'Как тебе проще учиться?', options: ['С примерами', 'По шагам', 'Сначала теория'], allow_custom: true },
      ],
    };
  }

  function extra(_, topic) {
    return {
      analysis: 'Демо-разбор: ошибки обычно из-за спешки — понятие запоминают, но не проверяют на примере.',
      quiz: Array.from({ length: 3 }).map((_, i) => ({
        q: `Демо-вопрос ${i + 1}: как проверить понимание темы «${topic}»?`,
        options: ['Разобрать на своём примере', 'Перечитать текст ещё раз', 'Записать определение', 'Пропустить'],
        answer: 0,
        explain: 'Понимание проверяется применением.',
      })),
    };
  }

  function bonus(topic) {
    return {
      title: `Практика: мини-проект по теме «${topic}»`,
      task: 'Демо-задание. Возьми цель, которую ты ставил в начале курса, и разложи её на 5 шагов: '
        + 'что нужно узнать, что сделать, как проверить результат. Запиши каждый шаг одним предложением '
        + 'и отметь, какой из них ты можешь выполнить уже сегодня.',
      checklist: ['5 шагов записаны', 'У каждого шага есть проверяемый результат', 'Один шаг выполнен сегодня'],
    };
  }

  function report(data) {
    return {
      verdict: `Демо-отчёт: пройдено ${data.doneCount} из ${data.totalCount} тем со средним результатом ${data.avg}%. `
        + 'Подключи ключ ИИ, чтобы получить честный разбор ошибок и персональные рекомендации.',
      strengths: ['Регулярность занятий', 'Есть пройденные темы с высоким результатом'],
      weak: ['Нужен разбор ошибок по темам с результатом ниже 80%'],
      recommendations: ['Пересдать одну тему с худшим результатом', 'Разобрать 2 ошибки через ИИ-учителя', 'Сделать бонусное практическое задание'],
      grade: 'начальный уровень',
    };
  }

  return { plan, interview, extra, bonus, report };
})();
