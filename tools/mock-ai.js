/**
 * tools/mock-ai.js — локальный «ИИ» для отладки без реального ключа.
 *
 * Поднимает OpenAI-совместимый эндпоинт POST /v1/chat/completions и отдаёт
 * правдоподобные ответы для каждого запроса Duo-AI (интервью, план, тема,
 * разбор ошибок, бонус, отчёт). Полезно, чтобы проверить приложение целиком,
 * не тратя запросы к настоящей модели.
 *
 * Запуск:  node tools/mock-ai.js            (порт 8999)
 * Затем:   в «Настройках» Duo-AI укажи Base URL http://localhost:8999/v1
 *          и любой ключ, например mock-key.
 */

const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 8999);

function plan(topic) {
  const mk = (n, title, emoji) => ({
    id: `t${n}`,
    title,
    subtitle: `Шаг ${n}: разбираем по-простому и сразу пробуем`,
    emoji,
    level: Math.min(3, Math.ceil(n / 3)),
    teaches: [`Главное про «${title}»`, 'Как объяснить это своими словами', 'Где применить на практике'],
    theory: [
      { h: 'Суть на пальцах', body: `«${title}» — это про ${topic}. Представь, что объясняешь другу за две минуты: сначала смысл, потом один живой пример.` },
      { h: 'Пример', body: `Возьми ситуацию из жизни, связанную с «${topic}», и разложи её на три шага: что дано, что делаем, что получаем.` },
    ],
    quiz: [1, 2, 3, 4].map((i) => ({
      q: `Вопрос ${i} по теме «${title}»: что поможет понять её по-настоящему?`,
      options: [
        'Разобрать на своём примере и объяснить своими словами',
        'Прочитать заголовок темы',
        'Заучить определение',
        'Пропустить и идти дальше',
      ],
      answer: 0,
      explain: 'Понимание проверяется применением, а не заучиванием формулировки.',
    })),
  });

  return {
    title: `Курс по теме «${topic}»`,
    emoji: '🎯',
    summary: `Персональный план по теме «${topic}»: от базовых понятий к уверенной практике.`,
    sections: [
      { id: 's1', title: 'Основы', subtitle: 'разбираемся, из чего всё состоит', color: 'blue', topics: [mk(1, `Что такое ${topic}`, '📘'), mk(2, 'Ключевые понятия', '🧩'), mk(3, 'Как это устроено', '⚙️')] },
      { id: 's2', title: 'Как это работает', subtitle: 'переходим к главным механизмам', color: 'orange', topics: [mk(4, 'Типичные ошибки новичка', '🔍'), mk(5, `Разбираем пример: ${topic}`, '🧪'), mk(6, 'Инструменты и приёмы', '🛠️')] },
      { id: 's3', title: 'Практика', subtitle: 'применяем знания на реальных примерах', color: 'purple', topics: [mk(7, 'Практический кейс', '🚀'), mk(8, 'Самопроверка и разбор', '📊'), mk(9, 'Итоговый разбор', '🏁')] },
    ],
  };
}

function answerFor(messages) {
  const text = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  const low = text.toLowerCase();
  const topic = (text.match(/теме «([^»]+)»/) || text.match(/тему «([^»]+)»/) || [, 'твоей теме'])[1];

  if (/\bping\b/.test(low) && messages.length <= 2) return { text: 'pong' };
  if (low.includes('уточняющих вопроса') || low.includes('уточняющих вопросов')) {
    return {
      questions: [
        { q: `Что ты уже знаешь про «${topic}»?`, options: ['Ничего', 'Только слышал(а)', 'Немного разбираюсь'], allow_custom: true },
        { q: 'Что мешает больше всего?', options: ['Термины', 'Не вижу, где применять', 'Всё сразу'], allow_custom: true },
        { q: 'Как удобнее разбирать материал?', options: ['С примерами', 'По шагам', 'Сначала теория'], allow_custom: true },
      ],
    };
  }
  if (low.includes('персональный курс')) return plan(topic);
  if (low.includes('материал по теме') || low.includes('разбирает тему')) {
    return {
      theory: [
        { h: 'Объясняем по-простому', body: `Тема «${topic}» станет понятной, если начать с бытового примера и только потом вводить термины.` },
        { h: 'Как запомнить', body: 'Проговори тему вслух своими словами и приведи один пример из своей жизни.' },
      ],
      quiz: [1, 2, 3, 4].map((i) => ({
        q: `Новый вопрос ${i}: что значит «понять» тему «${topic}»?`,
        options: ['Уметь применить и объяснить другому', 'Помнить определение', 'Пройти тест на 50%', 'Прочитать один раз'],
        answer: 0,
        explain: 'Понимание = применение.',
      })),
    };
  }
  if (low.includes('разбери ошибки') || low.includes('ошибся')) {
    return {
      analysis: 'Ошибки типичны: понятие запомнили, но не проверили на конкретном примере — начнём с него.',
      quiz: [1, 2, 3].map((i) => ({
        q: `Похожий вопрос ${i}: как проверить, что тема «${topic}» действительно освоена?`,
        options: ['Решить новую задачу по теме', 'Перечитать конспект', 'Записать определение', 'Отложить тему'],
        answer: 0,
        explain: 'Проверка — новая задача, а не повторение текста.',
      })),
    };
  }
  if (low.includes('практическое задание')) {
    return {
      title: `Мини-проект по теме «${topic}»`,
      task: 'Возьми цель, которую ты ставил в начале курса, и разложи её на 5 шагов. Для каждого шага укажи результат, который можно проверить.',
      checklist: ['5 шагов выписаны', 'У каждого шага проверяемый результат', 'Первый шаг выполнен'],
    };
  }
  if (low.includes('отчёт об успеваемости') || low.includes('составь отчёт')) {
    return {
      verdict: 'Прогресс есть: темы разбираются последовательно, но часть ответов теряется из-за спешки в формулировках.',
      strengths: ['Регулярно доходит до конца урока', 'Сильные результаты в темах про суть понятий'],
      weak: ['Ошибки в вопросах на применение', 'Мало практики на своих примерах'],
      recommendations: ['Пересдать тему с самым низким результатом', 'Разобрать 2 ошибки через ИИ-учителя', 'Сделать мини-проект на 30 минут'],
      grade: 'уверенное начало',
    };
  }
  return { text: `Коротко про «${topic}»: начни со смысла — зачем это нужно, потом один живой пример, потом практика. Спрашивай, если что-то непонятно, — разберём по шагам.` };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch {}
    const messages = payload.messages || [];
    const out = answerFor(messages);
    // Отвечаем как настоящая модель: текст с ```json-обёрткой, чтобы проверить парсер.
    const content = out.text ? out.text : '```json\n' + JSON.stringify(out) + '\n```\n';
    const reply = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model || 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 600, total_tokens: 700 },
    };
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    }, 250); // имитируем задержку модели
  });
});

server.listen(PORT, () => console.log(`[mock-ai] OpenAI-совместимый мок на http://localhost:${PORT}/v1`));
