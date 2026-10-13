/* app.js — 界面与交互（依赖 logic.js 的纯逻辑，通过 window.HabitLogic 取用） */

'use strict';

const L = window.HabitLogic;

const $ = (sel, root = document) => root.querySelector(sel);

const VIEWS = [
  { id: 'today', label: '今日', icon: '☀️' },
  { id: 'stats', label: '统计', icon: '📊' },
  { id: 'manage', label: '习惯', icon: '🗂️' },
  { id: 'settings', label: '设置', icon: '⚙️' },
];

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

let state = loadState();
const ui = {
  view: 'today',
  day: L.dateKey(),
  editing: null,
  banners: [],
  toastTimer: null,
};

/* ---------------- 存储 ---------------- */

function loadState() {
  try {
    const raw = localStorage.getItem(L.STORAGE_KEY);
    return L.normalizeState(raw ? JSON.parse(raw) : null);
  } catch (err) {
    return L.defaultState();
  }
}

function saveState() {
  try {
    localStorage.setItem(L.STORAGE_KEY, L.serialize(state));
    return true;
  } catch (err) {
    toast('保存失败：浏览器不允许本地存储，换个浏览器或改用「启动.cmd」打开');
    return false;
  }
}

/* ---------------- 小工具 ---------------- */

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function toast(message) {
  const box = $('#toast');
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 2600);
}

function prettyDate(key) {
  return `${Number(key.slice(5, 7))} 月 ${Number(key.slice(8, 10))} 日`;
}

function downloadBlob(text, type, filename) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ---------------- 主题与声音 ---------------- */

function resolveTheme() {
  const mode = state.settings.theme || 'auto';
  if (mode !== 'auto') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  const resolved = resolveTheme();
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolved === 'dark' ? '#0f1115' : '#f4f5f7';
}

let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      audioCtx = new Ctor();
    } catch (err) {
      return null;
    }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function unlockAudio() {
  const ctx = ensureAudio();
  return ctx;
}

function playChime() {
  if (!state.settings.soundEnabled) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const notes = [880, 1046.5, 1318.5];
  const base = ctx.currentTime + 0.02;
  notes.forEach((freq, index) => {
    const at = base + index * 0.2;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(0.22, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.32);
  });
}

function vibrate() {
  if (!state.settings.vibrateEnabled) return;
  try {
    navigator.vibrate?.([220, 120, 220, 120, 320]);
  } catch (err) {
    /* 忽略：部分浏览器不支持 */
  }
}

async function showNotification(habit, time, snooze) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = `${habit.emoji || '⏰'} ${habit.name}`;
  const body = snooze ? '稍后提醒时间到了，该做啦' : `${time} 到时间啦，点一下完成打卡`;
  const options = {
    body,
    tag: `habit-${habit.id}-${time}`,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { habitId: habit.id },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) {
      await reg.showNotification(title, options);
      return;
    }
  } catch (err) {
    /* 继续尝试普通通知 */
  }
  try {
    new Notification(title, options);
  } catch (err) {
    /* 忽略 */
  }
}

/* ---------------- 提醒 ---------------- */

function fireReminder({ habit, time, snooze }) {
  if (!ui.banners.some((b) => b.id === habit.id)) {
    ui.banners.push({ id: habit.id, name: habit.name, emoji: habit.emoji, time, snooze });
  }
  playChime();
  vibrate();
  showNotification(habit, time, snooze);
  renderBanners();
}

function tick() {
  const now = new Date();
  const day = L.dateKey(now);
  if (day !== ui.day) {
    ui.day = day;
    ui.banners = [];
    L.pruneFired(state, day);
    saveState();
    render();
  }
  const due = L.dueReminders(state, now);
  if (!due.length) return;
  for (const item of due) {
    if (item.snooze) delete state.snoozes[item.snoozeRawKey];
    else L.markFired(state, item.day, item.key);
    fireReminder(item);
  }
  saveState();
  if (ui.view === 'today') render();
}

