const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');

test('falls back to copy when Windows reports EXDEV during state replacement', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jnu-store-test-'));
  const filePath = path.join(directory, 'state.json');
  const store = new Store(filePath);
  store.state.courses.push({ id: 'saved-course', courseNumber: '08060169' });
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const error = new Error('cross-device link not permitted');
    error.code = 'EXDEV';
    throw error;
  };
  try {
    store.save();
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).courses[0].id, 'saved-course');
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('falls back to copy when Windows temporarily denies state replacement', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jnu-store-locked-'));
  const filePath = path.join(directory, 'state.json');
  const store = new Store(filePath);
  store.state.courses.push({ id: 'locked-course', courseNumber: '08060230' });
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  try {
    store.save();
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).courses[0].id, 'locked-course');
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('uses safe defaults when the state file is malformed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jnu-store-corrupt-'));
  const filePath = path.join(directory, 'state.json');
  fs.writeFileSync(filePath, '{not-json', 'utf8');
  const originalWarn = console.warn;
  console.warn = () => {};
  let store;
  try {
    store = new Store(filePath);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(store.state.courses, []);
  assert.equal(store.state.settings.watchMinSeconds, 20);
  store.save();
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).courses, []);
  fs.rmSync(directory, { recursive: true, force: true });
});
