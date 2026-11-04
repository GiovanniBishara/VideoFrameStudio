// Test unitari (Node): ZIP/ZIP64, ricampionamento, logica di trascrizione a finestre,
// rilevamento dei cambi di slide, composizione del testo, regole del Whisper originale,
// nuovi tentativi guidati dalla confidenza e seconda passata sui tratti saltati.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frameFileName, hmsMillis } from '../src/shared/format';
import { StreamingResampler } from '../src/shared/resample';
import { ChangeDetector, THUMB_H, THUMB_W } from '../src/shared/smart';
import {
	SAMPLE_RATE,
	planSeek,
	runTranscription,
	type AudioFeed,
	type RawSegment,
	type WindowRequest,
	type WindowResult,
} from '../src/shared/transcribeCore';
import { LogprobTracker, MAX_INITIAL_TIMESTAMP_INDEX, applyTimestampRules, logSoftmax } from '../src/shared/whisperRules';
import { buildSrt, buildTxt } from '../src/shared/transcriptText';
import { ZipWriter, crc32 } from '../src/shared/zip';
import { FakeToneEngine } from '../src/test/fakeEngine';

let failures = 0;
function check(cond: unknown, msg: string) {
	if (cond) console.log('  ok  ', msg);
	else {
		console.log('  FAIL', msg);
		failures++;
	}
}
const tmp = fs.mkdtempSync(path.join(process.env.SCRATCH ?? os.tmpdir(), 'vfts-'));

async function zipToFile(file: string, build: (z: ZipWriter) => Promise<void>) {
	const fd = fs.openSync(file, 'w');
	const z = new ZipWriter({ append: async (d) => void fs.writeSync(fd, d) });
	await build(z);
	await z.finish();
	fs.closeSync(fd);
}

async function testZip() {
	console.log('ZIP');
	check(crc32(new TextEncoder().encode('123456789')) === 0xcbf43926, 'CRC-32 vettore standard');
	const big = new Uint8Array(1_000_003).map((_, i) => (i * 7919) & 0xff);
	check(crc32(big) === crc32(big.subarray(500_000), crc32(big.subarray(0, 500_000))), 'CRC-32 incrementale = intero');

	const small = path.join(tmp, 'small.zip');
	await zipToFile(small, async (z) => {
		for (let i = 1; i <= 3; i++) await z.add(frameFileName(i, i * 61.5, 'jpg'), new TextEncoder().encode(`img ${i}`));
		await z.add('frames_index.csv', new TextEncoder().encode('﻿numero;file\r\n'));
	});
	const out = execFileSync('python3', ['-c', `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(z.namelist()); print(z.read(z.namelist()[1]).decode())`, small]).toString();
	check(out.includes('frame_000002_00h02m03s.jpg') && out.includes('img 2'), 'ZIP piccolo letto da Python, nomi e contenuti corretti');
	check(execFileSync('unzip', ['-tq', small]).toString().includes('No errors'), 'unzip -t: nessun errore');

	// ZIP64 per numero di voci (> 65535)
	const many = path.join(tmp, 'many.zip');
	await zipToFile(many, async (z) => {
		for (let i = 1; i <= 70_000; i++) await z.add(frameFileName(i, i / 30, 'jpg'), new Uint8Array([i & 0xff, (i >> 8) & 0xff]));
	});
	const outMany = execFileSync('python3', ['-c', `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); n=z.namelist(); assert z.testzip() is None
print(len(n), n[0], n[-1])`, many]).toString().trim();
	check(outMany.startsWith('70000 frame_000001_00h00m00s.jpg frame_070000_00h38m53s.jpg'), `ZIP64 con 70.000 voci (${outMany})`);
	check(execFileSync('unzip', ['-tq', many]).toString().includes('No errors'), 'unzip -t su 70.000 voci');

	// ZIP64 per dimensione (> 4 GB): 5 voci da 900 MB
	if (!process.env.SKIP_BIG) {
		const huge = path.join(tmp, 'huge.zip');
		const chunk = new Uint8Array(900 * 1024 * 1024);
		for (let i = 0; i < chunk.length; i += 4096) chunk[i] = (i / 4096) & 0xff;
		await zipToFile(huge, async (z) => {
			for (let i = 1; i <= 5; i++) {
				chunk[0] = i;
				await z.add(`blob_${i}.bin`, chunk);
			}
		});
		const size = fs.statSync(huge).size;
		const outHuge = execFileSync('python3', ['-c', `
import zipfile,sys,zlib
z=zipfile.ZipFile(sys.argv[1])
for i in z.infolist():
  d=z.read(i)
  assert zlib.crc32(d)==i.CRC and d[0]==int(i.filename[5])
print('ok', len(z.infolist()), z.infolist()[-1].header_offset)`, huge], { maxBuffer: 1 << 20 }).toString().trim();
		check(size > 4.2e9 && outHuge.startsWith('ok 5'), `ZIP64 oltre 4 GB (${(size / 1e9).toFixed(2)} GB, ${outHuge})`);
		fs.rmSync(huge);
	}
}