function renderBanners() {
  const box = $('#banners');
  if (!box) return;
  if (!ui.banners.length) {
    box.hidden = true;
    box.innerHTML = '';
    document.documentElement.style.setProperty('--banner-h', '0px');
    return;
  }
  box.hidden = false;
  box.innerHTML = ui.banners
    .map(
      (b) => `<div class="banner">
      <div class="habit-emoji small">${esc(b.emoji || '⏰')}</div>
      <div class="banner-body">
        <b>${esc(b.name)}</b>
        <small>${b.snooze ? '稍后提醒时间到了' : `${esc(b.time)} 到时间啦`} · 做完点一下「完成」</small>
      </div>
      <button class="btn small primary" data-action="banner-done" data-id="${esc(b.id)}">完成</button>
      <button class="btn small" data-action="banner-snooze" data-id="${esc(b.id)}">稍后 ${state.settings.snoozeMinutes} 分钟</button>
      <button class="btn small icon" data-action="banner-dismiss" data-id="${esc(b.id)}" aria-label="关闭">✕</button>
    </div>`,
    )
    .join('');
  // 让内容整体下移，避免横幅盖住顶部卡片
  document.documentElement.style.setProperty('--banner-h', `${box.offsetHeight}px`);
}

/* ---------------- 渲染 ---------------- */

function renderNav() {
  const items = VIEWS.map(
    (v) =>
      `<a class="nav-item ${ui.view === v.id ? 'active' : ''}" href="#${v.id}">
        <span class="nav-icon">${v.icon}</span><span>${v.label}</span>
      </a>`,
  ).join('');
  const tabs = VIEWS.map(
    (v) =>
      `<a class="tab ${ui.view === v.id ? 'active' : ''}" href="#${v.id}">
        <span class="nav-icon">${v.icon}</span><span>${v.label}</span>
      </a>`,
  ).join('');
  const desktop = $('#nav-desktop');
  const mobile = $('#nav-mobile');
  if (desktop) desktop.innerHTML = items;
  if (mobile) mobile.innerHTML = tabs;
  const foot = $('#sidebar-foot');
  if (foot) {
    const sum = L.todaySummary(state, ui.day);
    foot.innerHTML = `${WEEKDAYS[new Date().getDay()]} · ${prettyDate(ui.day)}<br>今天已完成 ${sum.done}/${sum.total}<br>数据保存在本机浏览器`;
  }
  const dateEl = $('#topbar-date');
  if (dateEl) dateEl.textContent = `${WEEKDAYS[new Date().getDay()]} · ${prettyDate(ui.day)}`;
}

function render() {
  applyTheme();
  renderNav();
  const main = $('#view');
  if (!main) return;
  if (ui.view === 'stats') main.innerHTML = viewStats();
  else if (ui.view === 'manage') main.innerHTML = viewManage();
  else if (ui.view === 'settings') main.innerHTML = viewSettings();
  else main.innerHTML = viewToday();
  renderBanners();
}

function permissionNeedsPrompt() {
  if (!('Notification' in window)) return false;
  if (Notification.permission !== 'default') return false;
  return L.activeHabits(state, ui.day).some((h) => h.reminderTimes.length > 0);
}

function viewToday() {
  const today = ui.day;
  const list = L.activeHabits(state, today);
  const sum = L.todaySummary(state, today);
  const overdue = new Set(L.overdueHabits(state, new Date()).map((h) => h.id));
  const pct = sum.total ? Math.round((sum.done / sum.total) * 100) : 0;

  let html = `<section class="hero">
    <div class="hero-top">
      <div>
        <div class="hero-title">今日任务</div>
        <div class="hero-sub">${
          sum.total === 0
            ? '还没有习惯，先添加一个吧'
            : sum.done === sum.total
              ? '今天全部完成 🎉'
              : `已完成 ${sum.done}/${sum.total}，还有 ${sum.pending} 个待打卡`
        }</div>
      </div>
      <div class="hero-ring" style="--pct:${pct}"><span>${pct}%</span></div>
    </div>
    <div class="bar"><i style="width:${pct}%"></i></div>
  </section>`;

  if (permissionNeedsPrompt()) {
    html += `<div class="card pad">
      <div class="setting-head"><b>开启到点提醒</b><span class="chip warn">未开启</span></div>
      <p class="muted">允许通知后，到点会在页面内弹提醒并响提示音。想要锁屏也能提醒，请到「设置」导出日历导入手机日历。</p>
      <button class="btn primary" data-action="enable-reminders">开启提醒</button>
    </div>`;
  }

  if (!list.length) {
    html += `<div class="card empty">
      <div class="empty-emoji">🌱</div>
      <p>还没有任何习惯。<br>可以自己添加，也可以先用示例习惯试试手感。</p>
      <div class="row wrap" style="justify-content:center">
        <button class="btn primary" data-action="new-habit">＋ 添加习惯</button>
        <button class="btn" data-action="add-samples">用示例习惯（喝水/跑步/俯卧撑）</button>
      </div>
    </div>`;
    return html;
  }

  html += `<div class="habits">${list.map((h) => habitCard(h, today, overdue.has(h.id))).join('')}</div>`;
  return html;
}

