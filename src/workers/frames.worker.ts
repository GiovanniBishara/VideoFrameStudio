// Estrazione dei fotogrammi: decodifica (hardware se disponibile) con
// Mediabunny/WebCodecs, codifica JPG/PNG su più worker in parallelo,
// scrittura progressiva in uno o più ZIP.

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from 'mediabunny';
import { csvDecimal, estimateEta, frameFileName, hmsMillis, formatBytes, formatNumber } from '../shared/format';
import { OutFile } from '../shared/outfile';
import { ChangeDetector, THUMB_H, THUMB_W, rgbaToGray } from '../shared/smart';
import type { FramesOptions, OutputRef, OutputTarget, WorkerOut } from '../shared/types';
import { ZipWriter } from '../shared/zip';
import { createWorkerFromSpec, type WorkerSpec } from '../workerUrls';

interface StartMsg {
	type: 'start';
	file: File;
	options: FramesOptions;
	target: OutputTarget;
	runId: string;
	/** Codice o URL del worker di codifica. */
	encoder: WorkerSpec;
}

let cancelled = false;
const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<StartMsg | { type: 'cancel' }>) => {
	if (e.data.type === 'cancel') {
		cancelled = true;
		return;
	}
	run(e.data).catch((err) => post({ type: 'error', message: String((err as Error)?.message ?? err) }));
};

// --- pool di codificatori -----------------------------------------------------

class EncoderPool {
	private workers: Worker[] = [];
	private busy: number[] = [];
	private nextId = 1;
	private callbacks = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void; w: number }>();
	inFlight = 0;
	private waiters: (() => void)[] = [];
	readonly limit: number;

	constructor(n: number, spec: WorkerSpec) {
		for (let i = 0; i < n; i++) {
			const w = createWorkerFromSpec(spec, `encoder-${i + 1}`);
			w.onmessage = (ev: MessageEvent<{ id: number; buf?: ArrayBuffer; error?: string }>) => {
				const cb = this.callbacks.get(ev.data.id);
				if (!cb) return;
				this.callbacks.delete(ev.data.id);
				this.busy[cb.w]--;
				this.inFlight--;
				this.waiters.shift()?.();
				if (ev.data.buf) cb.resolve(ev.data.buf);
				else cb.reject(new Error(ev.data.error ?? 'errore di codifica'));
			};
			w.onerror = (ev) => {
				for (const [id, cb] of this.callbacks) {
					if (cb.w === i) {
						this.callbacks.delete(id);
						cb.reject(new Error(`Worker di codifica terminato: ${ev.message}`));
					}
				}
			};
			this.workers.push(w);
			this.busy.push(0);
		}
		this.limit = n * 2;
	}

	async slot() {
		while (this.inFlight >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
	}

	encode(bitmap: ImageBitmap, format: 'jpeg' | 'png', quality: number): Promise<ArrayBuffer> {
		let w = 0;
		for (let i = 1; i < this.workers.length; i++) if (this.busy[i] < this.busy[w]) w = i;
		const id = this.nextId++;
		this.busy[w]++;
		this.inFlight++;
		return new Promise((resolve, reject) => {
			this.callbacks.set(id, { resolve, reject, w });
			this.workers[w].postMessage({ id, bitmap, format, quality }, [bitmap]);
		});
	}

	close() {
		for (const w of this.workers) w.terminate();
	}
}

// --- ZIP suddivisi --------------------------------------------------------------

class ZipParts {
	private file: OutFile | null = null;
	private zip: ZipWriter | null = null;
	private partRows: string[] = [];
	private allRows: string[] = [];
	private part = 0;
	readonly outputs: OutputRef[] = [];
	bytesTotal = 0;
	private static readonly HEADER = 'numero;timestamp_secondi;timestamp;file;archivio';

	constructor(
		private target: OutputTarget,
		private runId: string,
		private splitBytes: number,
	) {}

	private partName() {
		return this.splitBytes > 0 ? `FRAMES_parte${String(this.part).padStart(2, '0')}.zip` : 'FRAMES.zip';
	}

	private async open() {
		this.part++;
		this.file = await OutFile.open(this.target, this.runId, this.partName());
		const f = this.file;
		this.zip = new ZipWriter({ append: (d) => f.append(d) });
		this.partRows = [];
	}

	private csv(rows: string[]) {
		// BOM per la corretta apertura in Excel; separatore ';' (impostazioni italiane).
		return new TextEncoder().encode('﻿' + [ZipParts.HEADER, ...rows].join('\r\n') + '\r\n');
	}

