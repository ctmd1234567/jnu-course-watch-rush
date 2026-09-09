const $ = selector => document.querySelector(selector);
let state = null;
let localLogs = [];

const statusLabels = {
  queued: '等待检查', scheduled: '等待开抢', checking: '检查中', full: '已满', available: '发现余量',
  'not-found': '未找到', error: '异常', manual: '需人工', paused: '已暂停', selected: '已选',
};

function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.style.borderColor = isError ? 'rgba(255,113,133,.5)' : '';
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}

function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function nextCheck(course) {
  if (!course.nextCheckAt) return '即将检查';
  const seconds = Math.max(0, Math.ceil((course.nextCheckAt - Date.now()) / 1000));
  return `${seconds}s`;
}

function resultSummary(course) {
  const matches = course.lastResult?.matches || [];
  if (!matches.length) return course.lastResult?.message || course.lastError || '尚未检查';
  return matches.map(item => {
    const capacity = item.capacity == null ? '?' : item.capacity;
    const selected = item.selected == null ? (item.isFull ? '已满' : '?') : item.selected;
    return `${item.teachingClassId || '未标班号'} · ${item.teacher || '教师未知'} · ${selected}/${capacity}`;
  }).join('；');
}

function renderState(next) {
  state = next;
  const runtime = state.runtime || {};
  $('#runtimeStatus').textContent = runtime.running ? '运行中' : '已停止';
  $('#loginStatus').textContent = ({ ok: '正常', manual: '需人工', recovering: '恢复中', unknown: '未知' })[runtime.login] || runtime.login;
  $('#queueCount').textContent = state.courses.length;
  $('#startButton').disabled = runtime.running;
  $('#stopButton').disabled = !runtime.running;

  const settings = state.settings;
  const form = $('#settingsForm');
  if (document.activeElement?.form !== form) {
    form.watchMinSeconds.value = settings.watchMinSeconds;
    form.watchMaxSeconds.value = settings.watchMaxSeconds;
    form.rushRoundSeconds.value = settings.rushRoundSeconds;
    form.rushActionGapMs.value = settings.rushActionGapMs;
    form.autoConfirm.checked = settings.autoConfirm;
    form.autoPickExperiment.checked = settings.autoPickExperiment;
  }

  const tbody = $('#courseRows');
  tbody.replaceChildren(...state.courses.map(course => {
    const row = document.createElement('tr');
    const modeClass = course.mode === 'rush' ? 'rush' : '';
    const statusClass = ['full', 'available', 'error', 'selected'].includes(course.status) ? course.status : '';
    row.innerHTML = `
      <td><strong>${escapeHtml(course.courseNumber)}</strong><small>${course.createdAt ? `添加于 ${formatTime(course.createdAt)}` : ''}</small></td>
      <td>${escapeHtml(course.teachingClassId || '自动选择首个可选班')}</td>
      <td><span class="pill ${modeClass}">${course.mode === 'rush' ? '抢课' : '蹲课'}</span><small>${course.startAt ? `启动 ${new Date(course.startAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</small></td>
      <td><span class="pill ${statusClass}">${statusLabels[course.status] || course.status}</span></td>
      <td><strong>${escapeHtml(course.lastResult?.message || '等待首次检查')}</strong><small>${escapeHtml(resultSummary(course))}</small></td>
      <td>${nextCheck(course)}</td>
      <td><button class="delete" data-delete="${course.id}" aria-label="删除 ${escapeHtml(course.courseNumber)}">删除</button></td>`;
    return row;
  }));
  $('#emptyState').hidden = state.courses.length > 0;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function addLog(entry) {
  localLogs.unshift(entry);
  if (localLogs.length > 100) localLogs.length = 100;
  const container = $('#logs');
  container.replaceChildren(...localLogs.map(log => {
    const row = document.createElement('div');
    row.className = `log ${log.level}`;
    row.innerHTML = `<time>${formatTime(log.at)}</time><b>${escapeHtml(log.level)}</b><span>${escapeHtml(log.message)}</span>`;
    return row;
  }));
}

$('#courseForm').addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    const payload = Object.fromEntries(data);
    if (payload.startAt) payload.startAt = new Date(payload.startAt).toISOString();
    const next = await api('/api/courses', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    renderState(next);
    event.currentTarget.reset();
    event.currentTarget.mode.value = 'watch';
    syncModeFields();
    toast('课程已加入任务表');
  } catch (error) { toast(error.message, true); }
});

$('#settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const next = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        watchMinSeconds: Number(form.watchMinSeconds.value),
        watchMaxSeconds: Number(form.watchMaxSeconds.value),
        rushRoundSeconds: Number(form.rushRoundSeconds.value),
        rushActionGapMs: Number(form.rushActionGapMs.value),
        autoConfirm: form.autoConfirm.checked,
        autoPickExperiment: form.autoPickExperiment.checked,
      }),
    });
    renderState(next);
    toast('设置已保存');
  } catch (error) { toast(error.message, true); }
});

$('#startButton').addEventListener('click', async () => {
  try { renderState(await api('/api/start', { method: 'POST' })); toast('任务已启动，请留意可见浏览器'); }
  catch (error) { toast(error.message, true); }
});

$('#stopButton').addEventListener('click', async () => {
  try { renderState(await api('/api/stop', { method: 'POST' })); toast('任务已停止'); }
  catch (error) { toast(error.message, true); }
});

$('#courseRows').addEventListener('click', async event => {
  const id = event.target.dataset.delete;
  if (!id) return;
  try { renderState(await api(`/api/courses/${id}`, { method: 'DELETE' })); toast('任务已删除'); }
  catch (error) { toast(error.message, true); }
});

$('#clearLogs').addEventListener('click', () => { localLogs = []; $('#logs').replaceChildren(); });

function syncModeFields() {
  const rush = $('#courseForm').mode.value === 'rush';
  const field = $('#rushTimeField');
  field.hidden = !rush;
  field.querySelector('input').required = rush;
}

$('#courseForm').addEventListener('change', event => {
  if (event.target.name === 'mode') syncModeFields();
});

setInterval(() => { if (state) renderState(state); }, 1_000);

async function boot() {
  try {
    const initial = await api('/api/state');
    localLogs = initial.logs || [];
    renderState(initial);
    const existing = [...localLogs];
    localLogs = [];
    existing.reverse().forEach(addLog);
  } catch (error) { toast(`无法连接本地服务: ${error.message}`, true); }

  const events = new EventSource('/api/events');
  events.addEventListener('state', event => renderState(JSON.parse(event.data)));
  events.addEventListener('log', event => addLog(JSON.parse(event.data)));
  events.onerror = () => toast('实时连接暂时中断，正在重连…', true);
}

boot();
syncModeFields();
