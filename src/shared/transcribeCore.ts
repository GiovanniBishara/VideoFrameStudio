// Logica di trascrizione indipendente dal modello: finestre da 30 s con
// avanzamento "a seek" come l'algoritmo originale di Whisper. La finestra
// successiva riparte dall'inizio dell'ultimo segmento incompleto, quindi le
// finestre si sovrappongono dove serve e nessun segmento viene trascritto due
// volte né tagliato a metà parola. Ogni secondo dell'audio finisce o nel testo
// o in una zona classificata come silenzio, o (in caso di errore) in un buco
// dichiarato esplicitamente.
//
// Come nel Whisper originale ogni finestra può essere rifatta a temperatura più alta
// (0 → 0,2 → 0,4) quando il testo si ripete, ricalca il prompt o la confidenza media è
// bassa. Dopo la prima lettura, i tratti con voce chiara rimasti senza testo vengono
// ritrascritti da soli (seconda passata) e inseriti al loro posto.

import type { TranscriptGap, TranscriptSegment } from './types';

export const SAMPLE_RATE = 16000;
export const WINDOW_SEC = 30;
const FRAME = SAMPLE_RATE / 10; // 100 ms
/** Soglia di silenzio (dBFS) sui frame da 100 ms. */
export const SILENCE_DB = -50;

export interface RawSegment {
	start: number; // secondi, relativi alla finestra
	end: number | null; // null = segmento non chiuso dal modello
	text: string;
}

export interface WindowRequest {
	language: string;
	usePrompt: boolean;
	/** 0 = decodifica normale, 1 = anti-ripetizione. */
	attempt: number;
	/** Temperatura di campionamento: 0 = decodifica deterministica. */
	temperature?: number;
}

export interface WindowResult {
	segments: RawSegment[];
	/** Media del log-probabilità dei token (null se il motore non la misura). */
	avgLogprob: number | null;
}

export interface AsrEngine {
	/** Un motore può restituire solo i segmenti (senza confidenza). */
	transcribeWindow(audio: Float32Array, req: WindowRequest): Promise<WindowResult | RawSegment[]>;
	detectLanguage(audio: Float32Array): Promise<string | null>;
	/** Il prompt di contesto è supportato e impostato. */
	hasPrompt: boolean;
	/** Testo del prompt, per riconoscere eventuali "fughe" del contesto nel testo. */
	promptText: string;
	/** Prova a passare a un dispositivo alternativo dopo un errore (es. WebGPU → WASM). */
	fallback?(): Promise<boolean>;
}

/** Sorgente audio 16 kHz mono con indirizzamento assoluto e lettura progressiva. */
export interface AudioFeed {
	/** Restituisce i campioni [start, end); attende che siano decodificati. Più corto a fine flusso. */
	read(start: number, end: number): Promise<Float32Array>;
	/** Libera i campioni prima di `before`. */
	release(before: number): void;
	/** Numero totale di campioni, noto solo a fine decodifica. */
	total(): number | null;
	/** Durata attesa (dai metadati) in secondi, per l'avanzamento. */
	expectedDuration: number;
}

// --- analisi energia ---------------------------------------------------------

export function frameDb(audio: Float32Array): Float32Array {
	const n = Math.max(1, Math.floor(audio.length / FRAME));
	const out = new Float32Array(n);
	for (let f = 0; f < n; f++) {
		let s = 0;
		const a = f * FRAME;
		const b = Math.min(audio.length, a + FRAME);
		for (let i = a; i < b; i++) s += audio[i] * audio[i];
		const rms = Math.sqrt(s / Math.max(1, b - a));
		out[f] = 20 * Math.log10(rms + 1e-9);
	}
	return out;
}

export function percentile(values: Float32Array | number[], p: number): number {
	if (values.length === 0) return -Infinity;
	const arr = Array.from(values).sort((a, b) => a - b);
	const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((p / 100) * (arr.length - 1))));
	return arr[idx];
}

