// Test end-to-end nel vero Chrome (headless) con Playwright:
// carica un video, avvia l'elaborazione dall'interfaccia, scarica i risultati
// con i pulsanti e li salva per la verifica (tests/verify.py).
//
// uso: node tests/browser.test.mjs <url-app> <video> <cartella-output> <scenario>
//   scenari: all | interval | smart | compress | large
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? 'playwright');

const [url, video, outDir, scenario = 'all'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
	executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
	headless: true,
	args: ['--no-sandbox', '--enable-unsafe-webgpu'],
});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
	if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(url);
const caps = await page.evaluate(async () => ({
	avcDecode: (await VideoDecoder.isConfigSupported({ codec: 'avc1.64001f', codedWidth: 1280, codedHeight: 720 })).supported,
	avcEncodeSw: (await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1280, height: 720, bitrate: 2e6 })).supported,
	cores: navigator.hardwareConcurrency,
}));
console.log('Chrome:', await browser.version(), JSON.stringify(caps));
await page.setInputFiles('#file-input', video);
await page.waitForSelector('.slate dd', { timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('.slate')?.textContent?.includes('…'), null, { timeout: 120000 });
console.log('Slate:', (await page.textContent('.slate')).replace(/\s+/g, ' '));

const setChecked = async (sel, v) => {
	const el = page.locator(sel);
	if ((await el.isChecked()) !== v) await el.click({ force: true });
};

// configurazione per scenario
await setChecked('#toggle-estrazione-frame', ['all', 'interval', 'smart', 'large'].includes(scenario));
await setChecked('#toggle-trascrizione', ['all', 'large', 'smart'].includes(scenario));
await setChecked('#toggle-comprimi-video', ['compress', 'all'].includes(scenario));
if (scenario === 'all') await page.click('text=Tutti i frame');
if (scenario === 'interval' || scenario === 'large') {
	await page.click('text=A intervallo');
	await page.fill('#interval', scenario === 'large' ? '2' : '0.5');
}
if (scenario === 'smart') await page.click('text=Intelligente');
if (['compress', 'all'].includes(scenario)) {
	await page.fill('#target', process.env.TARGET_MB ?? '4');
	if (await page.locator('#allow-sw').count()) await setChecked('#allow-sw', true);
}
if (process.env.MEMORY) await page.click('#out-opfs');
await page.screenshot({ path: path.join(outDir, `ui-${scenario}-before.png`), fullPage: true });

const t0 = Date.now();
await page.click('text=AVVIA ELABORAZIONE');
// attende la fine di tutti i lavori
await page.waitForFunction(
	() => {
		const pills = [...document.querySelectorAll('.job .pill')];
		return pills.length > 0 && pills.every((p) => !p.closest('.job').classList.contains('running') && !p.closest('.job').classList.contains('waiting'));
	},
	null,
	{ timeout: Number(process.env.TIMEOUT_MS ?? 3_600_000), polling: 1000 },
);
const elapsed = (Date.now() - t0) / 1000;
await page.screenshot({ path: path.join(outDir, `ui-${scenario}-after.png`), fullPage: true });

const jobs = await page.$$eval('.job', (els) =>
	els.map((e) => ({
		name: e.querySelector('h3')?.textContent,
		status: e.className,
		summary: e.querySelector('.summary')?.textContent ?? '',
		error: e.querySelector('.error-text')?.textContent ?? '',
	})),
);
console.log(`Elaborazione terminata in ${elapsed.toFixed(1)} s`);
for (const j of jobs) console.log(` - ${j.name} [${j.status}] ${j.summary} ${j.error}`);

// scarica ogni risultato con il suo pulsante
const buttons = await page.$$('button.download');
const files = [];
for (const b of buttons) {
	const [dl] = await Promise.all([page.waitForEvent('download'), b.click()]);
	const dest = path.join(outDir, dl.suggestedFilename());
	await dl.saveAs(dest);
	files.push({ name: dl.suggestedFilename(), bytes: fs.statSync(dest).size });
}
console.log('Scaricati:', JSON.stringify(files));
const log = await page.$$eval('.log li', (els) => els.map((e) => e.textContent));
fs.writeFileSync(path.join(outDir, `result-${scenario}.json`), JSON.stringify({ elapsed, jobs, files, log, consoleErrors }, null, 2));
if (consoleErrors.length) console.log('Errori console:', consoleErrors.slice(0, 10));
await browser.close();
