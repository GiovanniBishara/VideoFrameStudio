import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import {
	type Capabilities,
	type VideoInfo,
	checkH264Encode,
	clearLeftovers,
	countFrames,
	detectCapabilities,
	downloadOutput,
	estimateImageBytes,
	keepScreenAwake,
	leftoverBytes,
	probeVideo,
} from './app/system';
import { formatBytes, formatDuration, formatNumber, hms } from './shared/format';
import type {
	CompressOptions,
	FramesOptions,
	OutputRef,
	OutputTarget,
	ProgressInfo,
	TranscribeOptions,
	TranscriptSegment,
	WorkerOut,
} from './shared/types';
import { createWorker, workerSpec, type WorkerName } from './workerUrls';

declare const __TEST_BUILD__: boolean;

type JobKey = 'frames' | 'transcribe' | 'compress';
type JobStatus = 'idle' | 'waiting' | 'running' | 'done' | 'error' | 'cancelled';
interface JobState {
	status: JobStatus;
	progress: ProgressInfo | null;
	outputs: OutputRef[];
	summary?: string;
	complete?: boolean;
	error?: string;
}
type Jobs = Record<JobKey, JobState>;
interface LogLine {
	time: string;
	job: string;
	level: 'info' | 'warn' | 'error';
	message: string;
}

/** Stato di un video nella coda: "warn" = completato con avvisi. */
type QueueStatus = 'pending' | 'running' | 'done' | 'warn' | 'error' | 'cancelled';
interface QueueItem {
	id: string;
	file: File;
	info: VideoInfo | null;
	probing: boolean;
	/** Il file non si può leggere: resta nella lista ma non viene elaborato. */
	error: string | null;
	h264: { hw: boolean; sw: boolean } | null;
	frameCount: number | null;
	status: QueueStatus;
	/** Risultati dell'ultima elaborazione di questo video. */
	jobs: Jobs | null;
}

const JOB_LABEL: Record<JobKey, string> = { frames: 'Frame', transcribe: 'Trascrizione', compress: 'Compressione' };
const JOB_KEYS: JobKey[] = ['frames', 'transcribe', 'compress'];
const idleJob = (): JobState => ({ status: 'idle', progress: null, outputs: [] });
const idleJobs = (): Jobs => ({ frames: idleJob(), transcribe: idleJob(), compress: idleJob() });
const baseNameOf = (f: File) => f.name.replace(/\.[^.]+$/, '');
/** Nome di cartella valido su Windows, macOS e Linux. */
const safeFolderName = (name: string) =>
	name
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
		.replace(/[. ]+$/, '')
		.slice(0, 120) || 'video';

