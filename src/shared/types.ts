// Tipi condivisi tra interfaccia e worker.

/** Dove scrivere gli output. */
export type OutputTarget =
	| { kind: 'opfs' }
	| { kind: 'dir'; handle: FileSystemDirectoryHandle };

/** Riferimento a un file di output già scritto. */
export interface OutputRef {
	storage: 'opfs' | 'dir' | 'memory';
	/** Nome file (in OPFS è il nome interno con prefisso; in cartella è il nome reale). */
	name: string;
	/** Nome suggerito per il download. */
	downloadName: string;
	bytes: number;
	/** Solo per storage === 'memory'. */
	blob?: Blob;
}

export type FrameMode = 'all' | 'interval' | 'smart';
export type ImageFormat = 'jpeg' | 'png';

export interface FramesOptions {
	mode: FrameMode;
	/** Secondi tra un frame e l'altro (modalità intervallo). */
	intervalSec: number;
	format: ImageFormat;
	/** 0..1, solo JPEG. */
	quality: number;
	/** 1..100: più alto = più sensibile ai cambiamenti (modalità intelligente). */
	smartSensitivity: number;
	/** Passo di analisi in secondi (modalità intelligente). */
	smartStep: number;
	/** Ignora le zone che cambiano di continuo (webcam, video incorporati). */
	smartIgnoreDynamic: boolean;
	/** Dimensione massima di ogni ZIP in byte, 0 = nessuna divisione. */
	splitBytes: number;
	/** Numero di worker di codifica immagini. */
	encoderThreads: number;
	/** Accelerazione hardware per la decodifica. */
	hardwareAcceleration: 'prefer-hardware' | 'no-preference' | 'prefer-software';
}

export type WhisperModelKey = 'base' | 'small' | 'turbo';

export interface TranscribeOptions {
	/** 'auto' = rilevamento automatico. */
	language: 'it' | 'en' | 'auto';
	model: WhisperModelKey;
	/** Dispositivo preferito. */
	device: 'webgpu' | 'wasm';
	/** Contesto opzionale (corso, termini tecnici). */
	context: string;
	timestamps: 'none' | 'paragraph' | 'segment';
	srt: boolean;
}

export interface CompressOptions {
	targetBytes: number;
	/** Se il risultato supera l'obiettivo, ripete la codifica una volta con bitrate corretto. */
	retryIfOver: boolean;
	hardwareAcceleration: 'prefer-hardware' | 'no-preference';
}

export interface ProgressInfo {
	/** 0..1, null se non ancora noto. */
	fraction: number | null;
	/** Testo breve sullo stato. */
	stage: string;
	/** Dettagli misurati (contatori, velocità). */
	detail?: string;
	/** Millisecondi trascorsi, misurati. */
	elapsedMs: number;
	/** Stima millisecondi residui, null se non affidabile. */
	etaMs: number | null;
}

export interface TranscriptSegment {
	start: number;
	end: number;
	text: string;
	/** Segnalazioni (es. possibile ripetizione del modello). */
	flags?: string[];
}

export interface TranscriptGap {
	start: number;
	end: number;
	reason: string;
}

export type WorkerOut =
	| { type: 'progress'; progress: ProgressInfo }
	| { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
	| { type: 'segments'; segments: TranscriptSegment[] }
	| { type: 'done'; outputs: OutputRef[]; summary: string; complete: boolean; extra?: Record<string, unknown> }
	| { type: 'error'; message: string; outputs?: OutputRef[] };
