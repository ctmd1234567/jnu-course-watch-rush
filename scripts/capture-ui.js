const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

async function main() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!executablePath) throw new Error('找不到 Edge/Chrome');
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:3210', { waitUntil: 'networkidle' });
  const output = path.resolve(__dirname, '..', 'docs', 'dashboard.png');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  await browser.close();
  console.log(output);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
