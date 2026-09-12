const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CourseAgent,
  parseCapacity,
  assessCourseResult,
  responseSignals,
  classifyError,
  needsFinalRushPreheat,
  isCreditLimitMessage,
  isLoginGuideUrl,
  isCourseSearchResponse,
  isAccessDeniedMessage,
  executableFromOpenCommand,
  isChromiumExecutable,
} = require('../src/course-agent');

test('parses available selected/capacity text', () => {
  assert.deepEqual(parseCapacity('94/95 可选', false), {
    selected: 94,
    capacity: 95,
    remaining: 1,
  });
});

test('parses full card where the page hides selected count', () => {
  assert.deepEqual(parseCapacity('95 不可选', true), {
    selected: null,
    capacity: 95,
    remaining: 0,
  });
});

test('keeps unknown capacity explicit', () => {
  assert.deepEqual(parseCapacity('', false), {
    selected: null,
    capacity: null,
    remaining: null,
  });
});

test('classifies website timeouts separately from program errors', () => {
  const diagnostic = classifyError(new Error('page.goto: Timeout 30000ms exceeded'));
  assert.equal(diagnostic.code, 'site_network');
  assert.equal(diagnostic.source, '学校网站/网络');
});

test('classifies selector failures as page adaptation problems', () => {
  const diagnostic = classifyError(new Error('无法进入全校课程页面'));
  assert.equal(diagnostic.code, 'page_changed');
  assert.equal(diagnostic.source, '页面适配');
});

test('classifies school rejection text', () => {
  const diagnostic = classifyError(new Error('课程冲突，不可选'));
  assert.equal(diagnostic.code, 'site_rejected');
  assert.equal(diagnostic.source, '学校返回');
});

test('treats a real ratio and visible choice as reliable availability', () => {
  const result = assessCourseResult({
    courseName: 'Java程序设计实验',
    capacityText: '87/100',
    fullFlag: null,
    isFull: false,
    choiceVisible: true,
    disabled: false,
    isConflict: false,
    alreadySelected: false,
  });
  assert.equal(result.reliable, true);
  assert.equal(result.available, true);
  assert.equal(result.remaining, 13);
});

test('already-selected result is reliable but never clicked again', () => {
  const result = assessCourseResult({
    courseName: 'Java程序设计实验',
    capacityText: '',
    fullFlag: null,
    isFull: false,
    choiceVisible: false,
    disabled: true,
    isConflict: false,
    alreadySelected: true,
  });
  assert.equal(result.reliable, true);
  assert.equal(result.available, false);
});

test('extracts nested school response code and message', () => {
  assert.deepEqual(responseSignals({ data: { code: '-1', msg: '已超过学分上限' } }), [
    { code: '-1', message: '已超过学分上限' },
  ]);
});

test('rush task has no artificial next-round wait after start time', () => {
  const store = { state: { settings: { watchMinSeconds: 20, watchMaxSeconds: 30 } } };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  const course = { mode: 'rush', startAt: new Date(Date.now() - 1_000).toISOString() };
  const before = Date.now();
  agent.scheduleNext(course, true);
  assert.ok(course.nextCheckAt >= before && course.nextCheckAt <= Date.now());
});

test('final rush preheat runs once inside the final window for the current session', () => {
  const now = Date.now();
  const page = { isClosed: () => false };
  const course = { mode: 'rush', startAt: new Date(now + 20_000).toISOString() };
  assert.equal(needsFinalRushPreheat(course, { page, generation: 2, phase: 'entry' }, now, page, 2), true);
  assert.equal(needsFinalRushPreheat(course, { page, generation: 2, phase: 'final' }, now, page, 2), false);
  assert.equal(needsFinalRushPreheat(course, { page, generation: 1, phase: 'final' }, now, page, 2), true);
  assert.equal(needsFinalRushPreheat({ ...course, startAt: new Date(now + 60_000).toISOString() }, null, now, page, 2), false);
});

