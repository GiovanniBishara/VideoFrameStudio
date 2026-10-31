// Logica di trascrizione indipendente dal modello: finestre da 30 s con
// avanzamento "a seek" come l'algoritmo originale di Whisper. La finestra
// successiva riparte dall'inizio dell'ultimo segmento incompleto, quindi le
// finestre si sovrappongono dove serve e nessun segmento viene trascritto due
// volte né tagliato a metà parola. Ogni secondo dell'audio finisce o nel testo
// o in una zona classificata come silenzio, o (in caso di errore) in un buco
// dichiarato esplicitamente.

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
}

export interface AsrEngine {
	transcribeWindow(audio: Float32Array, req: WindowRequest): Promise<RawSegment[]>;
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

// --- ciclo principale --------------------------------------------------------

export interface CoreCallbacks {
	onSegments(segs: TranscriptSegment[]): void;
	onProgress(processedSec: number, totalSec: number, info: string): void;
	onLog(level: 'info' | 'warn' | 'error', message: string): void;
	isCancelled(): boolean;
}

export interface CoreResult {
	segments: TranscriptSegment[];
	gaps: TranscriptGap[];
	silenceSec: number;
	audioSec: number;
	language: string;
	windows: number;
	retries: number;
	complete: boolean;
}

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

		if (language === 'auto') {
			try {
				language = (await engine.detectLanguage(audio)) ?? 'it';
				cb.onLog('info', `Lingua rilevata: ${language}`);
			} catch (e) {
				language = 'it';
				cb.onLog('warn', `Rilevamento lingua non riuscito, uso l'italiano (${(e as Error).message})`);
			}
		}

		let raw: RawSegment[] | null = null;
		let usePrompt = engine.hasPrompt;
		let attempt = 0;
		let lastError: unknown = null;
		let flags: string[] = [];
		for (let tries = 0; tries < 4 && raw === null; tries++) {
			try {
				const res = await engine.transcribeWindow(audio, { language, usePrompt, attempt });
				const text = res.map((s) => s.text).join(' ');
				const ratio = await compressionRatio(text);
				const leak = usePrompt && res.some((s) => looksLikePromptLeak(s.text, engine.promptText));
				if ((ratio > 2.4 || leak) && attempt === 0) {
					// Ripetizioni anomale o testo copiato dal contesto: nuovo tentativo più prudente.
					retries++;
					attempt = 1;
					if (leak) usePrompt = false;
					cb.onLog(
						'warn',
						`${fmt(startSec)}: ${leak ? 'testo simile al contesto' : 'ripetizioni anomale'}, nuovo tentativo`,
					);
					// conserva il risultato come riserva
					raw = null;
					const second = await engine.transcribeWindow(audio, { language, usePrompt, attempt });
					const ratio2 = await compressionRatio(second.map((s) => s.text).join(' '));
					if (ratio2 > 2.4) flags = ['possibili ripetizioni del modello'];
					raw = ratio2 <= ratio ? second : res;
				} else {
					raw = res;
				}
			} catch (e) {
				lastError = e;
				retries++;
				cb.onLog('warn', `${fmt(startSec)}: errore del modello (${(e as Error).message}), nuovo tentativo`);
				if (tries === 1 && engine.fallback) {
					const switched = await engine.fallback();
					if (switched) cb.onLog('warn', 'Passaggio al motore alternativo (più lento) per completare la trascrizione');
				}
			}
		}

		windows++;
		if (raw === null) {
			// Nessun tentativo riuscito: buco dichiarato, mai nascosto.
			const gap = { start: startSec, end: startSec + winSec, reason: String((lastError as Error)?.message ?? lastError) };
			gaps.push(gap);
			cb.onLog('error', `Parte non trascritta: ${fmt(gap.start)}–${fmt(gap.end)}`);
			seek += audio.length;
			feed.release(seek);
			continue;
		}

		const plan = planSeek(raw, winSec, isLast, (from, to) => {
			const tail = spanDb(db, from, to, 90);
			return tail > Math.max(SILENCE_DB, p95 - 25);
		});

		const out: TranscriptSegment[] = [];
		for (const s of plan.keep) {
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
			if (flags.length) seg.flags = flags;
			const prev = all[all.length - 1] ?? out[out.length - 1];
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

		const advance = Math.max(1, Math.round(Math.min(winSec, plan.advanceSec) * SAMPLE_RATE));
		seek += advance;
		feed.release(seek);
		cb.onProgress(seek / SAMPLE_RATE, feed.expectedDuration, `${windows} finestre`);
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
		complete: gaps.length === 0,
	};
}

function fmt(sec: number) {
	const s = Math.floor(sec);
	return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