function habitCard(habit, today, isOverdue) {
  const rec = L.getRecord(state, habit.id, today) || { done: false, count: 0 };
  const done = rec.done === true;
  const streak = L.computeStreak(state, habit, today);
  const target = habit.targetCount || 0;

  const times = habit.reminderTimes.map((t) => `<span class="chip">${t}</span>`).join('');
  const streakChip = streak > 0 ? `<span class="chip streak">🔥 ${streak} 天</span>` : '';
  const targetChip = target ? `<span class="chip">目标 ${target}${esc(habit.unit)}</span>` : '';
  const overdueChip = isOverdue ? '<span class="chip warn">已过提醒时间</span>' : '';

  const action = target
    ? `<button class="step" data-action="dec" data-id="${esc(habit.id)}" aria-label="减少一个">−</button>
       <button class="check ${done ? 'is-done' : ''}" data-action="toggle" data-id="${esc(habit.id)}" aria-label="切换完成">
         ${done ? '✓' : `<b>${rec.count}</b><small>/${target}</small>`}
       </button>
       <button class="step" data-action="inc" data-id="${esc(habit.id)}" aria-label="增加一个">+</button>`
    : `<button class="check ${done ? 'is-done' : ''}" data-action="toggle" data-id="${esc(habit.id)}" aria-label="切换完成">✓</button>`;

  return `<article class="card habit ${done ? 'is-done' : ''} ${isOverdue ? 'is-overdue' : ''}">
    <div class="habit-emoji">${esc(habit.emoji)}</div>
    <div class="habit-main">
      <div class="habit-name">${esc(habit.name)}${streakChip}</div>
      <div class="habit-meta">${times}${targetChip}${overdueChip}</div>
    </div>
    <div class="habit-action">${action}</div>
  </article>`;
}

function viewStats() {
  const today = ui.day;
  const list = state.habits.filter((h) => !h.archived);
  const sum = L.todaySummary(state, today);
  const pct = sum.total ? Math.round((sum.done / sum.total) * 100) : 0;

  let html = `<h2 class="section-title">统计</h2>
  <section class="hero">
    <div class="hero-top">
      <div>
        <div class="hero-title">今日完成度</div>
        <div class="hero-sub">${sum.done}/${sum.total}${sum.pending === 0 && sum.total > 0 ? ' · 全部搞定 🎉' : ''}</div>
      </div>
      <div class="hero-ring" style="--pct:${pct}"><span>${pct}%</span></div>
    </div>
    <div class="bar"><i style="width:${pct}%"></i></div>
  </section>`;

  if (!list.length) {
    html += `<div class="card empty"><div class="empty-emoji">📊</div><p>还没有习惯，先添加几个吧。</p>
      <button class="btn primary" data-action="new-habit">＋ 添加习惯</button></div>`;
    return html;
  }

  html += `<h2 class="section-title">每个习惯</h2>`;
  html += list
    .map((h) => {
      const st = L.habitStats(state, h, today);
      const chips = [];
      if (h.paused) chips.push('<span class="chip warn">已暂停</span>');
      if (st.streak > 0) chips.push(`<span class="chip streak">🔥 连续 ${st.streak} 天</span>`);
      else chips.push('<span class="chip">连续 0 天</span>');
      return `<article class="card stat-card">
        <div class="stat-head">
          <div class="habit-name">${esc(h.emoji)} ${esc(h.name)}</div>
          <div class="row wrap">${chips.join('')}</div>
        </div>
        <div class="stat-grid">
          <div class="stat"><b>${st.week.rate}%</b><small>本周 ${st.week.done}/${st.week.total}</small></div>
          <div class="stat"><b>${st.month.rate}%</b><small>本月 ${st.month.done}/${st.month.total}</small></div>
          <div class="stat"><b>${st.all.rate}%</b><small>总计 ${st.all.done}/${st.all.total}</small></div>
        </div>
        <div class="stat-foot">累计打卡 ${st.totalDone} 次 · 从 ${h.createdAt} 开始${
          h.reminderTimes.length ? ` · 提醒 ${h.reminderTimes.join(' / ')}` : ' · 未设提醒'
        }</div>
      </article>`;
    })
    .join('');
  return html;
}

