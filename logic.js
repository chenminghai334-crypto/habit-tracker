/* logic.js — 纯逻辑模块（不依赖 DOM），浏览器与 Node 测试共用
 * 故意写成普通脚本（不用 import/export）：这样双击 index.html 用 file:// 打开时
 * 浏览器不会因为 CORS 拦截模块加载，也就免去了必须起本地服务器的麻烦。
 * 对外暴露的接口在文件末尾挂到 window.HabitLogic 上。
 */

'use strict';

const SCHEMA_VERSION = 1;
const STORAGE_KEY = 'habitTracker:v1';

const EMOJI_CHOICES = [
  '💧', '🏃', '💪', '🧘', '🏋️', '🚶', '🚴', '🏊', '⚽', '🤸',
  '📖', '✍️', '📚', '🎧', '🗣️', '🧠', '🎸', '🎨', '🧩', '💻',
  '🥗', '🍎', '🍵', '☕', '🥛', '🍽️', '🚭', '💊', '🦷', '🧼',
  '😴', '🛏️', '🌞', '🌙', '🧴', '🧹', '💰', '📝', '📷', '🐕',
  '🙏', '❤️', '🔥', '✅', '🎯', '⏰',
];

/* ---------------- 基础工具 ---------------- */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地自然日的日期键：YYYY-MM-DD */
function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** HH:MM */
function clockKey(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function shiftDateKey(key, days) {
  const d = parseDateKey(key) || new Date();
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ''));
}

/** 宽松解析时间："9:5" -> "09:05"，非法返回 null */
function normalizeTime(value) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${pad2(h)}:${pad2(mi)}`;
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function uniqueSorted(list) {
  return Array.from(new Set(list)).sort();
}

let idSeed = 0;
function makeId() {
  idSeed = (idSeed + 1) % 1_000_000;
  return `h${Date.now().toString(36)}${idSeed.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 只保留安全字符，防止导入的数据把 id 注入到 HTML 属性里 */
function sanitizeId(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '');
}

/* ---------------- 状态结构 ---------------- */

function defaultSettings() {
  return {
    soundEnabled: true,
    vibrateEnabled: true,
    snoozeMinutes: 10,
    theme: 'auto', // auto | light | dark
    reminderIntroSeen: false,
  };
}

function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    habits: [],
    logs: {},
    fired: {},
    snoozes: {},
    settings: defaultSettings(),
  };
}

function createHabit(input = {}, opts = {}) {
  const today = opts.today || dateKey();
  const rawTimes = Array.isArray(input.reminderTimes) ? input.reminderTimes : [];
  const times = uniqueSorted(rawTimes.map(normalizeTime).filter(Boolean));
  const target = Math.floor(Number(input.targetCount));
  const created = parseDateKey(input.createdAt) ? String(input.createdAt) : today;
  const order = Number(input.sortOrder);
  return {
    id: sanitizeId(input.id) || sanitizeId(opts.id) || makeId(),
    name: String(input.name ?? '').trim() || '新习惯',
    emoji: String(input.emoji ?? '').trim() || '✅',
    targetCount: Number.isFinite(target) && target > 0 ? target : null,
    unit: String(input.unit ?? '').trim().slice(0, 8),
    reminderTimes: times,
    sortOrder: Number.isFinite(order) ? order : 0,
    paused: input.paused === true,
    archived: input.archived === true,
    createdAt: created,
  };
}