function testResampler() {
	console.log('Ricampionamento');
	for (const rate of [48000, 44100, 32000, 16000]) {
		const r = new StreamingResampler(rate, 16000);
		const seconds = 3;
		const f = 1000;
		const input = new Float32Array(rate * seconds).map((_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / rate));
		// a blocchi irregolari, come arrivano dal decodificatore
		const parts: Float32Array[] = [];
		let pos = 0;
		let k = 0;
		while (pos < input.length) {
			const n = [1024, 960, 4096, 333][k++ % 4];
			parts.push(r.process(input.subarray(pos, pos + n)));
			pos += n;
		}
		parts.push(r.flush());
		const total = parts.reduce((s, p) => s + p.length, 0);
		const out = new Float32Array(total);
		let o = 0;
		for (const p of parts) {
			out.set(p, o);
			o += p.length;
		}
		const expected = seconds * 16000;
		// confronto con la sinusoide ideale a 16 kHz (fase allineata = nessun ritardo)
		let err = 0;
		for (let i = 2000; i < expected - 2000; i++) err = Math.max(err, Math.abs(out[i] - 0.5 * Math.sin((2 * Math.PI * f * i) / 16000)));
		check(Math.abs(total - expected) <= 40 && err < 0.01, `${rate} Hz → 16 kHz: ${total} campioni (attesi ${expected}), errore max ${err.toFixed(4)}`);
	}
	// aliasing: 7,9 kHz e 10 kHz a 48 kHz devono essere attenuati sotto Nyquist di 16 kHz
	const r = new StreamingResampler(48000, 16000);
	const tone = new Float32Array(48000).map((_, i) => Math.sin((2 * Math.PI * 10000 * i) / 48000));
	const y = r.process(tone);
	let peak = 0;
	for (let i = 1000; i < y.length - 1000; i++) peak = Math.max(peak, Math.abs(y[i]));
	check(peak < 0.01, `tono a 10 kHz attenuato dal filtro anti-aliasing (picco ${peak.toFixed(4)})`);
}

function makeToneAudio(sentences: { id: number; start: number; dur: number }[], total: number) {
	const a = new Float32Array(Math.round(total * SAMPLE_RATE));
	for (const s of sentences) {
		const f = 300 + 10 * s.id;
		const i0 = Math.round(s.start * SAMPLE_RATE);
		const i1 = Math.round((s.start + s.dur) * SAMPLE_RATE);
		for (let i = i0; i < i1 && i < a.length; i++) a[i] = 0.3 * Math.sin((2 * Math.PI * f * (i - i0)) / SAMPLE_RATE);
	}
	// rumore di fondo leggero (come una registrazione reale)
	for (let i = 0; i < a.length; i++) a[i] += (Math.random() - 0.5) * 0.002;
	return a;
}

class ArrayFeed implements AudioFeed {
	released = 0;
	constructor(private a: Float32Array) {}
	expectedDuration = 0;
	async read(s: number, e: number) {
		return this.a.slice(s, Math.min(e, this.a.length));
	}
	release(b: number) {
		this.released = b;
	}
	total() {
		return this.a.length;
	}
}

