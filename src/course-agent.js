const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const START_URL = 'https://jwxk.jnu.edu.cn/';
const WATCH_ACTION_GAP_MS = 1_500;
const DEFAULT_TIMEOUT = 15_000;
const RUSH_READINESS_REFRESH_MS = 20_000;
const RUSH_WARMUP_LEAD_MS = 30_000;
const LOGIN_ENTRY_NAME = /^(登录|统一认证|统一认证登录|登录选课系统|进入系统|进入选课系统)$/;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeUrl = value => String(value || '').replace(/[?#].*$/, '');

function nowIso() {
  return new Date().toISOString();
}

function parseCapacity(text, isFull) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const ratio = normalized.match(/(\d+)\s*[/／]\s*(\d+)/);
  if (ratio) {
    const selected = Number(ratio[1]);
    const capacity = Number(ratio[2]);
    return { selected, capacity, remaining: Math.max(0, capacity - selected) };
  }
  const number = normalized.match(/(\d+)/);
  if (isFull && number) {
    return { selected: null, capacity: Number(number[1]), remaining: 0 };
  }
  return { selected: null, capacity: number ? Number(number[1]) : null, remaining: null };
}

function assessCourseResult(result) {
  const capacity = parseCapacity(result.capacityText, result.isFull);
  const hasRatio = /\d+\s*[/／]\s*\d+/.test(result.capacityText || '');
  const hasAvailabilitySignal = ['0', '1'].includes(result.fullFlag) ||
    hasRatio || /可选|不可选|已满/.test(result.capacityText || '');
  const consistent = !(capacity.remaining === 0 && result.fullFlag === '0') &&
    !(capacity.remaining > 0 && result.isFull);
  const reliable = Boolean(result.alreadySelected || (result.courseName && hasAvailabilitySignal && consistent));
  return {
    ...result,
    ...capacity,
    reliable,
    available: reliable && !result.alreadySelected && !result.isFull && result.choiceVisible &&
      !result.disabled && !result.isConflict && capacity.remaining !== 0,
  };
}

function needsFinalRushPreheat(course, warmup, now, page, generation) {
  if (course.mode !== 'rush' || !course.startAt) return false;
  const untilStart = new Date(course.startAt).getTime() - now;
  if (untilStart <= 0 || untilStart > RUSH_WARMUP_LEAD_MS) return false;
  return !warmup || warmup.page !== page || warmup.generation !== generation || warmup.phase !== 'final';
}

function isCreditLimitMessage(message) {
  const text = String(message || '').replace(/\s+/g, ' ');
  return /学分.{0,16}(?:达到|已达|超过|超出|上限|限制|选满)|(?:达到|已达|超过|超出).{0,12}学分.{0,12}(?:上限|限制)|可选学分.{0,12}(?:不足|为\s*0|上限)/.test(text);
}

function isLoginGuideUrl(url) {
  return /^https:\/\/netc\.jnu\.edu\.cn\/2020\/1124\/c10374a565499\/page\.htm(?:[?#]|$)/i.test(String(url || ''));
}

function isAccessDeniedMessage(message) {
  return /未获得.{0,12}(?:本系统|系统).{0,12}访问授权|(?:无权|没有权限|未授权).{0,12}(?:访问|进入).{0,12}(?:选课|本系统|系统)/.test(
    String(message || '').replace(/\s+/g, ' '),
  );
}

function executableFromOpenCommand(command) {
  const text = String(command || '').trim();
  const quoted = text.match(/^"([^"]+\.exe)"/i);
  const plain = text.match(/^(.+?\.exe)(?:\s|$)/i);
  const executable = quoted?.[1] || plain?.[1] || '';
  return executable.replace(/%([^%]+)%/g, (_match, name) => process.env[name] || process.env[name.toUpperCase()] || `%${name}%`);
}

function isChromiumExecutable(executablePath) {
  return /(?:^|[\\/])(msedge|chrome|chromium|brave|vivaldi|opera)\.exe$/i.test(String(executablePath || ''));
}

function browserLabel(executablePath) {
  const executable = path.basename(String(executablePath || ''), '.exe').toLowerCase();
  return ({ msedge: 'Microsoft Edge', chrome: 'Google Chrome', chromium: 'Chromium', brave: 'Brave', vivaldi: 'Vivaldi', opera: 'Opera' })[executable] || executable || 'Chromium';
}

function findDefaultChromiumBrowser() {
  if (process.platform !== 'win32') return null;
  try {
    const choice = execFileSync('reg.exe', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
      '/v',
      'ProgId',
    ], { encoding: 'utf8', windowsHide: true, timeout: 3_000 });
    const progId = choice.match(/ProgId\s+REG_\w+\s+([^\r\n]+)/i)?.[1]?.trim();
    if (!progId) return null;
    const openCommand = execFileSync('reg.exe', [
      'query',
      `HKCR\\${progId}\\shell\\open\\command`,
      '/ve',
    ], { encoding: 'utf8', windowsHide: true, timeout: 3_000 });
    const command = openCommand.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i)?.[1]?.trim();
    const executablePath = executableFromOpenCommand(command);
    if (!isChromiumExecutable(executablePath) || !fs.existsSync(executablePath)) return null;
    return { executablePath, label: browserLabel(executablePath), source: '系统默认浏览器' };
  } catch (_) {
    return null;
  }
}

