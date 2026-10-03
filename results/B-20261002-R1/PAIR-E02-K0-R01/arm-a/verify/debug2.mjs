import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require('C:/Users/caosh/AppData/Local/npm-cache/_npx/bd29c0cb7c2b284c/node_modules/playwright-core');
const CHROME = 'C:/Users/caosh/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
(async () => {
    const browser = await pw.chromium.launch({ headless: true, executablePath: CHROME });
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const msgs = [];
    page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
    page.on('pageerror', (e) => msgs.push('[pageerror] ' + String(e.message).slice(0, 300)));
    await page.goto('http://127.0.0.1:7102/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const info = await page.evaluate(() => {
        const d = window.__e02Debug;
        if (!d) return { err: 'no debug hook' };
        const om = d.oceanMat, sm = d.skyMat;
        const passInfo = (m) => {
            if (!m) return null;
            const p = m.passes && m.passes[0];
            return {
                effectName: m.effectName,
                passCount: (m.passes || []).length,
                program: p && p.program,
                getHandleTime: p && typeof p.getHandle === 'function',
                propTime: m.getProperty ? m.getProperty('u_time') : 'n/a',
                propSun: m.getProperty ? m.getProperty('u_sunDir') : 'n/a',
            };
        };
        return { ocean: passInfo(om), sky: passInfo(sm) };
    });
    console.log('MATERIALS:', JSON.stringify(info, null, 1));
    console.log('CONSOLE:\n' + msgs.join('\n'));
    await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