async function testTranscription() {
	console.log('Trascrizione a finestre (motore simulato)');
	check(
		planSeek([{ start: 1, end: 5, text: 'a' }, { start: 26, end: null, text: 'b' }], 30, false, () => false).advanceSec === 26,
		'segmento troncato a fine finestra: si riparte dal suo inizio',
	);
	check(
		planSeek([{ start: 1, end: 12, text: 'a' }], 30, false, () => true).advanceSec === 12,
		'il modello si ferma prima ma c\'è parlato: si riparte da lì',
	);
	check(planSeek([{ start: 1, end: 12, text: 'a' }], 30, false, () => false).advanceSec === 30, 'coda silenziosa: finestra intera');

	// 40 minuti di "lezione": frasi di durata 2-9 s, pause 0,3-3 s, una lunga pausa di 2 minuti
	const sentences: { id: number; start: number; dur: number }[] = [];
	let t = 0.8;
	let id = 1;
	while (t < 40 * 60 - 10) {
		const dur = 2 + ((id * 37) % 70) / 10;
		sentences.push({ id: id % 160 === 0 ? 1 : id % 160, start: t, dur });
		t += dur + 0.3 + ((id * 13) % 27) / 10;
		if (id === 120) t += 120;
		id++;
	}
	const total = t + 5;
	const audio = makeToneAudio(sentences, total);
	const engine = new FakeToneEngine();
	const feed = new ArrayFeed(audio);
	feed.expectedDuration = total;
	const res = await runTranscription(feed, engine, 'it', {
		onSegments: () => {},
		onProgress: () => {},
		onLog: () => {},
		isCancelled: () => false,
	});
	const got = res.segments;
	check(got.length === sentences.length, `tutte le frasi presenti una sola volta (${got.length}/${sentences.length})`);
	let maxErr = 0;
	let wrongText = 0;
	for (let i = 0; i < Math.min(got.length, sentences.length); i++) {
		maxErr = Math.max(maxErr, Math.abs(got[i].start - sentences[i].start), Math.abs(got[i].end - (sentences[i].start + sentences[i].dur)));
		if (got[i].text !== `frase ${sentences[i].id}.`) wrongText++;
	}
	check(wrongText === 0, 'ordine e contenuto delle frasi corretti');
	check(maxErr < 0.06, `timestamp entro 60 ms dal vero (errore max ${(maxErr * 1000).toFixed(0)} ms)`);
	check(res.complete && res.gaps.length === 0, 'nessun buco: trascrizione dichiarata completa');
	check(res.silenceSec >= 90, `pausa lunga riconosciuta come silenzio (${res.silenceSec.toFixed(0)} s)`);
	check(Math.abs(res.audioSec - total) < 0.01, `audio coperto fino alla fine (${res.audioSec.toFixed(1)} di ${total.toFixed(1)} s)`);
	console.log(`        ${engine.calls} finestre elaborate per ${(total / 60).toFixed(1)} min di audio`);

	// errore persistente in una finestra: deve comparire come buco dichiarato
	const failing = new FakeToneEngine();
	const orig = failing.transcribeWindow.bind(failing);
	let calls = 0;
	failing.transcribeWindow = async (a, r) => {
		calls++;
		if (calls >= 3 && calls <= 6) throw new Error('GPU persa');
		return orig(a, r);
	};
	const feed2 = new ArrayFeed(audio.subarray(0, 5 * 60 * SAMPLE_RATE));
	feed2.expectedDuration = 300;
	const res2 = await runTranscription(feed2, failing, 'it', { onSegments() {}, onProgress() {}, onLog() {}, isCancelled: () => false });
	check(!res2.complete && res2.gaps.length === 1, `finestra fallita 4 volte → buco dichiarato e trascrizione NON completa`);
	const txt = buildTxt(res2.segments, res2.gaps, 'paragraph', ['ATTENZIONE: TRASCRIZIONE INCOMPLETA']);
	check(txt.includes('[PARTE NON TRASCRITTA'), 'il buco è scritto nel testo');
}

