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
  safeUrl,
  sanitizeGraduatePageDiagnostic,
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
  assert.equal(isCourseSearchResponse(response('https://yjsxk.jnu.edu.cn/yjsxkapp/sys/xsxkapp/elective/queryCourse.do'), 'yjsxk.jnu.edu.cn'), true);
  assert.equal(isCourseSearchResponse(response('https://jwxk.jnu.edu.cn/xsxkapp/sys/xsxkapp/elective/queryCourse.do'), 'yjsxk.jnu.edu.cn'), false);
  assert.equal(isCourseSearchResponse(response('https://jwxk.jnu.edu.cn/xsxkapp/sys/xsxkapp/elective/addVolunteer.do')), false);
  assert.equal(isCourseSearchResponse(response('https://example.com/sys/xsxkapp/elective/queryCourse.do')), false);
  assert.equal(isCourseSearchResponse(response('https://jwxk.jnu.edu.cn/xsxkapp/sys/xsxkapp/elective/queryCourse.do', 'GET')), false);
});

test('uses separate entry URLs and browser profiles for the two systems', () => {
  const store = { state: { settings: { portal: 'standard' } }, snapshot: () => ({ settings: {}, courses: [], completed: [] }) };
  const agent = new CourseAgent({ store, profileDir: 'C:\\runtime\\browser-profile', emit: () => {} });
  assert.equal(agent.portalConfig().hostname, 'jwxk.jnu.edu.cn');
  assert.equal(agent.activeProfileDir(), 'C:\\runtime\\browser-profile');
  store.state.settings.portal = 'graduate';
  assert.equal(agent.portalConfig().hostname, 'yjsxk.jnu.edu.cn');
  assert.match(agent.portalConfig().startUrl, /\/yjsxkapp\/sys\/xsxkapp\/index\.html$/);
  assert.equal(agent.portalConfig().label, '研究生选课系统');
  assert.equal(agent.activeProfileDir(), 'C:\\runtime\\browser-profile-graduate');
});

test('graduate portal reuses an existing legacy freshman browser profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jnu-profile-migration-'));
  fs.mkdirSync(`${root}-freshman`);
  const store = { state: { settings: { portal: 'graduate' } }, snapshot: () => ({ settings: {}, courses: [], completed: [] }) };
  const agent = new CourseAgent({ store, profileDir: root, emit: () => {} });
  assert.equal(agent.activeProfileDir(), `${root}-freshman`);
  fs.rmSync(`${root}-freshman`, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('watch mode reloads the page before reading fresh course data', async () => {
  const store = { state: { settings: { portal: 'standard' } }, snapshot: () => ({ settings: {}, courses: [], completed: [] }) };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  let reloads = 0;
  agent.page = { reload: async () => { reloads += 1; } };
  agent.isSelectionApp = async () => true;
  agent.selectionReady = true;
  agent.selectionGeneration = 4;
  agent.rushWarmups.set('rush-1', { generation: 4 });
  agent.entryWarmupAttempts.set('rush-1', 4);
  await agent.refreshWatchCourseData();
  assert.equal(reloads, 1);
  assert.equal(agent.runtime.login, 'ok');
  assert.equal(agent.selectionGeneration, 5);
  assert.equal(agent.rushWarmups.size, 0);
  assert.equal(agent.entryWarmupAttempts.size, 0);
});

test('graduate same-domain unknown page is adaptation warning, not manual authentication', async () => {
  const store = { state: { settings: { portal: 'graduate' }, courses: [], completed: [] }, snapshot: () => ({ settings: {}, courses: [], completed: [] }), save: () => {} };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  agent.running = true;
  agent.accessDeniedText = async () => '';
  agent.isSelectionApp = async () => false;
  agent.enterSelectionIfNeeded = async () => false;
  agent.clickFirstVisible = async () => false;
  agent.graduateDomainPage = async () => agent.page;
  agent.captureGraduatePageDiagnostic = async () => ({ url: 'https://yjsxk.jnu.edu.cn/yjsxkapp/stale' });
  agent.page = { isClosed: () => false, url: () => 'https://yjsxk.jnu.edu.cn/yjsxkapp/stale', goto: async () => {} };
  assert.equal(await agent.recoverLogin(), false);
  assert.equal(agent.runtime.login, 'unknown');
  assert.equal(agent.runtime.page, 'graduate-unadapted');
  assert.equal(agent.runtime.diagnostic.code, 'graduate_page_unknown');
});

test('graduate authentication page still reports manual authentication', async () => {
  const store = { state: { settings: { portal: 'graduate' }, courses: [], completed: [] }, snapshot: () => ({ settings: {}, courses: [], completed: [] }), save: () => {} };
  let agent;
  agent = new CourseAgent({ store, profileDir: '', emit: () => {
    if (agent.runtime.diagnostic.code === 'auth_manual') agent.running = false;
  } });
  agent.running = true;
  agent.accessDeniedText = async () => '';
  agent.isSelectionApp = async () => false;
  agent.enterSelectionIfNeeded = async () => false;
  agent.graduateDomainPage = async () => null;
  agent.isManualAuthenticationPage = async () => true;
  agent.clickFirstVisible = async () => false;
  agent.page = {
    url: () => 'https://authserver.jnu.edu.cn/authserver/login',
    goto: async () => {},
  };
  agent.beep = () => {};
  agent.notify = () => {};
  assert.equal(await agent.recoverLogin(), false);
  assert.equal(agent.runtime.diagnostic.code, 'auth_manual');
});

test('recognizes JNU CAS host as a real manual authentication page', async () => {
  const store = { state: { settings: { portal: 'graduate' } }, snapshot: () => ({ settings: {}, courses: [], completed: [] }) };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  const page = { isClosed: () => false, url: () => 'https://authserver.jnu.edu.cn/authserver/login', frames: () => [] };
  agent.context = { pages: () => [page] };
  assert.equal(await agent.isManualAuthenticationPage(), true);
});

test('graduate adapter reuses the compatible course flow without changing standard configuration', async () => {
  const course = { id: 'g1', courseNumber: '081200mb16', teachingClassId: '20271Y2139', mode: 'rush' };
  const store = { state: { settings: { portal: 'graduate' }, courses: [course], completed: [] }, snapshot: () => ({ settings: {}, courses: [course], completed: [] }), save: () => {} };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  const calls = [];
  agent.searchStandardCourse = async () => { calls.push('search'); return { matches: [] }; };
  agent.preheatStandardRushCourse = async () => { calls.push('preheat'); return true; };
  agent.attemptStandardFastEnrollment = async () => { calls.push('fast'); return { success: false }; };
  assert.equal(agent.portalAdapter().verified, false);
  assert.equal(agent.portalAdapter().capabilities.rush, true);
  await agent.searchCourse(course);
  await agent.preheatRushCourse(course);
  await agent.attemptPreheatedEnrollment(course, {});
  assert.deepEqual(calls, ['search', 'preheat', 'fast']);
});

test('graduate diagnostics remove query, hash and sensitive payload fields', () => {
  assert.equal(safeUrl('https://yjsxk.jnu.edu.cn/path?a=token#ticket'), 'https://yjsxk.jnu.edu.cn/path');
  const diagnostic = sanitizeGraduatePageDiagnostic({
    url: 'https://yjsxk.jnu.edu.cn/path?token=secret#ticket',
    title: '选课系统 2027123456',
    frames: ['https://yjsxk.jnu.edu.cn/frame?code=secret'],
    ids: ['coursePanel', 'student2027123456', 'accessToken'],
    classes: ['course-list', 'userId-2027123456'],
    controls: [{ tag: 'button', id: 'submitCourse', classes: ['primary'], text: '确认选课 2027123456' }],
    formActions: ['https://yjsxk.jnu.edu.cn/submit?ticket=secret'],
    scriptPaths: ['https://yjsxk.jnu.edu.cn/app.js?v=secret'],
    functionNames: ['selectCourse'],
    network: [{ method: 'POST', url: 'https://yjsxk.jnu.edu.cn/api/course?token=secret', resourceType: 'xhr', status: 200, requestBody: 'password=secret', responseBody: 'token=secret', authorization: 'secret', cookie: 'secret' }],
    cookie: 'secret', authorization: 'secret', requestBody: 'password=secret', responseBody: 'token=secret',
  });
  const serialized = JSON.stringify(diagnostic).toLowerCase();
  assert.equal(diagnostic.url, 'https://yjsxk.jnu.edu.cn/path');
  assert.equal(diagnostic.network[0].pathname, '/api/course');
  assert.doesNotMatch(serialized, /secret|cookie|authorization|requestbody|responsebody|2027123456/);
});

test('graduate fixture format can feed the sanitizer without private browser state', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'graduate-page.example.json'), 'utf8'));
  const diagnostic = sanitizeGraduatePageDiagnostic(fixture);
  assert.equal(diagnostic.url, 'https://yjsxk.jnu.edu.cn/example/path');
  assert.deepEqual(diagnostic.ids, ['exampleCoursePanel']);
  assert.equal(diagnostic.controls[0].textHint, '查询 · 课程');
});