function viewManage() {
  let html = `<h2 class="section-title">习惯管理</h2>`;
  html += ui.editing ? habitForm() : '<button class="btn primary block" data-action="new-habit">＋ 新增习惯</button>';

  const active = state.habits.filter((h) => !h.archived);
  const archived = state.habits.filter((h) => h.archived);

  html += `<h2 class="section-title">进行中（${active.length}）</h2>`;
  html += active.length
    ? `<div class="card manage-list">${active
        .map((h, i) => manageRow(h, i, active.length, false))
        .join('')}</div>`
    : `<div class="card empty"><p>还没有习惯。点上面的「新增习惯」开始吧。</p></div>`;

  if (archived.length) {
    html += `<h2 class="section-title sub">已归档（${archived.length}）</h2>`;
    html += `<div class="card manage-list">${archived.map((h) => manageRow(h, 0, 1, true)).join('')}</div>`;
  }
  return html;
}

function manageRow(habit, index, total, isArchived) {
  const meta = [];
  if (habit.reminderTimes.length) meta.push(...habit.reminderTimes.map((t) => `<span class="chip">${t}</span>`));
  else meta.push('<span class="chip">未设提醒</span>');
  if (habit.targetCount) meta.push(`<span class="chip">目标 ${habit.targetCount}${esc(habit.unit)}</span>`);
  if (habit.paused && !isArchived) meta.push('<span class="chip warn">已暂停</span>');

  const buttons = isArchived
    ? `<button class="btn small" data-action="restore-habit" data-id="${esc(habit.id)}">恢复</button>
       <button class="btn small danger" data-action="delete-habit" data-id="${esc(habit.id)}">删除</button>`
    : `<button class="btn small" data-action="edit-habit" data-id="${esc(habit.id)}">编辑</button>
       <button class="btn small" data-action="move-up" data-id="${esc(habit.id)}" ${index === 0 ? 'disabled' : ''}>↑</button>
       <button class="btn small" data-action="move-down" data-id="${esc(habit.id)}" ${
         index === total - 1 ? 'disabled' : ''
       }>↓</button>
       ${
         habit.paused
           ? `<button class="btn small" data-action="resume-habit" data-id="${esc(habit.id)}">继续</button>`
           : `<button class="btn small" data-action="pause-habit" data-id="${esc(habit.id)}">暂停</button>`
       }
       <button class="btn small" data-action="archive-habit" data-id="${esc(habit.id)}">归档</button>
       <button class="btn small danger" data-action="delete-habit" data-id="${esc(habit.id)}">删除</button>`;

  return `<div class="manage-row ${habit.paused && !isArchived ? 'is-paused' : ''}">
    <div class="habit-emoji small">${esc(habit.emoji)}</div>
    <div class="manage-info">
      <div class="name">${esc(habit.name)}</div>
      <div class="meta">${meta.join('')}</div>
    </div>
    <div class="manage-actions">${buttons}</div>
  </div>`;
}