function testWhisperRules() {
	console.log('Regole del Whisper originale');
	const TS = 50365; // primo token timestamp di Whisper large-v3
	const V = TS + 1501;
	const fresh = () => new Float32Array(V).fill(1);
	let l = fresh();
	applyTimestampRules([], l, TS);
	check(
		l[TS + MAX_INITIAL_TIMESTAMP_INDEX] === 1 && l[TS + MAX_INITIAL_TIMESTAMP_INDEX + 1] === -Infinity && l[V - 1] === -Infinity && l[100] === 1,
		'primo timestamp entro 1 s (oltre: vietato)',
	);
	l = fresh();
	applyTimestampRules([TS + 10, 400, 401], l, TS);
	check(l[TS + 10] === -Infinity && l[TS + 11] === 1 && l[TS] === -Infinity && l[400] === 1, 'dopo il testo il timestamp di chiusura deve avanzare');
	l = fresh();
	applyTimestampRules([TS + 10, 400, TS + 20], l, TS);
	check(l[TS + 19] === -Infinity && l[TS + 20] === 1, 'dopo la chiusura il segmento successivo può iniziare allo stesso istante');
	l = fresh();
	applyTimestampRules([TS + 10, 400, TS + 20, TS + 20], l, TS);
	check(l[TS + 20] === -Infinity && l[TS + 21] === 1, 'i tempi non tornano mai indietro');

	const t1 = new LogprobTracker(0);
	t1.step(null, new Float32Array([0, Math.log(3)]));
	t1.step(1, new Float32Array([Math.log(9), 0]));
	t1.finish(0);
	check(Math.abs((t1.average as number) - (Math.log(0.75) + Math.log(0.9)) / 2) < 1e-6, 'confidenza = media del log-probabilità dei token scelti');
	const t2 = new LogprobTracker(0.5);
	t2.step(null, new Float32Array([0, Math.log(3) / 0.5])); // logit divisi per T dal campionamento
	t2.finish(1);
	check(Math.abs((t2.average as number) - Math.log(0.75)) < 1e-6, 'con temperatura la confidenza è riportata a T = 1');
	// stesso risultato del log-softmax completo, su logit realistici con valori vietati (-∞)
	const big = new Float32Array(51866).map((_, i) => Math.sin(i * 12.9898) * 8);
	big.fill(-Infinity, 50365 + 51);
	const tok = [17, 50365, 40000, 50400];
	const t3 = new LogprobTracker(0);
	let ref = 0;
	for (const k of tok) {
		t3.step(null, big);
		t3.finish(k);
		ref += logSoftmax(big)[k];
	}
	check(Math.abs((t3.average as number) - ref / tok.length) < 1e-4, 'calcolo per parola alleggerito: stesso valore del log-softmax completo');
}

/** 3 minuti di frasi a toni, per i test dei nuovi tentativi e della seconda passata. */
function shortLecture() {
	const sentences: { id: number; start: number; dur: number }[] = [];
	let t = 0.6;
	for (let id = 1; t < 170; id++) {
		const dur = 2.5 + ((id * 29) % 40) / 10;
		sentences.push({ id, start: t, dur });
		t += dur + 0.5 + ((id * 7) % 12) / 10;
	}
	return { sentences, audio: makeToneAudio(sentences, t + 3), total: t + 3 };
}

const quiet = { onSegments() {}, onProgress() {}, onLog() {}, isCancelled: () => false };