/** 容错归一化：任何脏数据都能变成结构完整的状态 */
function normalizeState(raw) {
  const state = defaultState();
  if (!raw || typeof raw !== 'object') return state;

  const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  state.settings = {
    soundEnabled: s.soundEnabled !== false,
    vibrateEnabled: s.vibrateEnabled !== false,
    snoozeMinutes: clampInt(s.snoozeMinutes, 1, 120, 10),
    theme: ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : 'auto',
    reminderIntroSeen: s.reminderIntroSeen === true,
  };

  const habits = Array.isArray(raw.habits) ? raw.habits : [];
  const seenIds = new Set();
  const normalized = [];
  habits.forEach((h, index) => {
    if (!h || typeof h !== 'object') return;
    const habit = createHabit({ ...h, sortOrder: h.sortOrder ?? index });
    if (seenIds.has(habit.id)) habit.id = makeId();
    seenIds.add(habit.id);
    normalized.push(habit);
  });
  normalized.sort((a, b) => a.sortOrder - b.sortOrder);
  state.habits = normalized;

  const logs = raw.logs && typeof raw.logs === 'object' ? raw.logs : {};
  for (const [day, entries] of Object.entries(logs)) {
    if (!parseDateKey(day) || !entries || typeof entries !== 'object') continue;
    const clean = {};
    for (const [habitId, rec] of Object.entries(entries)) {
      if (!rec || typeof rec !== 'object') continue;
      const id = sanitizeId(habitId);
      if (!id) continue;
      const count = Math.floor(Number(rec.count));
      const doneAt = Number(rec.doneAt);
      clean[id] = {
        done: rec.done === true,
        count: Number.isFinite(count) && count > 0 ? count : 0,
        doneAt: Number.isFinite(doneAt) && doneAt > 0 ? doneAt : null,
      };
    }
    if (Object.keys(clean).length) state.logs[day] = clean;
  }

  const fired = raw.fired && typeof raw.fired === 'object' ? raw.fired : {};
  for (const [day, list] of Object.entries(fired)) {
    if (!parseDateKey(day) || !Array.isArray(list)) continue;
    const clean = uniqueSorted(list.filter((k) => typeof k === 'string' && k.includes('|')));
    if (clean.length) state.fired[day] = clean;
  }

  const snoozes = raw.snoozes && typeof raw.snoozes === 'object' ? raw.snoozes : {};
  for (const [key, at] of Object.entries(snoozes)) {
    const time = Number(at);
    if (typeof key !== 'string' || !key.includes('|') || !Number.isFinite(time)) continue;
    state.snoozes[key] = time;
  }

  return state;
}

function serialize(state) {
  return JSON.stringify(state, null, 2);
}

function parseImport(text) {
  return normalizeState(JSON.parse(text));
}

/* ---------------- 查询 ---------------- */

function isHabitActiveOn(habit, day) {
  if (!habit || habit.archived || habit.paused) return false;
  return !habit.createdAt || habit.createdAt <= day;
}

