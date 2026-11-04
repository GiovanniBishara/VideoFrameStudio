// Trascrizione: estrazione e decodifica progressiva dell'audio (Mediabunny),
// conversione a 16 kHz mono, riconoscimento con Whisper multilingue
// (Transformers.js, WebGPU quando disponibile, altrimenti WebAssembly).
// Il worker resta vivo tra un video e l'altro della coda: il modello già caricato
// viene riutilizzato.

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import { estimateEta, formatDuration, formatNumber, hms } from '../shared/format';
import { OutFile } from '../shared/outfile';
import { StreamingResampler, mixToMono } from '../shared/resample';
import {
	SAMPLE_RATE,
	runTranscription,
	type AsrEngine,
	type AudioFeed,
	type CoreTiming,
	type RawSegment,
	type WindowRequest,
	type WindowResult,
} from '../shared/transcribeCore';
import { buildSrt, buildTxt } from '../shared/transcriptText';
import { LogprobTracker, applyTimestampRules } from '../shared/whisperRules';
import type { OutputRef, OutputTarget, TranscribeOptions, TranscriptSegment, WorkerOut } from '../shared/types';

/** Versione fissata e verificata della libreria (caricata dal CDN jsDelivr e poi dalla cache del browser). */
export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

export const MODEL_IDS: Record<TranscribeOptions['model'], string> = {
	base: 'onnx-community/whisper-base',
	small: 'onnx-community/whisper-small',
	turbo: 'onnx-community/whisper-large-v3-turbo',
};

interface StartMsg {
	type: 'start';
	file: File;
	options: TranscribeOptions;
	target: OutputTarget;
	runId: string;
	baseName: string;
	/** Solo nella build di test: motore finto per verificare la pipeline senza scaricare modelli. */
	testEngine?: boolean;
}

declare const __TEST_BUILD__: boolean;

let cancelled = false;
const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);
const log = (level: 'info' | 'warn' | 'error', message: string) => post({ type: 'log', level, message });

self.onmessage = (e: MessageEvent<StartMsg | { type: 'cancel' }>) => {
	if (e.data.type === 'cancel') {
		cancelled = true;
		return;
	}
	cancelled = false;
	run(e.data).catch((err) => post({ type: 'error', message: String((err as Error)?.message ?? err) }));
};

// --- audio: decodifica progressiva con limite di memoria ------------------------

class DecodedAudioFeed implements AudioFeed {
	private chunks: { start: number; data: Float32Array }[] = [];
	private produced = 0;
	private ended = false;
	private error: Error | null = null;
	private released = 0;
	private waiters: (() => void)[] = [];
	private producerWaiter: (() => void) | null = null;
	/** Al massimo 10 minuti di audio decodificato in anticipo (≈ 38 MB). */
	private static readonly MAX_AHEAD = SAMPLE_RATE * 600;
	decodedSec = 0;
	/** Tempo passato ad aspettare l'audio decodificato (per il riepilogo dei tempi). */
	waitMs = 0;

	constructor(readonly expectedDuration: number) {}

	private wake() {
		const w = this.waiters;
		this.waiters = [];
		w.forEach((f) => f());
	}

	async push(data: Float32Array) {
		if (data.length === 0) return;
		this.chunks.push({ start: this.produced, data });
		this.produced += data.length;
		this.wake();
		while (this.produced - this.released > DecodedAudioFeed.MAX_AHEAD && !cancelled) {
			await new Promise<void>((r) => (this.producerWaiter = r));
		}
	}

	end(totalSamples: number | null) {
		if (totalSamples !== null && totalSamples < this.produced) {
			// rimuove la coda di silenzio aggiunta dal filtro di ricampionamento
			let excess = this.produced - totalSamples;
			while (excess > 0 && this.chunks.length) {
				const last = this.chunks[this.chunks.length - 1];
				if (last.data.length <= excess) {
					this.chunks.pop();
					excess -= last.data.length;
				} else {
					last.data = last.data.subarray(0, last.data.length - excess);
					excess = 0;
				}
			}
			this.produced = totalSamples;
		}
		this.ended = true;
		this.wake();
	}

	fail(err: Error) {
		this.error = err;
		this.ended = true;
		this.wake();
	}

