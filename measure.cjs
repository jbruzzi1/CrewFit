const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.goto('http://localhost:8099/_mock_save_workout.html', { waitUntil: 'networkidle' });
  await page.screenshot({ path: '/tmp/mock_save9.png', fullPage: true });
  const m = await page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),cx:Math.round(b.x+b.width/2),cy:Math.round(b.y+b.height/2)}; };
    const card = document.querySelector('.card.center-v');
    const line = document.querySelector('.media-line');
    const badge = document.querySelector('.am-plus');
    const cr = r(card), lr = r(line), br = r(badge);
    return {
      card: cr, line: lr, badge: br,
      lineOffsetX: lr.cx - cr.cx,            // 0 = horizontally centered in card
      lineOffsetY: lr.cy - cr.cy,            // 0 = vertically centered in card
      badgePlusCentered: { bx: br.w/2, by: br.h/2, note:'badge is 20px; + should sit at center 10,10' }
    };
  });
  console.log(JSON.stringify(m, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