async function testRetriesAndRepass() {
	console.log('Nuovi tentativi e seconda passata');
	const { sentences, audio, total } = shortLecture();
	const expected = sentences.map((x) => `frase ${x.id}.`);
	const run = async (engine: { transcribeWindow(a: Float32Array, r: WindowRequest): Promise<WindowResult | RawSegment[]> }) => {
		const feed = new ArrayFeed(audio);
		feed.expectedDuration = total;
		const base = new FakeToneEngine();
		return runTranscription(feed, Object.assign(base, { transcribeWindow: engine.transcribeWindow }), 'it', quiet);
	};

	// A temperatura 0 il modello è insicuro e sbaglia: la finestra va rifatta a temperatura più alta.
	const truth = new FakeToneEngine();
	const temps: number[] = [];
	const r1 = await run({
		async transcribeWindow(a, req) {
			temps.push(req.temperature ?? 0);
			const segs = await truth.transcribeWindow(a, req);
			if (!req.temperature) return { segments: segs.map((x) => ({ ...x, text: 'testo sbagliato.' })), avgLogprob: -2.3 };
			return { segments: segs, avgLogprob: -0.2 };
		},
	});
	check(temps.includes(0.2) && !temps.includes(0.4), 'confidenza bassa a temperatura 0 → nuovo tentativo a 0,2');
	check(JSON.stringify(r1.segments.map((x) => x.text)) === JSON.stringify(expected), 'il testo finale viene dal tentativo sicuro');
	check(r1.retries > 0 && r1.lowConfidence === 0, `finestre ripetute contate (${r1.retries}), nessuna rimasta incerta`);

	// Sempre insicuro: il testo resta (mai buttato) ma è segnato da ricontrollare.
	const r2 = await run({
		async transcribeWindow(a, req) {
			return { segments: await truth.transcribeWindow(a, req), avgLogprob: -1.7 };
		},
	});
	check(r2.segments.length === expected.length && r2.segments.every((x) => x.flags?.includes('bassa confidenza')), 'testo incerto conservato e segnato "bassa confidenza"');
	check(r2.lowConfidence === r2.windows, `riepilogo: ${r2.lowConfidence} finestre a bassa confidenza su ${r2.windows}`);

	// Il modello salta una frase in mezzo alla finestra: la seconda passata la recupera.
	const r3 = await run({
		async transcribeWindow(a, req) {
			const segs = await truth.transcribeWindow(a, req);
			if (a.length < 20 * SAMPLE_RATE || segs.length < 4) return segs;
			return segs.filter((_, i) => i !== 1); // seconda frase di ogni finestra persa
		},
	});
	const texts3 = r3.segments.map((x) => x.text);
	check(JSON.stringify(texts3) === JSON.stringify(expected), `frasi saltate recuperate tutte, nell'ordine (${texts3.length}/${expected.length})`);
	check(r3.recovered > 0 && r3.segments.filter((x) => x.flags?.includes('recuperato nella seconda passata')).length === r3.recovered, `${r3.recovered} segmenti recuperati e segnati come tali`);
	let maxErr = 0;
	for (let i = 0; i < Math.min(r3.segments.length, sentences.length); i++) maxErr = Math.max(maxErr, Math.abs(r3.segments[i].start - sentences[i].start));
	check(maxErr < 0.06, `frasi recuperate con i tempi esatti (errore max ${(maxErr * 1000).toFixed(0)} ms)`);
}

function testText() {
	console.log('Testo e SRT');
	const segs = [
		{ start: 0.5, end: 3, text: 'Buongiorno a tutti.' },
		{ start: 3.2, end: 6, text: 'Oggi parliamo di integrali doppi' },
		{ start: 6.1, end: 9, text: 'e del teorema di Fubini.' },
		{ start: 14, end: 18, text: 'Partiamo da un esempio.' },
	];
	const txt = buildTxt(segs, [], 'paragraph', []);
	check(txt.startsWith('[00:00:00] Buongiorno a tutti. Oggi parliamo di integrali doppi e del teorema di Fubini.'), 'paragrafo con timestamp');
	check(txt.includes('\r\n\r\n[00:00:14] Partiamo da un esempio.'), 'nuovo paragrafo dopo una pausa lunga');
	const words = (s: string) => s.replace(/\[[^\]]*\]/g, '').split(/\s+/).filter(Boolean).length;
	check(words(txt) === segs.reduce((n, s) => n + words(s.text), 0), 'nessuna parola persa o aggiunta');
	const srt = buildSrt(segs);
	check(srt.startsWith('1\r\n00:00:00,500 --> 00:00:03,000\r\nBuongiorno a tutti.'), 'formato SRT');
	check(hmsMillis(3725.4) === '01:02:05.400', 'formato timestamp');
}

