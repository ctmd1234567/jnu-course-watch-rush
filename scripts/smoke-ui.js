const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');

async function main() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:3210', { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#rushTimeField').isHidden(), true);
  assert.equal(await page.locator('.automation-banner').isVisible(), true);
  assert.match(await page.locator('.automation-banner').innerText(), /额外打开.*Microsoft Edge/);
  assert.equal(await page.locator('#diagnosticPanel').isVisible(), true);
  assert.equal(await page.locator('.health-step').count(), 4);
  assert.equal(await page.locator('#copyDiagnostic').isVisible(), true);
  assert.equal(await page.locator('#courseFormMessage').isHidden(), true);
  await page.locator('.mode-card.rush').click();
  assert.equal(await page.locator('#rushTimeField').isVisible(), true);
  assert.equal(await page.locator('#rushTimeField input').getAttribute('required'), '');
  assert.equal(await page.locator('[name="teachingClassId"]').getAttribute('required'), '');
  assert.match(await page.locator('#teachingClassRequirement').innerText(), /抢课必填/);
  assert.equal(await page.locator('[name="rushRoundSeconds"]').count(), 0);
  assert.ok(Number(await page.locator('[name="rushActionGapMs"]').inputValue()) >= 0);
  assert.equal(await page.locator('[name="rushActionGapMs"]').getAttribute('min'), null);
  assert.equal(await page.locator('[name="rushActionGapMs"]').getAttribute('max'), null);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('UI smoke test passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
