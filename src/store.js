const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STATE = {
  settings: {
    watchMinSeconds: 20,
    watchMaxSeconds: 30,
    rushRoundSeconds: 3,
    rushActionGapMs: 900,
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
      this.state = {
        settings: { ...DEFAULT_STATE.settings, ...(saved.settings || {}) },
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
    fs.renameSync(tempPath, this.filePath);
  }

  snapshot() {
    return clone(this.state);
  }
}

module.exports = { Store, DEFAULT_STATE };