	private async closePart(isLast: boolean) {
		if (!this.zip || !this.file) return;
		await this.zip.add('frames_index.csv', this.csv(this.partRows));
		if (isLast && this.part > 1) {
			await this.zip.add('frames_index_completo.csv', this.csv(this.allRows));
		}
		await this.zip.finish();
		const ref = await this.file.close();
		this.bytesTotal += ref.bytes;
		this.outputs.push(ref);
		this.zip = null;
		this.file = null;
	}

	async add(index: number, timestamp: number, name: string, data: Uint8Array) {
		if (!this.zip) await this.open();
		if (
			this.splitBytes > 0 &&
			this.zip!.entryCount > 0 &&
			this.zip!.projectedSizeWith(name, data.byteLength) + (this.partRows.length + 1) * 80 > this.splitBytes
		) {
			await this.closePart(false);
			await this.open();
		}
		await this.zip!.add(name, data);
		const archive = this.partName();
		const row = `${index};${csvDecimal(timestamp)};${hmsMillis(timestamp)};${name};${archive}`;
		this.partRows.push(row);
		this.allRows.push(row);
	}

	get currentBytes() {
		return this.bytesTotal + (this.zip?.bytesWritten ?? 0);
	}

	async finish() {
		if (!this.zip) await this.open(); // anche senza frame produce uno ZIP valido con l'indice
		await this.closePart(true);
	}

	async discard() {
		await this.file?.discard();
	}
}

// --- lavoro principale ---------------------------------------------------------