	async read(start: number, end: number): Promise<Float32Array> {
		if (!this.ended && this.produced < end) {
			const t0 = performance.now();
			while (!this.ended && this.produced < end) {
				await new Promise<void>((r) => this.waiters.push(r));
			}
			this.waitMs += performance.now() - t0;
		}
		if (this.error) throw this.error;
		const stop = Math.min(end, this.produced);
		if (stop <= start) return new Float32Array(0);
		const out = new Float32Array(stop - start);
		for (const c of this.chunks) {
			const cEnd = c.start + c.data.length;
			if (cEnd <= start || c.start >= stop) continue;
			const a = Math.max(start, c.start);
			const b = Math.min(stop, cEnd);
			out.set(c.data.subarray(a - c.start, b - c.start), a - start);
		}
		return out;
	}

	release(before: number) {
		this.released = Math.max(this.released, before);
		while (this.chunks.length && this.chunks[0].start + this.chunks[0].data.length <= before) this.chunks.shift();
		this.producerWaiter?.();
		this.producerWaiter = null;
	}

	total() {
		return this.ended ? this.produced : null;
	}
}

async function decodeAudio(file: File, feed: DecodedAudioFeed) {
	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
	const track = await input.getPrimaryAudioTrack();
	if (!track) throw new Error('Il video non contiene una traccia audio.');
	if (!(await track.canDecode())) {
		throw new Error(`Il browser non sa decodificare l'audio (codec: ${(await track.getCodec()) ?? 'sconosciuto'}).`);
	}
	const sink = new AudioSampleSink(track);
	let resampler: StreamingResampler | null = null;
	let expectedNext = 0; // secondi, origine = inizio della linea temporale del file
	for await (const s of sink.samples()) {
		try {
			if (cancelled) throw new Error('Interrotto dall\'utente');
			const sr = s.sampleRate;
			if (!resampler || resampler.inRate !== sr) {
				if (resampler) await feed.push(resampler.flush());
				resampler = new StreamingResampler(sr, SAMPLE_RATE);
			}
			const n = s.numberOfFrames;
			const planes: Float32Array[] = [];
			for (let c = 0; c < s.numberOfChannels; c++) {
				const buf = new Float32Array(n);
				s.copyTo(buf, { format: 'f32-planar', planeIndex: c });
				planes.push(buf);
			}
			let mono = mixToMono(planes);
			let ts = s.timestamp;
			// parte prima dell'inizio (es. priming AAC con timestamp negativo)
			if (ts < expectedNext - 0.002) {
				const drop = Math.round((expectedNext - ts) * sr);
				if (drop >= mono.length) continue;
				mono = mono.subarray(drop);
				ts = expectedNext;
			}
			// buco nella traccia: silenzio, così i timestamp restano allineati al video
			if (ts > expectedNext + 0.002) {
				const gap = Math.round((ts - expectedNext) * sr);
				await feed.push(resampler.process(new Float32Array(gap)));
			}
			await feed.push(resampler.process(mono));
			expectedNext = ts + mono.length / sr;
			feed.decodedSec = expectedNext;
		} finally {
			s.close();
		}
	}
	if (resampler) await feed.push(resampler.flush());
	feed.end(Math.round(expectedNext * SAMPLE_RATE));
}

// --- motore Whisper ----------------------------------------------------------------

type Transformers = typeof import('./transformers-types');

