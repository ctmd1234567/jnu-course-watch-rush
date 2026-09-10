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
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      // 某些 Windows/Electron 环境会把同目录原子替换误判为跨设备移动。
      fs.copyFileSync(tempPath, this.filePath);
      fs.unlinkSync(tempPath);
    }
  }

  snapshot() {
    return clone(this.state);
  }
}

module.exports = { Store, DEFAULT_STATE };
