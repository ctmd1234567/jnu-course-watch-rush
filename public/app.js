const $ = selector => document.querySelector(selector);
let state = null;
let localLogs = [];

const statusLabels = {
  queued: '等待检查', scheduled: '等待开抢', checking: '检查中', full: '已满', available: '发现余量',
  preheated: '预热完成', 'not-found': '未找到', error: '异常', manual: '需人工', paused: '已暂停', selected: '已选',
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
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; }
  catch (_) { body = { error: text || `本地服务返回了无法识别的数据（HTTP ${response.status}）` }; }
  if (!response.ok) throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
  return body;
}

function showCourseFormMessage(message = '') {
  const element = $('#courseFormMessage');
  element.textContent = message;
  element.hidden = !message;
}

async function resyncStateAfterError(forceSettings = false) {
  try {
    const latest = await api('/api/state');
    renderState(latest, { forceSettings });
    return true;
  } catch (_) {
    return false;
  }
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
  const timing = course.lastResult?.timing;
  const preparationMs = timing?.preheatSearchMs ?? timing?.searchMs;
  const submitMs = timing?.submitMs ?? timing?.attemptMs;
  const timingText = timing
    ? ` · ${timing.preheatSearchMs == null ? '搜索' : '预热'} ${preparationMs ?? '?'}ms${submitMs == null ? '' : ` · 提交 ${submitMs}ms`}`
    : '';
  if (!matches.length) return `${course.lastResult?.message || course.lastError || '尚未检查'}${timingText}`;
  return `${matches.map(item => {
    const capacity = item.capacity == null ? '?' : item.capacity;
    const selected = item.selected == null ? (item.isFull ? '已满' : '?') : item.selected;
    return `${item.teachingClassId || '未标班号'} · ${item.teacher || '教师未知'} · ${selected}/${capacity}`;
  }).join('；')}${timingText}`;
}

function setHealthStep(selector, level, text) {
  const step = $(selector);
  step.className = `health-step ${level || ''}`;
  step.querySelector('small').textContent = text;
}

function renderDiagnostic(runtime, courses) {
  const diagnostic = runtime.diagnostic || {
    level: 'info', source: '本机程序', title: '等待启动',
    detail: '尚未执行网站检测。', action: '添加课程后点击“启动任务”。',
  };
  const panel = $('#diagnosticPanel');
  panel.dataset.level = diagnostic.level || 'info';
  $('#diagnosticSource').textContent = diagnostic.source || '运行诊断';
  $('#diagnosticTitle').textContent = diagnostic.title || runtime.message || '状态未知';
  $('#diagnosticDetail').textContent = diagnostic.detail || runtime.message || '正在等待更多信息。';
  $('#diagnosticAction').textContent = diagnostic.action || '查看受控浏览器与实时事件。';
  $('#diagnosticTechnical').textContent = JSON.stringify({
    diagnostic,
    runtime: {
      running: runtime.running,
      browser: runtime.browser,
      browserName: runtime.browserName,
      browserTabs: runtime.browserTabs,
      login: runtime.login,
      page: runtime.page,
      lastCheckAt: runtime.lastCheckAt,
      message: runtime.message,
    },
    pageDiagnostic: runtime.pageDiagnostic || null,
    courses: courses.map(course => ({
      courseNumber: course.courseNumber,
      teachingClassId: course.teachingClassId,
      mode: course.mode,
      status: course.status,
      lastResult: course.lastResult,
      lastError: course.lastError,
    })),
  }, null, 2);

  setHealthStep('#healthBrowser', runtime.browser === 'open' ? 'ok' : runtime.running ? 'warn' : '', runtime.browser === 'open' ? `${runtime.browserName || '浏览器'} · ${runtime.browserTabs ?? 1} 个页面` : runtime.running ? '正在打开' : '尚未启动');
  setHealthStep('#healthLogin', runtime.login === 'ok' ? 'ok' : runtime.login === 'denied' ? 'error' : ['manual', 'recovering'].includes(runtime.login) ? 'warn' : '', ({ ok: '登录有效', manual: '等待人工认证', recovering: '自动恢复中', denied: '学校未授权' })[runtime.login] || '等待浏览器');
  setHealthStep('#healthPage', ['all-courses', 'selection'].includes(runtime.page) ? 'ok' : runtime.login === 'ok' ? 'warn' : '', ({ 'all-courses': '全校课程已就绪', selection: '选课系统已进入' })[runtime.page] || '尚未进入');
  const courseDiagnostic = courses.find(course => course.lastResult?.diagnostic)?.lastResult?.diagnostic;
  setHealthStep('#healthCourse', courseDiagnostic?.level || (runtime.lastCheckAt ? 'ok' : ''), runtime.lastCheckAt ? (courseDiagnostic?.title || '已收到课程数据') : '尚未检测');
}