class WhisperEngine implements AsrEngine {
	hasPrompt = false;
	promptText = '';
	private promptIds: number[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private pipe: any = null;
	device: 'webgpu' | 'wasm' = 'wasm';
	dtypeLabel = '';

	constructor(
		private tf: Transformers,
		private modelId: string,
		private onProgress: (loaded: number, total: number) => void,
	) {}

	async load(device: 'webgpu' | 'wasm') {
		this.prepared = null; // un modello diverso dà un encoder diverso
		let f16 = false;
		if (device === 'webgpu') {
			const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: unknown): Promise<{ features: Set<string> } | null> } }).gpu;
			const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
			if (!adapter) throw new Error('WebGPU non disponibile');
			const desc = (adapter as { info?: { description?: string; vendor?: string } }).info;
			if ((adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter || /swiftshader/i.test(`${desc?.vendor} ${desc?.description}`)) {
				throw new Error('WebGPU disponibile solo in emulazione software');
			}
			f16 = adapter.features.has('shader-f16');
		}
		const candidates: Record<string, string>[] =
			device === 'webgpu'
				? [
						// decoder a 16 bit: più preciso del 4 bit sui termini tecnici
						...(f16
							? [
									{ encoder_model: 'fp16', decoder_model_merged: 'fp16' },
									{ encoder_model: 'fp16', decoder_model_merged: 'q4' },
								]
							: []),
						{ encoder_model: 'fp32', decoder_model_merged: 'q4' },
						{ encoder_model: 'fp32', decoder_model_merged: 'fp32' },
					]
				: [
						{ encoder_model: 'q8', decoder_model_merged: 'q8' },
						{ encoder_model: 'fp32', decoder_model_merged: 'q8' },
						{ encoder_model: 'fp32', decoder_model_merged: 'fp32' },
					];
		let lastErr: unknown = null;
		for (const dtype of candidates) {
			try {
				this.pipe = await this.tf.pipeline('automatic-speech-recognition', this.modelId, {
					device,
					dtype,
					progress_callback: (info: { status: string; loaded?: number; total?: number }) => {
						if (info.status === 'progress_total' && info.total) this.onProgress(info.loaded ?? 0, info.total);
					},
				});
				this.device = device;
				this.dtypeLabel = `${dtype.encoder_model}/${dtype.decoder_model_merged}`;
				return;
			} catch (e) {
				lastErr = e;
			}
		}
		throw lastErr ?? new Error('Caricamento del modello non riuscito');
	}

	setPrompt(text: string) {
		const clean = text.replace(/\s+/g, ' ').trim();
		if (!clean) {
			// video successivo senza contesto: nessun prompt residuo
			this.promptIds = [];
			this.promptText = '';
			this.hasPrompt = false;
			return;
		}
		const ids: number[] = Array.from(this.pipe.tokenizer.encode(' ' + clean, { add_special_tokens: false }), Number);
		// Limite di 120 token: il resto della finestra resta per il testo trascritto.
		this.promptIds = ids.slice(-120);
		this.promptText = clean;
		this.hasPrompt = this.promptIds.length > 0;
	}

	private tok(s: string): number {
		const id = this.pipe.tokenizer.convert_tokens_to_ids(s);
		if (id === undefined || id === null) throw new Error(`Token ${s} non presente nel modello`);
		return Number(id);
	}

	private toList(out: unknown): number[] {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const t: any = (out as any)?.sequences ?? out;
		const rows = typeof t.tolist === 'function' ? t.tolist() : t[0].tolist();
		const row = Array.isArray(rows[0]) ? rows[0] : rows;
		return row.map(Number);
	}

	async detectLanguage(audio: Float32Array): Promise<string | null> {
		const { input_features } = await this.pipe.processor(audio);
		const out = await this.pipe.model.generate({
			inputs: input_features,
			decoder_input_ids: [this.tok('<|startoftranscript|>')],
			max_new_tokens: 1,
		});
		const ids = this.toList(out);
		const token = this.pipe.tokenizer.decode([ids[ids.length - 1]], { skip_special_tokens: false }) as string;
		const m = /^<\|([a-z]{2,3})\|>$/.exec(token.trim());
		return m ? m[1] : null;
	}

	/** Regole del Whisper originale e confidenza attive; si spengono da sole se la libreria le rifiuta. */
	private customRules = true;
	private rulesChecked = false;

	/**
	 * Encoder calcolato una volta per finestra e riusato nei nuovi tentativi della stessa
	 * finestra (stesso audio → stesso risultato: il testo non cambia, si risparmia la parte
	 * più pesante). Si spegne da solo se la libreria non lo accetta.
	 */
	private encoderReuse = true;
	private encoderCallsInLibrary = 0;
	private prepared: { audio: Float32Array; features: unknown; encoder: unknown | null } | null = null;
	/** Tempi misurati, per il riepilogo nel registro. */
	readonly stats = { featuresMs: 0, encoderMs: 0, generateMs: 0, tokens: 0, generations: 0, encoderReused: 0 };

	private async prepare(audio: Float32Array) {
		if (this.prepared && this.prepared.audio === audio) {
			if (this.prepared.encoder) this.stats.encoderReused++;
			return this.prepared;
		}
		this.prepared = null; // libera la finestra precedente
		const t0 = performance.now();
		const { input_features } = await this.pipe.processor(audio);
		const t1 = performance.now();
		this.stats.featuresMs += t1 - t0;
		let encoder: unknown | null = null;
		if (this.encoderReuse) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const model: any = this.pipe.model;
			try {
				if (!model.__vftsEncode) {
					// La libreria calcola l'encoder in questa funzione: la si usa uguale (stesso calcolo)
					// e si contano le chiamate fatte dalla libreria, per accorgersi se il riuso non funziona.
					model.__vftsEncode = model._prepare_encoder_decoder_kwargs_for_generation;
					model._prepare_encoder_decoder_kwargs_for_generation = (...args: unknown[]) => {
						this.encoderCallsInLibrary++;
						return model.__vftsEncode.apply(model, args);
					};
					if (!model.forward_params.includes('encoder_outputs')) {
						model.forward_params = [...model.forward_params, 'encoder_outputs'];
					}
				}
				const r = await model.__vftsEncode.call(model, {
					inputs_tensor: input_features,
					model_inputs: { input_features },
					model_input_name: 'input_features',
					generation_config: { guidance_scale: null },
				});
				encoder = r?.encoder_outputs ?? null;
				if (!encoder) throw new Error('risultato assente');
				this.stats.encoderMs += performance.now() - t1;
			} catch (e) {
				this.encoderReuse = false;
				encoder = null;
				log('warn', `Riuso dell'encoder non disponibile (${(e as Error).message}): ogni tentativo lo ricalcola.`);
			}
		}
		this.prepared = { audio, features: input_features, encoder };
		return this.prepared;
	}

	async transcribeWindow(audio: Float32Array, req: WindowRequest): Promise<WindowResult> {
		const prep = await this.prepare(audio);
		const input_features = prep.features;
		const init: number[] = [];
		if (req.usePrompt && this.promptIds.length) init.push(this.tok('<|startofprev|>'), ...this.promptIds);
		init.push(this.tok('<|startoftranscript|>'), this.tok(`<|${req.language}|>`), this.tok('<|transcribe|>'));
		const temperature = req.temperature ?? 0;
		const tsBegin = Number(this.pipe.tokenizer.timestamp_begin);

		const generate = async (custom: boolean, useEncoder: boolean) => {
			const tracker = new LogprobTracker(temperature);
			let logitsProcessor: unknown;
			if (custom) {
				type Proc = (ids: bigint[][], logits: { data: Float32Array }[]) => unknown;
				// Regole sui timestamp prima, misura della confidenza per ultima (sui logit finali).
				const processors: Proc[] = [
					(ids, logits) => (applyTimestampRules(ids[0].slice(init.length).map(Number), logits[0].data, tsBegin), logits),
					(ids, logits) => {
						const row = ids[0];
						tracker.step(row.length > init.length ? Number(row[row.length - 1]) : null, logits[0].data);
						return logits;
					},
				];
				// La libreria aggiunge i propri processori con push/extend: restano prima della misura.
				logitsProcessor = {
					processors,
					push(p: Proc) {
						processors.splice(processors.length - 1, 0, p);
					},
					extend(list: Proc[]) {
						for (const p of list) processors.splice(processors.length - 1, 0, p);
					},
					[Symbol.iterator]() {
						return processors.values();
					},
				};
			}
			const encoder = useEncoder ? prep.encoder : null;
			const callsBefore = this.encoderCallsInLibrary;
			const t0 = performance.now();
			const out = await this.pipe.model.generate({
				inputs: input_features,
				...(encoder ? { encoder_outputs: encoder } : {}),
				decoder_input_ids: init,
				return_timestamps: true,
				// Con max_new_tokens esplicito la libreria non applica il proprio "seek":
				// l'avanzamento tra finestre è gestito da runTranscription.
				max_new_tokens: Math.min(440, 448 - init.length),
				...(temperature > 0 ? { do_sample: true, temperature } : {}),
				...(req.attempt > 0 ? { no_repeat_ngram_size: 6 } : {}),
				...(logitsProcessor ? { logits_processor: logitsProcessor } : {}),
			});
			const ids = this.toList(out).slice(init.length);
			this.stats.generateMs += performance.now() - t0;
			this.stats.tokens += ids.length;
			this.stats.generations++;
			if (encoder && this.encoderCallsInLibrary !== callsBefore) {
				this.encoderReuse = false;
				log('warn', "La libreria ricalcola comunque l'encoder: riuso disattivato (nessun effetto sul testo).");
			}
			tracker.finish(ids.length ? ids[ids.length - 1] : null);
			return { ids, tracker };
		};

		// Con l'encoder riusato; se la libreria lo rifiuta si riprova senza e il riuso si spegne.
		const run = async (custom: boolean) => {
			if (this.encoderReuse && prep.encoder) {
				try {
					return await generate(custom, true);
				} catch (e) {
					const r = await generate(custom, false).catch(() => {
						throw e;
					});
					this.encoderReuse = false;
					log('warn', `Riuso dell'encoder disattivato (${(e as Error).message}): nessun effetto sul testo.`);
					return r;
				}
			}
			return generate(custom, false);
		};

		let result: { ids: number[]; tracker: LogprobTracker };
		if (this.customRules) {
			try {
				result = await run(true);
			} catch (e) {
				// Se senza le regole aggiuntive funziona, il problema erano le regole: si spengono.
				result = await run(false).catch(() => {
					throw e;
				});
				this.customRules = false;
				log('warn', `Regole aggiuntive di Whisper disattivate (${(e as Error).message}): uso la decodifica standard.`);
			}
			// Alla prima finestra si verifica che la libreria abbia davvero usato i processori.
			if (this.customRules && !this.rulesChecked && result.ids.length > 0) {
				this.rulesChecked = true;
				if (result.tracker.count === 0) {
					this.customRules = false;
					log('warn', 'La libreria non ha applicato le regole aggiuntive di Whisper: uso la decodifica standard.');
				} else {
					log('info', 'Regole di decodifica del Whisper originale attive (inizio entro 1 s, tempi crescenti, confidenza per finestra).');
				}
			}
		} else {
			result = await run(false);
		}
		return { segments: this.parse(result.ids), avgLogprob: this.customRules ? result.tracker.average : null };
	}

	private parse(ids: number[]): RawSegment[] {
		const tsBegin = Number(this.pipe.tokenizer.timestamp_begin);
		const eot = this.tok('<|endoftext|>');
		const segs: RawSegment[] = [];
		let start: number | null = null;
		let text: number[] = [];
		const decode = (t: number[]) => (this.pipe.tokenizer.decode(t, { skip_special_tokens: true }) as string).trim();
		for (const id of ids) {
			if (id === eot) break;
			if (id >= tsBegin) {
				const t = (id - tsBegin) * 0.02;
				if (start === null) start = t;
				else if (text.length === 0) start = t; // coppia di timestamp: inizio del segmento successivo
				else {
					segs.push({ start, end: t, text: decode(text) });
					start = null;
					text = [];
				}
			} else if (id < eot) {
				text.push(id);
			}
		}
		if (text.length) segs.push({ start: start ?? 0, end: null, text: decode(text) });
		return segs.filter((s) => s.text.length > 0);
	}

	async fallback(): Promise<boolean> {
		if (this.device !== 'webgpu') return false;
		try {
			const prompt = this.promptText;
			await this.load('wasm');
			if (prompt) this.setPrompt(prompt);
			return true;
		} catch {
			return false;
		}
	}
}