function habitForm() {
  const d = ui.editing;
  const chips = d.times.length
    ? d.times
        .map(
          (t) =>
            `<button type="button" class="chip removable" data-action="remove-time" data-time="${t}">${t} ✕</button>`,
        )
        .join('')
    : '<span class="muted">还没有提醒时间</span>';

  return `<div class="card form">
    <div class="form-title">${d.id ? '编辑习惯' : '新增习惯'}</div>
    <label class="field"><span>习惯名称</span>
      <input data-draft="name" value="${esc(d.name)}" placeholder="例如：喝水" autocomplete="off">
    </label>
    <label class="field"><span>图标（可自己输入 emoji）</span>
      <input data-draft="emoji" value="${esc(d.emoji)}" maxlength="4" autocomplete="off">
    </label>
    <div class="emoji-grid">
      ${L.EMOJI_CHOICES.map(
        (e) =>
          `<button type="button" class="emoji-btn ${d.emoji === e ? 'active' : ''}" data-action="pick-emoji" data-emoji="${e}">${e}</button>`,
      ).join('')}
    </div>
    <div class="field-row">
      <label class="field"><span>目标数量（可留空）</span>
        <input data-draft="target" type="number" min="1" step="1" value="${esc(d.target)}" placeholder="如 8">
      </label>
      <label class="field"><span>单位</span>
        <input data-draft="unit" value="${esc(d.unit)}" placeholder="杯 / 个 / 分钟" autocomplete="off">
      </label>
    </div>
    <div class="field"><span>提醒时间（可加多个，例如喝水 09:00 / 15:00 / 20:00）</span>
      <div class="chips" id="draft-times">${chips}</div>
      <div class="row">
        <input type="time" id="draft-time-input" value="${esc(d.timeValue || '09:00')}">
        <button class="btn" data-action="add-time">添加时间</button>
      </div>
    </div>
    <div class="row end">
      <button class="btn" data-action="cancel-edit">取消</button>
      <button class="btn primary" data-action="save-habit">保存</button>
    </div>
  </div>`;
}

function viewSettings() {
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  const permText = { granted: '已允许', denied: '已被拒绝', default: '未开启', unsupported: '浏览器不支持' }[perm];
  const permClass = perm === 'granted' ? 'ok' : 'warn';
  const s = state.settings;
  const snoozeOptions = [5, 10, 15, 30]
    .map((m) => `<option value="${m}" ${s.snoozeMinutes === m ? 'selected' : ''}>${m} 分钟</option>`)
    .join('');
  const themeOptions = [
    ['auto', '跟随系统'],
    ['light', '浅色'],
    ['dark', '深色'],
  ]
    .map(([v, label]) => `<option value="${v}" ${s.theme === v ? 'selected' : ''}>${label}</option>`)
    .join('');

  return `<h2 class="section-title">设置</h2>

  <section class="card pad">
    <div class="setting-head"><b>到点提醒</b><span class="chip ${permClass}">${permText}</span></div>
    <p class="muted">网页内提醒只在页面（或主屏幕 App）打开时生效。想要关掉网页、锁屏也能提醒，请用下面的「导出日历」导入手机自带日历。</p>
    <div class="row wrap">
      <button class="btn primary" data-action="enable-reminders">${
        perm === 'granted' ? '重新解锁提示音' : '开启提醒'
      }</button>
      <button class="btn" data-action="test-reminder">测试提醒</button>
    </div>
  </section>

  <section class="card pad">
    <div class="setting-row"><span>提示音</span>
      <button class="switch ${s.soundEnabled ? 'on' : ''}" data-action="toggle-sound" role="switch" aria-checked="${s.soundEnabled}"><i></i></button>
    </div>
    <div class="setting-row"><span>震动（手机）</span>
      <button class="switch ${s.vibrateEnabled ? 'on' : ''}" data-action="toggle-vibrate" role="switch" aria-checked="${s.vibrateEnabled}"><i></i></button>
    </div>
    <div class="setting-row"><span>稍后提醒间隔</span>
      <select data-setting="snoozeMinutes">${snoozeOptions}</select>
    </div>
    <div class="setting-row"><span>外观</span>
      <select data-setting="theme">${themeOptions}</select>
    </div>
  </section>

  <section class="card pad">
    <b>数据</b>
    <p class="muted">数据只保存在这台设备的浏览器里。手机和电脑各存各的；换设备或清理浏览器数据前，请先导出备份。</p>
    <div class="row wrap">
      <button class="btn" data-action="export-json">导出 JSON 备份</button>
      <button class="btn" data-action="import-json">导入备份</button>
    </div>
    <div class="row wrap" style="margin-top:8px">
      <button class="btn primary" data-action="export-ics">导出日历（.ics）</button>
    </div>
    <p class="muted small">导出后，在手机「日历」里导入这个文件，到点就由系统提醒你，关掉网页也照样响。</p>
    <input type="file" id="import-file" accept=".json,application/json" hidden>
  </section>

  <section class="card pad">
    <b>危险操作</b>
    <p class="muted">清空后所有习惯与打卡记录都会被删除，且无法恢复。</p>
    <button class="btn danger" data-action="clear-data">清空所有数据</button>
  </section>

  <p class="muted small center">习惯打卡 v1.0 · 数据保存在本机</p>`;
}

