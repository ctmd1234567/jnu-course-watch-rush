const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Store } = require('./store');
const { CourseAgent } = require('./course-agent');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3210);
const RUNTIME_DIR = process.env.JNU_RUNTIME_DIR || path.join(ROOT, 'runtime');
const store = new Store(path.join(RUNTIME_DIR, 'state.json'));
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
  profileDir: path.join(RUNTIME_DIR, 'browser-profile'),
  emit: broadcast,
});

const app = express();
app.disable('x-powered-by');
app.use((_request, response, next) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.use('/api', (request, response, next) => {
  const origin = request.get('origin');
  if (!origin) return next();
  try {
    const url = new URL(origin);
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.host === request.get('host')) return next();
  } catch (_) {}
  return response.status(403).json({ error: '拒绝来自外部网页的本地控制请求' });
});

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
  if (!['watch', 'rush'].includes(request.body.mode)) {
    return response.status(400).json({ error: '任务模式必须是蹲课或抢课' });
  }
  const mode = request.body.mode;
  const startAtInput = String(request.body.startAt || '').trim();
  const startAt = mode === 'rush' && startAtInput ? new Date(startAtInput) : null;
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(courseNumber)) {
    return response.status(400).json({ error: '课程号应为 3–32 位字母、数字、下划线或短横线' });
  }
  if (teachingClassId && !/^[A-Za-z0-9_-]{3,40}$/.test(teachingClassId)) {
    return response.status(400).json({ error: '教学班号格式不正确' });
  }
  if (mode === 'rush' && !teachingClassId) {
    return response.status(400).json({ error: '抢课任务必须同时填写课程号和教学班号' });
  }
  if (mode === 'rush' && (!startAt || Number.isNaN(startAt.getTime()))) {
    return response.status(400).json({ error: '抢课任务必须设置有效的启动时间' });
  }
  const scheduled = mode === 'rush' && startAt.getTime() > Date.now();
  const task = {
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
  };
  store.state.courses.push(task);
  try {
    store.save();
  } catch (error) {
    const index = store.state.courses.findIndex(item => item.id === task.id);
    if (index >= 0) store.state.courses.splice(index, 1);
    throw error;
  }
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
  const requestedPortal = String(request.body.portal || 'standard');
  const portal = requestedPortal === 'freshman' ? 'graduate' : requestedPortal;
  const watchMinSeconds = Number(request.body.watchMinSeconds);
  const watchMaxSeconds = Number(request.body.watchMaxSeconds);
  const rushActionGapMs = Math.max(0, Number(request.body.rushActionGapMs) || 0);
  if (!['standard', 'graduate'].includes(portal)) {
    return response.status(400).json({ error: '请选择有效的选课系统入口' });
  }
  if (agent.runtime.running && portal !== store.state.settings.portal) {
    return response.status(409).json({ error: '请先停止任务，再切换选课系统入口' });
  }
  if (!Number.isFinite(watchMinSeconds) || watchMinSeconds < 15 || watchMinSeconds > 180) {
    return response.status(400).json({ error: '蹲课最短间隔必须为 15–180 秒' });
  }
  if (!Number.isFinite(watchMaxSeconds) || watchMaxSeconds < watchMinSeconds || watchMaxSeconds > 180) {
    return response.status(400).json({ error: '蹲课最长间隔必须不小于最短间隔，且不超过 180 秒' });
  }
  const previousSettings = store.state.settings;
  store.state.settings = {
    portal,
    watchMinSeconds,
    watchMaxSeconds,
    rushActionGapMs,
    autoConfirm: request.body.autoConfirm !== false,
    autoPickExperiment: request.body.autoPickExperiment === true,
  };
  try {
    store.save();
  } catch (error) {
    store.state.settings = previousSettings;
    throw error;
  }
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

let server = null;

function startServer(port = PORT) {
  if (server) return Promise.resolve({ server, port: server.address().port, agent, shutdown });
  return new Promise((resolve, reject) => {
    const candidate = app.listen(port, '127.0.0.1');
    candidate.once('error', reject);
    candidate.once('listening', () => {
      server = candidate;
      const actualPort = server.address().port;
      console.log(`JNU Course Watch & Rush: http://127.0.0.1:${actualPort}`);
      console.log('仅监听本机；打开页面后添加课程并点击“启动任务”。');
      resolve({ server, port: actualPort, agent, shutdown });
    });
  });
}

async function shutdown({ exit = false } = {}) {
  if (!server && !agent.runtime.running) return;
  console.log('\n正在停止...');
  await agent.stop().catch(() => {});
  for (const client of clients) client.end();
  clients.clear();
  if (server) {
    const closingServer = server;
    closingServer.closeIdleConnections?.();
    const closed = new Promise(resolve => closingServer.close(resolve));
    closingServer.closeAllConnections?.();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2_000))]);
    server = null;
  }
  if (exit) process.exit(0);
}

if (require.main === module) {
  startServer().catch(error => {
    console.error(error);
    process.exit(1);
  });
  process.on('SIGINT', () => shutdown({ exit: true }));
  process.on('SIGTERM', () => shutdown({ exit: true }));
}

module.exports = { startServer, shutdown };
