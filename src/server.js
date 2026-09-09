const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Store } = require('./store');
const { CourseAgent } = require('./course-agent');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3210);
const store = new Store(path.join(ROOT, 'runtime', 'state.json'));
const clients = new Set();
const logs = [];

function broadcast(event, payload) {
  if (event === 'log') {
    logs.unshift(payload);
    if (logs.length > 200) logs.length = 200;
  }
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of clients) response.write(frame);
}

const agent = new CourseAgent({
  store,
  profileDir: path.join(ROOT, 'runtime', 'browser-profile'),
  emit: broadcast,
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(ROOT, 'public')));

function sendState(response) {
  response.json({ ...agent.publicState(), logs });
}

app.get('/api/state', (_request, response) => sendState(response));

app.get('/api/events', (request, response) => {
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  clients.add(response);
  response.write(`event: state\ndata: ${JSON.stringify(agent.publicState())}\n\n`);
  request.on('close', () => clients.delete(response));
});

app.post('/api/courses', (request, response) => {
  const courseNumber = String(request.body.courseNumber || '').trim();
  const teachingClassId = String(request.body.teachingClassId || '').trim();
  const mode = request.body.mode === 'rush' ? 'rush' : 'watch';
  const startAtInput = String(request.body.startAt || '').trim();
  const startAt = mode === 'rush' && startAtInput ? new Date(startAtInput) : null;
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(courseNumber)) {
    return response.status(400).json({ error: '课程号应为 3–32 位字母、数字、下划线或短横线' });
  }
  if (teachingClassId && !/^[A-Za-z0-9_-]{3,40}$/.test(teachingClassId)) {
    return response.status(400).json({ error: '教学班号格式不正确' });
  }
  if (mode === 'rush' && (!startAt || Number.isNaN(startAt.getTime()))) {
    return response.status(400).json({ error: '抢课任务必须设置有效的启动时间' });
  }
  const duplicate = store.state.courses.some(item => item.courseNumber === courseNumber && item.teachingClassId === teachingClassId);
  if (duplicate) return response.status(409).json({ error: '该课程任务已经存在' });
  const scheduled = mode === 'rush' && startAt.getTime() > Date.now();
  store.state.courses.push({
    id: crypto.randomUUID(),
    courseNumber,
    teachingClassId,
    mode,
    startAt: startAt ? startAt.toISOString() : null,
    status: scheduled ? 'scheduled' : 'queued',
    createdAt: new Date().toISOString(),
    nextCheckAt: startAt ? startAt.getTime() : 0,
    lastResult: null,
    lastError: null,
  });
  store.save();
  broadcast('state', agent.publicState());
  sendState(response);
});

app.delete('/api/courses/:id', (request, response) => {
  const index = store.state.courses.findIndex(item => item.id === request.params.id);
  if (index < 0) return response.status(404).json({ error: '任务不存在' });
  store.state.courses.splice(index, 1);
  store.save();
  broadcast('state', agent.publicState());
  sendState(response);
});

app.patch('/api/settings', (request, response) => {
  const watchMinSeconds = Number(request.body.watchMinSeconds);
  const watchMaxSeconds = Number(request.body.watchMaxSeconds);
  const rushRoundSeconds = Number(request.body.rushRoundSeconds);
  const rushActionGapMs = Number(request.body.rushActionGapMs);
  if (!Number.isFinite(watchMinSeconds) || watchMinSeconds < 15 || watchMinSeconds > 180) {
    return response.status(400).json({ error: '蹲课最短间隔必须为 15–180 秒' });
  }
  if (!Number.isFinite(watchMaxSeconds) || watchMaxSeconds < watchMinSeconds || watchMaxSeconds > 180) {
    return response.status(400).json({ error: '蹲课最长间隔必须不小于最短间隔，且不超过 180 秒' });
  }
  if (!Number.isFinite(rushRoundSeconds) || rushRoundSeconds < 2 || rushRoundSeconds > 15) {
    return response.status(400).json({ error: '抢课整轮间隔必须为 2–15 秒' });
  }
  if (!Number.isFinite(rushActionGapMs) || rushActionGapMs < 500 || rushActionGapMs > 3000) {
    return response.status(400).json({ error: '抢课单课动作间隔必须为 500–3000 毫秒' });
  }
  store.state.settings = {
    watchMinSeconds,
    watchMaxSeconds,
    rushRoundSeconds,
    rushActionGapMs,
    autoConfirm: request.body.autoConfirm !== false,
    autoPickExperiment: request.body.autoPickExperiment === true,
  };
  store.save();
  broadcast('state', agent.publicState());
  sendState(response);
});

app.post('/api/start', async (_request, response, next) => {
  try {
    await agent.start();
    sendState(response);
  } catch (error) {
    next(error);
  }
});

app.post('/api/stop', async (_request, response, next) => {
  try {
    await agent.stop();
    sendState(response);
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: error.message || '服务器错误' });
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`JNU Course Keeper: http://127.0.0.1:${PORT}`);
  console.log('仅监听本机；打开页面后添加课程并点击“启动任务”。');
});

async function shutdown() {
  console.log('\n正在停止...');
  await agent.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
