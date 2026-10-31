// Compressione video verso una dimensione obiettivo: H.264 in MP4 con WebCodecs
// (accelerazione hardware richiesta esplicitamente), FPS e risoluzione originali,
// audio copiato senza ricodifica quando il formato lo consente.

import {
	ALL_FORMATS,
	BlobSource,
	Conversion,
	Input,
	Mp4OutputFormat,
	Output,
	Quality,
	StreamTarget,
	canEncodeVideo,
} from 'mediabunny';
import { estimateEta, formatBytes, formatNumber } from '../shared/format';
import { OutFile, removeOutput } from '../shared/outfile';
import type { CompressOptions, OutputTarget, WorkerOut } from '../shared/types';

interface StartMsg {
	type: 'start';
	file: File;
	options: CompressOptions;
	target: OutputTarget;
	runId: string;
}

let cancelled = false;
let current: Conversion | null = null;
const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);
const log = (level: 'info' | 'warn' | 'error', message: string) => post({ type: 'log', level, message });

self.onmessage = (e: MessageEvent<StartMsg | { type: 'cancel' }>) => {
	if (e.data.type === 'cancel') {
		cancelled = true;
		void current?.cancel();
		return;
	}
	run(e.data).catch((err) => post({ type: 'error', message: String((err as Error)?.message ?? err) }));
};

/** Margine per l'overhead del contenitore MP4 (indici, intestazioni). */
export function planBitrate(targetBytes: number, durationSec: number, audioBitrate: number) {
	const overheadBytes = targetBytes * 0.012 + 512 * 1024;
	const videoBits = (targetBytes - overheadBytes) * 8 - audioBitrate * durationSec;
	return Math.floor(videoBits / durationSec);
}

async function run(msg: StartMsg) {
	const { file, options: o, target, runId } = msg;
	const t0 = performance.now();
	const probe = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
	const vt = await probe.getPrimaryVideoTrack();
	if (!vt) throw new Error('Il file non contiene una traccia video.');
	const at = await probe.getPrimaryAudioTrack();
	const duration = await probe.computeDuration();
	const width = await vt.getCodedWidth();
	const height = await vt.getCodedHeight();
	const fps = (await vt.computeFrameRateMetrics()).bestGuessFrameRate;
	const audioBitrate = at ? (await at.computePacketStats(4000)).averageBitrate : 0;

	if (file.size <= o.targetBytes) {
		log('info', `Il file è già di ${formatBytes(file.size)}, sotto l'obiettivo: la compressione non è necessaria ma viene eseguita come richiesto.`);
	}

	let videoBitrate = planBitrate(o.targetBytes, duration, audioBitrate);
	const minBitrate = Math.max(150_000, width * height * fps * 0.01);
	if (videoBitrate < minBitrate) {
		throw new Error(
			`Obiettivo troppo basso: per ${formatBytes(o.targetBytes)} su ${formatNumber(duration / 60, 1)} minuti il video avrebbe ` +
				`${formatNumber(videoBitrate / 1000)} kbit/s, insufficienti per ${width}×${height}. Aumenta la dimensione obiettivo.`,
		);
	}

	const supported = await canEncodeVideo('avc', {
		width,
		height,
		quality: new Quality({ bitrate: videoBitrate }),
		hardwareAcceleration: o.hardwareAcceleration,
	});
	if (!supported) {
		throw new Error(
			o.hardwareAcceleration === 'prefer-hardware'
				? 'La codifica H.264 con accelerazione hardware non è disponibile in questo browser. ' +
					'Puoi riprovare scegliendo "Consenti codifica software" (più lenta).'
				: 'La codifica H.264 non è disponibile in questo browser.',
		);
	}

	for (let attempt = 1; attempt <= 2; attempt++) {
		const out = await OutFile.open(target, runId, 'VIDEO_COMPRESSO.mp4');
		const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: 'reserve' }),
			target: new StreamTarget(out.asStreamTargetWritable()),
		});
		const conversion = await Conversion.init({
			input,
			output,
			video: {
				codec: 'avc',
				quality: new Quality({ bitrate: videoBitrate }),
				hardwareAcceleration: o.hardwareAcceleration,
				forceTranscode: true,
			},
		});
		if (!conversion.isValid) {
			await out.discard();
			const reasons = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
			throw new Error(`Conversione non possibile (${reasons}).`);
		}
		const audioNote = conversion.discardedTracks.length
			? ` (tracce scartate: ${conversion.discardedTracks.map((d) => d.reason).join(', ')})`
			: '';
		log('info', `Tentativo ${attempt}: video ${formatNumber(videoBitrate / 1e6, 2)} Mbit/s, ${formatNumber(fps, 2)} FPS, ${width}×${height}${audioNote}`);
		const tStart = performance.now();
		let lastPost = 0;
		conversion.onProgress = (p: number) => {
			const now = performance.now();
			if (now - lastPost < 250) return;
			lastPost = now;
			const elapsedMs = now - tStart;
			post({
				type: 'progress',
				progress: {
					fraction: p,
					stage: attempt === 1 ? 'Compressione in corso' : 'Seconda codifica con bitrate corretto',
					detail: `${formatBytes(out.size)} scritti · ${formatNumber((p * duration) / Math.max(0.001, elapsedMs / 1000), 1)}× tempo reale`,
					elapsedMs: now - t0,
					etaMs: estimateEta(p, elapsedMs),
				},
			});
		};
		current = conversion;
		try {
			await conversion.execute();
		} catch (err) {
			await out.discard();
			throw cancelled ? new Error('Interrotto dall\'utente') : err;
		} finally {
			current = null;
		}
		const ref = await out.close();
		const elapsed = (performance.now() - tStart) / 1000;
		const over = ref.bytes > o.targetBytes;
		if (over && o.retryIfOver && attempt === 1) {
			const audioBytes = (audioBitrate * duration) / 8;
			const actualVideo = Math.max(1, ref.bytes - audioBytes - o.targetBytes * 0.012);
			const wantedVideo = (videoBitrate * duration) / 8;
			videoBitrate = Math.floor(videoBitrate * (wantedVideo / actualVideo) * 0.97);
			log('warn', `Risultato ${formatBytes(ref.bytes)} oltre l'obiettivo: nuova codifica con bitrate ridotto.`);
			await removeOutput(target, ref); // elimina il primo risultato
			continue;
		}
		const summary =
			`${formatBytes(file.size)} → ${formatBytes(ref.bytes)} (obiettivo ${formatBytes(o.targetBytes)}` +
			`${over ? ', NON RAGGIUNTO: il codificatore ha superato il bitrate richiesto' : ', rispettato'}) · ` +
			`${formatNumber(elapsed, 0)} s (${formatNumber(duration / Math.max(0.001, elapsed), 1)}× tempo reale) · ` +
			`H.264 ${formatNumber(videoBitrate / 1e6, 2)} Mbit/s, FPS e risoluzione originali`;
		post({ type: 'done', outputs: [ref], summary, complete: !over, extra: { bytes: ref.bytes, over } });
		return;
	}
}
