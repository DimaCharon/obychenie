/**
 * tests/adaptive.test.mjs — адаптация под ученика.
 *
 * Проверяем механику, от которой зависит подбор заданий:
 *   1. стартовый уровень берётся из ответа в опросе;
 *   2. уровень растёт на сильных результатах и падает на слабых;
 *   3. сложность заданий (1..3) выводится из уровня;
 *   4. уверенность растёт, а шаг изменения уровня замедляется;
 *   5. история попыток, темп и «модель ученика» для промптов заполняются;
 *   6. слабые темы и метрики считаются по прогрессу курса;
 *   7. локальный анализ (демо-режим) описывает ученика без ключа ИИ.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

const require = createRequire(import.meta.url);
const Adaptive = require(path.join(ROOT, 'public/js/adaptive.js'));

const courseWith = (progress = {}, adaptive = null) => ({
  topic: 'Проценты',
  profile: { level: 3 },
  progress,
  sections: [{ id: 's1', topics: [{ id: 't1', title: 'Основы процентов' }, { id: 't2', title: 'Скидки' }] }],
  adaptive: adaptive || Adaptive.blank({ level: 3 }),
});

describe('адаптация: уровень и сложность заданий', () => {
  test('стартовый уровень берётся из опроса, сложность выводится из уровня', () => {
    const low = Adaptive.blank({ level: 1 });
    const mid = Adaptive.blank({ level: 3 });
    const high = Adaptive.blank({ level: 5 });

    assert.equal(low.level, 1);
    assert.equal(mid.level, 3);
    assert.equal(high.level, 5);

    assert.equal(Adaptive.difficultyFor(1), 1);
    assert.equal(Adaptive.difficultyFor(2), 1);
    assert.equal(Adaptive.difficultyFor(3), 2);
    assert.equal(Adaptive.difficultyFor(4), 3);
    assert.equal(Adaptive.difficultyFor(5), 3);
    assert.equal(Adaptive.difficultyName(1), 'базовый');
    assert.equal(Adaptive.difficultyName(3), 'продвинутый');
  });

  test('сильный результат поднимает уровень и в какой-то момент — сложность', () => {
    const a = Adaptive.blank({ level: 3 });
    const first = Adaptive.record(a, { score: 1, seconds: 60, questions: 4, topicId: 't1' });
    assert.ok(first.levelAfter > first.levelBefore, 'после 100% уровень должен вырасти');
    assert.equal(first.direction, 'up');

    // ещё один сильный результат — сложность обязана подняться
    const second = Adaptive.record(a, { score: 1, seconds: 60, questions: 4, topicId: 't2' });
    assert.ok(second.difficultyAfter >= second.difficultyBefore, 'сложность не должна падать при отличных результатах');
    assert.ok(a.level > 3, `уровень должен вырасти выше стартового, сейчас ${a.level}`);
  });

  test('провал опускает уровень и сложность, ученику дают задания проще', () => {
    const a = Adaptive.blank({ level: 4 });
    const r1 = Adaptive.record(a, { score: 0.25, seconds: 240, questions: 4, topicId: 't1' });
    assert.equal(r1.direction, 'down');
    assert.ok(r1.levelAfter < r1.levelBefore);
    const r2 = Adaptive.record(a, { score: 0.25, seconds: 240, questions: 4, topicId: 't1' });
    assert.ok(r2.difficultyAfter <= r1.difficultyAfter, 'сложность должна снижаться или держаться');
    assert.match(r2.message, /проще|полегче|разберу/i);
  });

  test('уровень не выходит за границы 1..5 и шаг замедляется с ростом уверенности', () => {
    const a = Adaptive.blank({ level: 1 });
    for (let i = 0; i < 12; i += 1) Adaptive.record(a, { score: 0.1, seconds: 30, questions: 4 });
    assert.equal(a.level, 1, 'ниже 1 уровень не падает');

    const b = Adaptive.blank({ level: 5 });
    for (let i = 0; i < 12; i += 1) Adaptive.record(b, { score: 1, seconds: 20, questions: 4 });
    assert.equal(b.level, 5, 'выше 5 уровень не растёт');
    assert.ok(b.confidence > 0.9, `уверенность должна расти: ${b.confidence}`);
  });

  test('история, темп и типичные ошибки накапливаются', () => {
    const a = Adaptive.blank({ level: 3 });
    Adaptive.record(a, { score: 0.75, seconds: 120, questions: 4, topicId: 't1', errorTags: ['что такое процент?'] });
    Adaptive.record(a, { score: 0.5, seconds: 80, questions: 4, topicId: 't2', errorTags: ['как считать скидку?'] });

    assert.equal(a.history.length, 2);
    assert.equal(a.attempts, 2);
    assert.equal(a.history[0].topicId, 't1');
    assert.ok(a.pace > 0, 'темп (сек/вопрос) должен посчитаться');
    assert.equal(a.errorTags.length, 2);
    assert.equal(a.errorTags[0], 'как считать скидку?', 'свежие ошибки — впереди');
  });

  test('модель ученика для промптов описывает уровень, сложность и результаты', () => {
    const course = courseWith();
    Adaptive.record(Adaptive.ensure(course), { score: 1, seconds: 40, questions: 4, topicId: 't1' });
    const text = Adaptive.text(course);

    assert.match(text, /уровень/i);
    assert.match(text, /сложност/i);
    assert.match(text, /100%|темп/i);
    assert.match(text, /базов|средн|продвинут/i);
  });

  test('слабые темы и метрики считаются по прогрессу курса', () => {
    const course = courseWith({
      t1: { best: 0.4, attempts: 2 },
      t2: { best: 1, attempts: 1 },
    });
    const weak = Adaptive.weakTopics(course);
    assert.equal(weak.length, 1);
    assert.equal(weak[0].id, 't1');
    assert.equal(Math.round(weak[0].best * 100), 40);

    Adaptive.record(Adaptive.ensure(course), { score: 1, seconds: 60, questions: 4, topicId: 't2' });
    const m = Adaptive.metrics(course);
    assert.equal(m.attempts, 1);
    assert.equal(m.avg, 100);
    assert.equal(m.difficulty, Adaptive.difficultyFor(m.level));
  });

  test('демо-анализ работает без ключа ИИ и опирается на данные', () => {
    const course = courseWith({ t1: { best: 0.3, attempts: 2 } });
    Adaptive.record(Adaptive.ensure(course), { score: 0.5, seconds: 90, questions: 4, topicId: 't1' });
    const analysis = Adaptive.localAnalysis(course, { doneCount: 1, total: 2, avg: 50 });

    assert.equal(analysis.demo, true);
    assert.ok(analysis.summary.length > 40);
    assert.ok(Array.isArray(analysis.strengths) && analysis.strengths.length >= 1);
    assert.ok(Array.isArray(analysis.weaknesses) && analysis.weaknesses.length >= 1);
    assert.ok(Array.isArray(analysis.nextSteps) && analysis.nextSteps.length >= 1);
    assert.match(analysis.summary, /уровень/i);
  });

  test('ensure() восстанавливает адаптацию у курсов старого формата', () => {
    const legacy = { topic: 'Старый курс', profile: { level: 4 }, progress: {}, sections: [] };
    const a = Adaptive.ensure(legacy);
    assert.ok(a, 'адаптация должна создаться');
    assert.equal(a.level, 4, 'стартовый уровень берём из профиля');
    assert.equal(a.history.length, 0);
    assert.ok(Array.isArray(a.errorTags));
  });
});
