const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const START_URL = 'https://jwxk.jnu.edu.cn/';
const WATCH_ACTION_GAP_MS = 1_500;
const DEFAULT_TIMEOUT = 15_000;

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
    this.runtime = {
      running: false,
      browser: 'closed',
      login: 'unknown',
      page: 'unknown',
      currentCourseId: null,
      lastCheckAt: null,
      message: '尚未启动',
    };
  }

  publicState() {
    return { ...this.store.snapshot(), runtime: { ...this.runtime } };
  }

  updateRuntime(patch) {
    Object.assign(this.runtime, patch);
    this.emit('state', this.publicState());
  }

  log(level, message, data = {}) {
    this.emit('log', { at: nowIso(), level, message, data });
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.updateRuntime({ running: true, message: '正在启动浏览器' });
    this.loopPromise = this.runLoop().catch(error => {
      this.log('error', `主循环异常退出: ${error.message}`);
      this.running = false;
      this.updateRuntime({ running: false, message: '异常停止' });
    }).finally(() => { this.loopPromise = null; });
  }

  async stop() {
    this.running = false;
    this.updateRuntime({ running: false, currentCourseId: null, message: '正在停止' });
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
    if (this.loopPromise) await Promise.race([this.loopPromise, sleep(2_000)]).catch(() => {});
    this.updateRuntime({ browser: 'closed', login: 'unknown', page: 'unknown', message: '已停止' });
  }

  findBrowser() {
    const candidates = [
      process.env.PLAYWRIGHT_BROWSER,
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ].filter(Boolean);
    return candidates.find(candidate => fs.existsSync(candidate));
  }

  async ensureBrowser() {
    if (this.context && this.page && !this.page.isClosed()) return;
    const executablePath = this.findBrowser();
    if (!executablePath) throw new Error('找不到 Microsoft Edge 或 Chrome');
    fs.mkdirSync(this.profileDir, { recursive: true });
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
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(DEFAULT_TIMEOUT);
    this.context.on('page', candidate => {
      candidate.setDefaultTimeout(DEFAULT_TIMEOUT);
    });
    this.updateRuntime({ browser: 'open', message: '浏览器已打开' });
    await this.page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(error => {
      this.log('warn', `首次打开入口失败，稍后重试: ${error.message}`);
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
        this.page = candidate;
        this.page.setDefaultTimeout(DEFAULT_TIMEOUT);
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

  async recoverLogin() {
    if (await this.isSelectionApp()) {
      this.updateRuntime({ login: 'ok' });
      return true;
    }

    this.updateRuntime({ login: 'recovering', message: '正在恢复登录' });
    if (!this.page.url().startsWith(START_URL)) {
      await this.page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    }
    await this.clickFirstVisible([
      frame => frame.getByRole('button', { name: /登录|统一认证|进入系统/ }),
      frame => frame.getByRole('link', { name: /登录|统一认证|进入系统/ }),
      frame => frame.getByText(/^(登录|统一认证登录|进入选课系统)$/),
    ]).catch(() => false);

    const deadline = Date.now() + 30 * 60_000;
    let announcedManual = false;
    while (this.running && Date.now() < deadline) {
      if (await this.enterSelectionIfNeeded()) {
        this.updateRuntime({ login: 'ok', message: '登录已恢复' });
        this.log('success', '登录状态已恢复');
        return true;
      }
      if (!announcedManual) {
        announcedManual = true;
        this.updateRuntime({ login: 'manual', message: '请在浏览器中完成人工登录' });
        this.log('warn', '需要人工登录、验证码或统一认证；完成后将自动继续');
        this.beep(8);
      }
      await sleep(2_000);
    }
    return false;
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
      ? this.store.state.settings.rushActionGapMs
      : WATCH_ACTION_GAP_MS;
    const elapsed = Date.now() - this.lastActionAt;
    if (elapsed < configuredGap) await sleep(configuredGap - elapsed);
    this.lastActionAt = Date.now();
  }

  async searchCourse(course) {
    const pageKind = await this.gotoAllCourses();
    const split = pageKind === 'split';
    const input = this.page.locator(split ? '#splitSchoolSearch' : '#schoolSearch').first();
    const button = this.page.locator('#splitSearchBtn').first();
    await this.throttle(course.mode);
    await input.fill(course.courseNumber);
    const bodySelector = split ? '#splitSchoolBody' : '#schoolBody';
    const body = this.page.locator(bodySelector);
    const before = await body.innerHTML().catch(() => '');
    if (split && await button.isVisible().catch(() => false)) await button.click();
    else await input.press('Enter');

    await this.page.waitForFunction(
      ({ selector, previous }) => document.querySelector(selector)?.innerHTML !== previous,
      { selector: bodySelector, previous: before },
      { timeout: 8_000 },
    ).catch(() => {});
    await this.page.locator(`${bodySelector} .cv-row`).first().waitFor({ state: 'attached', timeout: 4_000 }).catch(() => {});
    await sleep(120);
    const rows = this.page.locator(`${bodySelector} .cv-row`);
    const results = [];
    const count = Math.min(await rows.count().catch(() => 0), 100);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const result = await row.evaluate(el => {
        const text = selector => (el.querySelector(selector)?.innerText || '').replace(/\s+/g, ' ').trim();
        const choice = el.querySelector('.cv-choice');
        return {
          courseNumber: text('.cv-school-number-col'),
          courseName: text('.cv-school-title-col'),
          teachingClassId: text('.cv-school-jxbid-col, .cv-school-index-col'),
          teacher: text('.cv-school-teacher-col'),
          capacityText: text('.cv-school-capcity-col'),
          choiceText: (choice?.innerText || '').trim(),
          isFull: choice?.getAttribute('isFull') === '1' || /已满|人数已满/.test(text('.cv-school-capcity-col')),
          disabled: !choice || choice.classList.contains('cv-disabled') || choice.hasAttribute('disabled') || choice.getAttribute('aria-disabled') === 'true',
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
    return results;
  }

  async confirmDialogs(course, result) {
    const dialog = this.page.locator('#cvDialog:visible').last();
    if (!await dialog.isVisible({ timeout: 2_000 }).catch(() => false)) return;
    const dialogText = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (/失败|不可选|冲突|已满|超过/.test(dialogText) && !/确认选择/.test(dialogText)) {
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
    await result.choice.scrollIntoViewIfNeeded().catch(() => {});
    await result.choice.click();
    await this.confirmDialogs(course, result);
    await this.handleExperimentDialog(course);

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const rowText = (await result.row.innerText().catch(() => '')).replace(/\s+/g, ' ');
      const selected = await result.row.locator('.cv-setting-col.cv-selected, .cv-selected').count().catch(() => 0);
      if (selected || /已选/.test(rowText) && !/已选人数/.test(rowText)) {
        return { success: true, message: '选课成功' };
      }
      const visibleDialog = this.page.locator('#cvDialog:visible');
      if (await visibleDialog.count().catch(() => 0)) {
        const text = (await visibleDialog.last().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (/成功/.test(text)) {
          await visibleDialog.last().locator('.cv-sure, [type="sure"]').first().click().catch(() => {});
          return { success: true, message: text.slice(0, 200) };
        }
        if (/失败|不可选|冲突|已满/.test(text)) {
          await visibleDialog.last().locator('.cv-sure, [type="sure"]').first().click().catch(() => {});
          return { success: false, message: text.slice(0, 240) };
        }
      }
      await sleep(500);
    }
    return { success: false, message: '已点击选课，但未在 15 秒内确认成功结果' };
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
      seconds = settings.rushRoundSeconds + Math.random() * 0.35;
    } else {
      seconds = settings.watchMinSeconds + Math.random() * (settings.watchMaxSeconds - settings.watchMinSeconds);
    }
    if (failed) {
      seconds = course.mode === 'rush'
        ? Math.min(15, Math.max(seconds * 1.5, 3))
        : Math.min(180, Math.max(seconds * 2, 20));
    }
    course.nextCheckAt = Date.now() + Math.round(seconds * 1_000);
  }

  completeCourse(course, result) {
    const index = this.store.state.courses.findIndex(item => item.id === course.id);
    if (index >= 0) this.store.state.courses.splice(index, 1);
    this.store.state.completed.unshift({
      ...course,
      status: 'selected',
      selectedAt: nowIso(),
      result: {
        courseName: result.courseName,
        teachingClassId: result.teachingClassId,
        teacher: result.teacher,
      },
    });
    this.store.state.completed = this.store.state.completed.slice(0, 100);
    this.store.save();
    this.log('success', `${course.courseNumber} 选课成功，已移出任务表`, result);
    this.beep(10);
    this.notify('选课成功', `${course.courseNumber} ${result.courseName} ${result.teacher}`);
  }

  async checkCourse(course) {
    this.updateRuntime({ currentCourseId: course.id, lastCheckAt: nowIso(), message: `正在检查 ${course.courseNumber}` });
    course.status = 'checking';
    course.lastError = null;
    this.store.save();
    const matches = await this.searchCourse(course);
    if (!matches.length) {
      course.status = 'not-found';
      course.lastResult = { checkedAt: nowIso(), message: '未找到匹配课程或教学班' };
      this.scheduleNext(course, false);
      this.store.save();
      this.log('warn', `${course.courseNumber} 未找到匹配结果`);
      return;
    }

    const summaries = matches.map(result => {
      const capacity = parseCapacity(result.capacityText, result.isFull);
      return { ...result, ...capacity, available: !result.isFull && !result.disabled && capacity.remaining !== 0 };
    });
    const available = summaries.find(result => result.available);
    course.status = available ? 'available' : 'full';
    course.lastResult = {
      checkedAt: nowIso(),
      matches: summaries.map(({ row, choice, ...result }) => result),
      message: available ? '发现可选教学班，正在提交' : '当前无可选教学班',
    };
    this.store.save();
    this.emit('state', this.publicState());

    if (!available) {
      this.scheduleNext(course, false);
      this.store.save();
      this.log('info', `${course.courseNumber} 当前无余量`, { matches: course.lastResult.matches });
      return;
    }

    const { row: _row, choice: _choice, ...availableData } = available;
    this.log('success', `${course.courseNumber} 发现可选教学班`, availableData);
    const attempt = await this.attemptEnrollment(course, available);
    if (attempt.success) this.completeCourse(course, available);
    else {
      course.status = attempt.manual ? 'manual' : 'error';
      course.lastError = attempt.message;
      this.scheduleNext(course, true);
      this.store.save();
      this.log(attempt.manual ? 'warn' : 'error', `${course.courseNumber}: ${attempt.message}`);
    }
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
        const active = this.store.state.courses.filter(course => course.status !== 'paused');
        if (!active.length) {
          this.updateRuntime({ currentCourseId: null, message: '等待添加课程' });
          await sleep(1_000);
          continue;
        }
        for (const course of active) {
          if (course.mode === 'rush' && course.startAt && new Date(course.startAt).getTime() > Date.now()) {
            course.status = 'scheduled';
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
            course.status = 'error';
            course.lastError = error.message;
            course.lastResult = { ...(course.lastResult || {}), checkedAt: nowIso(), message: error.message };
            this.scheduleNext(course, true);
            this.store.save();
            this.log('error', `${course.courseNumber} 检查失败: ${error.message}`, { url: safeUrl(this.page?.url()) });
            if (/登录|session|页面|Execution context|Target closed/i.test(error.message)) {
              this.updateRuntime({ login: 'unknown' });
              course.status = 'queued';
              course.nextCheckAt = 0;
            }
          }
          this.emit('state', this.publicState());
        }
      } catch (error) {
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

module.exports = { CourseAgent, parseCapacity };