function activeHabits(state, day = dateKey()) {
  return state.habits
    .filter((h) => isHabitActiveOn(h, day))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function getRecord(state, habitId, day) {
  return state.logs?.[day]?.[habitId] || null;
}

function isDoneOn(state, habitId, day) {
  return getRecord(state, habitId, day)?.done === true;
}

function getCountOn(state, habitId, day) {
  return getRecord(state, habitId, day)?.count || 0;
}

function todaySummary(state, day = dateKey()) {
  const list = activeHabits(state, day);
  const done = list.filter((h) => isDoneOn(state, h.id, day)).length;
  return { total: list.length, done, pending: list.length - done };
}

function overdueHabits(state, now = new Date()) {
  const day = dateKey(now);
  const clock = clockKey(now);
  return activeHabits(state, day).filter(
    (h) => !isDoneOn(state, h.id, day) && h.reminderTimes.some((t) => t < clock),
  );
}

/* ---------------- 打卡 ---------------- */

const ACTIONS = ['toggle', 'inc', 'dec', 'complete', 'uncomplete'];

/**
 * 修改某习惯今天的打卡状态。就地修改 state 并返回新的记录。
 * action: toggle | inc | dec | complete | uncomplete
 */
function applyProgress(state, habit, action, nowMs = Date.now()) {
  if (!ACTIONS.includes(action)) throw new Error(`未知操作：${action}`);
  const day = dateKey(new Date(nowMs));
  const logs = (state.logs[day] ||= {});
  const prev = logs[habit.id] || null;
  const wasDone = prev?.done === true;
  const target = habit.targetCount || 0;
  let count = prev?.count || 0;
  let done = wasDone;
  let doneAt = prev?.doneAt ?? null;

  switch (action) {
    case 'inc':
      count += 1;
      break;
    case 'dec':
      count = Math.max(0, count - 1);
      break;
    case 'toggle':
      if (target) {
        if (wasDone) {
          done = false;
          count = 0;
        } else {
          done = true;
          count = Math.max(count, target);
        }
      } else {
        done = !wasDone;
        count = 0;
      }
      break;
    case 'complete':
      done = true;
      count = target ? Math.max(count, target) : 0;
      break;
    case 'uncomplete':
      done = false;
      count = 0;
      break;
    default:
      break;
  }

  if (target) {
    done = count >= target;
  } else if (action === 'inc' || action === 'dec') {
    count = 0; // 无目标数量的习惯不保留计数
  }
  if (done && !wasDone) doneAt = nowMs;
  if (!done) doneAt = null;

  const rec = { done, count, doneAt };
  if (!done && count === 0) delete logs[habit.id];
  else logs[habit.id] = rec;
  if (!Object.keys(logs).length) delete state.logs[day];
  if (done) clearSnoozesFor(state, habit.id);
  return rec;
}

/* ---------------- 连击与统计 ---------------- */

function computeStreak(state, habit, today = dateKey()) {
  let cursor = today;
  if (!isDoneOn(state, habit.id, cursor)) cursor = shiftDateKey(cursor, -1);
  let streak = 0;
  let guard = 0;
  while (guard++ < 4000) {
    if (habit.createdAt && cursor < habit.createdAt) break;
    if (!isDoneOn(state, habit.id, cursor)) break;
    streak += 1;
    cursor = shiftDateKey(cursor, -1);
  }
  return streak;
}

function weekStartKey(today = dateKey()) {
  const d = parseDateKey(today) || new Date();
  const mondayOffset = (d.getDay() + 6) % 7; // 周一 = 0
  d.setDate(d.getDate() - mondayOffset);
  return dateKey(d);
}

function monthStartKey(today = dateKey()) {
  const d = parseDateKey(today) || new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
}

/** 区间完成率；分母从 max(区间起点, 习惯创建日) 到 end 起算 */
function periodStats(state, habit, startKey, endKey = dateKey()) {
  const from = habit.createdAt && habit.createdAt > startKey ? habit.createdAt : startKey;
  let total = 0;
  let done = 0;
  let cursor = from;
  let guard = 0;
  while (cursor <= endKey && guard++ < 4000) {
    total += 1;
    if (isDoneOn(state, habit.id, cursor)) done += 1;
    cursor = shiftDateKey(cursor, 1);
  }
  return { from, to: endKey, total, done, rate: total ? Math.round((done / total) * 100) : 0 };
}

function countDoneDays(state, habit) {
  let total = 0;
  for (const entries of Object.values(state.logs || {})) {
    if (entries?.[habit.id]?.done === true) total += 1;
  }
  return total;
}

function habitStats(state, habit, today = dateKey()) {
  return {
    streak: computeStreak(state, habit, today),
    week: periodStats(state, habit, weekStartKey(today), today),
    month: periodStats(state, habit, monthStartKey(today), today),
    all: periodStats(state, habit, habit.createdAt || today, today),
    totalDone: countDoneDays(state, habit),
  };
}

/* ---------------- 提醒 ---------------- */

function reminderKey(habitId, time) {
  return `${habitId}|${time}`;
}

function markFired(state, day, key) {
  const list = (state.fired[day] ||= []);
  if (!list.includes(key)) list.push(key);
  return state.fired[day];
}

function hasFired(state, day, key) {
  return (state.fired?.[day] || []).includes(key);
}

/** 只保留昨天/今天/明天，避免无限增长 */
function pruneFired(state, today = dateKey()) {
  const keep = new Set([shiftDateKey(today, -1), today, shiftDateKey(today, 1)]);
  for (const day of Object.keys(state.fired || {})) {
    if (!keep.has(day)) delete state.fired[day];
  }
}

function scheduleSnooze(state, habitId, nowMs = Date.now(), minutes) {
  const mins = Number.isFinite(Number(minutes))
    ? clampInt(minutes, 1, 120, 10)
    : clampInt(state?.settings?.snoozeMinutes, 1, 120, 10);
  const key = `${habitId}|${nowMs}`;
  state.snoozes[key] = nowMs + mins * 60_000;
  return key;
}

function clearSnoozesFor(state, habitId) {
  let removed = 0;
  for (const key of Object.keys(state.snoozes || {})) {
    if (key.split('|')[0] === habitId) {
      delete state.snoozes[key];
      removed += 1;
    }
  }
  return removed;
}

/**
 * 当前时刻应当响起的提醒。
 * 返回 [{ habit, day, time, key, snooze, snoozeRawKey }]
 */
function dueReminders(state, now = new Date()) {
  const day = dateKey(now);
  const clock = clockKey(now);
  const nowMs = now.getTime();
  const due = [];

  for (const habit of activeHabits(state, day)) {
    if (isDoneOn(state, habit.id, day)) continue;
    for (const time of habit.reminderTimes) {
      if (time !== clock) continue;
      const key = reminderKey(habit.id, time);
      if (hasFired(state, day, key)) continue;
      due.push({ habit, day, time, key, snooze: false, snoozeRawKey: null });
    }
  }

  for (const [rawKey, at] of Object.entries(state.snoozes || {})) {
    if (at > nowMs) continue;
    const habitId = rawKey.split('|')[0];
    const habit = state.habits.find((h) => h.id === habitId);
    if (!habit || !isHabitActiveOn(habit, day) || isDoneOn(state, habit.id, day)) continue;
    due.push({
      habit,
      day,
      time: '稍后提醒',
      key: `snooze|${rawKey}`,
      snooze: true,
      snoozeRawKey: rawKey,
    });
  }

  return due;
}

/* ---------------- .ics 日历导出 ---------------- */

function escapeICSText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** 按 RFC5545 折叠超过 75 字节的行 */
function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    if (size + bytes > 73 && current) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  if (current) parts.push(current);
  return parts.join('\r\n ');
}