/* ---------------- 表单草稿 ---------------- */

function syncDraftFromDom() {
  if (!ui.editing) return;
  const val = (key) => $(`[data-draft="${key}"]`)?.value;
  const name = val('name');
  const emoji = val('emoji');
  const unit = val('unit');
  const target = val('target');
  if (name !== undefined) ui.editing.name = name;
  if (emoji !== undefined) ui.editing.emoji = emoji;
  if (unit !== undefined) ui.editing.unit = unit;
  if (target !== undefined) ui.editing.target = target;
  const timeValue = $('#draft-time-input')?.value;
  if (timeValue) ui.editing.timeValue = timeValue;
}

function addDraftTime() {
  const input = $('#draft-time-input');
  const value = L.normalizeTime(input?.value);
  if (!value) {
    toast('请选择一个有效的提醒时间');
    return;
  }
  if (ui.editing.times.includes(value)) {
    toast('这个时间已经加过了');
    return;
  }
  syncDraftFromDom();
  ui.editing.times = L.uniqueSorted([...ui.editing.times, value]);
  ui.editing.timeValue = value;
  render();
}

function readForm() {
  syncDraftFromDom();
  const d = ui.editing;
  const target = Math.floor(Number(d.target));
  return {
    name: String(d.name || '').trim(),
    emoji: String(d.emoji || '').trim() || '✅',
    targetCount: Number.isFinite(target) && target > 0 ? target : null,
    unit: String(d.unit || '').trim(),
    times: L.uniqueSorted(d.times || []),
  };
}

function saveHabit() {
  const data = readForm();
  if (!data.name) {
    toast('先给习惯起个名字吧');
    return;
  }
  if (ui.editing.id) {
    const habit = state.habits.find((h) => h.id === ui.editing.id);
    if (!habit) {
      ui.editing = null;
      render();
      return;
    }
    Object.assign(habit, {
      name: data.name,
      emoji: data.emoji,
      targetCount: data.targetCount,
      unit: data.unit,
      reminderTimes: data.times,
    });
  } else {
    const maxOrder = state.habits.reduce((max, h) => Math.max(max, h.sortOrder), -1);
    state.habits.push(
      L.createHabit({ ...data, reminderTimes: data.times, sortOrder: maxOrder + 1 }, { today: L.dateKey() }),
    );
  }
  state.habits.sort((a, b) => a.sortOrder - b.sortOrder);
  ui.editing = null;
  saveState();
  render();
  toast('已保存');
}

/* ---------------- 习惯操作 ---------------- */

function normalizeOrders() {
  state.habits
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .forEach((h, index) => {
      h.sortOrder = index;
    });
}

function moveHabit(habit, direction) {
  const group = state.habits
    .filter((h) => Boolean(h.archived) === Boolean(habit.archived))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const index = group.indexOf(habit);
  const other = group[index + direction];
  if (!other) return;
  const tmp = habit.sortOrder;
  habit.sortOrder = other.sortOrder;
  other.sortOrder = tmp;
  normalizeOrders();
  saveState();
  render();
}

function deleteHabit(habit) {
  const days = Object.values(state.logs).filter((entries) => entries[habit.id]).length;
  if (!confirm(`删除「${habit.name}」？它的 ${days} 天打卡记录也会一起删除，无法撤销。`)) return;
  state.habits = state.habits.filter((h) => h.id !== habit.id);
  for (const day of Object.keys(state.logs)) {
    delete state.logs[day][habit.id];
    if (!Object.keys(state.logs[day]).length) delete state.logs[day];
  }
  const prefix = `${habit.id}|`;
  for (const day of Object.keys(state.fired)) {
    state.fired[day] = state.fired[day].filter((key) => !key.startsWith(prefix));
    if (!state.fired[day].length) delete state.fired[day];
  }
  L.clearSnoozesFor(state, habit.id);
  ui.banners = ui.banners.filter((b) => b.id !== habit.id);
  if (ui.editing?.id === habit.id) ui.editing = null;
  saveState();
  render();
  toast('已删除');
}

