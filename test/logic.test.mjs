/* 逻辑单元测试：node --test test/logic.test.mjs */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// logic.js 是普通脚本（不是 ES 模块），这里载入源码并取出它挂出来的对外接口
const source = readFileSync(new URL('../logic.js', import.meta.url), 'utf8');
const L = new Function(`${source}\n;return HabitLogic;`)();

const TODAY = '2026-10-14';
const ms = (y, m, d, hh = 9, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();

function stateWith(habits, logs = {}, extra = {}) {
  return L.normalizeState({ schemaVersion: 1, habits, logs, ...extra });
}

/* ---------------- 时间与日期工具 ---------------- */

test('时间解析与校验', () => {
  assert.equal(L.normalizeTime('9:5'), '09:05');
  assert.equal(L.normalizeTime(' 23:59 '), '23:59');
  assert.equal(L.normalizeTime('24:00'), null);
  assert.equal(L.normalizeTime('09:60'), null);
  assert.equal(L.normalizeTime('abc'), null);
  assert.equal(L.normalizeTime(null), null);
  assert.equal(L.isValidTime('09:05'), true);
  assert.equal(L.isValidTime('9:5'), false);
});

test('日期键推进（含跨月跨年）', () => {
  assert.equal(L.dateKey(new Date(2026, 9, 14)), '2026-10-14');
  assert.equal(L.clockKey(new Date(2026, 9, 14, 9, 5, 30)), '09:05');
  assert.equal(L.shiftDateKey('2026-10-14', -1), '2026-10-13');
  assert.equal(L.shiftDateKey('2026-03-01', -1), '2026-02-28');
  assert.equal(L.shiftDateKey('2025-12-31', 1), '2026-01-01');
  assert.equal(L.parseDateKey('乱码'), null);
});

test('周起点是周一，月起点是 1 号', () => {
  const weekStart = L.weekStartKey(TODAY);
  assert.equal(L.parseDateKey(weekStart).getDay(), 1, '周一');
  assert.ok(weekStart <= TODAY);
  assert.ok(L.parseDateKey(TODAY) - L.parseDateKey(weekStart) < 7 * 86400000);
  assert.equal(L.weekStartKey('2026-10-12'), '2026-10-12', '本身就是周一');
  assert.equal(L.monthStartKey(TODAY), '2026-10-01');
  assert.equal(L.monthStartKey('2026-01-05'), '2026-01-01');
});

/* ---------------- 归一化 / 导入导出 ---------------- */

test('脏数据能容错成完整结构', () => {
  assert.deepEqual(L.normalizeState(null), L.defaultState());
  assert.deepEqual(L.normalizeState('垃圾'), L.defaultState());
  assert.deepEqual(L.normalizeState([]), L.defaultState());

  const state = L.normalizeState({
    settings: { theme: 'rainbow', snoozeMinutes: 999, soundEnabled: false },
    habits: [
      { id: 'a b!*', name: '   ', emoji: '', targetCount: '8', unit: '杯', reminderTimes: ['9:5', '25:00', '09:05', '09:05'] },
      'not-an-object',
    ],
    logs: { '2026-10-14': { 'a b!*': { done: 1, count: '3.7', doneAt: 'x' }, bogus: null } },
    fired: { '2026-10-14': ['k|1', 42], '乱码': ['k|2'] },
    snoozes: { 'a b!*|1': '1000', bad: 5 },
  });

  assert.equal(state.settings.theme, 'auto');
  assert.equal(state.settings.snoozeMinutes, 120);
  assert.equal(state.settings.soundEnabled, false);
  assert.equal(state.habits.length, 1, '非对象习惯被丢弃');

  const habit = state.habits[0];
  assert.equal(habit.id, 'ab');
  assert.equal(habit.name, '新习惯');
  assert.equal(habit.emoji, '✅');
  assert.equal(habit.targetCount, 8, '字符串数字被接受');
  assert.deepEqual(habit.reminderTimes, ['09:05'], '非法时间被剔除并去重排序');
  assert.equal(habit.paused, false);
  assert.equal(habit.archived, false);
  assert.equal(L.isValidTime(habit.createdAt) === false, true, 'createdAt 是日期键');

  assert.deepEqual(state.logs['2026-10-14'].ab, { done: false, count: 3, doneAt: null });
  assert.deepEqual(state.fired['2026-10-14'], ['k|1']);
  assert.equal(state.fired['乱码'], undefined);
  assert.deepEqual(state.snoozes, { 'a b!*|1': 1000 });
});

test('重复 id 会被换成新 id', () => {
  const state = L.normalizeState({
    habits: [{ id: 'same' }, { id: 'same' }],
  });
  assert.equal(state.habits.length, 2);
  assert.notEqual(state.habits[0].id, state.habits[1].id);
});

test('导出再导入内容一致（往返）', () => {
  const original = stateWith(
    [
      { id: 'water', name: '喝水', emoji: '💧', targetCount: 8, unit: '杯', reminderTimes: ['09:00', '15:00', '20:00'], createdAt: '2026-10-01', sortOrder: 0 },
      { id: 'run', name: '跑步', emoji: '🏃', reminderTimes: ['07:00'], createdAt: '2026-10-05', sortOrder: 1, paused: true },
    ],
    { '2026-10-13': { water: { done: true, count: 8, doneAt: ms(2026, 10, 13, 21) } } },
    { fired: { '2026-10-13': ['water|09:00'] }, snoozes: { 'water|1': 2 } },
  );

  const restored = L.parseImport(L.serialize(original));
  assert.deepEqual(restored, L.normalizeState(original));
  assert.throws(() => L.parseImport('{不是 json'));
});

/* ---------------- 打卡 ---------------- */

test('计数习惯：达标才算完成，掉下来就取消', () => {
  const state = stateWith([
    { id: 'water', name: '喝水', targetCount: 8, reminderTimes: ['09:00'], createdAt: '2026-10-01' },
  ]);
  const habit = state.habits[0];

  for (let i = 0; i < 7; i += 1) {
    const rec = L.applyProgress(state, habit, 'inc', ms(2026, 10, 14, 9, 30));
    assert.equal(rec.done, false, `第 ${i + 1} 次还没达标`);
  }
  const rec8 = L.applyProgress(state, habit, 'inc', ms(2026, 10, 14, 9, 31));
  assert.equal(rec8.count, 8);
  assert.equal(rec8.done, true);
  assert.equal(rec8.doneAt, ms(2026, 10, 14, 9, 31));
  assert.equal(L.isDoneOn(state, 'water', TODAY), true);

  const down = L.applyProgress(state, habit, 'dec', ms(2026, 10, 14, 9, 32));
  assert.equal(down.count, 7);
  assert.equal(down.done, false);
  assert.equal(down.doneAt, null);
});

test('计数习惯：直接点勾会把数量记为达标值', () => {
  const state = stateWith([
    { id: 'push', name: '俯卧撑', targetCount: 30, reminderTimes: [], createdAt: '2026-10-01' },
  ]);
  const habit = state.habits[0];
  L.applyProgress(state, habit, 'inc', ms(2026, 10, 14, 8));
  const rec = L.applyProgress(state, habit, 'toggle', ms(2026, 10, 14, 8, 1));
  assert.equal(rec.count, 30);
  assert.equal(rec.done, true);

  const off = L.applyProgress(state, habit, 'toggle', ms(2026, 10, 14, 8, 2));
  assert.equal(off.count, 0);
  assert.equal(off.done, false);
  assert.equal(L.getRecord(state, 'push', TODAY), null, '清零后不留空记录');
});

test('无目标习惯：点一下完成，再点取消（记录被清掉）', () => {
  const state = stateWith([{ id: 'run', name: '跑步', reminderTimes: ['07:00'], createdAt: '2026-10-01' }]);
  const habit = state.habits[0];
  const on = L.applyProgress(state, habit, 'toggle', ms(2026, 10, 14, 7, 30));
  assert.deepEqual({ done: on.done, count: on.count }, { done: true, count: 0 });
  const off = L.applyProgress(state, habit, 'toggle', ms(2026, 10, 14, 7, 31));
  assert.equal(off.done, false);
  assert.equal(L.getRecord(state, 'run', TODAY), null);
  assert.equal(state.logs[TODAY], undefined, '整天空记录也一起清掉');

  assert.throws(() => L.applyProgress(state, habit, 'nope', ms(2026, 10, 14, 8)), /未知操作/);
});

test('complete / uncomplete 以及完成后清掉稍后提醒', () => {
  const state = stateWith([
    { id: 'water', name: '喝水', targetCount: 8, reminderTimes: ['09:00'], createdAt: '2026-10-01' },
  ]);
  const habit = state.habits[0];
  L.scheduleSnooze(state, 'water', ms(2026, 10, 14, 9), 10);
  assert.equal(Object.keys(state.snoozes).length, 1);

  L.applyProgress(state, habit, 'inc', ms(2026, 10, 14, 9, 1));
  const rec = L.applyProgress(state, habit, 'complete', ms(2026, 10, 14, 9, 2));
  assert.equal(rec.count, 8);
  assert.equal(rec.done, true);
  assert.equal(Object.keys(state.snoozes).length, 0, '完成后不再稍后提醒');

  const undone = L.applyProgress(state, habit, 'uncomplete', ms(2026, 10, 14, 9, 3));
  assert.deepEqual({ done: undone.done, count: undone.count, doneAt: undone.doneAt }, { done: false, count: 0, doneAt: null });
});

/* ---------------- 连击与统计 ---------------- */

test('连击：今天完成从今天算，今天没完成从昨天续算', () => {
  const logs = {
    '2026-10-12': { run: { done: true, count: 0, doneAt: 1 } },
    '2026-10-13': { run: { done: true, count: 0, doneAt: 1 } },
  };
  const state = stateWith([{ id: 'run', name: '跑步', createdAt: '2026-10-01' }], logs);
  const habit = state.habits[0];

  assert.equal(L.computeStreak(state, habit, TODAY), 2, '今天还没打卡，连击不断');
  L.applyProgress(state, habit, 'toggle', ms(2026, 10, 14, 7, 10));
  assert.equal(L.computeStreak(state, habit, TODAY), 3, '今天补上后 +1');
});

test('连击：断档归零，创建日之前不算', () => {
  const state = stateWith(
    [{ id: 'run', name: '跑步', createdAt: '2026-10-10' }],
    { '2026-10-12': { run: { done: true, count: 0, doneAt: 1 } } },
  );
  const habit = state.habits[0];
  assert.equal(L.computeStreak(state, habit, TODAY), 0, '昨天断了就归零');

  const fresh = stateWith(
    [{ id: 'run', name: '跑步', createdAt: TODAY }],
    { '2026-10-10': { run: { done: true, count: 0, doneAt: 1 } } },
  );
  assert.equal(L.computeStreak(fresh, fresh.habits[0], TODAY), 0, '创建前的记录不参与连击');
  L.applyProgress(fresh, fresh.habits[0], 'toggle', ms(2026, 10, 14, 8));
  assert.equal(L.computeStreak(fresh, fresh.habits[0], TODAY), 1);
});

test('完成率：分母从习惯创建日起算', () => {
  const state = stateWith(
    [{ id: 'run', name: '跑步', createdAt: '2026-10-11' }],
    {
      '2026-10-12': { run: { done: true, count: 0, doneAt: 1 } },
      '2026-10-13': { run: { done: false, count: 0, doneAt: null } },
      '2026-10-14': { run: { done: true, count: 0, doneAt: 1 } },
    },
  );
  const habit = state.habits[0];
  const all = L.periodStats(state, habit, '2026-01-01', TODAY);
  assert.deepEqual({ from: all.from, total: all.total, done: all.done, rate: all.rate }, {
    from: '2026-10-11',
    total: 4,
    done: 2,
    rate: 50,
  });
  assert.equal(L.countDoneDays(state, habit), 2);

  const week = L.periodStats(state, habit, L.weekStartKey(TODAY), TODAY);
  assert.equal(week.total, 3, '本周从周一算起');
  assert.equal(week.done, 2);

  const stats = L.habitStats(state, habit, TODAY);
  assert.equal(stats.streak, 1);
  assert.equal(stats.week.rate, 67);
});

test('今日概览只看活跃习惯', () => {
  const state = stateWith([
    { id: 'a', name: 'A', createdAt: '2026-10-01' },
    { id: 'b', name: 'B', createdAt: '2026-10-01', paused: true },
    { id: 'c', name: 'C', createdAt: '2026-10-01', archived: true },
    { id: 'd', name: 'D', createdAt: '2026-11-01' },
  ]);
  assert.deepEqual(L.todaySummary(state, TODAY), { total: 1, done: 0, pending: 1 });
  L.applyProgress(state, state.habits[0], 'toggle', ms(2026, 10, 14, 8));
  assert.deepEqual(L.todaySummary(state, TODAY), { total: 1, done: 1, pending: 0 });
});

/* ---------------- 提醒 ---------------- */

test('提醒：到点触发一次，不重复；跨天后重新触发', () => {
  const state = stateWith([
    { id: 'water', name: '喝水', reminderTimes: ['09:00', '15:00'], createdAt: '2026-10-01' },
  ]);
  const at = (hh, mm, day = 14) => new Date(2026, 9, day, hh, mm, 30);

  assert.equal(L.dueReminders(state, at(8, 59)).length, 0, '没到点不触发');
  assert.equal(L.dueReminders(state, at(9, 0)).length, 1);
  assert.equal(L.dueReminders(state, at(9, 0)).length, 1, '同一分钟仍然只算一次');

  const [item] = L.dueReminders(state, at(9, 0));
  assert.equal(item.time, '09:00');
  assert.equal(item.key, 'water|09:00');
  assert.equal(item.habit.id, 'water');
  L.markFired(state, item.day, item.key);

  assert.equal(L.dueReminders(state, at(9, 0)).length, 0, '标记后不再重复');
  assert.equal(L.dueReminders(state, at(9, 1)).length, 0, '过了这一分钟也不补');
  assert.equal(L.dueReminders(state, at(15, 0)).length, 1, '当天第二个时间点照常触发');
  assert.equal(L.dueReminders(state, at(9, 0, 15)).length, 1, '第二天重新触发');
});

test('提醒：已完成、暂停、归档都不触发', () => {
  const at = new Date(2026, 9, 14, 9, 0, 30);
  const base = [{ id: 'water', name: '喝水', reminderTimes: ['09:00'], createdAt: '2026-10-01' }];

  const done = stateWith(base, { '2026-10-14': { water: { done: true, count: 0, doneAt: 1 } } });
  assert.equal(L.dueReminders(done, at).length, 0);

  const paused = stateWith([{ ...base[0], paused: true }]);
  assert.equal(L.dueReminders(paused, at).length, 0);

  const archived = stateWith([{ ...base[0], archived: true }]);
  assert.equal(L.dueReminders(archived, at).length, 0);
});

test('稍后提醒：到时间才响，响过就删，完成后取消', () => {
  const state = stateWith([
    { id: 'water', name: '喝水', reminderTimes: ['09:00'], createdAt: '2026-10-01' },
  ]);
  const base = ms(2026, 10, 14, 9, 0);
  L.scheduleSnooze(state, 'water', base, 10);

  assert.equal(L.dueReminders(state, new Date(base + 9 * 60000)).length, 0, '还没到');
  const due = L.dueReminders(state, new Date(base + 10 * 60000));
  assert.equal(due.length, 1);
  assert.equal(due[0].snooze, true);
  assert.equal(due[0].time, '稍后提醒');
  assert.ok(due[0].snoozeRawKey);

  delete state.snoozes[due[0].snoozeRawKey];
  assert.equal(L.dueReminders(state, new Date(base + 11 * 60000)).length, 0, '响过之后不再重复');

  L.scheduleSnooze(state, 'water', base, 10);
  assert.equal(L.clearSnoozesFor(state, 'water'), 1);
  assert.equal(Object.keys(state.snoozes).length, 0);
});

test('逾期习惯：已过提醒时间且未完成', () => {
  const state = stateWith([
    { id: 'water', name: '喝水', reminderTimes: ['09:00'], createdAt: '2026-10-01' },
    { id: 'run', name: '跑步', reminderTimes: ['23:00'], createdAt: '2026-10-01' },
    { id: 'gym', name: '健身', reminderTimes: ['08:00'], createdAt: '2026-10-01' },
  ]);
  L.applyProgress(state, state.habits[2], 'toggle', ms(2026, 10, 14, 8, 5));
  const overdue = L.overdueHabits(state, new Date(2026, 9, 14, 10, 0)).map((h) => h.id);
  assert.deepEqual(overdue, ['water'], '跑步还没到点、健身已完成，都不算逾期');
});

test('fired 只保留相邻三天', () => {
  const state = L.normalizeState({
    fired: {
      '2026-10-01': ['a|09:00'],
      '2026-10-13': ['a|09:00'],
      '2026-10-14': ['a|09:00'],
      '2026-10-15': ['a|09:00'],
    },
  });
  L.pruneFired(state, TODAY);
  assert.deepEqual(Object.keys(state.fired).sort(), ['2026-10-13', '2026-10-14', '2026-10-15']);
});

/* ---------------- .ics 导出 ---------------- */

test('.ics：每个提醒时间一条每日重复事件，用浮动本地时间', () => {
  const state = stateWith([
    {
      id: 'water',
      name: '喝水,8;杯',
      emoji: '💧',
      targetCount: 8,
      unit: '杯',
      reminderTimes: ['09:00', '23:55'],
      createdAt: '2026-10-01',
    },
    { id: 'run', name: '跑步', emoji: '🏃', reminderTimes: [], createdAt: '2026-10-01' },
    { id: 'off', name: '暂停的', reminderTimes: ['10:00'], createdAt: '2026-10-01', paused: true },
    { id: 'old', name: '归档的', reminderTimes: ['11:00'], createdAt: '2026-10-01', archived: true },
  ]);
  const ics = L.buildICS(state, { now: new Date(2026, 9, 14, 12, 0) });

  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.split('BEGIN:VEVENT').length - 1, 2, '两个提醒时间 → 两条事件');
  assert.equal((ics.match(/RRULE:FREQ=DAILY/g) || []).length, 2);
  assert.ok(ics.includes('DTSTART:20261014T090000\r\n'), '浮动本地时间，没有 Z');
  assert.ok(ics.includes('DTEND:20261014T091000\r\n'), '默认 10 分钟');
  assert.ok(ics.includes('DTEND:20261015T000500\r\n'), '跨零点正确进位');
  assert.ok(ics.includes('SUMMARY:💧 喝水\\,8\\;杯'), '逗号和分号被转义');
  assert.ok(ics.includes('UID:water-0900@habit-tracker'));
  assert.ok(!ics.includes('暂停的') && !ics.includes('归档的'), '暂停/归档不导出');
  assert.ok(/DTSTAMP:\d{8}T\d{6}Z/.test(ics));
});

test('.ics：没有提醒时间时只有空日历', () => {
  const state = stateWith([{ id: 'run', name: '跑步', reminderTimes: [], createdAt: '2026-10-01' }]);
  const ics = L.buildICS(state, { now: new Date(2026, 9, 14, 12, 0) });
  assert.ok(!ics.includes('BEGIN:VEVENT'));
});

test('示例习惯可以直接用', () => {
  const list = L.sampleHabits(TODAY);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((h) => h.name), ['喝水', '跑步', '俯卧撑']);
  assert.equal(list[0].targetCount, 8);
  assert.deepEqual(list[0].reminderTimes, ['09:00', '15:00', '20:00']);
  assert.ok(list.every((h) => h.createdAt === TODAY));
});