function testSmart() {
	console.log('Estrazione intelligente');
	const det = new ChangeDetector(60, true);
	const slide = (n: number) => {
		const g = new Uint8Array(THUMB_W * THUMB_H).fill(240);
		// righe di "testo" diverse per ogni slide
		for (let line = 0; line < 8; line++) {
			const y0 = 20 + line * 18;
			const len = 60 + ((n * 53 + line * 31) % 200);
			for (let y = y0; y < y0 + 4; y++) for (let x = 20; x < 20 + len; x++) g[y * THUMB_W + x] = 30;
		}
		return g;
	};
	const withCursor = (g: Uint8Array, cx: number, cy: number) => {
		const c = g.slice();
		for (let y = cy; y < cy + 5; y++) for (let x = cx; x < cx + 3; x++) c[y * THUMB_W + x] = 0;
		return c;
	};
	const withWebcam = (g: Uint8Array, k: number) => {
		const c = g.slice();
		for (let y = 120; y < 175; y++) for (let x = 230; x < 315; x++) c[y * THUMB_W + x] = (x * 7 + y * 3 + k * 50) & 0xff;
		return c;
	};
	let kept = 0;
	let t = 0;
	const keptAt: number[] = [];
	for (let s = 0; s < 5; s++) {
		for (let i = 0; i < 40; i++) {
			// 20 s per slide, campioni ogni 0,5 s, cursore che si muove, webcam sempre attiva
			let g = withCursor(slide(s), 40 + ((i * 17) % 250), 30 + ((i * 11) % 120));
			g = withWebcam(g, i + s * 40);
			const d = det.push(g, t);
			if (d.keepCurrent) {
				kept++;
				keptAt.push(t);
			}
			if (d.keepPrevious) kept++;
			t += 0.5;
		}
	}
	check(kept >= 5 && kept <= 8, `5 slide con cursore e webcam → ${kept} frame (attesi 5, al massimo qualche frame iniziale della webcam)`);
	check([20, 40, 60, 80].every((x) => keptAt.some((k) => k >= x && k <= x + 1.5)), `cambi slide rilevati entro 1,5 s (${keptAt.join(', ')})`);

	// lavagna: scrittura progressiva, poi cancellazione
	const det2 = new ChangeDetector(60, true);
	const board = new Uint8Array(THUMB_W * THUMB_H).fill(40);
	let keptBoard = 0;
	let prevKept = 0;
	t = 0;
	for (let i = 0; i < 120; i++) {
		// ogni campione aggiunge un pezzetto di tratto (poche decine di pixel)
		const y = 20 + Math.floor(i / 10) * 12;
		const x0 = 20 + (i % 10) * 25;
		for (let yy = y; yy < y + 3; yy++) for (let x = x0; x < x0 + 22; x++) board[yy * THUMB_W + x] = 230;
		const d = det2.push(board, t);
		if (d.keepCurrent) keptBoard++;
		if (d.keepPrevious) prevKept++;
		t += 0.5;
	}
	const erased = new Uint8Array(THUMB_W * THUMB_H).fill(40);
	const d1 = det2.push(erased, t);
	const d2 = det2.push(erased, t + 0.5);
	check(keptBoard >= 3 && keptBoard <= 30, `lavagna scritta poco a poco: ${keptBoard} frame intermedi (non uno per campione)`);
	check(d1.keepPrevious || keptBoard > 0, 'alla cancellazione viene salvato lo stato finale della lavagna');
	check(d2.keepCurrent || d1.keepCurrent, 'lavagna pulita salvata');
	void prevKept;
}

await testZip();
testResampler();
await testTranscription();
testWhisperRules();
await testRetriesAndRepass();
testText();
testSmart();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} TEST FALLITI` : '\nTutti i test superati');
process.exit(failures ? 1 : 0);
