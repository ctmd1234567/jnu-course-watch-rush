const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STATE = {
  settings: {
    watchMinSeconds: 20,
    watchMaxSeconds: 30,
    rushActionGapMs: 0,
    autoConfirm: true,
    autoPickExperiment: false,
  },
  courses: [],
  completed: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = clone(DEFAULT_STATE);
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const savedSettings = saved.settings || {};
      this.state = {
        settings: {
          watchMinSeconds: savedSettings.watchMinSeconds ?? DEFAULT_STATE.settings.watchMinSeconds,
          watchMaxSeconds: savedSettings.watchMaxSeconds ?? DEFAULT_STATE.settings.watchMaxSeconds,
          rushActionGapMs: Math.max(0, Number(savedSettings.rushActionGapMs) || 0),
          autoConfirm: savedSettings.autoConfirm ?? DEFAULT_STATE.settings.autoConfirm,
          autoPickExperiment: savedSettings.autoPickExperiment ?? DEFAULT_STATE.settings.autoPickExperiment,
        },
        courses: Array.isArray(saved.courses) ? saved.courses : [],
        completed: Array.isArray(saved.completed) ? saved.completed.slice(0, 100) : [],
      };
      for (const course of this.state.courses) {
        if (course.status === 'checking') course.status = 'queued';
        course.nextCheckAt = course.mode === 'rush' && course.startAt
          ? Math.max(Date.now(), new Date(course.startAt).getTime())
          : 0;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`无法读取状态文件，将使用默认值: ${error.message}`);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(error.code)) throw error;
      // Windows、杀毒软件或同步盘可能短暂锁住现有文件，导致原子替换失败。
      // copyFileSync 会覆盖目标文件，成功后再删除临时文件；失败则保留临时文件供诊断。
      try {
        fs.copyFileSync(tempPath, this.filePath);
        fs.unlinkSync(tempPath);
      } catch (fallbackError) {
        fallbackError.message = `无法保存任务状态（${fallbackError.code || 'UNKNOWN'}）：${fallbackError.message}`;
        throw fallbackError;
      }
    }
  }

  snapshot() {
    return clone(this.state);
  }
}

module.exports = { Store, DEFAULT_STATE };
