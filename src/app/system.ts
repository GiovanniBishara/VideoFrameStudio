// Controlli sulle capacità reali del browser e gestione degli output salvati.

import { ALL_FORMATS, BlobSource, Input, Quality, canEncodeVideo } from 'mediabunny';
import { OPFS_PREFIX } from '../shared/outfile';
import type { OutputRef } from '../shared/types';

export interface Capabilities {
	webcodecs: boolean;
	webgpu: boolean;
	gpuName: string | null;
	shaderF16: boolean;
	opfs: boolean;
	dirPicker: boolean;
	storageFree: number | null;
	cores: number;
	memoryGB: number | null;
}

export async function detectCapabilities(): Promise<Capabilities> {
	const nav = navigator as Navigator & {
		gpu?: { requestAdapter(o?: unknown): Promise<{ features: Set<string>; info?: { vendor?: string; architecture?: string; description?: string } } | null> };
		deviceMemory?: number;
	};
	let webgpu = false;
	let gpuName: string | null = null;
	let shaderF16 = false;
	try {
		const adapter = await nav.gpu?.requestAdapter({ powerPreference: 'high-performance' });
		if (adapter) {
			const info = adapter.info;
			gpuName = [info?.vendor, info?.description || info?.architecture].filter(Boolean).join(' ') || null;
			// Un adattatore "di riserva" (es. SwiftShader) è WebGPU emulato su CPU: non conta come GPU.
			const fallback = (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter || /swiftshader/i.test(gpuName ?? '');
			webgpu = !fallback;
			if (fallback) gpuName = 'solo emulazione software';
			shaderF16 = adapter.features.has('shader-f16');
		}
	} catch {
		/* WebGPU non disponibile */
	}
	let opfs = false;
	try {
		await navigator.storage.getDirectory();
		opfs = true;
	} catch {
		opfs = false;
	}
	let storageFree: number | null = null;
	try {
		const est = await navigator.storage.estimate();
		if (est.quota !== undefined && est.usage !== undefined) storageFree = est.quota - est.usage;
	} catch {
		/* ignorato */
	}
	let dirPicker = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
	try {
		if (window.top !== window.self) dirPicker = false; // nei frame incorporati il selettore è bloccato
	} catch {
		dirPicker = false;
	}
	return {
		webcodecs: typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined',
		webgpu,
		gpuName,
		shaderF16,
		opfs,
		dirPicker,
		storageFree,
		cores: navigator.hardwareConcurrency || 4,
		memoryGB: nav.deviceMemory ?? null,
	};
}

export interface VideoInfo {
	name: string;
	size: number;
	duration: number;
	container: string;
	width: number | null;
	height: number | null;
	fps: number | null;
	videoCodec: string | null;
	canDecodeVideo: boolean;
	audioCodec: string | null;
	sampleRate: number | null;
	channels: number | null;
	canDecodeAudio: boolean;
	audioBitrate: number | null;
}

export async function probeVideo(file: File): Promise<VideoInfo> {
	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
	if (!(await input.canRead())) throw new Error('Formato del file non riconosciuto.');
	const format = await input.getFormat();
	const vt = await input.getPrimaryVideoTrack();
	const at = await input.getPrimaryAudioTrack();
	const duration = await input.computeDuration();
	const info: VideoInfo = {
		name: file.name,
		size: file.size,
		duration,
		container: format.name,
		width: null,
		height: null,
		fps: null,
		videoCodec: null,
		canDecodeVideo: false,
		audioCodec: null,
		sampleRate: null,
		channels: null,
		canDecodeAudio: false,
		audioBitrate: null,
	};
	if (vt) {
		info.width = await vt.getDisplayWidth();
		info.height = await vt.getDisplayHeight();
		info.videoCodec = await vt.getCodecParameterString().catch(() => null) ?? (await vt.getCodec());
		info.canDecodeVideo = await vt.canDecode();
		try {
			info.fps = (await vt.computeFrameRateMetrics()).bestGuessFrameRate;
		} catch {
			info.fps = null;
		}
	}
	if (at) {
		info.audioCodec = await at.getCodecParameterString().catch(() => null) ?? (await at.getCodec());
		info.sampleRate = await at.getSampleRate();
		info.channels = await at.getNumberOfChannels();
		info.canDecodeAudio = await at.canDecode();
		try {
			info.audioBitrate = (await at.computePacketStats(2000)).averageBitrate;
		} catch {
			info.audioBitrate = null;
		}
	}
	return info;
}

/** Numero esatto di fotogrammi (dai dati del contenitore). */
export async function countFrames(file: File): Promise<number | null> {
	const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
	const vt = await input.getPrimaryVideoTrack();
	if (!vt) return null;
	return (await vt.computePacketStats()).packetCount;
}

export async function checkH264Encode(width: number, height: number, hardware: boolean): Promise<boolean> {
	try {
		return await canEncodeVideo('avc', {
			width: width - (width % 2),
			height: height - (height % 2),
			quality: new Quality({ bitrate: 4_000_000 }),
			hardwareAcceleration: hardware ? 'prefer-hardware' : 'no-preference',
		});
	} catch {
		return false;
	}
}

// --- output -------------------------------------------------------------------

export async function downloadOutput(ref: OutputRef) {
	let blob: Blob;
	if (ref.storage === 'memory' && ref.blob) blob = ref.blob;
	else if (ref.storage === 'opfs') {
		const root = await navigator.storage.getDirectory();
		blob = await (await root.getFileHandle(ref.name)).getFile(); // file su disco, non copiato in RAM
	} else throw new Error('Il file è già salvato nella cartella scelta.');
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = ref.downloadName;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

export async function readTextOutput(ref: OutputRef): Promise<string> {
	if (ref.storage === 'memory' && ref.blob) return ref.blob.text();
	if (ref.storage === 'opfs') {
		const root = await navigator.storage.getDirectory();
		return (await (await root.getFileHandle(ref.name)).getFile()).text();
	}
	return '';
}

/** Spazio occupato da elaborazioni precedenti nell'archivio del browser. */
export async function leftoverBytes(exceptRun?: string): Promise<number> {
	let total = 0;
	try {
		const root = await navigator.storage.getDirectory();
		for await (const [name, handle] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
			if (!name.startsWith(OPFS_PREFIX) || (exceptRun && name.startsWith(`${OPFS_PREFIX}${exceptRun}-`))) continue;
			if (handle.kind === 'file') total += (await (handle as FileSystemFileHandle).getFile()).size;
		}
	} catch {
		/* ignorato */
	}
	return total;
}

export async function clearLeftovers(exceptRun?: string) {
	try {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const [name] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
			if (name.startsWith(OPFS_PREFIX) && !(exceptRun && name.startsWith(`${OPFS_PREFIX}${exceptRun}-`))) names.push(name);
		}
		for (const n of names) {
			try {
				await root.removeEntry(n);
			} catch {
				/* in uso */
			}
		}
	} catch {
		/* ignorato */
	}
}

/** Stima indicativa dei byte per immagine. */
export function estimateImageBytes(width: number, height: number, format: 'jpeg' | 'png', quality: number) {
	const px = width * height;
	return format === 'png' ? px * 0.8 : px * (0.05 + 0.15 * quality * quality);
}

/**
 * Tiene acceso lo schermo durante una coda lunga (il PC non va in standby finché la
 * scheda resta in primo piano). Il blocco si perde quando la scheda va in secondo
 * piano: viene richiesto di nuovo al ritorno.
 */
export async function keepScreenAwake(): Promise<{ release(): void }> {
	const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
	if (!wl) return { release() {} };
	let sentinel: WakeLockSentinelLike | null = null;
	let active = true;
	const acquire = async () => {
		try {
			if (active && document.visibilityState === 'visible' && (!sentinel || sentinel.released)) {
				sentinel = await wl.request('screen');
			}
		} catch {
			/* non concesso: si continua senza */
		}
	};
	const onVisibility = () => {
		void acquire();
	};
	document.addEventListener('visibilitychange', onVisibility);
	await acquire();
	return {
		release() {
			active = false;
			document.removeEventListener('visibilitychange', onVisibility);
			sentinel?.release().catch(() => {});
		},
	};
}

interface WakeLockSentinelLike {
	released: boolean;
	release(): Promise<void>;
}
