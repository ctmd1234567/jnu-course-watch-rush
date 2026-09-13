const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('allows duplicate course tasks and returns both to the frontend', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jnu-course-test-'));
  process.env.JNU_RUNTIME_DIR = runtimeDir;
  const { startServer } = require('../src/server');
  const service = await startServer(0);
  const endpoint = `http://127.0.0.1:${service.port}/api/courses`;
  const payload = { courseNumber: '08060169', teachingClassId: '2627100562', mode: 'watch' };

  try {
    const externalOrigin = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com', Connection: 'close' },
      body: JSON.stringify(payload),
    });
    assert.equal(externalOrigin.status, 403);

    const invalidMode = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ ...payload, mode: 'unexpected' }),
    });
    assert.equal(invalidMode.status, 400);

    const invalidRush = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ courseNumber: '08060169', mode: 'rush', startAt: new Date(Date.now() + 60_000).toISOString() }),
    });
    assert.equal(invalidRush.status, 400);
    assert.match((await invalidRush.json()).error, /教学班号/);
    for (let index = 0; index < 2; index++) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
    }
    const stateResponse = await fetch(`http://127.0.0.1:${service.port}/api/state`, {
      headers: { Connection: 'close' },
    });
    assert.match(stateResponse.headers.get('content-security-policy'), /default-src 'self'/);
    const state = await stateResponse.json();
    assert.equal(state.courses.length, 2);
    assert.notEqual(state.courses[0].id, state.courses[1].id);
    assert.equal(Object.hasOwn(state.settings, 'rushRoundSeconds'), false);
    assert.equal(state.settings.rushActionGapMs, 0);

    const invalidSettings = await fetch(`http://127.0.0.1:${service.port}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ watchMinSeconds: 30, watchMaxSeconds: 20, rushActionGapMs: 0 }),
    });
    assert.equal(invalidSettings.status, 400);

    const invalidPortal = await fetch(`http://127.0.0.1:${service.port}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ portal: 'unknown', watchMinSeconds: 20, watchMaxSeconds: 30, rushActionGapMs: 0 }),
    });
    assert.equal(invalidPortal.status, 400);

    const freshmanSettings = await fetch(`http://127.0.0.1:${service.port}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ portal: 'freshman', watchMinSeconds: 20, watchMaxSeconds: 30, rushActionGapMs: 0 }),
    });
    assert.equal(freshmanSettings.status, 200);
    assert.equal((await freshmanSettings.json()).settings.portal, 'freshman');

    service.agent.runtime.running = true;
    const portalChangeWhileRunning = await fetch(`http://127.0.0.1:${service.port}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ portal: 'standard', watchMinSeconds: 20, watchMaxSeconds: 30, rushActionGapMs: 0 }),
    });
    assert.equal(portalChangeWhileRunning.status, 409);
    assert.match((await portalChangeWhileRunning.json()).error, /先停止任务/);
    service.agent.runtime.running = false;

    const stateAfterRejectedPortalChange = await fetch(`http://127.0.0.1:${service.port}/api/state`, {
      headers: { Connection: 'close' },
    });
    assert.equal((await stateAfterRejectedPortalChange.json()).settings.portal, 'freshman');

    const missingDelete = await fetch(`http://127.0.0.1:${service.port}/api/courses/not-found`, {
      method: 'DELETE',
      headers: { Connection: 'close' },
    });
    assert.equal(missingDelete.status, 404);

    const eventStream = await fetch(`http://127.0.0.1:${service.port}/api/events`, {
      headers: { Accept: 'text/event-stream', Connection: 'close' },
    });
    assert.equal(eventStream.status, 200);
    const shutdownStartedAt = Date.now();
    await service.shutdown();
    assert.ok(Date.now() - shutdownStartedAt < 3_000);
    await eventStream.body.cancel();
  } finally {
    await service.shutdown();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