// --- lavoro principale -----------------------------------------------------------

/** Modello caricato, tenuto tra un video e l'altro della coda. */
let cachedEngine: { key: string; engine: WhisperEngine } | null = null;

async function run(msg: StartMsg) {
	const { file, options: o, target, runId, baseName } = msg;
	const t0 = performance.now();
	let lastPost = 0;

	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
	const audioTrack = await input.getPrimaryAudioTrack();
	if (!audioTrack) throw new Error('Il video non contiene una traccia audio.');
	const duration = await input.computeDuration();

	// 1) avvio decodifica audio in parallelo al caricamento del modello
	const feed = new DecodedAudioFeed(duration);
	const decoding = decodeAudio(file, feed).catch((e) => feed.fail(e as Error));

	// 2) modello
	let engine: AsrEngine;
	let engineLabel = '';
	let whisperForStats: WhisperEngine | null = null;
	let statsBefore: WhisperEngine['stats'] | null = null;
	if (__TEST_BUILD__ && msg.testEngine) {
		// Solo build di test (eliminato dalla build pubblicata): verifica la pipeline senza modello.
		const { FakeToneEngine } = await import('../test/fakeEngine');
		engine = new FakeToneEngine();
		engineLabel = 'motore di test';
	} else {
		post({ type: 'progress', progress: { fraction: null, stage: 'Caricamento libreria AI', elapsedMs: 0, etaMs: null } });
		let tf: Transformers;
		try {
			tf = (await import(/* @vite-ignore */ TRANSFORMERS_URL)) as Transformers;
		} catch (e) {
			throw new Error(
				`Impossibile caricare Transformers.js dal CDN (${(e as Error).message}). Serve la connessione a internet al primo utilizzo.`,
			);
		}
		tf.env.allowLocalModels = false;
		tf.env.useBrowserCache = true;
		const modelId = MODEL_IDS[o.model];
		const loadStart = performance.now();
		const key = `${modelId}|${o.device}`;
		const reused = !!cachedEngine && cachedEngine.key === key && cachedEngine.engine.device === o.device;
		const whisper = reused
			? cachedEngine!.engine
			: new WhisperEngine(tf, modelId, (loaded, total) => {
					const now = performance.now();
					if (now - lastPost < 250) return;
					lastPost = now;
					post({
						type: 'progress',
						progress: {
							fraction: loaded / total,
							stage: 'Download del modello (solo la prima volta, poi resta in cache)',
							detail: `${modelId} · ${formatNumber(loaded / 1048576)} / ${formatNumber(total / 1048576)} MB`,
							elapsedMs: now - loadStart,
							etaMs: estimateEta(loaded / total, now - loadStart),
						},
					});
				});
		if (!reused) {
			cachedEngine = null;
			try {
				await whisper.load(o.device);
			} catch (e) {
				if (o.device === 'webgpu') {
					log('warn', `WebGPU non utilizzabile (${(e as Error).message}): uso WebAssembly, più lento.`);
					await whisper.load('wasm');
				} else throw e;
			}
			cachedEngine = { key, engine: whisper };
		}
		whisper.setPrompt(o.context);
		if (o.context.trim()) log('info', 'Contesto (corso e termini) usato come prompt iniziale di Whisper.');
		engine = whisper;
		whisperForStats = whisper;
		statsBefore = { ...whisper.stats };
		engineLabel = `${modelId} · ${whisper.device === 'webgpu' ? 'WebGPU' : 'WebAssembly (CPU)'} · ${whisper.dtypeLabel}`;
		log(
			'info',
			reused
				? `Modello già caricato dal video precedente, riutilizzato: ${engineLabel}`
				: `Modello pronto in ${formatDuration(performance.now() - loadStart)}: ${engineLabel}`,
		);
	}

	// 3) trascrizione
	const tStart = performance.now();
	const segments: TranscriptSegment[] = [];
	let result;
	try {
		result = await runTranscription(feed, engine, o.language, {
			onSegments: (segs) => {
				segments.push(...segs);
				post({ type: 'segments', segments: segs });
			},
			onProgress: (done, total, info) => {
				const now = performance.now();
				if (now - lastPost < 250) return;
				lastPost = now;
				const fraction = Math.min(1, done / Math.max(1, total));
				const elapsedMs = now - tStart;
				post({
					type: 'progress',
					progress: {
						fraction,
						stage: 'Trascrizione in corso',
						detail: `${hms(done)} di ${hms(total)} · ${formatNumber(done / Math.max(0.001, elapsedMs / 1000), 1)}× tempo reale · ${info}`,
						elapsedMs: now - t0,
						etaMs: estimateEta(fraction, elapsedMs),
					},
				});
			},
			onLog: log,
			isCancelled: () => cancelled,
		});
	} catch (err) {
		// Salva comunque quanto trascritto, dichiarandolo incompleto.
		if (segments.length) {
			const partial = await writeOutputs(
				target, runId, baseName, segments, [], o,
				[`ATTENZIONE: TRASCRIZIONE INCOMPLETA — elaborazione interrotta: ${(err as Error).message}`,
					`Ultimo istante trascritto: ${hms(segments[segments.length - 1].end)}`],
				true,
			);
			post({ type: 'error', message: String((err as Error).message), outputs: partial });
			return;
		}
		throw err;
	}
	await decoding;

	const coveredSec = result.audioSec;
	const header: string[] = [];
	if (!result.complete) {
		header.push(
			'ATTENZIONE: TRASCRIZIONE INCOMPLETA — alcune parti non sono state trascritte (segnate nel testo come [PARTE NON TRASCRITTA]).',
		);
	}
	const outputs = await writeOutputs(target, runId, baseName, result.segments, result.gaps, o, header, !result.complete);
	const elapsed = (performance.now() - tStart) / 1000;
	logTiming(elapsed * 1000, result.timing, feed.waitMs, whisperForStats, statsBefore);
	const summary =
		`${formatNumber(result.segments.length)} segmenti · audio ${hms(coveredSec)} trascritto in ${formatDuration(elapsed * 1000)} ` +
		`(${formatNumber(coveredSec / Math.max(0.001, elapsed), 1)}× tempo reale) · lingua: ${result.language}` +
		(result.silenceSec >= 1 ? ` · ${hms(result.silenceSec)} di silenzio` : '') +
		(result.retries ? ` · ${result.retries} finestre ripetute per sicurezza` : '') +
		(result.recovered ? ` · ${result.recovered} segmenti recuperati nei tratti saltati` : '') +
		(result.lowConfidence ? ` · ${result.lowConfidence} finestre a bassa confidenza (da ricontrollare)` : '') +
		` · ${engineLabel}`;
	post({
		type: 'done',
		outputs,
		summary,
		complete: result.complete,
		extra: { gaps: result.gaps, language: result.language, audioSec: coveredSec },
	});
}