function renderState(next, { forceSettings = false } = {}) {
  state = next;
  const runtime = state.runtime || {};
  $('#runtimeStatus').textContent = runtime.running ? '运行中' : '已停止';
  $('#loginStatus').textContent = ({ ok: '正常', manual: '需人工', recovering: '恢复中', denied: '未授权', unknown: '未知' })[runtime.login] || runtime.login;
  $('#queueCount').textContent = state.courses.length;
  $('#startButton').disabled = runtime.running;
  $('#stopButton').disabled = !runtime.running;

  renderDiagnostic(runtime, state.courses);
  const settings = state.settings;
  const form = $('#settingsForm');
  if (forceSettings || document.activeElement?.form !== form) {
    form.elements.portal.value = settings.portal || 'standard';
    form.watchMinSeconds.value = settings.watchMinSeconds;
    form.watchMaxSeconds.value = settings.watchMaxSeconds;
    form.rushActionGapMs.value = settings.rushActionGapMs ?? 0;
    form.autoConfirm.checked = settings.autoConfirm;
    form.autoPickExperiment.checked = settings.autoPickExperiment;
  }
  form.elements.portal.disabled = runtime.running;

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
      <td><strong>${escapeHtml(course.lastResult?.message || '等待首次检查')}</strong><small>${escapeHtml(resultSummary(course))}</small>${course.lastResult?.diagnostic ? `<span class="reason-tag">${escapeHtml(course.lastResult.diagnostic.source)} · ${escapeHtml(course.lastResult.diagnostic.title)}</span>` : ''}</td>
      <td>${nextCheck(course)}</td>
      <td><button class="delete" data-delete="${escapeHtml(course.id)}" aria-label="删除 ${escapeHtml(course.courseNumber)}">删除</button></td>`;
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
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '正在加入…';
  showCourseFormMessage();
  const data = new FormData(form);
  try {
    const payload = Object.fromEntries(data);
    if (payload.startAt) payload.startAt = new Date(payload.startAt).toISOString();
    const next = await api('/api/courses', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    renderState(next);
    form.reset();
    form.mode.value = 'watch';
    syncModeFields();
    toast('课程已加入任务表');
  } catch (error) {
    const synced = await resyncStateAfterError();
    const message = `添加失败：${error.message}${synced ? '。任务表已与后台重新同步。' : '。同时无法重新读取后台状态。'}`;
    showCourseFormMessage(message);
    toast(message, true);
  } finally {
    button.disabled = false;
    button.textContent = '＋ 加入任务表';
  }
});

$('#settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const next = await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        portal: form.elements.portal.value,
        watchMinSeconds: Number(form.watchMinSeconds.value),
        watchMaxSeconds: Number(form.watchMaxSeconds.value),
        rushActionGapMs: Number(form.rushActionGapMs.value),
        autoConfirm: form.autoConfirm.checked,
        autoPickExperiment: form.autoPickExperiment.checked,
      }),
    });
    renderState(next);
    toast('设置已保存');
  } catch (error) {
    await resyncStateAfterError(true);
    toast(`设置保存失败：${error.message}`, true);
  }
});

$('#settingsForm').elements.portal.addEventListener('change', event => {
  if (!event.currentTarget.disabled) event.currentTarget.form.requestSubmit();
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

$('#copyDiagnostic').addEventListener('click', async () => {
  const text = $('#diagnosticTechnical').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('诊断信息已复制，可直接发给维护者');
  } catch (_) {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast('诊断信息已复制');
  }
});

function syncModeFields() {
  const rush = $('#courseForm').mode.value === 'rush';
  const field = $('#rushTimeField');
  const teachingClass = $('#courseForm').teachingClassId;
  field.hidden = !rush;
  field.querySelector('input').required = rush;
  teachingClass.required = rush;
  teachingClass.placeholder = rush ? '抢课必须填写准确教学班号' : '蹲课可留空';
  $('#teachingClassRequirement').textContent = rush ? '抢课必填' : '蹲课可选';
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