export function spanDb(db: Float32Array, fromSec: number, toSec: number, p = 90): number {
	const a = Math.max(0, Math.floor(fromSec * 10));
	const b = Math.min(db.length, Math.ceil(toSec * 10));
	if (b <= a) return -Infinity;
	return percentile(db.subarray(a, b), p);
}

// --- decisione di avanzamento ----------------------------------------------

const MIN_ADVANCE = 1.0;
const END_MARGIN = 1.0;
const MIN_SPLIT_ADVANCE = 5.0;

export interface SeekPlan {
	keep: { start: number; end: number; text: string }[];
	advanceSec: number;
	note?: string;
}

export function planSeek(
	segments: RawSegment[],
	winLenSec: number,
	isLast: boolean,
	tailHasSpeech: (from: number, to: number) => boolean,
): SeekPlan {
	const segs = segments
		.filter((s) => s.start < winLenSec - 0.05 && s.text.trim().length > 0)
		.sort((a, b) => a.start - b.start);
	const close = (s: RawSegment) => ({
		start: s.start,
		end: Math.min(winLenSec, Math.max(s.start, s.end ?? winLenSec)),
		text: s.text,
	});
	if (isLast) return { keep: segs.map(close), advanceSec: winLenSec };
	if (segs.length === 0) return { keep: [], advanceSec: winLenSec, note: 'nessun testo riconosciuto' };
	const last = segs[segs.length - 1];
	const incomplete = last.end === null || last.end > winLenSec - END_MARGIN;
	if (incomplete) {
		if (last.start >= MIN_SPLIT_ADVANCE) {
			return { keep: segs.slice(0, -1).map(close), advanceSec: last.start };
		}
		// Un unico segmento lungo occupa quasi tutta la finestra: lo si accetta.
		return { keep: segs.map(close), advanceSec: winLenSec };
	}
	const lastEnd = last.end as number;
	if (winLenSec - lastEnd > 3 && tailHasSpeech(lastEnd, winLenSec)) {
		// Il modello si è fermato prima della fine ma c'è ancora parlato: si riparte da lì.
		return { keep: segs.map(close), advanceSec: Math.max(MIN_ADVANCE, lastEnd) };
	}
	return { keep: segs.map(close), advanceSec: winLenSec };
}

// --- controlli di qualità ---------------------------------------------------

/** Rapporto di compressione del testo (come in Whisper): > 2,4 indica ripetizioni anomale. */
export async function compressionRatio(text: string): Promise<number> {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length < 40) return 1;
	const cs = new CompressionStream('deflate-raw');
	const stream = new Blob([bytes]).stream().pipeThrough(cs);
	const compressed = await new Response(stream).arrayBuffer();
	return bytes.length / Math.max(1, compressed.byteLength);
}