/** Due righe nel registro: dove è andato il tempo, e quanto costano encoder e generazione del testo. */
function logTiming(
	totalMs: number,
	timing: CoreTiming,
	waitMs: number,
	whisper: WhisperEngine | null,
	before: WhisperEngine['stats'] | null,
) {
	const d = (ms: number) => formatDuration(ms);
	const pct = (ms: number) => `${Math.round((ms / Math.max(1, totalMs)) * 100)}%`;
	log(
		'info',
		`Tempi: primo passaggio ${d(timing.firstMs)} (${pct(timing.firstMs)}) · nuovi tentativi ${d(timing.retryMs)} (${pct(timing.retryMs)}) · ` +
			`seconda passata ${d(timing.repassMs)} (${pct(timing.repassMs)}) · attesa dell'audio ${d(waitMs)} (${pct(waitMs)})`,
	);
	if (!whisper || !before) return;
	const now = whisper.stats;
	const generations = now.generations - before.generations;
	const tokens = now.tokens - before.tokens;
	const encMs = now.encoderMs - before.encoderMs;
	const genMs = now.generateMs - before.generateMs;
	const featMs = now.featuresMs - before.featuresMs;
	const reused = now.encoderReused - before.encoderReused;
	const encCount = generations - reused;
	log(
		'info',
		`Modello: preparazione audio ${d(featMs)} · ` +
			(encMs > 0
				? `encoder ${d(encMs)}${encCount > 0 ? ` (${formatNumber(encMs / encCount / 1000, 2)} s per finestra)` : ''}`
				: 'encoder compreso nella generazione') +
			` · generazione del testo ${d(genMs)} (${formatNumber(tokens)} token` +
			(tokens > 0 ? `, ${formatNumber(genMs / tokens, 1)} ms l'uno` : '') +
			')' +
			(reused > 0 ? ` · encoder riusato ${reused} volte nei nuovi tentativi` : ''),
	);
}

async function writeOutputs(
	target: OutputTarget,
	runId: string,
	baseName: string,
	segments: TranscriptSegment[],
	gaps: { start: number; end: number; reason: string }[],
	o: TranscribeOptions,
	header: string[],
	partial: boolean,
): Promise<OutputRef[]> {
	const enc = new TextEncoder();
	const outputs: OutputRef[] = [];
	const txtName = partial ? 'TRASCRIZIONE_INCOMPLETA.txt' : 'TRASCRIZIONE.txt';
	const txt = await OutFile.open(target, runId, txtName);
	await txt.append(enc.encode('﻿' + buildTxt(segments, gaps, o.timestamps, header)));
	outputs.push(await txt.close());
	if (o.srt) {
		const srt = await OutFile.open(target, runId, partial ? 'SOTTOTITOLI_INCOMPLETI.srt' : 'SOTTOTITOLI.srt');
		await srt.append(enc.encode('﻿' + buildSrt(segments)));
		outputs.push(await srt.close());
	}
	void baseName;
	return outputs;
}