async function run(msg: StartMsg) {
	const { file, options: o, target, runId } = msg;
	const t0 = performance.now();
	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('Il file non contiene una traccia video.');
	if (!(await track.canDecode())) {
		const codec = await track.getCodec();
		throw new Error(`Il browser non sa decodificare il video (codec: ${codec ?? 'sconosciuto'}).`);
	}
	const width = await track.getDisplayWidth();
	const height = await track.getDisplayHeight();
	const first = await track.getFirstTimestamp();
	const end = await track.computeDuration();
	const span = Math.max(1e-6, end - first);

	// Decodifica hardware se il browser la offre per questo codec, altrimenti software (dichiarato nel registro).
	let hardwareAcceleration = o.hardwareAcceleration;
	const decoderConfig = await track.getDecoderConfig();
	if (decoderConfig && hardwareAcceleration !== 'no-preference') {
		const support = await VideoDecoder.isConfigSupported({ ...decoderConfig, hardwareAcceleration }).catch(() => null);
		if (!support?.supported) {
			post({ type: 'log', level: 'warn', message: 'Decodifica video hardware non disponibile per questo file: uso la decodifica software.' });
			hardwareAcceleration = 'no-preference';
		} else {
			post({ type: 'log', level: 'info', message: `Decodifica video: ${decoderConfig.codec}, accelerazione hardware richiesta.` });
		}
	}
	const sink = new VideoSampleSink(track, { hardwareAcceleration });
	const pool = new EncoderPool(Math.max(1, o.encoderThreads), msg.encoder);
	const zips = new ZipParts(target, runId, o.splitBytes);
	const ext = o.format === 'png' ? 'png' : 'jpg';

	const full = new OffscreenCanvas(width, height);
	const fullCtx = full.getContext('2d', { alpha: false })!;

	let decoded = 0;
	let extracted = 0;
	let duplicates = 0;
	let lastTs = first;
	let lastPost = 0;
	let writeError: Error | null = null;

	// Scrittura ordinata: i risultati arrivano in ordine sparso dai worker.
	const ready = new Map<number, { ts: number; data: Uint8Array }>();
	let nextToWrite = 1;
	let writing: Promise<void> = Promise.resolve();
	const drain = () => {
		writing = writing.then(async () => {
			while (ready.has(nextToWrite)) {
				const item = ready.get(nextToWrite)!;
				ready.delete(nextToWrite);
				await zips.add(nextToWrite, item.ts, frameFileName(nextToWrite, item.ts, ext), item.data);
				nextToWrite++;
			}
		});
		writing.catch((e) => (writeError = e as Error));
	};

	const progress = (force = false) => {
		const now = performance.now();
		if (!force && now - lastPost < 250) return;
		lastPost = now;
		const elapsedMs = now - t0;
		const fraction = Math.min(1, Math.max(0, (lastTs - first) / span));
		const fps = decoded / Math.max(0.001, elapsedMs / 1000);
		post({
			type: 'progress',
			progress: {
				fraction,
				stage: 'Estrazione in corso',
				detail: `${formatNumber(extracted)} frame estratti · ${formatNumber(fps, 1)} frame/s decodificati · ${formatBytes(zips.currentBytes)} scritti`,
				elapsedMs,
				etaMs: estimateEta(fraction, elapsedMs),
			},
		});
	};

	let index = 0;
	const submit = async (bitmap: ImageBitmap, ts: number) => {
		await pool.slot();
		const myIndex = ++index;
		pool.encode(bitmap, o.format, o.quality).then(
			(buf) => {
				ready.set(myIndex, { ts, data: new Uint8Array(buf) });
				extracted++;
				drain();
			},
			(err) => {
				writeError ??= err as Error;
			},
		);
	};

	const renderFull = (sample: VideoSample): ImageBitmap => {
		sample.draw(fullCtx, 0, 0, width, height);
		return full.transferToImageBitmap();
	};

	const checkAbort = () => {
		if (cancelled) throw new Error('Interrotto dall\'utente');
		if (writeError) throw writeError;
	};

	// istanti first, first+step, … strettamente prima della fine del video
	function* timeline(step: number) {
		for (let k = 0; first + k * step < end - 1e-6; k++) yield first + k * step;
	}

	try {
		if (o.mode === 'all') {
			for await (const sample of sink.samples()) {
				try {
					checkAbort();
					decoded++;
					lastTs = sample.timestamp;
					await submit(renderFull(sample), sample.timestamp);
				} finally {
					sample.close();
				}
				progress();
			}
		} else if (o.mode === 'interval') {
			let prevTs = -Infinity;
			for await (const sample of sink.samplesAtTimestamps(timeline(Math.max(0.01, o.intervalSec)))) {
				if (!sample) continue;
				try {
					checkAbort();
					decoded++;
					lastTs = sample.timestamp;
					if (Math.abs(sample.timestamp - prevTs) < 1e-6) {
						duplicates++; // intervallo più breve della durata di un frame
						continue;
					}
					prevTs = sample.timestamp;
					await submit(renderFull(sample), sample.timestamp);
				} finally {
					sample.close();
				}
				progress();
			}
		} else {
			const detector = new ChangeDetector(o.smartSensitivity, o.smartIgnoreDynamic);
			const thumb = new OffscreenCanvas(THUMB_W, THUMB_H);
			const tctx = thumb.getContext('2d', { alpha: false, willReadFrequently: true })!;
			const gray = new Uint8Array(THUMB_W * THUMB_H);
			let prevBitmap: { bmp: ImageBitmap; ts: number } | null = null;
			let prevTs = -Infinity;
			for await (const sample of sink.samplesAtTimestamps(timeline(Math.max(0.1, o.smartStep)))) {
				if (!sample) continue;
				try {
					checkAbort();
					decoded++;
					lastTs = sample.timestamp;
					if (Math.abs(sample.timestamp - prevTs) < 1e-6) continue;
					prevTs = sample.timestamp;
					sample.draw(tctx, 0, 0, THUMB_W, THUMB_H);
					rgbaToGray(tctx.getImageData(0, 0, THUMB_W, THUMB_H).data, gray);
					const decision = detector.push(gray, sample.timestamp);
					const current = { bmp: renderFull(sample), ts: sample.timestamp };
					if (decision.keepPrevious && prevBitmap) {
						await submit(prevBitmap.bmp, prevBitmap.ts);
						prevBitmap = null;
					}
					prevBitmap?.bmp.close();
					prevBitmap = null;
					if (decision.keepCurrent) await submit(current.bmp, current.ts);
					else prevBitmap = current;
				} finally {
					sample.close();
				}
				progress();
			}
			if (detector.finish() && prevBitmap) {
				await submit(prevBitmap.bmp, prevBitmap.ts);
				prevBitmap = null;
			}
			prevBitmap?.bmp.close();
		}

		// attende la fine delle codifiche e delle scritture
		while (pool.inFlight > 0) {
			checkAbort();
			await new Promise((r) => setTimeout(r, 20));
		}
		await writing;
		checkAbort();
		if (nextToWrite - 1 !== index) throw new Error(`Frame mancanti nello ZIP (${nextToWrite - 1} di ${index}).`);
		await zips.finish();
	} catch (err) {
		pool.close();
		await zips.discard();
		throw err;
	}
	pool.close();
	lastTs = end;
	progress(true);

	const elapsed = (performance.now() - t0) / 1000;
	const modeLabel = o.mode === 'all' ? 'tutti i frame' : o.mode === 'interval' ? `un frame ogni ${o.intervalSec} s` : 'estrazione intelligente';
	const summary =
		`${formatNumber(index)} frame (${modeLabel}) in ${formatNumber(elapsed, 1)} s · ` +
		`${formatNumber(decoded / Math.max(0.001, elapsed), 0)} frame/s decodificati · ` +
		`${formatBytes(zips.bytesTotal)} in ${zips.outputs.length} ZIP` +
		(duplicates ? ` · ${duplicates} istanti coincidenti con il frame precedente non duplicati` : '');
	post({
		type: 'done',
		outputs: zips.outputs,
		summary,
		complete: true,
		extra: { frames: index, decoded, width, height },
	});
}