function App() {
	const [caps, setCaps] = useState<Capabilities | null>(null);
	const [queue, setQueue] = useState<QueueItem[]>([]);
	const queueRef = useRef<QueueItem[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [queueRunning, setQueueRunning] = useState(false);
	const stopRequested = useRef(false);
	/** Lettura dei video in sequenza: una promessa per ogni video aggiunto. */
	const probes = useRef(new Map<string, Promise<void>>());
	/** Worker di trascrizione tenuto vivo tra un video e l'altro: il modello resta caricato. */
	const sharedTranscriber = useRef<Worker | null>(null);
	const leftoversCleared = useRef(false);
	const [previewVideoId, setPreviewVideoId] = useState<string | null>(null);
	const [leftover, setLeftover] = useState(0);
	const [dragOver, setDragOver] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const [pageError, setPageError] = useState<string | null>(null);
	/** Aperta dentro un'anteprima (iframe): il browser blocca l'elaborazione dei video. */
	const embedded = useMemo(() => {
		try {
			return window.top !== window.self;
		} catch {
			return true;
		}
	}, []);

	const [doFrames, setDoFrames] = useState(true);
	const [doTranscribe, setDoTranscribe] = useState(true);
	const [doCompress, setDoCompress] = useState(false);
	const [parallel, setParallel] = useState(true);
	const [outMode, setOutMode] = useState<'opfs' | 'dir'>('opfs');
	const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);

	const [fo, setFo] = useState<FramesOptions>({
		mode: 'smart',
		intervalSec: 1,
		format: 'jpeg',
		quality: 0.9,
		smartSensitivity: 60,
		smartStep: 0.5,
		smartIgnoreDynamic: true,
		splitBytes: 0,
		encoderThreads: 4,
		hardwareAcceleration: 'prefer-hardware',
	});
	const [to, setTo] = useState<TranscribeOptions>({
		language: 'it',
		model: 'turbo',
		device: 'webgpu',
		context: '',
		timestamps: 'paragraph',
		srt: false,
	});
	const [co, setCo] = useState<CompressOptions>({
		targetBytes: 480 * 1024 * 1024,
		retryIfOver: true,
		hardwareAcceleration: 'prefer-hardware',
	});

	const [jobs, setJobs] = useState<Jobs>(idleJobs);
	const [segments, setSegments] = useState<TranscriptSegment[]>([]);
	const [logs, setLogs] = useState<LogLine[]>([]);
	const workers = useRef<Partial<Record<JobKey, Worker>>>({});
	const [testEngine] = useState(() => __TEST_BUILD__ && new URLSearchParams(location.search).has('test-asr'));

	useEffect(() => {
		detectCapabilities().then((c) => {
			setCaps(c);
			setFo((f) => ({ ...f, encoderThreads: Math.min(6, Math.max(1, c.cores - 2)) }));
			if (!c.webgpu) setTo((t) => ({ ...t, device: 'wasm', model: 'small' }));
			// Pagina aperta da disco: niente archivio interno, si salva direttamente in una cartella.
			if (!c.opfs && c.dirPicker) setOutMode('dir');
		});
		leftoverBytes().then(setLeftover);
		// Gli errori imprevisti compaiono sulla pagina, non solo nella console.
		const onError = (e: ErrorEvent) => setPageError(e.message || 'Errore imprevisto');
		const onRejection = (e: PromiseRejectionEvent) => setPageError(String((e.reason as Error)?.message ?? e.reason));
		window.addEventListener('error', onError);
		window.addEventListener('unhandledrejection', onRejection);
		return () => {
			window.removeEventListener('error', onError);
			window.removeEventListener('unhandledrejection', onRejection);
		};
	}, []);

	const running = queueRunning || Object.values(jobs).some((j) => j.status === 'running' || j.status === 'waiting');

	// Chiudere la pagina ferma la coda: il browser chiede conferma.
	useEffect(() => {
		if (!queueRunning) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = '';
		};
		window.addEventListener('beforeunload', onBeforeUnload);
		return () => window.removeEventListener('beforeunload', onBeforeUnload);
	}, [queueRunning]);

	const addLog = useCallback((job: string, level: LogLine['level'], message: string) => {
		const time = new Date().toLocaleTimeString('it-IT');
		setLogs((l) => [...l.slice(-400), { time, job, level, message }]);
	}, []);

	// Lo stato dei lavori è anche in un ref: la coda lo legge tra un passo e l'altro.
	const jobsRef = useRef<Jobs>(idleJobs());
	const setAllJobs = useCallback((j: Jobs) => {
		jobsRef.current = j;
		setJobs(j);
	}, []);
	const patchJob = useCallback((key: JobKey, patch: Partial<JobState>) => {
		jobsRef.current = { ...jobsRef.current, [key]: { ...jobsRef.current[key], ...patch } };
		setJobs(jobsRef.current);
	}, []);

	const updateQueue = useCallback((fn: (q: QueueItem[]) => QueueItem[]) => {
		queueRef.current = fn(queueRef.current);
		setQueue(queueRef.current);
	}, []);
	const patchItem = useCallback(
		(id: string, patch: Partial<QueueItem>) => updateQueue((q) => q.map((it) => (it.id === id ? { ...it, ...patch } : it))),
		[updateQueue],
	);

	const probeItem = useCallback(
		async (id: string, f: File) => {
			try {
				const vi = await probeVideo(f);
				let h264: QueueItem['h264'] = null;
				if (vi.width && vi.height) {
					const [hw, sw] = await Promise.all([checkH264Encode(vi.width, vi.height, true), checkH264Encode(vi.width, vi.height, false)]);
					h264 = { hw, sw };
				}
				patchItem(id, { info: vi, h264, probing: false });
				// Con un solo video le opzioni si adattano al file, come prima della coda.
				if (queueRef.current.length === 1) {
					if (!vi.canDecodeVideo) setDoFrames(false);
					if (!vi.audioCodec || !vi.canDecodeAudio) setDoTranscribe(false);
					const target = Math.min(480 * 1024 * 1024, Math.floor((vi.size * 0.75) / 1048576) * 1048576);
					setCo((c) => ({ ...c, targetBytes: Math.max(1048576, target) }));
				}
			} catch (e) {
				patchItem(id, { error: (e as Error).message, probing: false });
			}
		},
		[patchItem],
	);

	const addFiles = useCallback(
		(files: File[]) => {
			if (!files.length) return;
			const items: QueueItem[] = files.map((f, i) => ({
				id: `${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`,
				file: f,
				info: null,
				probing: true,
				error: null,
				h264: null,
				frameCount: null,
				status: 'pending',
				jobs: null,
			}));
			updateQueue((q) => [...q, ...items]);
			if (!queueRunning) setSelectedId(items[0].id);
			// Un video alla volta, dopo quelli già in lettura.
			let chain = Promise.all([...probes.current.values()]).then(() => {});
			for (const it of items) {
				chain = chain.then(() => probeItem(it.id, it.file));
				probes.current.set(it.id, chain);
			}
		},
		[queueRunning, updateQueue, probeItem],
	);

	const removeItem = (id: string) => {
		updateQueue((q) => q.filter((it) => it.id !== id || it.status === 'running'));
		if (selectedId === id) setSelectedId(null);
	};

	// Video mostrato: quello scelto nella lista, altrimenti quello in elaborazione, altrimenti il primo.
	const current = queue.find((q) => q.id === selectedId) ?? queue.find((q) => q.status === 'running') ?? queue[0] ?? null;
	const file = current?.file ?? null;
	const info = current?.info ?? null;
	const probing = current?.probing ?? false;
	const probeError = current?.error ?? null;
	const frameCount = current?.frameCount ?? null;
	const h264 = current?.h264 ?? null;
	const multi = queue.length > 1;

	// conteggio esatto dei frame solo quando serve (modalità "tutti i frame")
	const counted = useRef(new Set<string>());
	useEffect(() => {
		if (current && current.info && fo.mode === 'all' && current.frameCount === null && !counted.current.has(current.id)) {
			const id = current.id;
			counted.current.add(id);
			countFrames(current.file)
				.then((n) => patchItem(id, { frameCount: n }))
				.catch(() => {});
		}
	}, [current, fo.mode, patchItem]);

	const estimate = useMemo(() => {
		if (!info || !info.width || !info.height) return null;
		let count: number | null = null;
		if (fo.mode === 'all') count = frameCount ?? (info.fps ? Math.round(info.fps * info.duration) : null);
		else if (fo.mode === 'interval') count = Math.floor(info.duration / Math.max(0.01, fo.intervalSec)) + 1;
		const per = estimateImageBytes(info.width, info.height, fo.format, fo.quality);
		return { count, bytes: count !== null ? count * per : null, per, exact: fo.mode === 'all' && frameCount !== null };
	}, [info, fo.mode, fo.intervalSec, fo.format, fo.quality, frameCount]);

	const heavy = fo.mode === 'all' && estimate?.count !== null && estimate !== null && ((estimate.count ?? 0) > 20000 || (estimate.bytes ?? 0) > 8 * 1024 ** 3);

	const pickDir = async (): Promise<FileSystemDirectoryHandle | null> => {
		try {
			const h = await (window as unknown as { showDirectoryPicker(o?: unknown): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({
				mode: 'readwrite',
				id: 'vfts-output',
			});
			setDirHandle(h);
			setOutMode('dir');
			setStartError(null);
			return h;
		} catch (e) {
			const err = e as DOMException;
			// L'elaborazione non parte mai in silenzio: si dice perché.
			setStartError(
				err?.name === 'AbortError'
					? 'Nessuna cartella scelta. Scegli una cartella dove salvare i risultati, oppure seleziona "In memoria" (adatto solo a risultati piccoli).'
					: `Il browser non ha aperto la scelta della cartella (${err?.message ?? err}). Seleziona "In memoria" oppure apri l'app in Chrome o Edge.`,
			);
			return null;
		}
	};

	const runJob = (key: JobKey, name: WorkerName, msg: Record<string, unknown>, reuse = false) =>
		new Promise<void>((resolve) => {
			let w: Worker;
			if (reuse && sharedTranscriber.current) w = sharedTranscriber.current;
			else {
				w = createWorker(name);
				if (reuse) sharedTranscriber.current = w;
			}
			workers.current[key] = w;
			const t0 = performance.now();
			patchJob(key, { status: 'running', progress: { fraction: null, stage: 'Avvio', elapsedMs: 0, etaMs: null } });
			const finish = (keepAlive = false) => {
				w.onmessage = null;
				w.onerror = null;
				if (!(reuse && keepAlive)) {
					w.terminate();
					if (sharedTranscriber.current === w) sharedTranscriber.current = null;
				}
				delete workers.current[key];
				resolve();
			};
			w.onmessage = (e: MessageEvent<WorkerOut | { type: 'cancelled' }>) => {
				const m = e.data;
				switch (m.type) {
					case 'progress':
						patchJob(key, { progress: m.progress });
						break;
					case 'log':
						addLog(JOB_LABEL[key], m.level, m.message);
						break;
					case 'segments':
						setSegments((s) => [...s, ...m.segments]);
						break;
					case 'done':
						patchJob(key, {
							status: 'done',
							outputs: m.outputs,
							summary: m.summary,
							complete: m.complete,
							progress: { fraction: 1, stage: 'Completato', elapsedMs: performance.now() - t0, etaMs: 0 },
						});
						addLog(JOB_LABEL[key], m.complete ? 'info' : 'warn', m.summary);
						finish(true);
						break;
					case 'error': {
						const cancelled = /interrotto/i.test(m.message);
						patchJob(key, { status: cancelled ? 'cancelled' : 'error', error: m.message, outputs: m.outputs ?? [] });
						addLog(JOB_LABEL[key], cancelled ? 'warn' : 'error', m.message);
						finish();
						break;
					}
				}
			};
			w.onerror = (e) => {
				patchJob(key, { status: 'error', error: `Errore interno: ${e.message || 'worker terminato (memoria esaurita?)'}` });
				addLog(JOB_LABEL[key], 'error', e.message || 'worker terminato');
				finish();
			};
			w.postMessage({ type: 'start', ...msg });
		});

	const start = async () => {
		setStartError(null);
		try {
			await runQueue();
		} catch (e) {
			setStartError(`Avvio non riuscito: ${(e as Error)?.message ?? e}`);
			addLog('Generale', 'error', `Avvio non riuscito: ${(e as Error)?.message ?? e}`);
		}
	};

	const runQueue = async () => {
		if (running || !queueRef.current.some((q) => q.status === 'pending' && !q.error)) return;
		// il selettore di cartella va aperto subito, finché vale il clic dell'utente
		let chosenDir = dirHandle;
		if (outMode === 'dir' && !chosenDir) {
			chosenDir = await pickDir();
			if (!chosenDir) return;
		}
		if (!leftoversCleared.current) {
			leftoversCleared.current = true;
			await clearLeftovers();
			setLeftover(0);
		}
		try {
			await navigator.storage.persist?.();
		} catch {
			/* facoltativo */
		}
		let target: OutputTarget = { kind: 'opfs' };
		if (outMode === 'dir' && chosenDir) {
			const perm = await (chosenDir as unknown as { requestPermission?(o: unknown): Promise<string> }).requestPermission?.({ mode: 'readwrite' });
			if (perm && perm !== 'granted') {
				setStartError('Permesso di scrittura sulla cartella negato: consentilo quando il browser lo chiede, oppure scegli un\'altra cartella.');
				return;
			}
			target = { kind: 'dir', handle: chosenDir };
		}
		stopRequested.current = false;
		setQueueRunning(true);
		const awake = await keepScreenAwake();
		const total = queueRef.current.filter((q) => q.status === 'pending' && !q.error).length;
		let done = 0;
		try {
			while (!stopRequested.current) {
				const next = queueRef.current.find((q) => q.status === 'pending' && !q.error);
				if (!next) break;
				if (next.probing || !next.info) {
					// video ancora in lettura: si aspetta
					await probes.current.get(next.id);
					const again = queueRef.current.find((q) => q.id === next.id);
					if (again && again.probing) await new Promise((r) => setTimeout(r, 300));
					continue;
				}
				done++;
				await processItem(next, target, done, Math.max(total, done));
			}
			if (stopRequested.current) {
				const left = queueRef.current.filter((q) => q.status === 'pending').length;
				if (left) addLog('Coda', 'warn', `Coda interrotta: ${left} video non elaborati restano in coda.`);
			} else if (done > 1) addLog('Coda', 'info', `Coda completata: ${done} video elaborati.`);
		} finally {
			sharedTranscriber.current?.terminate();
			sharedTranscriber.current = null;
			awake.release();
			setQueueRunning(false);
		}
	};

	const processItem = async (item: QueueItem, rootTarget: OutputTarget, index: number, total: number) => {
		const vi = item.info as VideoInfo;
		const f = item.file;
		const baseName = baseNameOf(f);
		patchItem(item.id, { status: 'running', jobs: null });
		setSelectedId(item.id);
		setSegments([]);
		setPreviewVideoId(item.id);
		addLog('Coda', 'info', total > 1 ? `Video ${index} di ${total}: ${f.name}` : `Inizio: ${f.name}`);

		// Le funzioni scelte valgono per tutta la coda; per ogni video si salta ciò che il file non permette.
		const wantFrames = doFrames && vi.canDecodeVideo;
		const wantTranscribe = doTranscribe && !!vi.audioCodec && vi.canDecodeAudio;
		const wantCompress = doCompress && vi.canDecodeVideo;
		if (doFrames && !wantFrames) addLog('Coda', 'warn', `${f.name}: il browser non decodifica il video, frame saltati.`);
		if (doTranscribe && !wantTranscribe) addLog('Coda', 'warn', `${f.name}: audio assente o non decodificabile, trascrizione saltata.`);
		if (doCompress && !wantCompress) addLog('Coda', 'warn', `${f.name}: video non decodificabile, compressione saltata.`);

		// Con più video, ognuno nella sua sottocartella.
		let target = rootTarget;
		if (rootTarget.kind === 'dir' && queueRef.current.length > 1) {
			try {
				target = { kind: 'dir', handle: await rootTarget.handle.getDirectoryHandle(safeFolderName(baseName), { create: true }) };
			} catch (e) {
				addLog('Coda', 'warn', `Sottocartella per ${f.name} non creata (${(e as Error).message}): salvo nella cartella principale.`);
			}
		}
		const runId = `${Date.now().toString(36)}${item.id.slice(-4)}`;
		// L'obiettivo di compressione non supera mai il 75% del file di partenza.
		const compressOptions: CompressOptions = {
			...co,
			targetBytes: Math.max(1048576, Math.min(co.targetBytes, Math.floor((vi.size * 0.75) / 1048576) * 1048576)),
		};

		setAllJobs({
			frames: wantFrames ? { ...idleJob(), status: 'waiting' } : idleJob(),
			transcribe: wantTranscribe ? { ...idleJob(), status: 'waiting' } : idleJob(),
			compress: wantCompress ? { ...idleJob(), status: 'waiting' } : idleJob(),
		});
		const framesTask = () =>
			runJob('frames', 'frames.worker', { file: f, options: fo, target, runId, encoder: workerSpec('encoder.worker') });
		const transcribeTask = () =>
			runJob('transcribe', 'transcribe.worker', { file: f, options: to, target, runId, baseName, testEngine }, true);
		const compressTask = () => runJob('compress', 'compress.worker', { file: f, options: compressOptions, target, runId });
		const stillWaiting = (k: JobKey) => !stopRequested.current && jobsRef.current[k].status === 'waiting';

		if (parallel) {
			// Audio e video su pipeline indipendenti; la compressione (che usa
			// decodificatore e codificatore video) parte dopo l'estrazione dei frame.
			const video = (async () => {
				if (wantFrames && stillWaiting('frames')) await framesTask();
				if (wantCompress && stillWaiting('compress')) await compressTask();
			})();
			const audio = wantTranscribe && stillWaiting('transcribe') ? transcribeTask() : Promise.resolve();
			await Promise.all([video, audio]);
		} else {
			if (wantFrames && stillWaiting('frames')) await framesTask();
			if (wantTranscribe && stillWaiting('transcribe')) await transcribeTask();
			if (wantCompress && stillWaiting('compress')) await compressTask();
		}
		for (const k of JOB_KEYS) if (jobsRef.current[k].status === 'waiting') patchJob(k, { status: 'cancelled' });

		const final = jobsRef.current;
		const statuses = Object.values(final).map((j) => j.status);
		const status: QueueStatus = statuses.includes('error')
			? 'error'
			: statuses.includes('cancelled')
				? 'cancelled'
				: Object.values(final).some((j) => j.status === 'done' && j.complete === false)
					? 'warn'
					: 'done';
		patchItem(item.id, { status, jobs: final });
	};

	const cancel = (key: JobKey) => {
		const w = workers.current[key];
		if (!w) {
			patchJob(key, { status: 'cancelled' });
			return;
		}
		w.postMessage({ type: 'cancel' });
		// se il worker non risponde entro 4 s viene terminato
		setTimeout(() => {
			if (workers.current[key] === w) {
				w.terminate();
				if (sharedTranscriber.current === w) sharedTranscriber.current = null;
				delete workers.current[key];
				patchJob(key, { status: 'cancelled', error: 'Interrotto dall\'utente' });
			}
		}, 4000);
	};

	const cancelAll = () => {
		stopRequested.current = true;
		JOB_KEYS.forEach((k) => {
			if (jobsRef.current[k].status === 'running') cancel(k);
			else if (jobsRef.current[k].status === 'waiting') patchJob(k, { status: 'cancelled' });
		});
	};

	const requeue = (id: string) => patchItem(id, { status: 'pending', jobs: null });

	const pending = queue.filter((q) => q.status === 'pending').filter((q) => !q.error);
	const anyEnabled = doFrames || doTranscribe || doCompress;
	const canStart = !running && pending.length > 0 && pending.some((q) => !!q.info || q.probing) && anyEnabled;
	// Se il pulsante non si può usare, sotto compare sempre il motivo.
	const startBlocker = running
		? null
		: queue.length === 0
			? 'Carica prima un video.'
			: pending.length === 0 && queue.some((q) => q.status !== 'pending')
				? 'Tutti i video in coda sono già stati elaborati: aggiungine altri o rimettine uno in coda.'
				: pending.length === 0
					? `Nessun video in coda si può elaborare${probeError ? `: ${probeError}` : '.'}`
					: anyEnabled
						? null
						: 'Attiva almeno una funzione: frame, trascrizione o compressione.';

	// Risultati mostrati: quelli in corso, oppure quelli salvati del video scelto nella lista.
	const showLive = !!current && (current.status === 'running' || (!multi && current.jobs === null));
	const shownJobs = showLive ? jobs : (current?.jobs ?? null);
	const showPreview =
		!!current && current.id === previewVideoId && (segments.length > 0 || (showLive && jobs.transcribe.status === 'running'));
	const finishedCount = queue.filter((q) => q.status !== 'pending' && q.status !== 'running').length;
	const startedCount = queue.filter((q) => q.status !== 'pending').length;

	return (
		<div className="app">
			<header className="topbar">
				<div className="brand">
					<span className="tally" aria-hidden="true" />
					<h1>VideoFrame &amp; Transcript Studio</h1>
				</div>
				<Diagnostics caps={caps} h264={h264} />
			</header>

			<main className="content">
				{embedded && (
					<div className="banner" role="alert">
						Stai vedendo l'app dentro un'anteprima, dove il browser blocca l'elaborazione dei video. Scarica il file
						VideoFrameStudio.html e aprilo con Chrome o Edge (doppio clic sul file scaricato).
					</div>
				)}
				{caps && !caps.webcodecs && (
					<div className="banner" role="alert">
						Questo browser non supporta WebCodecs, necessario per leggere i video. Apri l'app con Google Chrome o Microsoft Edge
						aggiornati.
					</div>
				)}
				{pageError && (
					<div className="banner" role="alert">
						Errore: {pageError}{' '}
						<button type="button" className="link" onClick={() => setPageError(null)}>
							Chiudi
						</button>
					</div>
				)}

				<section
					className={`drop ${dragOver ? 'over' : ''} ${file ? 'has-file' : ''}`}
					onDragOver={(e) => {
						e.preventDefault();
						setDragOver(true);
					}}
					onDragLeave={() => setDragOver(false)}
					onDrop={(e) => {
						e.preventDefault();
						setDragOver(false);
						addFiles(Array.from(e.dataTransfer.files ?? []));
					}}
				>
					<label className="drop-inner" htmlFor="file-input">
						<strong>{queue.length ? 'Trascina qui altri video da mettere in coda' : 'Trascina qui i tuoi video oppure selezionali'}</strong>
						<span>MP4, MOV, MKV, WebM · anche più video insieme: vengono elaborati uno alla volta · i file non lasciano il tuo computer</span>
						<span className="button ghost">{queue.length ? 'Aggiungi video…' : 'Scegli i video…'}</span>
					</label>
					<input
						id="file-input"
						type="file"
						accept="video/*,.mkv,.mov,.mp4,.webm"
						multiple
						onChange={(e) => {
							addFiles(Array.from(e.target.files ?? []));
							e.target.value = '';
						}}
					/>
				</section>

				{multi && (
					<QueueList
						queue={queue}
						selectedId={current?.id ?? null}
						onSelect={setSelectedId}
						onRemove={removeItem}
						onRequeue={requeue}
						onClearFinished={() => updateQueue((q) => q.filter((it) => it.status === 'pending' || it.status === 'running'))}
						running={running}
					/>
				)}

				{file && <FileSlate file={file} info={info} probing={probing} error={probeError} />}

				<div className="grid">
					<Panel
						title="Estrazione frame"
						enabled={doFrames}
						onToggle={setDoFrames}
						disabled={!multi && !!info && !info.canDecodeVideo}
						disabledNote="Il browser non decodifica il video di questo file."
					>
						<div className="seg" role="radiogroup" aria-label="Modalità">
							{(
								[
									['smart', 'Intelligente', 'Un frame per ogni slide, formula o lavagna diversa'],
									['interval', 'A intervallo', 'Un frame ogni N secondi'],
									['all', 'Tutti i frame', 'Ogni fotogramma originale'],
								] as const
							).map(([v, label, hint]) => (
								<button
									key={v}
									type="button"
									role="radio"
									aria-checked={fo.mode === v}
									className={fo.mode === v ? 'on' : ''}
									onClick={() => setFo({ ...fo, mode: v })}
								>
									<b>{label}</b>
									<small>{hint}</small>
								</button>
							))}
						</div>

						{fo.mode === 'interval' && (
							<div className="row">
								<label htmlFor="interval">Intervallo</label>
								<div className="chips">
									{[0.5, 1, 2, 5, 10].map((v) => (
										<button key={v} type="button" className={fo.intervalSec === v ? 'chip on' : 'chip'} onClick={() => setFo({ ...fo, intervalSec: v })}>
											{String(v).replace('.', ',')} s
										</button>
									))}
									<input
										id="interval"
										type="number"
										min={0.04}
										step={0.1}
										value={fo.intervalSec}
										onChange={(e) => setFo({ ...fo, intervalSec: Math.max(0.04, Number(e.target.value) || 1) })}
									/>
									<span className="unit">s</span>
								</div>
							</div>
						)}

						{fo.mode === 'smart' && (
							<>
								<div className="row">
									<label htmlFor="sens">Sensibilità ai cambiamenti</label>
									<div className="slider">
										<input
											id="sens"
											type="range"
											min={1}
											max={100}
											value={fo.smartSensitivity}
											onChange={(e) => setFo({ ...fo, smartSensitivity: Number(e.target.value) })}
										/>
										<output>{fo.smartSensitivity}</output>
									</div>
								</div>
								<p className="hint">
									Più alta: cattura anche piccole aggiunte (una riga di formula). Più bassa: solo cambi di slide. Il cursore e
									il puntatore non bastano a far salvare un frame.
								</p>
								<div className="row">
									<label htmlFor="step">Analizza ogni</label>
									<select id="step" value={fo.smartStep} onChange={(e) => setFo({ ...fo, smartStep: Number(e.target.value) })}>
										<option value={0.25}>0,25 s (più preciso)</option>
										<option value={0.5}>0,5 s</option>
										<option value={1}>1 s (più veloce)</option>
									</select>
								</div>
								<label className="check">
									<input
										id="dyn"
										type="checkbox"
										checked={fo.smartIgnoreDynamic}
										onChange={(e) => setFo({ ...fo, smartIgnoreDynamic: e.target.checked })}
									/>
									Ignora le zone sempre in movimento (webcam del docente in Webex, video nelle slide)
								</label>
							</>
						)}

						<div className="row">
							<label htmlFor="fmt">Formato</label>
							<div className="inline">
								<select id="fmt" value={fo.format} onChange={(e) => setFo({ ...fo, format: e.target.value as 'jpeg' | 'png' })}>
									<option value="jpeg">JPG</option>
									<option value="png">PNG (senza perdita, più pesante)</option>
								</select>
								{fo.format === 'jpeg' && (
									<span className="slider small">
										<input
											id="quality"
											type="range"
											min={50}
											max={100}
											value={Math.round(fo.quality * 100)}
											onChange={(e) => setFo({ ...fo, quality: Number(e.target.value) / 100 })}
											aria-label="Qualità JPG"
										/>
										<output>qualità {Math.round(fo.quality * 100)}</output>
									</span>
								)}
							</div>
						</div>

						<div className="row">
							<label htmlFor="split">Dividi lo ZIP</label>
							<select id="split" value={fo.splitBytes} onChange={(e) => setFo({ ...fo, splitBytes: Number(e.target.value) })}>
								<option value={0}>Un solo archivio</option>
								<option value={1024 ** 3}>Parti da 1 GB</option>
								<option value={2 * 1024 ** 3}>Parti da 2 GB</option>
								<option value={4 * 1024 ** 3}>Parti da 4 GB</option>
							</select>
						</div>

						{estimate && (
							<p className={`estimate ${heavy ? 'warn' : ''}`}>
								{estimate.count !== null ? (
									<>
										{estimate.exact ? '' : '≈ '}
										{formatNumber(estimate.count)} immagini · circa {formatBytes(estimate.bytes ?? 0)}
										{caps?.storageFree != null && outMode === 'opfs' && (estimate.bytes ?? 0) > caps.storageFree && (
											<> · <b>supera lo spazio disponibile ({formatBytes(caps.storageFree)})</b></>
										)}
									</>
								) : (
									<>Il numero di immagini dipende dal contenuto (di solito 1–4 al minuto per una lezione) · circa {formatBytes(estimate.per)} ciascuna</>
								)}
							</p>
						)}
						{heavy && (
							<div className="callout">
								<p>
									Tutti i frame di questo video sono {formatNumber(estimate?.count ?? 0)} immagini quasi identiche tra loro. Per una
									lezione bastano di solito l'estrazione intelligente o un frame al secondo. Puoi comunque procedere con
									l'estrazione integrale.
								</p>
								<div className="chips">
									<button type="button" className="chip" onClick={() => setFo({ ...fo, mode: 'smart' })}>Usa l'estrazione intelligente</button>
									<button type="button" className="chip" onClick={() => setFo({ ...fo, mode: 'interval', intervalSec: 1 })}>Un frame al secondo</button>
								</div>
							</div>
						)}
					</Panel>

					<Panel
						title="Trascrizione"
						enabled={doTranscribe}
						onToggle={setDoTranscribe}
						disabled={!multi && !!info && (!info.audioCodec || !info.canDecodeAudio)}
						disabledNote={info && !info.audioCodec ? 'Il file non contiene audio.' : 'Il browser non decodifica l\'audio di questo file.'}
					>
						<div className="row">
							<label htmlFor="lang">Lingua</label>
							<select id="lang" value={to.language} onChange={(e) => setTo({ ...to, language: e.target.value as TranscribeOptions['language'] })}>
								<option value="it">Italiano</option>
								<option value="en">Inglese</option>
								<option value="auto">Rilevamento automatico</option>
							</select>
						</div>
						<div className="seg two" role="radiogroup" aria-label="Precisione">
							<button type="button" role="radio" aria-checked={to.model === 'turbo'} className={to.model === 'turbo' ? 'on' : ''} onClick={() => setTo({ ...to, model: 'turbo' })}>
								<b>Alta precisione</b>
								<small>Whisper large-v3-turbo · ~1,4 GB da scaricare una volta</small>
							</button>
							<button type="button" role="radio" aria-checked={to.model !== 'turbo'} className={to.model !== 'turbo' ? 'on' : ''} onClick={() => setTo({ ...to, model: 'small' })}>
								<b>Veloce</b>
								<small>Whisper small · ~300 MB · più errori sui termini tecnici</small>
							</button>
						</div>
						<div className="row">
							<label htmlFor="device">Motore</label>
							<select id="device" value={to.device} onChange={(e) => setTo({ ...to, device: e.target.value as 'webgpu' | 'wasm' })}>
								<option value="webgpu" disabled={!caps?.webgpu}>
									GPU (WebGPU){caps && !caps.webgpu ? ' — non disponibile' : ''}
								</option>
								<option value="wasm">CPU (WebAssembly, molto più lento)</option>
							</select>
						</div>
						{to.device === 'wasm' && to.model === 'turbo' && (
							<p className="hint warn-text">Senza GPU il modello di alta precisione può impiegare più della durata del video.</p>
						)}
						<div className="row column">
							<label htmlFor="ctx">Corso e termini tecnici attesi (facoltativo)</label>
							<textarea
								id="ctx"
								rows={3}
								placeholder="Es.: Analisi Matematica 2. Jacobiano, integrale di Lebesgue, teorema di Fubini, forma differenziale"
								value={to.context}
								onChange={(e) => setTo({ ...to, context: e.target.value })}
							/>
							<span className="hint">
								Passato a Whisper come prompt iniziale, una funzione supportata dal modello: aiuta a scrivere bene i termini quando
								vengono pronunciati, non aggiunge parole. Se il testo prodotto ricalca il prompt, la finestra viene rifatta senza.
							</span>
						</div>
						<div className="row">
							<label htmlFor="ts">Timestamp</label>
							<select id="ts" value={to.timestamps} onChange={(e) => setTo({ ...to, timestamps: e.target.value as TranscribeOptions['timestamps'] })}>
								<option value="paragraph">A inizio paragrafo</option>
								<option value="segment">A ogni segmento</option>
								<option value="none">Nessuno</option>
							</select>
						</div>
						<label className="check">
							<input id="srt" type="checkbox" checked={to.srt} onChange={(e) => setTo({ ...to, srt: e.target.checked })} />
							Esporta anche i sottotitoli .srt
						</label>
					</Panel>

					<Panel title="Comprimi video" enabled={doCompress} onToggle={setDoCompress} optional>
						<div className="row">
							<label htmlFor="target">Dimensione obiettivo</label>
							<div className="inline">
								<input
									id="target"
									type="number"
									min={1}
									step={10}
									value={Math.round(co.targetBytes / 1048576)}
									onChange={(e) => setCo({ ...co, targetBytes: Math.max(1, Number(e.target.value) || 480) * 1048576 })}
								/>
								<span className="unit">MB</span>
								{info && <span className="hint">attuale: {formatBytes(info.size)}</span>}
							</div>
						</div>
						{info && (
							<p className="hint">
								Bitrate video previsto ≈{' '}
								{formatNumber(
									Math.max(0, ((co.targetBytes * 0.988 - 512 * 1024) * 8 - (info.audioBitrate ?? 128000) * info.duration) / info.duration / 1e6),
									2,
								)}{' '}
								Mbit/s · H.264 MP4 · FPS ({info.fps ? formatNumber(info.fps, 2) : '—'}) e risoluzione originali · audio copiato
							</p>
						)}
						<label className="check">
							<input id="retry" type="checkbox" checked={co.retryIfOver} onChange={(e) => setCo({ ...co, retryIfOver: e.target.checked })} />
							Se il risultato supera l'obiettivo, ripeti una volta con bitrate corretto
						</label>
						{h264 && !h264.hw && (
							<div className="callout">
								<p>
									{h264.sw
										? 'La codifica H.264 con accelerazione hardware non è disponibile in questo browser: è possibile solo quella software, più lenta.'
										: 'Questo browser non sa codificare video H.264: la compressione non è disponibile.'}
								</p>
								{h264.sw && (
									<label className="check">
										<input
											id="allow-sw"
											type="checkbox"
											checked={co.hardwareAcceleration === 'no-preference'}
											onChange={(e) => setCo({ ...co, hardwareAcceleration: e.target.checked ? 'no-preference' : 'prefer-hardware' })}
										/>
										Consenti codifica software
									</label>
								)}
							</div>
						)}
						<p className="hint">Facoltativa: non parte se chiedi solo frame e trascrizione.</p>
					</Panel>
				</div>

				<section className="launch">
					<div className="launch-options">
						<fieldset>
							<legend>Dove salvare i risultati</legend>
							<label className="check">
								<input type="radio" id="out-opfs" name="out" checked={outMode === 'opfs'} onChange={() => setOutMode('opfs')} />
								{caps && !caps.opfs ? (
									<>
										In memoria, poi scarichi con i pulsanti
										<span className="hint"> · solo per risultati piccoli: aperta da disco, la pagina non ha l'archivio interno del browser</span>
									</>
								) : (
									<>
										Archivio del browser, poi scarichi con i pulsanti
										{caps?.storageFree != null && <span className="hint"> · {formatBytes(caps.storageFree)} disponibili</span>}
									</>
								)}
							</label>
							<label className="check">
								<input
									type="radio"
									id="out-dir"
									name="out"
									checked={outMode === 'dir'}
									disabled={!caps?.dirPicker}
									onChange={() => (dirHandle ? setOutMode('dir') : pickDir())}
								/>
								Direttamente in una cartella del PC
								{dirHandle ? <b> · {dirHandle.name}</b> : null}
								{caps && !caps.dirPicker && <span className="hint"> · non disponibile qui</span>}
							</label>
							{caps?.dirPicker && (
								<button type="button" className="link" onClick={() => void pickDir()}>
									{dirHandle ? 'Cambia cartella' : 'Scegli cartella…'}
								</button>
							)}
						</fieldset>
						<label className="check">
							<input id="parallel" type="checkbox" checked={parallel} onChange={(e) => setParallel(e.target.checked)} />
							Frame e trascrizione in parallelo (decodifica video e AI usano parti diverse della GPU)
						</label>
						{leftover > 0 && !running && (
							<p className="hint">
								{formatBytes(leftover)} occupati da elaborazioni precedenti nell'archivio del browser.{' '}
								<button type="button" className="link" onClick={() => clearLeftovers().then(() => leftoverBytes().then(setLeftover))}>
									Libera spazio
								</button>
							</p>
						)}
					</div>
					<div className="launch-actions">
						<button type="button" className="primary" disabled={!canStart} onClick={start}>
							{pending.length > 1 ? `AVVIA ELABORAZIONE · ${pending.length} VIDEO` : 'AVVIA ELABORAZIONE'}
						</button>
						{running && multi && (
							<p className="start-note">
								Video {Math.min(startedCount, queue.length)} di {queue.length} · {finishedCount} finiti · si procede uno alla volta
							</p>
						)}
						{running && (
							<button type="button" className="button ghost" onClick={cancelAll}>
								{multi ? 'Interrompi la coda' : 'Interrompi tutto'}
							</button>
						)}
						{multi && caps && !caps.opfs && outMode === 'opfs' && (
							<p className="start-note">Con più video conviene salvare in una cartella del PC: "in memoria" tiene tutti i risultati nella RAM.</p>
						)}
						{multi && outMode === 'dir' && <p className="hint">Ogni video avrà la sua sottocartella con il proprio nome.</p>}
						{running && multi && (
							<p className="hint">
								Tieni la pagina aperta: chiuderla ferma la coda. Il PC non va in standby finché la scheda resta in primo piano.
							</p>
						)}
						{!canStart && startBlocker && <p className="start-note">{startBlocker}</p>}
						{startError && (
							<p className="start-note error-text" role="alert">
								{startError}
							</p>
						)}
					</div>
				</section>

				{multi && current && shownJobs && <h2 className="results-title">Risultati · {current.file.name}</h2>}

				{shownJobs &&
					JOB_KEYS.filter((k) => shownJobs[k].status !== 'idle').map((k) => (
						<JobCard key={k} jobKey={k} job={shownJobs[k]} onCancel={() => cancel(k)} downloadPrefix={multi && current ? baseNameOf(current.file) : undefined} />
					))}

				{showPreview && <TranscriptPreview segments={segments} running={showLive && jobs.transcribe.status === 'running'} />}

				{logs.length > 0 && (
					<details className="log">
						<summary>Registro attività ({logs.length})</summary>
						<ol>
							{logs.map((l, i) => (
								<li key={i} className={l.level}>
									<time>{l.time}</time> <b>{l.job}</b> {l.message}
								</li>
							))}
						</ol>
					</details>
				)}
			</main>
			<footer className="foot">
				Elaborazione locale nel browser: il video non viene caricato su alcun server. Al primo uso si scaricano solo la libreria
				AI e il modello Whisper (open source, gratuito), poi conservati nella cache del browser.
			</footer>
		</div>
	);
}

function Diagnostics({ caps, h264 }: { caps: Capabilities | null; h264: { hw: boolean; sw: boolean } | null }) {
	if (!caps) return <div className="diag">Verifica del browser…</div>;
	const items: [string, boolean | null, string][] = [
		['WebCodecs', caps.webcodecs, caps.webcodecs ? 'decodifica video nativa' : 'assente: usa Chrome o Edge aggiornati'],
		['WebGPU', caps.webgpu, caps.webgpu ? caps.gpuName ?? 'GPU disponibile' : 'assente: trascrizione su CPU'],
		['H.264 hardware', h264 ? h264.hw : null, h264 ? (h264.hw ? 'codifica disponibile' : 'non disponibile') : 'si verifica dopo il caricamento'],
		['Archivio', caps.opfs, caps.opfs ? (caps.storageFree != null ? `${formatBytes(caps.storageFree)} liberi` : 'disponibile') : 'assente: output in memoria'],
	];
	return (
		<ul className="diag" aria-label="Capacità del browser">
			{items.map(([k, ok, d]) => (
				<li key={k} className={ok === null ? 'pending' : ok ? 'ok' : 'no'} title={d}>
					<span className="dot" aria-hidden="true" />
					<span className="k">{k}</span>
					<span className="d">{d}</span>
				</li>
			))}
		</ul>
	);
}

function FileSlate({ file, info, probing, error }: { file: File; info: VideoInfo | null; probing: boolean; error: string | null }) {
	return (
		<section className="slate" aria-live="polite">
			<div className="slate-name">
				<span className="label">File</span>
				<strong title={file.name}>{file.name}</strong>
			</div>
			{error ? (
				<p className="error-text">{error}</p>
			) : (
				<dl>
					<div>
						<dt>Dimensione</dt>
						<dd>{formatBytes(file.size)}</dd>
					</div>
					<div>
						<dt>Durata</dt>
						<dd>{info ? hms(info.duration) : probing ? '…' : '—'}</dd>
					</div>
					<div>
						<dt>Risoluzione</dt>
						<dd>{info?.width ? `${info.width}×${info.height}` : probing ? '…' : '—'}</dd>
					</div>
					<div>
						<dt>FPS</dt>
						<dd>{info?.fps ? formatNumber(info.fps, 2) : probing ? '…' : '—'}</dd>
					</div>
					<div>
						<dt>Video</dt>
						<dd>{info ? `${info.videoCodec ?? 'assente'}${info.videoCodec && !info.canDecodeVideo ? ' (non supportato)' : ''}` : '…'}</dd>
					</div>
					<div>
						<dt>Audio</dt>
						<dd>
							{info
								? info.audioCodec
									? `${info.audioCodec} · ${formatNumber((info.sampleRate ?? 0) / 1000, 1)} kHz · ${info.channels} can.`
									: 'assente'
								: '…'}
						</dd>
					</div>
				</dl>
			)}
		</section>
	);
}

const QUEUE_STATUS: Record<QueueStatus, string> = {
	pending: 'In coda',
	running: 'In elaborazione',
	done: 'Completato',
	warn: 'Completato con avvisi',
	error: 'Errore',
	cancelled: 'Interrotto',
};

function QueueList(props: {
	queue: QueueItem[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onRemove: (id: string) => void;
	onRequeue: (id: string) => void;
	onClearFinished: () => void;
	running: boolean;
}) {
	const finished = props.queue.filter((q) => q.status !== 'pending' && q.status !== 'running').length;
	const totalSec = props.queue.reduce((a, q) => a + (q.info?.duration ?? 0), 0);
	return (
		<section className="queue" aria-label="Coda dei video">
			<header>
				<h2>Coda · {props.queue.length} video</h2>
				<span className="hint">
					{totalSec > 0 && <>{hms(totalSec)} in totale · </>}
					{finished} finiti · elaborati uno alla volta, nell'ordine
				</span>
				{finished > 0 && (
					<button type="button" className="link" onClick={props.onClearFinished}>
						Togli i finiti dalla lista
					</button>
				)}
			</header>
			<ol>
				{props.queue.map((q, i) => (
					<li key={q.id} className={`${q.status} ${q.id === props.selectedId ? 'sel' : ''}`}>
						<button type="button" className="q-main" onClick={() => props.onSelect(q.id)} aria-pressed={q.id === props.selectedId}>
							<span className="q-num">{i + 1}</span>
							<span className="q-name" title={q.file.name}>
								{q.file.name}
							</span>
							<span className="q-meta">{q.error ? 'non leggibile' : q.info ? `${hms(q.info.duration)} · ${formatBytes(q.file.size)}` : 'lettura…'}</span>
						</button>
						<span className={`pill ${q.status === 'warn' ? 'done' : q.status === 'pending' ? 'waiting' : q.status}`}>
							{q.error && q.status === 'pending' ? 'Non elaborabile' : QUEUE_STATUS[q.status]}
						</span>
						<span className="q-actions">
							{(q.status === 'done' || q.status === 'warn' || q.status === 'error' || q.status === 'cancelled') && !q.error && (
								<button type="button" className="link" onClick={() => props.onRequeue(q.id)}>
									Rimetti in coda
								</button>
							)}
							{q.status !== 'running' && (
								<button type="button" className="link" onClick={() => props.onRemove(q.id)} aria-label={`Togli ${q.file.name} dalla coda`}>
									Togli
								</button>
							)}
						</span>
					</li>
				))}
			</ol>
		</section>
	);
}

function Panel(props: {
	title: string;
	enabled: boolean;
	onToggle: (v: boolean) => void;
	children: React.ReactNode;
	optional?: boolean;
	disabled?: boolean;
	disabledNote?: string;
}) {
	const id = `toggle-${props.title.replace(/\W+/g, '-').toLowerCase()}`;
	return (
		<section className={`panel ${props.enabled && !props.disabled ? '' : 'off'}`}>
			<header>
				<h2>{props.title}</h2>
				<label className="switch" htmlFor={id}>
					<input
						id={id}
						type="checkbox"
						checked={props.enabled && !props.disabled}
						disabled={props.disabled}
						onChange={(e) => props.onToggle(e.target.checked)}
					/>
					<span>{props.disabled ? 'Non disponibile' : props.enabled ? 'Attiva' : props.optional ? 'Facoltativa' : 'Disattivata'}</span>
				</label>
			</header>
			{props.disabled && props.disabledNote ? <p className="hint">{props.disabledNote}</p> : null}
			<fieldset className="panel-body" disabled={!props.enabled || props.disabled}>
				{props.children}
			</fieldset>
		</section>
	);
}

const DOWNLOAD_LABEL: Record<string, string> = {
	'FRAMES.zip': 'Scarica FRAMES.zip',
	'TRASCRIZIONE.txt': 'Scarica TRASCRIZIONE.txt',
	'VIDEO_COMPRESSO.mp4': 'Scarica VIDEO_COMPRESSO.mp4',
};

function JobCard({
	jobKey,
	job,
	onCancel,
	downloadPrefix,
}: {
	jobKey: JobKey;
	job: JobState;
	onCancel: () => void;
	/** Con più video, il nome del video davanti al file scaricato ("lezione 3 - TRASCRIZIONE.txt"). */
	downloadPrefix?: string;
}) {
	const p = job.progress;
	const pct = p?.fraction != null ? Math.round(p.fraction * 1000) / 10 : null;
	const statusText: Record<JobStatus, string> = {
		idle: '',
		waiting: 'In attesa',
		running: p?.stage ?? 'In corso',
		done: job.complete === false ? 'Terminato con avvisi' : 'Completato',
		error: 'Errore',
		cancelled: 'Interrotto',
	};
	return (
		<section className={`job ${job.status}`} aria-live="polite">
			<header>
				<h3>{JOB_LABEL[jobKey]}</h3>
				<span className={`pill ${job.status}`}>{statusText[job.status]}</span>
				{job.status === 'running' && (
					<button type="button" className="link" onClick={onCancel}>
						Interrompi
					</button>
				)}
			</header>
			{(job.status === 'running' || job.status === 'done') && (
				<>
					<div
						className={`bar ${pct === null ? 'indeterminate' : ''}`}
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={pct ?? undefined}
					>
						<span style={{ width: pct === null ? undefined : `${pct}%` }} />
					</div>
					<div className="meta">
						{pct !== null && <span className="num">{formatNumber(pct, 1)}%</span>}
						{p && <span>trascorso {formatDuration(p.elapsedMs)}</span>}
						{job.status === 'running' && p?.etaMs != null && <span>residuo stimato {formatDuration(p.etaMs)}</span>}
						{p?.detail && <span className="detail">{p.detail}</span>}
					</div>
				</>
			)}
			{job.summary && <p className="summary">{job.summary}</p>}
			{job.error && <p className="error-text">{job.error}</p>}
			{job.outputs.length > 0 && (
				<div className="downloads">
					{job.outputs.map((o) =>
						o.storage === 'dir' ? (
							<span key={o.name} className="saved">
								Salvato nella cartella: <b>{o.name}</b> ({formatBytes(o.bytes)})
							</span>
						) : (
							<button
								key={o.name}
								type="button"
								className="download"
								onClick={() =>
									downloadOutput(downloadPrefix ? { ...o, downloadName: `${downloadPrefix} - ${o.downloadName}` } : o).catch((e) =>
										alert(e.message),
									)
								}
							>
								{DOWNLOAD_LABEL[o.downloadName] ?? `Scarica ${o.downloadName}`}
								<small>{formatBytes(o.bytes)}</small>
							</button>
						),
					)}
				</div>
			)}
		</section>
	);
}

function TranscriptPreview({ segments, running }: { segments: TranscriptSegment[]; running: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (el && running) el.scrollTop = el.scrollHeight;
	}, [segments.length, running]);
	const shown = segments.slice(-300);
	return (
		<section className="preview">
			<header>
				<h3>Anteprima della trascrizione</h3>
				<span className="hint">
					{segments.length} segmenti{segments.length > 300 ? ' · mostrati gli ultimi 300, il file contiene tutto' : ''}
				</span>
			</header>
			<div className="preview-body" ref={ref}>
				{shown.map((s, i) => (
					<p key={i}>
						<time>{hms(s.start)}</time> {s.text}
						{s.flags?.length ? <em className="flag"> ({s.flags.join(', ')})</em> : null}
					</p>
				))}
				{running && <p className="typing">…</p>}
			</div>
		</section>
	);
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