function isCourseSearchResponse(response) {
  try {
    const request = response.request();
    const url = new URL(response.url());
    return ['xhr', 'fetch'].includes(request.resourceType()) &&
      request.method() === 'POST' &&
      url.hostname === 'jwxk.jnu.edu.cn' &&
      /\/sys\/xsxkapp\/elective\/queryCourse\.do$/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function responseSignals(payload, output = [], depth = 0) {
  if (!payload || depth > 4 || output.length >= 20) return output;
  if (Array.isArray(payload)) {
    for (const item of payload) responseSignals(item, output, depth + 1);
    return output;
  }
  if (typeof payload !== 'object') return output;
  if (Object.hasOwn(payload, 'code') || Object.hasOwn(payload, 'msg') || Object.hasOwn(payload, 'message')) {
    output.push({
      code: payload.code == null ? '' : String(payload.code),
      message: String(payload.msg ?? payload.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
    });
  }
  for (const value of Object.values(payload)) responseSignals(value, output, depth + 1);
  return output;
}

const DIAGNOSTIC_CATALOG = {
  idle: ['info', '本机程序', '等待启动', '添加课程后点击“启动任务”。'],
  starting: ['info', '本机程序', '正在启动', '正在打开可见的受控浏览器。'],
  ready: ['ok', '运行正常', '选课系统已就绪', '程序会按任务时间自动检查。'],
  rush_preheated: ['ok', '抢课预热', '教学班已预热', '到达设定时间后将跳过搜索，直接调用学校页面的选课逻辑。'],
  auth_recovering: ['warn', '登录状态', '正在恢复登录', '程序正在自动点击登录入口或“开始选课”。'],
  auth_manual: ['warn', '人工认证', '需要你完成认证', '请在受控浏览器中完成账号、验证码或短信验证，完成后程序自动继续。'],
  access_denied: ['error', '学校系统', '当前账号未获得选课系统访问授权', '请用同一账号手动打开暨大选课官网；若仍显示该提示，请确认选课批次或联系教务部门开通权限。'],
  site_network: ['error', '学校网站/网络', '学校网站暂时无法访问', '检查网络、VPN 和学校网站；程序会降低频率后重试。'],
  page_changed: ['error', '页面适配', '无法识别选课页面', '学校页面结构可能更新，请停止任务并提交脱敏诊断信息。'],
  course_not_found: ['warn', '课程数据', '没有找到匹配课程', '核对课程号和教学班号；也可能是本轮课程尚未开放。'],
  course_full: ['ok', '学校返回', '课程存在但当前不可选', '这是正常课程状态，程序会继续下一轮。'],
  course_blocked: ['warn', '学校返回', '课程存在但被限制选择', '查看教学班冲突、禁用状态或学校返回说明。'],
  response_unreliable: ['error', '页面数据', '返回结果无法可靠识别', '为避免误选，本轮不会点击；请查看原始容量和按钮状态。'],
  submitting: ['info', '学校页面', '发现余量，正在提交', '程序正在点击学校页面的选择与确认按钮。'],
  site_rejected: ['warn', '学校返回', '学校拒绝了选课', '查看学校弹窗原文，通常与冲突、限制、已满或选课规则有关。'],
  credit_limit_stopped: ['error', '学校返回', '已达到学分上限，任务已停止', '请查看受控浏览器中的学校原始提示；调整选课计划后再手动启动任务。'],
  result_unconfirmed: ['error', '结果确认', '点击后无法确认是否成功', '请立即查看受控浏览器当前页面，避免重复操作。'],
  already_selected: ['ok', '学校返回', '课程已经选上', '该课程已自动移出活动任务表。'],
  selected: ['ok', '学校返回', '选课成功', '该课程已移出活动任务表。'],
  stopped_by_browser: ['info', '本机程序', '任务已停止', '检测到你关闭了受控浏览器，程序不会自动重新打开。'],
  program_error: ['error', '本机程序', '程序执行异常', '程序会重试；若连续出现，请复制诊断信息反馈。'],
};

function makeDiagnostic(code, detail = '', technical = '') {
  const [level, source, title, action] = DIAGNOSTIC_CATALOG[code] || DIAGNOSTIC_CATALOG.program_error;
  return { code, level, source, title, detail, action, technical, at: nowIso() };
}

function classifyError(error) {
  const message = String(error?.message || error || '未知错误');
  if (isAccessDeniedMessage(message)) return makeDiagnostic('access_denied', message);
  if (/ERR_|net::|网络|超时|timeout|timed out|502|503|504|连接|socket/i.test(message)) {
    return makeDiagnostic('site_network', message);
  }
  if (/无法进入全校课程页面|locator|selector|找不到.*页面|页面结构/i.test(message)) {
    return makeDiagnostic('page_changed', message);
  }
  if (/验证码|短信|人工登录|账号|认证/i.test(message)) return makeDiagnostic('auth_manual', message);
  if (/冲突|不可选|已满|超过|失败|拒绝|学分|上限|重复|限制|不能|无法选择/i.test(message)) {
    return makeDiagnostic('site_rejected', message);
  }
  if (/未在.*确认成功|无法确认/i.test(message)) return makeDiagnostic('result_unconfirmed', message);
  return makeDiagnostic('program_error', message, error?.stack || '');
}

class CourseAgent {
  constructor({ store, profileDir, emit }) {
    this.store = store;
    this.profileDir = profileDir;
    this.emit = emit;
    this.context = null;
    this.page = null;
    this.running = false;
    this.loopPromise = null;
    this.lastActionAt = 0;
    this.lastRushReadinessRefreshAt = 0;
    this.rushWarmups = new Map();
    this.entryWarmupAttempts = new Map();
    this.selectionGeneration = 0;
    this.selectionReady = false;
    this.runtime = {
      running: false,
      browser: 'closed',
      browserName: '',
      browserTabs: 0,
      login: 'unknown',
      page: 'unknown',
      currentCourseId: null,
      lastCheckAt: null,
      message: '尚未启动',
      diagnostic: makeDiagnostic('idle'),
    };
  }

  publicState() {
    return { ...this.store.snapshot(), runtime: { ...this.runtime } };
  }

  updateRuntime(patch) {
    Object.assign(this.runtime, patch);
    this.emit('state', this.publicState());
  }

  setDiagnostic(code, detail = '', technical = '') {
    this.updateRuntime({ diagnostic: makeDiagnostic(code, detail, technical) });
  }

  log(level, message, data = {}) {
    this.emit('log', { at: nowIso(), level, message, data });
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.updateRuntime({ running: true, message: '正在启动浏览器', diagnostic: makeDiagnostic('starting') });
    this.loopPromise = this.runLoop().catch(error => {
      this.log('error', `主循环异常退出: ${error.message}`);
      this.running = false;
      this.updateRuntime({ running: false, message: '异常停止', diagnostic: classifyError(error) });
    }).finally(() => { this.loopPromise = null; });
  }

  async stop() {
    this.running = false;
    this.rushWarmups.clear();
    this.entryWarmupAttempts.clear();
    this.selectionReady = false;
    this.updateRuntime({ running: false, currentCourseId: null, message: '正在停止' });
    await this.context?.close().catch(() => {});
    this.clearBrowserSessionRestore();
    this.context = null;
    this.page = null;
    if (this.loopPromise) await Promise.race([this.loopPromise, sleep(2_000)]).catch(() => {});
    this.updateRuntime({ browser: 'closed', browserTabs: 0, login: 'unknown', page: 'unknown', message: '已停止', diagnostic: makeDiagnostic('idle') });
  }

  findBrowser() {
    const preferred = findDefaultChromiumBrowser();
    if (preferred) return preferred;
    const candidates = [
      [process.env.PLAYWRIGHT_BROWSER, '自定义浏览器', '环境变量'],
      ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Edge', '自动回退'],
      ['C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Edge', '自动回退'],
      ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'Google Chrome', '自动回退'],
      [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Google Chrome', '自动回退'],
      [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'Brave', '自动回退'],
    ];
    const found = candidates.find(([candidate]) => candidate && fs.existsSync(candidate));
    return found ? { executablePath: found[0], label: found[1], source: found[2] } : null;
  }

  async accessDeniedText() {
    const pages = this.context?.pages() || (this.page ? [this.page] : []);
    for (const candidate of pages) {
      if (candidate.isClosed()) continue;
      if (isLoginGuideUrl(candidate.url())) continue;
      for (const frame of candidate.frames()) {
        const text = await frame.locator('body').innerText({ timeout: 600 }).catch(() => '');
        if (!isAccessDeniedMessage(text)) continue;
        const normalized = text.replace(/\s+/g, ' ').trim();
        const marker = normalized.search(/未获得|无权|没有权限|未授权/);
        return normalized.slice(Math.max(0, marker - 40), marker + 180);
      }
    }
    return '';
  }

  haltForAccessDenied(detail) {
    this.running = false;
    this.markSelectionUnavailable('学校拒绝当前账号访问');
    const diagnostic = makeDiagnostic('access_denied', detail);
    this.updateRuntime({
      running: false,
      login: 'denied',
      page: 'access-denied',
      currentCourseId: null,
      message: diagnostic.title,
      diagnostic,
    });
    this.log('error', diagnostic.title, { detail });
    this.beep(5);
    this.notify('选课系统未授权', '学校系统拒绝当前账号访问，请核对选课批次或联系教务部门。');
  }

  clearBrowserSessionRestore() {
    const roots = [this.profileDir, path.join(this.profileDir, 'Default')];
    const legacyNames = ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'];
    let removed = 0;
    for (const root of roots) {
      for (const name of legacyNames) {
        try {
          fs.unlinkSync(path.join(root, name));
          removed++;
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'EPERM' && error.code !== 'EBUSY') {
            this.log('warn', `无法清理 Edge 标签恢复文件: ${error.message}`);
          }
        }
      }
      const sessionsDir = path.join(root, 'Sessions');
      let entries = [];
      try { entries = fs.readdirSync(sessionsDir); } catch (error) {
        if (error.code !== 'ENOENT') this.log('warn', `无法读取 Edge 标签恢复目录: ${error.message}`);
      }
      for (const name of entries.filter(value => /^(Session|Tabs)_/i.test(value))) {
        try {
          fs.unlinkSync(path.join(sessionsDir, name));
          removed++;
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'EPERM' && error.code !== 'EBUSY') {
            this.log('warn', `无法清理 Edge 标签恢复文件: ${error.message}`);
          }
        }
      }
    }
    return removed;
  }

  async keepOnlyPage(preferred, reason = '') {
    if (!this.context || !preferred || preferred.isClosed()) return false;
    if (this.page && this.page !== preferred) this.markSelectionUnavailable('选课页面已切换');
    const pages = this.context.pages();
    const extras = pages.filter(candidate => candidate !== preferred && !candidate.isClosed());
    for (const candidate of extras) {
      await candidate.close({ runBeforeUnload: false }).catch(() => {});
    }
    if (preferred.isClosed()) return false;
    this.page = preferred;
    this.page.setDefaultTimeout(DEFAULT_TIMEOUT);
    this.updateRuntime({ browserTabs: this.context.pages().filter(candidate => !candidate.isClosed()).length });
    if (extras.length) this.log('info', `已清理 ${extras.length} 个旧页面，只保留当前选课页面`, { reason });
    return true;
  }

  async ensureBrowser() {
    if (this.context && this.page && !this.page.isClosed()) return;
    const browser = this.findBrowser();
    if (!browser) throw new Error('找不到 Playwright 可控制的 Chromium 浏览器（建议安装 Microsoft Edge）');
    const { executablePath } = browser;
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.clearBrowserSessionRestore();
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      executablePath,
      headless: false,
      chromiumSandbox: true,
      viewport: null,
      args: [
        '--start-maximized',
        '--proxy-bypass-list=<-loopback>;*.jnu.edu.cn;jnu.edu.cn',
      ],
    });
    const launchedContext = this.context;
    launchedContext.once('close', () => {
      if (this.context === launchedContext) {
        this.context = null;
        this.page = null;
        this.rushWarmups.clear();
        this.entryWarmupAttempts.clear();
        this.selectionReady = false;
      }
      this.clearBrowserSessionRestore();
      setTimeout(() => this.clearBrowserSessionRestore(), 750);
      if (!this.running) return;
      this.running = false;
      this.log('info', '检测到受控浏览器已关闭，任务自动停止');
      this.updateRuntime({
        running: false,
        browser: 'closed',
        browserTabs: 0,
        login: 'unknown',
        page: 'unknown',
        currentCourseId: null,
        message: '受控浏览器已关闭，任务已停止',
        diagnostic: makeDiagnostic('stopped_by_browser'),
      });
    });
    // 持久 Profile 可能恢复上次关闭时的标签。始终新建一个干净页面并关闭全部恢复页。
    const freshPage = await this.context.newPage();
    await this.keepOnlyPage(freshPage, '浏览器启动清理');
    this.context.on('page', candidate => {
      candidate.setDefaultTimeout(DEFAULT_TIMEOUT);
      candidate.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => null).then(async () => {
        if (!this.running || !this.context || candidate.isClosed()) return;
        const url = candidate.url();
        if (isLoginGuideUrl(url)) {
          this.log('info', '统一认证打开了登录指南页，已关闭指南并保留身份验证页');
          await candidate.close({ runBeforeUnload: false }).catch(() => {});
          this.updateRuntime({ browserTabs: this.context?.pages().filter(page => !page.isClosed()).length || 0 });
          return;
        }
        // 统一认证也可能在新标签打开。只有确认是选课系统后才替换主页面，
        // 避免按“最新标签”误关真正的身份验证页面。
        for (const frame of candidate.frames()) {
          const hasApp = await frame.locator(
            '#cvSplitSchoolCourse, #cvSchoolCourse, #cvRecommendCourse, #aSplitSchoolCourse',
          ).count().catch(() => 0);
          if (hasApp) {
            await this.keepOnlyPage(candidate, '网站打开选课页面');
            return;
          }
        }
        try {
          const hostname = new URL(candidate.url()).hostname;
          if (hostname === 'jnu.edu.cn' || hostname.endsWith('.jnu.edu.cn')) {
            await this.keepOnlyPage(candidate, '进入统一认证');
            return;
          }
        } catch (_) {}
        this.updateRuntime({ browserTabs: this.context.pages().filter(page => !page.isClosed()).length });
      }).catch(() => {});
    });
    this.log('info', `使用${browser.source}：${browser.label}`, { executablePath });
    this.updateRuntime({ browser: 'open', browserName: browser.label, browserTabs: 1, message: `${browser.label} 已打开` });
    await this.page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(error => {
      this.log('warn', `首次打开入口失败，稍后重试: ${error.message}`);
      this.setDiagnostic('site_network', error.message);
    });
  }

  async adoptSelectionPage() {
    const pages = this.context ? this.context.pages().slice().reverse() : [];
    for (const candidate of pages) {
      if (candidate.isClosed()) continue;
      let hasApp = false;
      for (const frame of candidate.frames()) {
        hasApp = (await frame.locator(
          '#cvSplitSchoolCourse, #cvSchoolCourse, #cvRecommendCourse, #aSplitSchoolCourse',
        ).count().catch(() => 0)) > 0;
        if (hasApp) break;
      }
      if (hasApp) {
        await this.keepOnlyPage(candidate, '进入选课系统');
        return true;
      }
    }
    return false;
  }

  async clickFirstVisible(builders, timeout = 800) {
    for (const frame of this.page.frames()) {
      for (const build of builders) {
        const target = build(frame).first();
        if (await target.isVisible({ timeout }).catch(() => false)) {
          await target.click({ timeout: DEFAULT_TIMEOUT });
          return true;
        }
      }
    }
    return false;
  }

  async isSelectionApp() {
    return this.adoptSelectionPage();
  }

  markSelectionUnavailable(reason = '') {
    const hadState = this.selectionReady || this.rushWarmups.size > 0;
    this.selectionReady = false;
    this.rushWarmups.clear();
    this.entryWarmupAttempts.clear();
    if (hadState && reason) this.log('info', `选课会话需要重新建立: ${reason}`);
  }

  markSelectionReady(reason = '') {
    if (this.selectionReady) return false;
    this.selectionReady = true;
    this.selectionGeneration += 1;
    this.rushWarmups.clear();
    this.entryWarmupAttempts.clear();
    this.log('success', `已进入选课系统，会话代次 ${this.selectionGeneration}`, { reason });
    return true;
  }

  async recoverLogin() {
    const initialDenied = await this.accessDeniedText();
    if (initialDenied) {
      this.haltForAccessDenied(initialDenied);
      return false;
    }
    if (await this.isSelectionApp()) {
      this.markSelectionReady('检测到有效选课页面');
      this.updateRuntime({ login: 'ok', diagnostic: makeDiagnostic('ready') });
      return true;
    }

    this.markSelectionUnavailable('未检测到有效选课页面');
    this.updateRuntime({ login: 'recovering', message: '正在恢复登录', diagnostic: makeDiagnostic('auth_recovering') });
    if (!this.page.url().startsWith(START_URL)) {
      await this.page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    }
    await this.clickFirstVisible([
      frame => frame.getByRole('button', { name: LOGIN_ENTRY_NAME }),
      frame => frame.getByRole('link', { name: LOGIN_ENTRY_NAME }),
      frame => frame.getByText(LOGIN_ENTRY_NAME),
    ]).catch(() => false);

    const deadline = Date.now() + 30 * 60_000;
    let announcedManual = false;
    while (this.running && Date.now() < deadline) {
      const denied = await this.accessDeniedText();
      if (denied) {
        this.haltForAccessDenied(denied);
        return false;
      }
      if (await this.enterSelectionIfNeeded()) {
        this.markSelectionReady('登录或开始选课后进入');
        this.updateRuntime({ login: 'ok', message: '登录已恢复', diagnostic: makeDiagnostic('ready', '已自动重新进入选课系统。') });
        this.log('success', '登录状态已恢复');
        return true;
      }
      if (!announcedManual) {
        announcedManual = true;
        this.updateRuntime({ login: 'manual', message: '请在浏览器中完成人工登录', diagnostic: makeDiagnostic('auth_manual') });
        this.log('warn', '需要人工登录、验证码或统一认证；完成后将自动继续');
        this.beep(8);
        this.notify('需要人工认证', '请在受控浏览器窗口完成登录、验证码或短信验证；完成后任务会自动继续。');
      }
      await sleep(2_000);
    }
    return false;
  }

  async maintainRushReadiness(courses) {
    const now = Date.now();
    const futureRush = courses.filter(course =>
      course.mode === 'rush' && course.startAt && new Date(course.startAt).getTime() > now,
    );
    const waitingRush = futureRush.length > 0;
    if (!waitingRush || Date.now() - this.lastRushReadinessRefreshAt < RUSH_READINESS_REFRESH_MS) return;
    const finalWindowStarted = futureRush.some(course =>
      new Date(course.startAt).getTime() - now <= RUSH_WARMUP_LEAD_MS,
    );
    if (finalWindowStarted) {
      if (!await this.isSelectionApp()) {
        this.markSelectionUnavailable('抢课待机时页面失效');
        this.updateRuntime({ login: 'unknown' });
        await this.recoverLogin();
      }
      return;
    }
    this.lastRushReadinessRefreshAt = Date.now();
    this.updateRuntime({ message: '抢课待机：正在验证登录状态' });

    if (!await this.isSelectionApp()) {
      this.markSelectionUnavailable('抢课待机检查时页面失效');
      this.updateRuntime({ login: 'unknown' });
      await this.recoverLogin();
      return;
    }

    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(700);
    if (!await this.isSelectionApp()) {
      this.log('warn', '抢课待机检测到 Session 失效，正在自动恢复');
      this.markSelectionUnavailable('刷新后 Session 失效');
      this.updateRuntime({ login: 'unknown' });
      await this.recoverLogin();
      return;
    }
    this.updateRuntime({ login: 'ok', page: 'selection', message: '抢课待机：登录状态正常', diagnostic: makeDiagnostic('ready', '抢课待机检查通过。') });
  }

  async enterSelectionIfNeeded() {
    if (await this.adoptSelectionPage()) return true;
    const clicked = await this.clickFirstVisible([
      frame => frame.locator('#changeCampus'),
      frame => frame.getByRole('button', { name: /^(开始选课|进入选课|进入选课系统|开始选择)$/ }),
      frame => frame.getByRole('link', { name: /^(开始选课|进入选课|进入选课系统|开始选择)$/ }),
      frame => frame.getByText(/^(开始选课|进入选课|进入选课系统|开始选择)$/),
    ]).catch(() => false);
    if (!clicked) return false;
    this.log('info', '已点击开始选课，等待选课页面');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await this.adoptSelectionPage()) return true;
      await sleep(500);
    }
    return false;
  }

  async gotoAllCourses() {
    if (await this.page.locator('#cvSplitSchoolCourse:visible').count().catch(() => 0)) {
      this.updateRuntime({ page: 'all-courses' });
      return 'split';
    }
    if (await this.page.locator('#cvSchoolCourse:visible').count().catch(() => 0)) {
      this.updateRuntime({ page: 'all-courses' });
      return 'school';
    }
    await this.clickFirstVisible([
      frame => frame.locator('#aSplitSchoolCourse'),
      frame => frame.getByRole('link', { name: /^全校课程$/ }),
      frame => frame.getByText(/^全校课程$/),
    ], 1_000);
    await sleep(1_500);
    if (await this.page.locator('#cvSplitSchoolCourse:visible').count().catch(() => 0)) {
      this.updateRuntime({ page: 'all-courses' });
      return 'split';
    }

    await this.clickFirstVisible([
      frame => frame.locator('#aSchoolCourse'),
      frame => frame.getByRole('link', { name: /^全校课程$/ }),
    ], 700);
    await sleep(1_500);
    if (await this.page.locator('#cvSchoolCourse:visible').count().catch(() => 0)) {
      this.updateRuntime({ page: 'all-courses' });
      return 'school';
    }
    throw new Error('无法进入全校课程页面');
  }

  async throttle(mode) {
    const configuredGap = mode === 'rush'
      ? Math.max(0, Number(this.store.state.settings.rushActionGapMs) || 0)
      : WATCH_ACTION_GAP_MS;
    const elapsed = Date.now() - this.lastActionAt;
    if (elapsed < configuredGap) await sleep(configuredGap - elapsed);
    this.lastActionAt = Date.now();
  }

  async searchCourse(course) {
    const searchStartedAt = Date.now();
    const pageKind = await this.gotoAllCourses();
    const split = pageKind === 'split';
    const input = this.page.locator(split ? '#splitSchoolSearch' : '#schoolSearch').first();
    const button = this.page.locator('#splitSearchBtn').first();
    await this.throttle(course.mode);
    await input.click();
    await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await input.press('Backspace').catch(() => {});
    await input.fill('');
    if (await input.inputValue() !== '') throw new Error('课程搜索框无法清空，已停止本轮搜索');
    await input.fill(course.courseNumber);
    const enteredCourseNumber = (await input.inputValue()).trim();
    if (enteredCourseNumber !== course.courseNumber) {
      throw new Error(`课程搜索框内容异常：期望 ${course.courseNumber}，实际 ${enteredCourseNumber || '空'}`);
    }
    const bodySelector = split ? '#splitSchoolBody' : '#schoolBody';
    const body = this.page.locator(bodySelector);
    const before = await body.innerHTML().catch(() => '');
    const queryResponse = this.page.waitForResponse(isCourseSearchResponse, { timeout: 8_000 })
      .then(async response => {
        const payload = await response.json().catch(() => null);
        return { type: 'response', ok: response.ok(), status: response.status(), signals: responseSignals(payload) };
      })
      .catch(() => null);
    if (split && await button.isVisible().catch(() => false)) await button.click();
    else await input.press('Enter');

    const domChanged = this.page.waitForFunction(
      ({ selector, previous }) => document.querySelector(selector)?.innerHTML !== previous,
      { selector: bodySelector, previous: before },
      { timeout: 8_000 },
    ).then(() => ({ type: 'dom' })).catch(() => null);
    const refreshSignal = await Promise.race([queryResponse, domChanged]);
    if (!refreshSignal) {
      const denied = await this.accessDeniedText();
      if (denied) {
        this.haltForAccessDenied(denied);
        throw new Error(denied);
      }
      if (!await this.isSelectionApp()) throw new Error('登录状态失效：课程搜索后已离开选课系统');
      throw new Error('课程搜索请求未返回，未复用旧的搜索结果');
    }
    if (refreshSignal.type === 'response') {
      const denied = refreshSignal.signals.find(signal => isAccessDeniedMessage(signal.message));
      if (denied) {
        this.haltForAccessDenied(denied.message);
        throw new Error(denied.message);
      }
      const expired = refreshSignal.signals.find(signal =>
        signal.code === '302' || /(?:登录|session|会话).{0,12}(?:失效|过期|超时)|请重新登录|未登录/i.test(signal.message),
      );
      if (expired) throw new Error(`登录状态失效：${expired.message || `学校返回错误码 ${expired.code}`}`);
      if (!refreshSignal.ok) {
        if ([302, 401].includes(refreshSignal.status)) throw new Error(`登录状态失效：学校网站返回 HTTP ${refreshSignal.status}`);
        throw new Error(`课程搜索请求失败，学校网站返回 HTTP ${refreshSignal.status}`);
      }
    }
    await this.page.locator(`${bodySelector} .cv-row`).first().waitFor({ state: 'attached', timeout: 4_000 }).catch(() => {});
    await sleep(120);
    const rows = this.page.locator(`${bodySelector} .cv-row`);
    const results = [];
    const count = Math.min(await rows.count().catch(() => 0), 100);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const result = await row.evaluate(el => {
        const text = selector => (el.querySelector(selector)?.innerText || '').replace(/\s+/g, ' ').trim();
        const setting = el.querySelector('.cv-setting-col');
        const choice = el.querySelector('.cv-choice');
        const fullFlag = choice?.getAttribute('isFull') ?? null;
        const settingText = (setting?.innerText || '').replace(/\s+/g, ' ').trim();
        const choiceVisible = Boolean(choice && getComputedStyle(choice).display !== 'none' &&
          getComputedStyle(choice).visibility !== 'hidden' && choice.getClientRects().length);
        const alreadySelected = Boolean(
          setting?.classList.contains('cv-selected') ||
          /已选|已获得|已中选|选课成功/.test(settingText),
        );
        return {
          courseNumber: text('.cv-school-number-col'),
          courseName: text('.cv-school-title-col'),
          teachingClassId: text('.cv-school-jxbid-col, .cv-school-index-col'),
          teacher: text('.cv-school-teacher-col'),
          capacityText: text('.cv-school-capcity-col'),
          settingText,
          settingClass: setting?.className || '',
          choiceExists: Boolean(choice),
          choiceVisible,
          choiceText: (choice?.innerText || '').trim(),
          fullFlag,
          isFull: fullFlag === '1' || /已满|人数已满|不可选/.test(text('.cv-school-capcity-col')),
          alreadySelected,
          disabled: !choice || !choiceVisible || choice.classList.contains('cv-disabled') || choice.hasAttribute('disabled') || choice.getAttribute('aria-disabled') === 'true',
          hasTest: choice?.getAttribute('hasTest') === '1',
          isConflict: choice?.getAttribute('isConflict') === '1',
        };
      });
      if (result.courseNumber === course.courseNumber || result.courseNumber.startsWith(`${course.courseNumber}[`)) {
        if (!course.teachingClassId || result.teachingClassId === course.teachingClassId) {
          results.push({ row, choice: row.locator('.cv-choice').first(), ...result });
        }
      }
    }
    return { matches: results, totalRows: count, durationMs: Date.now() - searchStartedAt };
  }

  async confirmDialogs(course, result) {
    const dialog = this.page.locator('#cvDialog:visible').last();
    if (!await dialog.isVisible({ timeout: 2_000 }).catch(() => false)) return;
    const dialogText = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (/失败|不可选|冲突|已满|超过|上限|学分|重复|限制|不能|不符合|禁止/.test(dialogText) && !/确认选择/.test(dialogText)) {
      await dialog.locator('.cv-sure, [type="sure"]').first().click().catch(() => {});
      throw new Error(dialogText.slice(0, 240));
    }
    if (!this.store.state.settings.autoConfirm) {
      this.log('warn', `${course.courseNumber} 等待人工确认`, { teachingClassId: result.teachingClassId });
      throw new Error('自动确认已关闭，等待人工处理');
    }
    await dialog.locator('.cv-sure, [type="sure"]').first().click();
    this.log('info', `${course.courseNumber} 已点击确认`, { teachingClassId: result.teachingClassId });
  }

  async handleExperimentDialog(course) {
    const table = this.page.locator('.syk-table:visible, #testCourse_choice_btn:visible').first();
    if (!await table.isVisible({ timeout: 2_000 }).catch(() => false)) return;
    if (!this.store.state.settings.autoPickExperiment) {
      this.log('warn', `${course.courseNumber} 需要选择实验教学班，已暂停该课程`);
      throw new Error('需要人工选择实验教学班');
    }
    const radio = this.page.locator('.syk-table input[type="radio"]:not([disabled])').first();
    if (!await radio.isVisible().catch(() => false)) throw new Error('没有可选实验教学班');
    await radio.check();
    await this.page.locator('#testCourse_choice_btn').click();
    await this.confirmDialogs(course, { teachingClassId: '实验班自动首选' });
  }

  async attemptEnrollment(course, result) {
    if (result.hasTest && !this.store.state.settings.autoPickExperiment) {
      return { success: false, manual: true, message: '该课程包含实验班，需要开启“自动选择首个实验班”或人工处理' };
    }
    const networkEvidence = [];
    const onResponse = async response => {
      try {
        const request = response.request();
        if (!['xhr', 'fetch'].includes(request.resourceType())) return;
        if (!/jwxk\.jnu\.edu\.cn$/i.test(new URL(response.url()).hostname)) return;
        const payload = await response.json();
        for (const signal of responseSignals(payload)) {
          networkEvidence.push({
            ...signal,
            status: response.status(),
            url: safeUrl(response.url()),
          });
        }
      } catch (_) {}
    };
    this.page.on('response', onResponse);
    try {
      await result.choice.scrollIntoViewIfNeeded().catch(() => {});
      await result.choice.click();
      await this.confirmDialogs(course, result);
      await this.handleExperimentDialog(course);

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const rowText = (await result.row.innerText().catch(() => '')).replace(/\s+/g, ' ');
        const selected = await result.row.locator('.cv-setting-col.cv-selected, .cv-selected').count().catch(() => 0);
        if (selected || /已选/.test(rowText) && !/已选人数/.test(rowText)) {
          return { success: true, message: '选课成功', evidence: networkEvidence };
        }

        const failure = [...networkEvidence].reverse().find(item =>
          item.code === '-1' || item.code === '302' ||
          (item.message && /失败|不可选|冲突|已满|超过|上限|学分|重复|限制|不能|不符合|禁止|已选/.test(item.message)),
        );
        if (failure) {
          return {
            success: false,
            message: failure.message || (failure.code === '302' ? '学校返回登录状态失效' : `学校返回错误码 ${failure.code}`),
            evidence: networkEvidence,
          };
        }

        const visibleTip = this.page.locator('.bh-tip:visible').last();
        if (await visibleTip.count().catch(() => 0)) {
          const text = (await visibleTip.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          if (/成功/.test(text)) return { success: true, message: text.slice(0, 240), evidence: networkEvidence };
          if (/失败|不可选|冲突|已满|超过|上限|学分|重复|限制|不能|不符合|禁止|已选/.test(text)) {
            return { success: false, message: text.slice(0, 240), evidence: networkEvidence };
          }
        }

        const visibleDialog = this.page.locator('#cvDialog:visible');
        if (await visibleDialog.count().catch(() => 0)) {
          const text = (await visibleDialog.last().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          if (/成功/.test(text)) {
            await visibleDialog.last().locator('.cv-sure, [type="sure"]').first().click().catch(() => {});
            return { success: true, message: text.slice(0, 200), evidence: networkEvidence };
          }
          if (/失败|不可选|冲突|已满|超过|上限|学分|重复|限制|不能|不符合|禁止|已选/.test(text)) {
            await visibleDialog.last().locator('.cv-sure, [type="sure"]').first().click().catch(() => {});
            return { success: false, message: text.slice(0, 240), evidence: networkEvidence };
          }
        }
        await sleep(200);
      }
      return { success: false, message: '已点击选课，但未在 15 秒内确认成功结果', evidence: networkEvidence };
    } catch (error) {
      return { success: false, manual: /人工|实验班/.test(error.message), message: error.message, evidence: networkEvidence };
    } finally {
      this.page.off('response', onResponse);
    }
  }

  scheduleNext(course, failed = false) {
    const settings = this.store.state.settings;
    let seconds;
    if (course.mode === 'rush') {
      const startAt = course.startAt ? new Date(course.startAt).getTime() : 0;
      if (startAt > Date.now()) {
        course.status = 'scheduled';
        course.nextCheckAt = startAt;
        return;
      }
      // 抢课到点后不再增加整轮等待，只保留页面动作的最小保护间隔。
      course.nextCheckAt = Date.now();
      return;
    } else {
      seconds = settings.watchMinSeconds + Math.random() * (settings.watchMaxSeconds - settings.watchMinSeconds);
    }
    if (failed) {
      seconds = Math.min(180, Math.max(seconds * 2, 20));
    }
    course.nextCheckAt = Date.now() + Math.round(seconds * 1_000);
  }

  completeCourse(course, result, alreadySelected = false) {
    this.rushWarmups.delete(course.id);
    this.entryWarmupAttempts.delete(course.id);
    const index = this.store.state.courses.findIndex(item => item.id === course.id);
    if (index < 0) return false;
    this.store.state.courses.splice(index, 1);
    this.store.state.completed.unshift({
      ...course,
      status: 'selected',
      selectedAt: nowIso(),
      result: {
        courseName: result.courseName,
        teachingClassId: result.teachingClassId,
        teacher: result.teacher,
        alreadySelected,
      },
    });
    this.store.state.completed = this.store.state.completed.slice(0, 100);
    this.store.save();
    const diagnostic = makeDiagnostic(
      alreadySelected ? 'already_selected' : 'selected',
      `${course.courseNumber} ${result.courseName} ${result.teachingClassId || ''}`.trim(),
    );
    this.log('success', alreadySelected
      ? `${course.courseNumber} 已在学校已选记录中，已移出任务表`
      : `${course.courseNumber} 选课成功，已移出任务表`, result);
    this.updateRuntime({ diagnostic });
    if (!alreadySelected) {
      this.beep(10);
      this.notify('选课成功', `${course.courseNumber} ${result.courseName} ${result.teacher}`);
    }
    return true;
  }

  async preheatRushCourse(course, phase = 'final') {
    course.lastWarmupAttemptAt = Date.now();
    this.updateRuntime({ currentCourseId: course.id, message: `正在预热 ${course.courseNumber} / ${course.teachingClassId}` });
    const search = await this.searchCourse(course);
    if (!this.store.state.courses.some(item => item.id === course.id)) {
      this.rushWarmups.delete(course.id);
      return false;
    }
    const summaries = search.matches.map(assessCourseResult);
    const match = summaries.find(result => result.teachingClassId === course.teachingClassId);
    if (!match) {
      this.rushWarmups.delete(course.id);
      const diagnostic = makeDiagnostic(
        'course_not_found',
        `预热返回 ${search.totalRows} 行，但没有教学班 ${course.teachingClassId}。`,
      );
      course.status = 'not-found';
      course.lastResult = { checkedAt: nowIso(), message: '预热未找到教学班', diagnostic, timing: { preheatSearchMs: search.durationMs } };
      this.store.save();
      this.updateRuntime({ diagnostic });
      return false;
    }
    if (match.alreadySelected) {
      this.completeCourse(course, match, true);
      return false;
    }
    const pageFunctionsReady = await this.page.evaluate(() =>
      typeof window.buildAddVolunteerParam === 'function' &&
      typeof window.addVolunteer === 'function' &&
      typeof window.initProcessInterval === 'function',
    ).catch(() => false);
    if (!pageFunctionsReady) {
      this.rushWarmups.delete(course.id);
      throw new Error('学校页面的直选函数尚未加载，预热失败');
    }
    const publicMatch = (({ row, choice, ...value }) => value)(match);
    this.rushWarmups.set(course.id, {
      page: this.page,
      warmedAt: Date.now(),
      generation: this.selectionGeneration,
      phase,
      result: publicMatch,
    });
    course.status = 'preheated';
    course.lastResult = {
      checkedAt: nowIso(),
      matches: [publicMatch],
      message: '预热完成，等待开抢',
      diagnostic: makeDiagnostic('rush_preheated', `${course.courseNumber} / ${course.teachingClassId}`),
      timing: { preheatSearchMs: search.durationMs },
    };
    this.store.save();
    this.updateRuntime({ diagnostic: course.lastResult.diagnostic, message: `${course.courseNumber} 预热完成` });
    this.log('success', `${course.courseNumber} / ${course.teachingClassId} 抢课预热完成`, { phase, generation: this.selectionGeneration, searchMs: search.durationMs });
    return true;
  }

  async preheatRushAfterEntry(courses) {
    const rushCourses = courses.filter(course =>
      course.mode === 'rush' && this.entryWarmupAttempts.get(course.id) !== this.selectionGeneration,
    );
    if (!rushCourses.length) return;
    this.log('info', `本次进入选课系统后预热 ${rushCourses.length} 个抢课任务`);
    for (const course of rushCourses) {
      if (!this.store.state.courses.some(item => item.id === course.id)) continue;
      this.entryWarmupAttempts.set(course.id, this.selectionGeneration);
      try {
        const untilStart = course.startAt ? new Date(course.startAt).getTime() - Date.now() : 0;
        const phase = untilStart <= RUSH_WARMUP_LEAD_MS ? 'final' : 'entry';
        await this.preheatRushCourse(course, phase);
      } catch (error) {
        this.rushWarmups.delete(course.id);
        course.status = 'error';
        course.lastError = error.message;
        course.lastResult = { checkedAt: nowIso(), message: '进入后预热失败', diagnostic: classifyError(error) };
        this.store.save();
        this.log('error', `${course.courseNumber} 进入后预热失败，不影响其他任务: ${error.message}`);
      }
    }
  }

  async preheatRushCourses(courses) {
    const now = Date.now();
    for (const course of courses) {
      if (!this.store.state.courses.some(item => item.id === course.id)) continue;
      const warmup = this.rushWarmups.get(course.id);
      if (!needsFinalRushPreheat(course, warmup, now, this.page, this.selectionGeneration)) continue;
      if (course.lastWarmupAttemptAt && now - course.lastWarmupAttemptAt < 2_000) continue;
      try {
        await this.preheatRushCourse(course, 'final');
      } catch (error) {
        this.rushWarmups.delete(course.id);
        course.status = 'error';
        course.lastError = error.message;
        course.lastResult = { checkedAt: nowIso(), message: '预热失败', diagnostic: classifyError(error) };
        this.store.save();
        this.log('error', `${course.courseNumber} 预热失败: ${error.message}`);
      }
    }
  }

  async attemptPreheatedEnrollment(course, warmup) {
    const startedAt = Date.now();
    if (!this.store.state.settings.autoConfirm) {
      return { success: false, manual: true, message: '自动确认已关闭，抢课直选未提交', durationMs: 0 };
    }
    if (warmup.result.hasTest) {
      return { success: false, manual: true, message: '该课程包含实验教学班，暂不支持预热直选', durationMs: 0 };
    }
    await this.throttle('rush');
    const response = await this.page.evaluate(async teachingClassId => {
      const clean = value => ({
        code: value?.code == null ? '' : String(value.code),
        message: String(value?.msg ?? value?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
      });
      if (typeof window.buildAddVolunteerParam !== 'function' || typeof window.addVolunteer !== 'function') {
        return { stage: 'prepare', code: 'FUNCTION_MISSING', message: '学校页面直选函数不可用' };
      }
      const first = await new Promise(resolve => {
        try {
          window.addVolunteer(window.buildAddVolunteerParam(teachingClassId))
            .done(value => resolve({ stage: 'submit', ...clean(value) }))
            .fail((_xhr, status, error) => resolve({ stage: 'submit', code: 'NETWORK', message: error || status || '提交请求失败' }));
        } catch (error) {
          resolve({ stage: 'submit', code: 'SCRIPT_ERROR', message: error.message });
        }
      });
      if (first.code !== '1') return first;
      if (typeof window.initProcessInterval !== 'function') {
        return { stage: 'confirm', code: 'FUNCTION_MISSING', message: '学校结果确认函数不可用' };
      }
      return new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          resolve({ stage: 'confirm', ...clean(value) });
        };
        window.initProcessInterval(finish);
        setTimeout(() => finish({ code: 'TIMEOUT', msg: '学校未在 15 秒内返回最终结果' }), 15_000);
      });
    }, course.teachingClassId);
    const durationMs = Date.now() - startedAt;
    return {
      success: response.code === '1' && response.stage === 'confirm',
      message: response.message || (response.code === '1' ? '选课成功' : response.code === '302' ? '登录状态失效' : `学校返回 ${response.code}`),
      evidence: [response],
      durationMs,
    };
  }

  async checkRushCourse(course) {
    let warmup = this.rushWarmups.get(course.id);
    if (!warmup || warmup.page !== this.page || warmup.generation !== this.selectionGeneration || this.page.isClosed()) {
      await this.preheatRushCourse(course, 'final');
      warmup = this.rushWarmups.get(course.id);
      if (!warmup) return;
    }
    if (!this.store.state.courses.some(item => item.id === course.id)) return;
    this.updateRuntime({ currentCourseId: course.id, lastCheckAt: nowIso(), message: `正在直选 ${course.courseNumber} / ${course.teachingClassId}` });
    course.status = 'checking';
    const attempt = await this.attemptPreheatedEnrollment(course, warmup);
    course.lastResult.timing.submitMs = attempt.durationMs;
    if (attempt.success) {
      this.completeCourse(course, warmup.result);
      return;
    }
    if (/已经?选|已选过|课程已选|重复选课|不可重复选择/.test(attempt.message)) {
      this.completeCourse(course, warmup.result, true);
      return;
    }
    if (isCreditLimitMessage(attempt.message)) {
      this.haltForCreditLimit(course, attempt.message, attempt.evidence);
      return;
    }
    const classified = classifyError(new Error(attempt.message));
    course.status = attempt.manual ? 'manual' : 'error';
    course.lastError = attempt.message;
    course.lastResult.message = attempt.message;
    course.lastResult.attemptEvidence = attempt.evidence || [];
    course.lastResult.diagnostic = makeDiagnostic(classified.code, attempt.message, JSON.stringify(attempt.evidence || []));
    if (attempt.evidence?.some(item => item.code === '302')) {
      this.markSelectionUnavailable('学校返回 Session 失效代码 302');
      this.updateRuntime({ login: 'unknown' });
      course.nextCheckAt = 0;
    } else {
      this.scheduleNext(course, true);
    }
    this.store.save();
    this.updateRuntime({ diagnostic: course.lastResult.diagnostic });
    this.log(attempt.manual ? 'warn' : 'error', `${course.courseNumber} 直选返回: ${attempt.message}`, { submitMs: attempt.durationMs });
  }

  async checkCourse(course) {
    if (course.mode === 'rush') return this.checkRushCourse(course);
    return this.checkWatchCourse(course);
  }

  async checkWatchCourse(course) {
    this.updateRuntime({ currentCourseId: course.id, lastCheckAt: nowIso(), message: `正在检查 ${course.courseNumber}` });
    course.status = 'checking';
    course.lastError = null;
    this.store.save();
    const search = await this.searchCourse(course);
    if (!this.store.state.courses.some(item => item.id === course.id)) return;
    const matches = search.matches;
    if (!matches.length) {
      course.status = 'not-found';
      const diagnostic = makeDiagnostic(
        'course_not_found',
        `课程列表返回 ${search.totalRows} 行，但没有匹配 ${course.courseNumber}${course.teachingClassId ? ` / ${course.teachingClassId}` : ''}。`,
      );
      course.lastResult = { checkedAt: nowIso(), message: diagnostic.title, diagnostic, timing: { searchMs: search.durationMs } };
      this.scheduleNext(course, false);
      this.store.save();
      this.updateRuntime({ diagnostic });
      this.log('warn', `${course.courseNumber} 未找到匹配结果`);
      return;
    }

    const summaries = matches.map(assessCourseResult);
    const publicMatches = summaries.map(({ row, choice, ...result }) => result);

    const alreadySelected = summaries.find(result => result.alreadySelected);
    if (alreadySelected) {
      this.completeCourse(course, alreadySelected, true);
      return;
    }

    if (summaries.some(result => !result.reliable)) {
      const diagnostic = makeDiagnostic(
        'response_unreliable',
        '课程存在，但容量、可选标记或页面字段互相矛盾。本轮已安全停止点击。',
        JSON.stringify(publicMatches),
      );
      course.status = 'error';
      course.lastResult = { checkedAt: nowIso(), matches: publicMatches, message: diagnostic.title, diagnostic, timing: { searchMs: search.durationMs } };
      this.scheduleNext(course, true);
      this.store.save();
      this.updateRuntime({ diagnostic });
      this.log('error', `${course.courseNumber} 返回结果无法可靠识别，未执行选课`, { matches: publicMatches });
      return;
    }

    const available = summaries.find(result => result.available);
    const blocked = !available && summaries.some(result => result.isConflict || (!result.isFull && result.disabled));
    const diagnostic = makeDiagnostic(
      available ? 'submitting' : blocked ? 'course_blocked' : 'course_full',
      available
        ? `教学班 ${available.teachingClassId || '未知'} 可选。`
        : publicMatches.map(result => `${result.teachingClassId || '未标班号'}：${result.capacityText || '无容量文字'}${result.isConflict ? '，存在冲突' : ''}`).join('；'),
    );
    course.status = available ? 'available' : blocked ? 'manual' : 'full';
    course.lastResult = {
      checkedAt: nowIso(),
      matches: publicMatches,
      message: diagnostic.title,
      diagnostic,
      timing: { searchMs: search.durationMs },
    };
    this.store.save();
    this.updateRuntime({ diagnostic });

    if (!available) {
      this.scheduleNext(course, false);
      this.store.save();
      this.log('info', `${course.courseNumber} 当前无余量`, { matches: course.lastResult.matches });
      return;
    }

    const { row: _row, choice: _choice, ...availableData } = available;
    this.log('success', `${course.courseNumber} 发现可选教学班`, availableData);
    const attemptStartedAt = Date.now();
    const attempt = await this.attemptEnrollment(course, available);
    course.lastResult.timing.attemptMs = Date.now() - attemptStartedAt;
    if (attempt.success) this.completeCourse(course, available);
    else if (/已经?选|已选过|课程已选|重复选课|不可重复选择/.test(attempt.message)) {
      this.completeCourse(course, available, true);
    }
    else if (isCreditLimitMessage(attempt.message)) {
      this.haltForCreditLimit(course, attempt.message, attempt.evidence);
    }
    else {
      const classified = classifyError(new Error(attempt.message));
      const attemptDiagnostic = makeDiagnostic(
        classified.code,
        attempt.message,
        JSON.stringify(attempt.evidence || []),
      );
      course.status = attempt.manual ? 'manual' : 'error';
      course.lastError = attempt.message;
      course.lastResult.attemptEvidence = attempt.evidence || [];
      course.lastResult.diagnostic = attemptDiagnostic;
      this.scheduleNext(course, true);
      this.store.save();
      this.updateRuntime({ diagnostic: attemptDiagnostic });
      this.log(attempt.manual ? 'warn' : 'error', `${course.courseNumber}: ${attempt.message}`);
    }
  }

  haltForCreditLimit(course, message, evidence = []) {
    const detail = String(message || '学校返回已达到学分上限').slice(0, 500);
    const diagnostic = makeDiagnostic('credit_limit_stopped', detail, JSON.stringify(evidence || []));
    course.status = 'manual';
    course.lastError = detail;
    course.lastResult = {
      ...(course.lastResult || {}),
      checkedAt: nowIso(),
      message: diagnostic.title,
      attemptEvidence: evidence || [],
      diagnostic,
    };
    this.store.save();
    this.running = false;
    this.log('error', `学校返回学分上限，已停止全部任务: ${detail}`);
    this.updateRuntime({
      running: false,
      currentCourseId: course.id,
      message: '已达到学分上限，任务已停止',
      diagnostic,
    });
    this.beep(10);
    this.notify('任务已停止：达到学分上限', detail);
  }

  async runLoop() {
    await this.ensureBrowser();
    while (this.running) {
      try {
        await this.ensureBrowser();
        if (!await this.recoverLogin()) {
          await sleep(5_000);
          continue;
        }
        let active = this.store.state.courses.filter(course => course.status !== 'paused');
        if (!active.length) {
          this.updateRuntime({ currentCourseId: null, message: '等待添加课程' });
          await sleep(1_000);
          continue;
        }
        await this.preheatRushAfterEntry(active);
        active = this.store.state.courses.filter(course => course.status !== 'paused');
        if (!active.length) {
          this.updateRuntime({ currentCourseId: null, message: '等待添加课程' });
          await sleep(250);
          continue;
        }
        await this.maintainRushReadiness(active);
        await this.preheatRushCourses(active);
        active = this.store.state.courses.filter(course => course.status !== 'paused');
        for (const course of active) {
          if (course.mode === 'rush' && course.startAt && new Date(course.startAt).getTime() > Date.now()) {
            course.status = this.rushWarmups.has(course.id) ? 'preheated' : 'scheduled';
            course.nextCheckAt = new Date(course.startAt).getTime();
          }
        }
        const due = active
          .filter(course => !course.nextCheckAt || course.nextCheckAt <= Date.now())
          .sort((a, b) => (a.mode === 'rush' ? 0 : 1) - (b.mode === 'rush' ? 0 : 1));
        if (!due.length) {
          const waitMs = Math.max(250, Math.min(...active.map(course => course.nextCheckAt - Date.now()), 1_000));
          await sleep(waitMs);
          continue;
        }
        for (const course of due) {
          if (!this.running || !this.store.state.courses.some(item => item.id === course.id)) break;
          try {
            await this.checkCourse(course);
          } catch (error) {
            if (!this.running) break;
            const diagnostic = classifyError(error);
            course.status = 'error';
            course.lastError = error.message;
            course.lastResult = { ...(course.lastResult || {}), checkedAt: nowIso(), message: diagnostic.title, diagnostic };
            this.updateRuntime({ diagnostic });
            this.scheduleNext(course, true);
            this.store.save();
            this.log('error', `${course.courseNumber} 检查失败: ${error.message}`, { url: safeUrl(this.page?.url()) });
            if (/登录|session|页面|Execution context|Target closed/i.test(error.message)) {
              this.markSelectionUnavailable(error.message);
              this.updateRuntime({ login: 'unknown' });
              course.status = 'queued';
              course.nextCheckAt = 0;
            }
          }
          this.emit('state', this.publicState());
        }
      } catch (error) {
        if (!this.running) break;
        this.updateRuntime({ diagnostic: classifyError(error) });
        this.log('error', `循环恢复中: ${error.message}`);
        await sleep(10_000);
      }
    }
  }

  beep(times = 3) {
    let count = 0;
    const timer = setInterval(() => {
      process.stdout.write('\x07');
      if (++count >= times) clearInterval(timer);
    }, 220);
  }

  notify(title, message) {
    if (process.platform !== 'win32') return;
    const safeTitle = title.replace(/'/g, "''");
    const safeMessage = message.replace(/'/g, "''");
    const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; ` +
      `$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(0); ` +
      `$t=$x.GetElementsByTagName('text'); $t.Item(0).AppendChild($x.CreateTextNode('${safeTitle}')) > $null; ` +
      `$t.Item(1).AppendChild($x.CreateTextNode('${safeMessage}')) > $null; ` +
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('JNU Course Keeper').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (_) {}
  }
}

module.exports = {
  CourseAgent,
  parseCapacity,
  assessCourseResult,
  responseSignals,
  classifyError,
  makeDiagnostic,
  needsFinalRushPreheat,
  isCreditLimitMessage,
  isLoginGuideUrl,
  isCourseSearchResponse,
  isAccessDeniedMessage,
  executableFromOpenCommand,
  isChromiumExecutable,
};