function stampUTC(date) {
  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
  );
}

/**
 * 生成可导入手机日历的 .ics。
 * 使用浮动本地时间（不带 TZID / Z），手机日历按本机时区解释，无需 VTIMEZONE。
 */
function buildICS(state, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const today = dateKey(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Habit Tracker//Habit Reminder 1.0//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:习惯打卡提醒',
  ];
  const stamp = stampUTC(now);

  for (const habit of activeHabits(state, today)) {
    for (const time of habit.reminderTimes) {
      const [hh, mm] = time.split(':').map(Number);
      const startDay = habit.createdAt && habit.createdAt > today ? habit.createdAt : today;
      const startDate = parseDateKey(startDay) || now;
      const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), hh, mm);
      const end = new Date(start.getTime() + 10 * 60_000);
      const compact = (d) =>
        `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
      const target = habit.targetCount ? ` · 目标 ${habit.targetCount}${habit.unit || ''}` : '';
      lines.push(
        'BEGIN:VEVENT',
        `UID:${habit.id}-${pad2(hh)}${pad2(mm)}@habit-tracker`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${compact(start)}`,
        `DTEND:${compact(end)}`,
        'RRULE:FREQ=DAILY',
        `SUMMARY:${escapeICSText(`${habit.emoji} ${habit.name}`)}`,
        `DESCRIPTION:${escapeICSText(`习惯打卡提醒${target}`)}`,
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM',
        'TRIGGER:PT0M',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeICSText(habit.name)}`,
        'END:VALARM',
        'END:VEVENT',
      );
    }
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/* ---------------- 示例习惯 ---------------- */

function sampleHabits(today = dateKey()) {
  return [
    createHabit(
      { name: '喝水', emoji: '💧', targetCount: 8, unit: '杯', reminderTimes: ['09:00', '15:00', '20:00'], sortOrder: 0, createdAt: today },
      { today },
    ),
    createHabit(
      { name: '跑步', emoji: '🏃', reminderTimes: ['07:00'], sortOrder: 1, createdAt: today },
      { today },
    ),
    createHabit(
      { name: '俯卧撑', emoji: '💪', targetCount: 30, unit: '个', reminderTimes: ['21:00'], sortOrder: 2, createdAt: today },
      { today },
    ),
  ];
}

/* 对外接口：浏览器里用 window.HabitLogic，Node 测试里用 new Function 取同名对象 */
const HabitLogic = {
  SCHEMA_VERSION,
  STORAGE_KEY,
  EMOJI_CHOICES,
  ACTIONS,
  pad2,
  dateKey,
  clockKey,
  parseDateKey,
  shiftDateKey,
  isValidTime,
  normalizeTime,
  clampInt,
  uniqueSorted,
  makeId,
  defaultSettings,
  defaultState,
  createHabit,
  normalizeState,
  serialize,
  parseImport,
  isHabitActiveOn,
  activeHabits,
  getRecord,
  isDoneOn,
  getCountOn,
  todaySummary,
  overdueHabits,
  applyProgress,
  computeStreak,
  weekStartKey,
  monthStartKey,
  periodStats,
  countDoneDays,
  habitStats,
  reminderKey,
  markFired,
  hasFired,
  pruneFired,
  scheduleSnooze,
  clearSnoozesFor,
  dueReminders,
  buildICS,
  sampleHabits,
};

if (typeof window !== 'undefined') window.HabitLogic = HabitLogic;