function addSamples() {
  const existing = new Set(state.habits.map((h) => h.name));
  const base = state.habits.reduce((max, h) => Math.max(max, h.sortOrder), -1) + 1;
  let added = 0;
  L.sampleHabits(L.dateKey()).forEach((habit, index) => {
    if (existing.has(habit.name)) return;
    habit.sortOrder = base + index;
    state.habits.push(habit);
    added += 1;
  });
  saveState();
  render();
  toast(added ? `已添加 ${added} 个示例习惯` : '示例习惯都已经有了');
}

function completeHabit(habitId) {
  const habit = state.habits.find((h) => h.id === habitId);
  ui.banners = ui.banners.filter((b) => b.id !== habitId);
  if (!habit) {
    renderBanners();
    return;
  }
  L.applyProgress(state, habit, 'complete', Date.now());
  saveState();
  render();
  toast(`已完成：${habit.name}`);
}

/* ---------------- 数据导入导出 ---------------- */

function exportJson() {
  downloadBlob(L.serialize(state), 'application/json', `习惯打卡备份-${L.dateKey()}.json`);
  toast('已导出 JSON 备份');
}

function exportIcs() {
  const ics = L.buildICS(state, { now: new Date() });
  if (!ics.includes('BEGIN:VEVENT')) {
    toast('还没有设置提醒时间的习惯');
    return;
  }
  downloadBlob(ics, 'text/calendar', `习惯打卡提醒-${L.dateKey()}.ics`);
  toast('已导出日历文件，导入手机日历即可锁屏提醒');
}

async function handleImportFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const next = L.parseImport(text);
    const count = next.habits.length;
    if (!confirm(`导入会覆盖当前数据（当前 ${state.habits.length} 个习惯，文件里 ${count} 个）。继续？`)) return;
    state = next;
    L.pruneFired(state, L.dateKey());
    ui.editing = null;
    ui.banners = [];
    saveState();
    render();
    toast(`已导入 ${count} 个习惯`);
  } catch (err) {
    toast('导入失败：这个文件不是有效的备份 JSON');
  }
}

function clearData() {
  if (!confirm('确定要清空全部习惯和打卡记录吗？此操作无法撤销。')) return;
  if (!confirm('再确认一次：建议先「导出 JSON 备份」。确定现在清空？')) return;
  state = L.defaultState();
  ui.editing = null;
  ui.banners = [];
  saveState();
  render();
  toast('已清空全部数据');
}

async function enableReminders() {
  unlockAudio();
  if (!('Notification' in window)) {
    toast('这个浏览器不支持系统通知，到点仍会在页面内提醒');
    render();
    return;
  }
  let perm = Notification.permission;
  if (perm === 'default') {
    try {
      perm = await Notification.requestPermission();
    } catch (err) {
      perm = Notification.permission;
    }
  }
  if (perm === 'granted') {
    state.settings.reminderIntroSeen = true;
    saveState();
    playChime();
    toast('提醒已开启，提示音也解锁了');
  } else if (perm === 'denied') {
    toast('通知被浏览器拒绝了，可在地址栏左侧的图标里改回「允许」');
  } else {
    toast('提示音已解锁；通知权限稍后可再开');
  }
  render();
}

function testReminder() {
  unlockAudio();
  const now = new Date();
  const active = L.activeHabits(state, L.dateKey());
  const habit = {
    id: '__test__',
    name: active[0] ? active[0].name : '测试提醒',
    emoji: active[0] ? active[0].emoji : '⏰',
  };
  fireReminder({ habit, time: L.clockKey(now), snooze: false });
  const granted = 'Notification' in window && Notification.permission === 'granted';
  toast(granted ? '已发出测试提醒' : '页面内提醒已触发（通知权限未开启）');
}

/* ---------------- 事件 ---------------- */

