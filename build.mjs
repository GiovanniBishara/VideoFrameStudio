// Build con esbuild (lo stesso compilatore usato internamente da Vite).
//   node build.mjs           -> dist/                     sito statico da pubblicare (GitHub Pages, Netlify, Cloudflare Pages…)
//   node build.mjs --single  -> dist-single/VideoFrameStudio.html   un solo file da aprire con doppio clic
//   node build.mjs --test    -> dist-test/                include il motore finto usato dai test automatici
//   node build.mjs --serve   -> server locale su http://localhost:5173
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const test = process.argv.includes('--test');
const single = process.argv.includes('--single');
const serve = process.argv.includes('--serve');
const outdir = test ? 'dist-test' : single ? 'dist-single' : 'dist';

const alias = {};
if (process.env.MEDIABUNNY_SRC) alias.mediabunny = process.env.MEDIABUNNY_SRC;

const common = {
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: ['chrome113', 'edge113'],
	minify: !test,
	sourcemap: test ? 'inline' : false,
	legalComments: 'eof',
	alias,
	nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [],
	logLevel: 'warning',
	logOverride: { 'import-is-undefined': 'silent', 'empty-import-meta': 'silent' },
	jsx: 'automatic',
	loader: { '.css': 'css' },
};
const defines = (inlineWorkers) => ({
	__TEST_BUILD__: test ? 'true' : 'false',
	__INLINE_WORKERS__: inlineWorkers ? JSON.stringify(inlineWorkers) : 'null',
	'process.env.NODE_ENV': '"production"',
});

const workers = {
	'frames.worker': 'src/workers/frames.worker.ts',
	'encoder.worker': 'src/workers/encoder.worker.ts',
	'transcribe.worker': 'src/workers/transcribe.worker.ts',
	'compress.worker': 'src/workers/compress.worker.ts',
};

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
const template = fs.readFileSync('index.html', 'utf8');

function checkNoTestCode(code, where) {
	if (!test && (code.includes('FakeToneEngine') || code.includes('motore di test'))) {
		throw new Error(`Codice di test finito nella build pubblicata (${where})`);
	}
}

if (single) {
	// 1) worker come stringhe
	const inline = {};
	for (const [name, entry] of Object.entries(workers)) {
		// worker classici (IIFE): da una pagina aperta da disco Chrome non accetta worker-modulo da blob
		const r = await esbuild.build({ ...common, format: 'iife', define: defines({}), entryPoints: [entry], write: false, outfile: `${name}.js` });
		inline[name] = r.outputFiles[0].text;
		checkNoTestCode(inline[name], name);
	}
	// 2) app con i worker incorporati
	const r = await esbuild.build({
		...common,
		define: defines(inline),
		entryPoints: { app: 'src/main.tsx' },
		write: false,
		outdir: 'out',
	});
	const js = r.outputFiles.find((f) => f.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
	const css = r.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
	const html = template
		.replace('<!--STYLE-->', () => `<style>\n${css}</style>`)
		.replace('<!--SCRIPT-->', () => `<script type="module">\n${js}</script>`);
	fs.writeFileSync(path.join(outdir, 'VideoFrameStudio.html'), html);
	console.log(`${outdir}/VideoFrameStudio.html: ${(html.length / 1024).toFixed(0)} KB`);
} else {
	fs.mkdirSync(path.join(outdir, 'assets'), { recursive: true });
	const options = {
		...common,
		define: defines(null),
		entryPoints: { app: 'src/main.tsx', ...workers },
		outdir: path.join(outdir, 'assets'),
	};
	const html = template
		.replace('<!--STYLE-->', '<link rel="stylesheet" href="assets/app.css" />')
		.replace('<!--SCRIPT-->', '<script type="module" src="assets/app.js"></script>');
	fs.writeFileSync(path.join(outdir, 'index.html'), html);
	if (serve) {
		const ctx = await esbuild.context(options);
		await ctx.watch();
		const { port } = await ctx.serve({ servedir: outdir, port: 5173 });
		console.log(`Server locale: http://localhost:${port}`);
	} else {
		await esbuild.build(options);
		for (const name of Object.keys(workers)) {
			checkNoTestCode(fs.readFileSync(path.join(outdir, 'assets', `${name}.js`), 'utf8'), name);
		}
		console.log(`Build completata in ${outdir}/`);
	}
}
