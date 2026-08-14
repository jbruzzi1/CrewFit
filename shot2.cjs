const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.goto('http://localhost:8099/_mock_save_workout.html', { waitUntil: 'networkidle' });
  // simulate selected media
  await page.evaluate(() => {
    const t = document.getElementById('thumbs');
    const mk = (label, bg) => { const d=document.createElement('div'); d.className='thumb'; d.style.background=bg; d.innerHTML=label+'<span class="x">✕</span>'; t.appendChild(d); };
    mk('📷', '#cfe3ff'); mk('📷', '#d6f0d6'); mk('🎬', '#ffe2c2');
    document.getElementById('tabNote').style.display='block';
  });
  await page.screenshot({ path: '/tmp/mock_save3.png', fullPage: true });
  await browser.close();
  console.log('saved /tmp/mock_save3.png');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