function onClick(event) {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const habit = id ? state.habits.find((h) => h.id === id) : null;

  switch (action) {
    case 'toggle':
    case 'inc':
    case 'dec': {
      if (!habit) return;
      L.applyProgress(state, habit, action, Date.now());
      if (L.isDoneOn(state, habit.id, ui.day)) ui.banners = ui.banners.filter((b) => b.id !== habit.id);
      saveState();
      render();
      break;
    }
    case 'new-habit':
      ui.editing = { id: null, name: '', emoji: '✅', target: '', unit: '', times: [], timeValue: '09:00' };
      if (ui.view !== 'manage') {
        location.hash = '#manage';
        return;
      }
      render();
      break;
    case 'edit-habit': {
      if (!habit) return;
      ui.editing = {
        id: habit.id,
        name: habit.name,
        emoji: habit.emoji,
        target: habit.targetCount ? String(habit.targetCount) : '',
        unit: habit.unit || '',
        times: [...habit.reminderTimes],
        timeValue: habit.reminderTimes[0] || '09:00',
      };
      render();
      break;
    }
    case 'cancel-edit':
      ui.editing = null;
      render();
      break;
    case 'save-habit':
      saveHabit();
      break;
    case 'pick-emoji':
      syncDraftFromDom();
      ui.editing.emoji = btn.dataset.emoji;
      render();
      break;
    case 'add-time':
      addDraftTime();
      break;
    case 'remove-time':
      syncDraftFromDom();
      ui.editing.times = ui.editing.times.filter((t) => t !== btn.dataset.time);
      render();
      break;
    case 'move-up':
      if (habit) moveHabit(habit, -1);
      break;
    case 'move-down':
      if (habit) moveHabit(habit, 1);
      break;
    case 'pause-habit':
      if (habit) {
        habit.paused = true;
        saveState();
        render();
      }
      break;
    case 'resume-habit':
      if (habit) {
        habit.paused = false;
        saveState();
        render();
      }
      break;
    case 'archive-habit':
      if (habit) {
        habit.archived = true;
        saveState();
        render();
      }
      break;
    case 'restore-habit':
      if (habit) {
        habit.archived = false;
        saveState();
        render();
      }
      break;
    case 'delete-habit':
      if (habit) deleteHabit(habit);
      break;
    case 'add-samples':
      addSamples();
      break;
    case 'banner-done':
      if (id) completeHabit(id);
      break;
    case 'banner-snooze':
      if (id) {
        if (state.habits.some((h) => h.id === id)) {
          L.scheduleSnooze(state, id, Date.now(), state.settings.snoozeMinutes);
        }
        ui.banners = ui.banners.filter((b) => b.id !== id);
        saveState();
        renderBanners();
        toast(`好，${state.settings.snoozeMinutes} 分钟后再提醒你`);
      }
      break;
    case 'banner-dismiss':
      ui.banners = ui.banners.filter((b) => b.id !== id);
      renderBanners();
      break;
    case 'enable-reminders':
      enableReminders();
      break;
    case 'test-reminder':
      testReminder();
      break;
    case 'toggle-sound':
      state.settings.soundEnabled = !state.settings.soundEnabled;
      saveState();
      if (state.settings.soundEnabled) {
        unlockAudio();
        playChime();
      }
      render();
      break;
    case 'toggle-vibrate':
      state.settings.vibrateEnabled = !state.settings.vibrateEnabled;
      saveState();
      render();
      break;
    case 'export-json':
      exportJson();
      break;
    case 'import-json':
      $('#import-file')?.click();
      break;
    case 'export-ics':
      exportIcs();
      break;
    case 'clear-data':
      clearData();
      break;
    default:
      break;
  }
}

function onChange(event) {
  const target = event.target;
  if (target.id === 'import-file') {
    handleImportFile(target.files?.[0]);
    target.value = '';
    return;
  }
  const setting = target.closest('[data-setting]');
  if (!setting) return;
  const key = setting.dataset.setting;
  if (key === 'theme') {
    state.settings.theme = setting.value;
    saveState();
    applyTheme();
    render();
  } else if (key === 'snoozeMinutes') {
    state.settings.snoozeMinutes = L.clampInt(setting.value, 1, 120, 10);
    saveState();
    render();
  }
}

function syncViewFromHash() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  ui.view = VIEWS.some((v) => v.id === raw) ? raw : 'today';
  ui.editing = ui.view === 'manage' ? ui.editing : null;
  render();
}

/* ---------------- 启动 ---------------- */

function setupServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.type === 'complete' && data.habitId) completeHabit(data.habitId);
  });
}

function init() {
  L.pruneFired(state, L.dateKey());
  applyTheme();
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('hashchange', syncViewFromHash);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (state.settings.theme === 'auto') {
      applyTheme();
      render();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
  setupServiceWorker();
  syncViewFromHash();
  render();
  setInterval(tick, 1000);
  tick();
}

init();