test('selection generation changes only after a real leave and re-entry', () => {
  const store = { state: { settings: {} }, snapshot: () => ({ settings: {}, courses: [], completed: [] }) };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  assert.equal(agent.markSelectionReady('first'), true);
  assert.equal(agent.selectionGeneration, 1);
  assert.equal(agent.markSelectionReady('same page'), false);
  assert.equal(agent.selectionGeneration, 1);
  agent.markSelectionUnavailable('expired');
  assert.equal(agent.markSelectionReady('recovered'), true);
  assert.equal(agent.selectionGeneration, 2);
});

test('runtime-added rush task gets one entry-phase preheat in the current session', async () => {
  const store = { state: { settings: {}, courses: [] }, snapshot: () => ({ settings: {}, courses: [], completed: [] }), save: () => {} };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  agent.selectionGeneration = 3;
  const calls = [];
  agent.preheatRushCourse = async (course, phase) => { calls.push([course.id, phase]); return true; };
  const first = { id: 'first', mode: 'rush', courseNumber: 'A', teachingClassId: '1', startAt: new Date(Date.now() + 60_000).toISOString() };
  const second = { id: 'second', mode: 'rush', courseNumber: 'B', teachingClassId: '2', startAt: new Date(Date.now() + 20_000).toISOString() };
  store.state.courses.push(first);
  await agent.preheatRushAfterEntry([first]);
  await agent.preheatRushAfterEntry([first]);
  store.state.courses.push(second);
  await agent.preheatRushAfterEntry([first, second]);
  assert.deepEqual(calls, [['first', 'entry'], ['second', 'final']]);
});

test('recognizes the fixed JNU login guide without matching the authentication page', () => {
  assert.equal(isLoginGuideUrl('https://netc.jnu.edu.cn/2020/1124/c10374a565499/page.htm'), true);
  assert.equal(isLoginGuideUrl('https://authserver.jnu.edu.cn/authserver/login'), false);
});

test('recognizes school access denial separately from manual authentication', () => {
  assert.equal(isAccessDeniedMessage('未获得本系统访问授权'), true);
  assert.equal(isAccessDeniedMessage('请输入账号和验证码'), false);
});