const KNOWN_SILENCE_HALLUCINATIONS = [
	/sottotitoli (creati|e revisione|a cura)/i,
	/amara\.org/i,
	/qtss/i,
	/grazie per (la visione|l'attenzione|aver guardato)\.?$/i,
	/iscriviti al canale/i,
	/thanks? (you )?for watching/i,
	/subtitles by/i,
	/^\s*\[?(musica|music|applausi)\]?\s*$/i,
];

export function looksLikeSilenceHallucination(text: string): boolean {
	return KNOWN_SILENCE_HALLUCINATIONS.some((r) => r.test(text.trim()));
}

function normalize(s: string) {
	return s
		.toLowerCase()
		.replace(/[^\p{L}\p{N} ]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function looksLikePromptLeak(text: string, prompt: string): boolean {
	if (!prompt) return false;
	const t = normalize(text);
	const p = normalize(prompt);
	return t.length >= 15 && p.includes(t);
}

// --- tentativi a temperatura crescente (come il Whisper originale) -----------------

/** Temperature dei tentativi successivi. */
export const TEMPERATURES = [0, 0.2, 0.4];
/** Sotto questa confidenza media la finestra viene rifatta (logprob_threshold di Whisper). */
export const LOGPROB_THRESHOLD = -1;
/** Oltre questo rapporto di compressione il testo è ripetitivo (compression_ratio_threshold). */
export const COMPRESSION_RATIO_THRESHOLD = 2.4;
/** Seconda passata: secondi minimi di voce senza testo per ritrascrivere un tratto. */
const REPASS_MIN_SPEECH_SEC = 1.5;
/** Seconda passata: tratti al massimo per finestra (i più lunghi). */
const REPASS_MAX_SPANS = 3;
/** Silenzio iniziale oltre il quale la finestra viene fatta partire dalla voce. */
const LEADING_SILENCE_SKIP_SEC = 2;
/** Ogni quanti secondi di audio scrivere nel registro la velocità misurata. */
const SPEED_LOG_EVERY_SEC = 600;

function asWindowResult(r: WindowResult | RawSegment[]): WindowResult {
	return Array.isArray(r) ? { segments: r, avgLogprob: null } : r;
}

interface Attempt {
	res: WindowResult;
	ratio: number;
	leak: boolean;
	lowConf: boolean;
}

interface AttemptOutcome {
	chosen: Attempt;
	attempts: number;
	firstMs: number;
	retryMs: number;
}

/**
 * Trascrive una finestra con i nuovi tentativi del Whisper originale. Se nessun tentativo
 * supera i controlli, sceglie il migliore: niente testo copiato dal prompt, niente
 * ripetizioni, poi la confidenza più alta.
 */
async function transcribeWithRetries(
	engine: AsrEngine,
	audio: Float32Array,
	language: string,
	startSec: number,
	cb: CoreCallbacks,
): Promise<AttemptOutcome> {
	let usePrompt = engine.hasPrompt;
	let antiRepeat = false;
	const tried: Attempt[] = [];
	let firstMs = 0;
	let retryMs = 0;
	for (let k = 0; k < TEMPERATURES.length; k++) {
		const t0 = performance.now();
		const res = asWindowResult(
			await engine.transcribeWindow(audio, { language, usePrompt, attempt: antiRepeat ? 1 : 0, temperature: TEMPERATURES[k] }),
		);
		if (k === 0) firstMs += performance.now() - t0;
		else retryMs += performance.now() - t0;
		const text = res.segments.map((s) => s.text).join(' ');
		const ratio = await compressionRatio(text);
		const leak = usePrompt && res.segments.some((s) => looksLikePromptLeak(s.text, engine.promptText));
		const lowConf = res.avgLogprob !== null && res.avgLogprob < LOGPROB_THRESHOLD && text.trim().length > 0;
		const attempt: Attempt = { res, ratio, leak, lowConf };
		tried.push(attempt);
		if (ratio <= COMPRESSION_RATIO_THRESHOLD && !leak && !lowConf) return { chosen: attempt, attempts: k + 1, firstMs, retryMs };
		if (k < TEMPERATURES.length - 1) {
			const why = leak
				? 'testo simile al contesto'
				: ratio > COMPRESSION_RATIO_THRESHOLD
					? 'ripetizioni anomale'
					: `confidenza bassa (${(res.avgLogprob as number).toFixed(2)})`;
			cb.onLog('warn', `${fmt(startSec)}: ${why}, nuovo tentativo (temperatura ${TEMPERATURES[k + 1]})`);
		}
		if (leak) usePrompt = false;
		if (ratio > COMPRESSION_RATIO_THRESHOLD) antiRepeat = true;
	}
	const score = (a: Attempt) => (a.leak ? -1000 : 0) + (a.ratio > COMPRESSION_RATIO_THRESHOLD ? -100 : 0) + (a.res.avgLogprob ?? -10);
	return { chosen: tried.reduce((best, a) => (score(a) > score(best) ? a : best)), attempts: tried.length, firstMs, retryMs };
}

// --- tratti di voce rimasti senza testo ------------------------------------------

export interface SpeechSpan {
	start: number;
	end: number;
	/** Secondi con energia sopra la soglia della voce. */
	speechSec: number;
}

/**
 * Tratti della finestra (fino a `untilSec`) non coperti da alcun segmento (±0,3 s)
 * che contengono voce, cioè frame da 100 ms sopra `speechDb`.
 */
export function uncoveredSpeech(
	db: Float32Array,
	segments: { start: number; end: number }[],
	speechDb: number,
	untilSec: number,
): SpeechSpan[] {
	const spans: SpeechSpan[] = [];
	const n = Math.min(db.length, Math.floor(untilSec * 10));
	let cur: { start: number; end: number; speech: number } | null = null;
	for (let f = 0; f < n; f++) {
		const t = f / 10;
		if (segments.some((s) => t >= s.start - 0.3 && t < s.end + 0.3)) {
			if (cur) spans.push({ start: cur.start, end: cur.end, speechSec: cur.speech / 10 });
			cur = null;
			continue;
		}
		if (!cur) cur = { start: t, end: t + 0.1, speech: 0 };
		cur.end = t + 0.1;
		if (db[f] > speechDb) cur.speech++;
	}
	if (cur) spans.push({ start: cur.start, end: cur.end, speechSec: cur.speech / 10 });
	return spans.filter((s) => s.speechSec > 0);
}

// --- ciclo principale --------------------------------------------------------

export interface CoreCallbacks {
	onSegments(segs: TranscriptSegment[]): void;
	onProgress(processedSec: number, totalSec: number, info: string): void;
	onLog(level: 'info' | 'warn' | 'error', message: string): void;
	isCancelled(): boolean;
}

export interface CoreTiming {
	/** Primo tentativo di ogni finestra. */
	firstMs: number;
	/** Nuovi tentativi a temperatura più alta. */
	retryMs: number;
	/** Seconda passata sui tratti saltati. */
	repassMs: number;
}

export interface CoreResult {
	segments: TranscriptSegment[];
	gaps: TranscriptGap[];
	silenceSec: number;
	audioSec: number;
	language: string;
	windows: number;
	retries: number;
	/** Segmenti recuperati dalla seconda passata. */
	recovered: number;
	/** Finestre rimaste a bassa confidenza anche dopo i nuovi tentativi. */
	lowConfidence: number;
	complete: boolean;
	timing: CoreTiming;
}

type KeptSegment = { start: number; end: number; text: string; recovered?: boolean };

export async function runTranscription(
	feed: AudioFeed,
	engine: AsrEngine,
	languageSetting: string,
	cb: CoreCallbacks,
): Promise<CoreResult> {
	const W = WINDOW_SEC * SAMPLE_RATE;
	let seek = 0;
	let language = languageSetting;
	const all: TranscriptSegment[] = [];
	const gaps: TranscriptGap[] = [];
	let silenceSec = 0;
	let windows = 0;
	let retries = 0;
	let recovered = 0;
	let lowConfidence = 0;
	const timing: CoreTiming = { firstMs: 0, retryMs: 0, repassMs: 0 };
	let speedT0 = performance.now();
	let speedFromSec = 0;

	while (true) {
		if (cb.isCancelled()) throw new Error('Interrotto dall\'utente');
		const audio = await feed.read(seek, seek + W);
		if (audio.length === 0) break;
		const total = feed.total();
		const isLast = total !== null && seek + audio.length >= total;
		const winSec = audio.length / SAMPLE_RATE;
		const startSec = seek / SAMPLE_RATE;
		const db = frameDb(audio);
		const p95 = percentile(db, 95);
		let loudFrames = 0;
		for (const v of db) if (v > SILENCE_DB) loudFrames++;

		// Silenzio solo se nessun tratto di almeno 200 ms supera la soglia:
		// anche una frase che inizia all'ultimo secondo della finestra viene trascritta.
		if (loudFrames < 2) {
			silenceSec += winSec;
			seek += audio.length;
			feed.release(seek);
			cb.onProgress(seek / SAMPLE_RATE, feed.expectedDuration, 'silenzio');
			continue;
		}

		// Silenzio iniziale lungo: la finestra riparte poco prima della voce, così il
		// primo segmento cade entro il primo secondo come vuole Whisper.
		let leading = 0;
		while (leading < db.length && db[leading] <= SILENCE_DB) leading++;
		if (leading / 10 >= LEADING_SILENCE_SKIP_SEC) {
			const skip = (leading - 3) * FRAME;
			silenceSec += skip / SAMPLE_RATE;
			seek += skip;
			feed.release(seek);
			cb.onProgress(seek / SAMPLE_RATE, feed.expectedDuration, 'silenzio');
			continue;
		}

		if (language === 'auto') {
			try {
				language = (await engine.detectLanguage(audio)) ?? 'it';
				cb.onLog('info', `Lingua rilevata: ${language}`);
			} catch (e) {
				language = 'it';
				cb.onLog('warn', `Rilevamento lingua non riuscito, uso l'italiano (${(e as Error).message})`);
			}
		}

		let chosen: Attempt | null = null;
		let lastError: unknown = null;
		for (let tries = 0; tries < 4 && chosen === null; tries++) {
			try {
				const outcome = await transcribeWithRetries(engine, audio, language, startSec, cb);
				chosen = outcome.chosen;
				timing.firstMs += outcome.firstMs;
				timing.retryMs += outcome.retryMs;
				if (outcome.attempts > 1) retries++;
			} catch (e) {
				lastError = e;
				retries++;
				cb.onLog('warn', `${fmt(startSec)}: errore del modello (${(e as Error).message}), nuovo tentativo`);
				if (tries === 1 && engine.fallback && (await engine.fallback())) {
					cb.onLog('warn', 'Passaggio al motore alternativo (più lento) per completare la trascrizione');
				}
			}
		}

		windows++;
		if (chosen === null) {
			// Nessun tentativo riuscito: buco dichiarato, mai nascosto.
			const gap = { start: startSec, end: startSec + winSec, reason: String((lastError as Error)?.message ?? lastError) };
			gaps.push(gap);
			cb.onLog('error', `Parte non trascritta: ${fmt(gap.start)}–${fmt(gap.end)}`);
			seek += audio.length;
			feed.release(seek);
			continue;
		}

		const flags: string[] = [];
		if (chosen.ratio > COMPRESSION_RATIO_THRESHOLD) flags.push('possibili ripetizioni del modello');
		if (chosen.lowConf) {
			flags.push('bassa confidenza');
			lowConfidence++;
		}

		const plan = planSeek(chosen.res.segments, winSec, isLast, (from, to) => {
			const tail = spanDb(db, from, to, 90);
			return tail > Math.max(SILENCE_DB, p95 - 25);
		});
		const kept: KeptSegment[] = plan.keep.slice();
		const speechDb = Math.max(SILENCE_DB, p95 - 20);

		// Seconda passata: voce chiara in mezzo alla finestra ma nessun testo.
		if (kept.length) {
			const until = kept[kept.length - 1].start;
			const spans = uncoveredSpeech(db, kept, speechDb, until)
				.filter((sp) => sp.speechSec >= REPASS_MIN_SPEECH_SEC)
				.sort((a, b) => b.speechSec - a.speechSec)
				.slice(0, REPASS_MAX_SPANS);
			for (const sp of spans) {
				const from = Math.max(0, sp.start - 0.2);
				const to = Math.min(winSec, sp.end + 0.2);
				const piece = audio.subarray(Math.floor(from * SAMPLE_RATE), Math.ceil(to * SAMPLE_RATE));
				const t0 = performance.now();
				try {
					const { chosen: again } = await transcribeWithRetries(engine, piece, language, startSec + from, cb);
					if (again.ratio > COMPRESSION_RATIO_THRESHOLD || again.leak) continue;
					const len = to - from;
					const found: KeptSegment[] = again.res.segments
						.filter((s) => s.text.trim().length > 0 && s.start < len - 0.05)
						.map((s) => ({
							start: from + s.start,
							end: from + Math.min(len, Math.max(s.start + 0.1, s.end ?? len)),
							text: s.text,
							recovered: true,
						}))
						.filter((s) => {
							const overlaps = kept.some((k) => Math.min(k.end, s.end) - Math.max(k.start, s.start) > 0.5 * (s.end - s.start));
							const norm = normalize(s.text);
							const duplicate = norm.length >= 12 && kept.some((k) => normalize(k.text).includes(norm));
							return !overlaps && !duplicate;
						});
					if (found.length) {
						kept.push(...found);
						kept.sort((a, b) => a.start - b.start);
						recovered += found.length;
						cb.onLog(
							'info',
							`${fmt(startSec + sp.start)}: recuperati ${found.length} segmenti in ${Math.round(sp.speechSec)} s di voce saltati alla prima lettura`,
						);
					}
				} catch (e) {
					cb.onLog('warn', `${fmt(startSec + sp.start)}: seconda passata non riuscita (${(e as Error).message})`);
				} finally {
					timing.repassMs += performance.now() - t0;
				}
			}
		}

		const out: TranscriptSegment[] = [];
		for (const s of kept) {
			const segDb = spanDb(db, s.start, Math.max(s.end, s.start + 0.1), 90);
			if (segDb < SILENCE_DB && looksLikeSilenceHallucination(s.text)) {
				cb.onLog('info', `${fmt(startSec + s.start)}: scartata frase tipica del modello su silenzio ("${s.text.trim()}")`);
				continue;
			}
			const seg: TranscriptSegment = {
				start: startSec + s.start,
				end: startSec + s.end,
				text: s.text.trim(),
			};
			const segFlags = s.recovered ? [...flags, 'recuperato nella seconda passata'] : flags;
			if (segFlags.length) seg.flags = segFlags;
			const prev = out[out.length - 1] ?? all[all.length - 1];
			// Duplicato al confine tra finestre: stesso testo E sovrapposto nel tempo.
			// Una frase ripetuta davvero dal docente ("sì... sì") non si sovrappone e resta.
			if (prev && normalize(prev.text) === normalize(seg.text) && seg.start < prev.end - 0.1) {
				continue;
			}
			out.push(seg);
		}
		all.push(...out);
		if (out.length) cb.onSegments(out);
		if (plan.note && spanDb(db, 0, winSec, 90) > SILENCE_DB + 10) {
			cb.onLog('info', `${fmt(startSec)}: ${plan.note} (musica o rumore?)`);
		}

		// Avviso se resta molta voce senza testo: da riascoltare.
		{
			const until = Math.min(winSec, plan.advanceSec);
			const missing = uncoveredSpeech(db, kept, speechDb, until).reduce((a, sp) => a + sp.speechSec, 0);
			let speech = 0;
			for (let f = 0; f < Math.min(db.length, Math.floor(until * 10)); f++) if (db[f] > speechDb) speech++;
			speech /= 10;
			if (speech >= 5 && missing / speech > 0.3) {
				cb.onLog(
					'warn',
					`${fmt(startSec)}: ${Math.round(missing)} s su ${Math.round(speech)} s di voce senza testo (voce troppo bassa o coperta dal rumore?)`,
				);
			}
		}

		const advance = Math.max(1, Math.round(Math.min(winSec, plan.advanceSec) * SAMPLE_RATE));
		seek += advance;
		feed.release(seek);
		cb.onProgress(seek / SAMPLE_RATE, feed.expectedDuration, `${windows} finestre`);

		// Velocità per blocchi di 10 minuti: se cala andando avanti, il PC rallenta per il calore.
		const doneSec = seek / SAMPLE_RATE;
		if (doneSec - speedFromSec >= SPEED_LOG_EVERY_SEC) {
			const now = performance.now();
			const speed = (doneSec - speedFromSec) / Math.max(0.001, (now - speedT0) / 1000);
			cb.onLog('info', `Velocità ${fmt(speedFromSec)}–${fmt(doneSec)}: ${speed.toFixed(1).replace('.', ',')}× tempo reale`);
			speedFromSec = doneSec;
			speedT0 = now;
		}
	}

	const audioSec = (feed.total() ?? seek) / SAMPLE_RATE;
	return {
		segments: all,
		gaps,
		silenceSec,
		audioSec,
		language,
		windows,
		retries,
		recovered,
		lowConfidence,
		complete: gaps.length === 0,
		timing,
	};
}

function fmt(sec: number) {
	const s = Math.floor(sec);
	return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
