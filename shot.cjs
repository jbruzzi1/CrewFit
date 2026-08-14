const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const url = process.argv[2] || 'http://localhost:8099/_mock_save_workout.html';
  const out = process.argv[3] || '/tmp/mock_shot.png';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log('saved', out);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