test('graduate network observer keeps only bounded same-domain metadata', () => {
  const store = { state: { settings: { portal: 'graduate' } }, snapshot: () => ({ settings: {}, courses: [], completed: [] }) };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  const response = (url, status = 200) => ({
    url: () => url,
    status: () => status,
    request: () => ({ method: () => 'POST', resourceType: () => 'xhr' }),
  });
  agent.observeGraduateNetwork(response('https://example.com/ignored?token=secret'));
  for (let index = 0; index < 55; index++) {
    agent.observeGraduateNetwork(response(`https://yjsxk.jnu.edu.cn/api/course/${index}?token=secret`, 200 + index % 3));
  }
  assert.equal(agent.graduateNetwork.length, 50);
  assert.equal(agent.graduateNetwork.some(item => item.url.includes('?') || item.url.includes('secret')), false);
  assert.equal(agent.graduateNetwork.some(item => item.url.includes('example.com')), false);
});

test('standard course search scans later pages for a requested teaching class', async () => {
  const store = { state: { settings: { portal: 'standard' } }, snapshot: () => ({ settings: {}, courses: [], completed: [] }) };
  const agent = new CourseAgent({ store, profileDir: '', emit: () => {} });
  const pages = [
    { matches: [], totalRows: 20, signature: 'page-1' },
    { matches: [], totalRows: 20, signature: 'page-2' },
    { matches: [{ teachingClassId: 'TARGET', alreadySelected: true }], totalRows: 8, signature: 'page-3' },
  ];
  let reads = 0;
  let advances = 0;
  agent.readStandardCoursePage = async () => pages[reads++];
  agent.advanceStandardCoursePage = async () => { advances += 1; return true; };
  const result = await agent.collectStandardCoursePages({ teachingClassId: 'TARGET' }, '#schoolBody');
  assert.equal(result.pagesScanned, 3);
  assert.equal(result.totalRows, 48);
  assert.equal(result.matches[0].teachingClassId, 'TARGET');
  assert.equal(advances, 2);
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