test('extracts only controllable Chromium executables from Windows default browser commands', () => {
  assert.equal(executableFromOpenCommand('"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" --single-argument %1'), 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(isChromiumExecutable('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), true);
  assert.equal(isChromiumExecutable('C:\\Program Files\\Mozilla Firefox\\firefox.exe'), false);
});

test('matches only the official JNU course search POST response', () => {
  const response = (url, method = 'POST', type = 'xhr') => ({
    url: () => url,
    request: () => ({ method: () => method, resourceType: () => type }),
  });
  assert.equal(isCourseSearchResponse(response('https://jwxk.jnu.edu.cn/xsxkapp/sys/xsxkapp/elective/queryCourse.do')), true);
  assert.equal(isCourseSearchResponse(response('https://jwxk.jnu.edu.cn/xsxkapp/sys/xsxkapp/elective/addVolunteer.do')), false);
  assert.equal(isCourseSearchResponse(response('https://example.com/sys/xsxkapp/elective/queryCourse.do')), false);
  assert.equal(isCourseSearchResponse(response('https://jwxk.jnu.edu.cn/xsxkapp/sys/xsxkapp/elective/queryCourse.do', 'GET')), false);
});

test('does not complete a task that was deleted while an async check was running', () => {
  const store = {
    state: { settings: {}, courses: [], completed: [] },
    snapshot: () => ({ settings: {}, courses: [], completed: [] }),
    save: () => { throw new Error('deleted task must not be persisted as completed'); },
  };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  assert.equal(agent.completeCourse({ id: 'deleted', courseNumber: 'A' }, { courseName: 'A' }), false);
  assert.equal(store.state.completed.length, 0);
});

test('credit limit response is recognized and stops the task engine', () => {
  assert.equal(isCreditLimitMessage('已超过本学期可选学分上限'), true);
  assert.equal(isCreditLimitMessage('课程人数已满'), false);
  const course = { id: 'course-1', status: 'checking', lastResult: {} };
  const store = {
    state: { settings: {}, courses: [course] },
    snapshot: () => ({ settings: {}, courses: [course], completed: [] }),
    save: () => {},
  };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  agent.running = true;
  agent.beep = () => {};
  agent.notify = () => {};
  agent.haltForCreditLimit(course, '已超过本学期可选学分上限');
  assert.equal(agent.running, false);
  assert.equal(agent.runtime.running, false);
  assert.equal(agent.runtime.diagnostic.code, 'credit_limit_stopped');
  assert.equal(course.status, 'manual');
});

test('keeps exactly one controlled browser page', async () => {
  const store = { state: { settings: {} }, snapshot: () => ({ settings: {}, courses: [], completed: [] }) };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  const preferred = { isClosed: () => false, setDefaultTimeout: () => {} };
  let extraClosed = false;
  const extra = {
    isClosed: () => extraClosed,
    close: async () => { extraClosed = true; },
  };
  agent.context = { pages: () => [preferred, extra].filter(page => !page.isClosed()) };
  assert.equal(await agent.keepOnlyPage(preferred, 'test'), true);
  assert.equal(extraClosed, true);
  assert.equal(agent.page, preferred);
  assert.equal(agent.runtime.browserTabs, 1);
});

test('cleans tab restore files without touching profile cookies', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jnu-profile-test-'));
  const sessionsDir = path.join(profileDir, 'Default', 'Sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'Session_123'), 'session');
  fs.writeFileSync(path.join(sessionsDir, 'Tabs_123'), 'tabs');
  const cookiePath = path.join(profileDir, 'Default', 'Cookies');
  fs.writeFileSync(cookiePath, 'cookie-data');
  const store = { state: { settings: {} }, snapshot: () => ({ settings: {}, courses: [], completed: [] }) };
  const agent = new CourseAgent({ store, profileDir, emit: () => {} });
  assert.equal(agent.clearBrowserSessionRestore(), 2);
  assert.equal(fs.existsSync(path.join(sessionsDir, 'Session_123')), false);
  assert.equal(fs.existsSync(path.join(sessionsDir, 'Tabs_123')), false);
  assert.equal(fs.readFileSync(cookiePath, 'utf8'), 'cookie-data');
  fs.rmSync(profileDir, { recursive: true, force: true });
});

test('preheated rush submits directly through the official page function result', async () => {
  const store = {
    state: { settings: { autoConfirm: true, rushActionGapMs: 0 } },
    snapshot: () => ({ settings: {}, courses: [], completed: [] }),
  };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  agent.page = { evaluate: async () => ({ stage: 'confirm', code: '1', message: '成功' }) };
  const result = await agent.attemptPreheatedEnrollment(
    { teachingClassId: '2627100562' },
    { result: { hasTest: false } },
  );
  assert.equal(result.success, true);
  assert.equal(result.message, '成功');
});

test('removes only browser tab restore records', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jnu-profile-test-'));
  const sessionsDir = path.join(profileDir, 'Default', 'Sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'Session_123'), 'session');
  fs.writeFileSync(path.join(sessionsDir, 'Tabs_123'), 'tabs');
  fs.writeFileSync(path.join(profileDir, 'Default', 'Cookies'), 'keep-cookie');
  const store = { state: { settings: {} }, snapshot: () => ({ settings: {}, courses: [], completed: [] }) };
  const agent = new CourseAgent({ store, profileDir, emit: () => {} });
  assert.equal(agent.clearBrowserSessionRestore(), 2);
  assert.equal(fs.existsSync(path.join(sessionsDir, 'Session_123')), false);
  assert.equal(fs.existsSync(path.join(sessionsDir, 'Tabs_123')), false);
  assert.equal(fs.readFileSync(path.join(profileDir, 'Default', 'Cookies'), 'utf8'), 'keep-cookie');
  fs.rmSync(profileDir, { recursive: true, force: true });
});
