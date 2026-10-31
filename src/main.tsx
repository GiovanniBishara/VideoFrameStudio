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
interface LogLine {
	time: string;
	job: string;
	level: 'info' | 'warn' | 'error';
	message: string;
}

const JOB_LABEL: Record<JobKey, string> = { frames: 'Frame', transcribe: 'Trascrizione', compress: 'Compressione' };
const idleJob = (): JobState => ({ status: 'idle', progress: null, outputs: [] });

function App() {
	const [caps, setCaps] = useState<Capabilities | null>(null);
	const [file, setFile] = useState<File | null>(null);
	const [info, setInfo] = useState<VideoInfo | null>(null);
	const [probeError, setProbeError] = useState<string | null>(null);
	const [probing, setProbing] = useState(false);
	const [frameCount, setFrameCount] = useState<number | null>(null);
	const [h264, setH264] = useState<{ hw: boolean; sw: boolean } | null>(null);
	const [leftover, setLeftover] = useState(0);
	const [dragOver, setDragOver] = useState(false);

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

	const [jobs, setJobs] = useState<Record<JobKey, JobState>>({
		frames: idleJob(),
		transcribe: idleJob(),
		compress: idleJob(),
	});
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
	}, []);

	const running = Object.values(jobs).some((j) => j.status === 'running' || j.status === 'waiting');

	const addLog = useCallback((job: string, level: LogLine['level'], message: string) => {
		const time = new Date().toLocaleTimeString('it-IT');
		setLogs((l) => [...l.slice(-400), { time, job, level, message }]);
	}, []);

	const patchJob = useCallback((key: JobKey, patch: Partial<JobState>) => {
		setJobs((j) => ({ ...j, [key]: { ...j[key], ...patch } }));
	}, []);

	const loadFile = useCallback(
		async (f: File) => {
			if (running) return;
			setFile(f);
			setInfo(null);
			setProbeError(null);
			setFrameCount(null);
			setH264(null);
			setProbing(true);
			setJobs({ frames: idleJob(), transcribe: idleJob(), compress: idleJob() });
			setSegments([]);
			try {
				const vi = await probeVideo(f);
				setInfo(vi);
				if (vi.width && vi.height) {
					const [hw, sw] = await Promise.all([
						checkH264Encode(vi.width, vi.height, true),
						checkH264Encode(vi.width, vi.height, false),
					]);
					setH264({ hw, sw });
				}
				if (!vi.canDecodeVideo) setDoFrames(false);
				if (!vi.audioCodec || !vi.canDecodeAudio) setDoTranscribe(false);
				const target = Math.min(480 * 1024 * 1024, Math.floor((vi.size * 0.75) / 1048576) * 1048576);
				setCo((c) => ({ ...c, targetBytes: Math.max(1048576, target) }));
			} catch (e) {
				setProbeError((e as Error).message);
			} finally {
				setProbing(false);
			}
		},
		[running],
	);

	// conteggio esatto dei frame solo quando serve (modalità "tutti i frame")
	useEffect(() => {
		if (file && info && fo.mode === 'all' && frameCount === null) {
			countFrames(file).then(setFrameCount).catch(() => setFrameCount(null));
		}
	}, [file, info, fo.mode, frameCount]);

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
			return h;
		} catch {
			return null; // annullato
		}
	};

	const runJob = (key: JobKey, name: WorkerName, msg: Record<string, unknown>) =>
		new Promise<void>((resolve) => {
			const w = createWorker(name);
			workers.current[key] = w;
			const t0 = performance.now();
			patchJob(key, { status: 'running', progress: { fraction: null, stage: 'Avvio', elapsedMs: 0, etaMs: null } });
			const finish = () => {
				w.terminate();
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
						finish();
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
		if (!file || !info || running) return;
		// il selettore di cartella va aperto subito, finché vale il clic dell'utente
		let chosenDir = dirHandle;
		if (outMode === 'dir' && !chosenDir) {
			chosenDir = await pickDir();
			if (!chosenDir) return;
		}
		const runId = Date.now().toString(36);
		await clearLeftovers();
		setLeftover(0);
		try {
			await navigator.storage.persist?.();
		} catch {
			/* facoltativo */
		}
		let target: OutputTarget = { kind: 'opfs' };
		if (outMode === 'dir' && chosenDir) {
			const perm = await (chosenDir as unknown as { requestPermission(o: unknown): Promise<string> }).requestPermission?.({ mode: 'readwrite' });
			if (perm && perm !== 'granted') {
				addLog('Generale', 'error', 'Permesso di scrittura sulla cartella negato.');
				return;
			}
			target = { kind: 'dir', handle: chosenDir };
		}
		setSegments([]);
		setJobs({
			frames: doFrames ? { ...idleJob(), status: 'waiting' } : idleJob(),
			transcribe: doTranscribe ? { ...idleJob(), status: 'waiting' } : idleJob(),
			compress: doCompress ? { ...idleJob(), status: 'waiting' } : idleJob(),
		});
		const baseName = file.name.replace(/\.[^.]+$/, '');
		const framesTask = () =>
			runJob('frames', 'frames.worker', { file, options: fo, target, runId, encoder: workerSpec('encoder.worker') });
		const transcribeTask = () =>
			runJob('transcribe', 'transcribe.worker', { file, options: to, target, runId, baseName, testEngine });
		const compressTask = () => runJob('compress', 'compress.worker', { file, options: co, target, runId });

		if (parallel) {
			// Audio e video su pipeline indipendenti; la compressione (che usa
			// decodificatore e codificatore video) parte dopo l'estrazione dei frame.
			const video = (async () => {
				if (doFrames) await framesTask();
				if (doCompress) await compressTask();
			})();
			const audio = doTranscribe ? transcribeTask() : Promise.resolve();
			await Promise.all([video, audio]);
		} else {
			if (doFrames) await framesTask();
			if (doTranscribe) await transcribeTask();
			if (doCompress) await compressTask();
		}
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
				delete workers.current[key];
				patchJob(key, { status: 'cancelled', error: 'Interrotto dall\'utente' });
			}
		}, 4000);
	};

	const cancelAll = () => (['frames', 'transcribe', 'compress'] as JobKey[]).forEach((k) => {
		if (jobs[k].status === 'running') cancel(k);
		else if (jobs[k].status === 'waiting') patchJob(k, { status: 'cancelled' });
	});

	const canStart = !!file && !!info && !running && (doFrames || doTranscribe || doCompress);

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
						const f = e.dataTransfer.files?.[0];
						if (f) loadFile(f);
					}}
				>
					<label className="drop-inner" htmlFor="file-input">
						<strong>Trascina qui il tuo video oppure seleziona un file</strong>
						<span>MP4, MOV, MKV, WebM · nessun limite di dimensione · il file non lascia il tuo computer</span>
						<span className="button ghost">Scegli un file…</span>
					</label>
					<input
						id="file-input"
						type="file"
						accept="video/*,.mkv,.mov,.mp4,.webm"
						disabled={running}
						onChange={(e) => {
							const f = e.target.files?.[0];
							if (f) loadFile(f);
							e.target.value = '';
						}}
					/>
				</section>

				{file && <FileSlate file={file} info={info} probing={probing} error={probeError} />}

				<div className="grid">
					<Panel
						title="Estrazione frame"
						enabled={doFrames}
						onToggle={setDoFrames}
						disabled={!!info && !info.canDecodeVideo}
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
						disabled={!!info && (!info.audioCodec || !info.canDecodeAudio)}
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
							AVVIA ELABORAZIONE
						</button>
						{running && (
							<button type="button" className="button ghost" onClick={cancelAll}>
								Interrompi tutto
							</button>
						)}
					</div>
				</section>

				{(['frames', 'transcribe', 'compress'] as JobKey[])
					.filter((k) => jobs[k].status !== 'idle')
					.map((k) => (
						<JobCard key={k} jobKey={k} job={jobs[k]} onCancel={() => cancel(k)} />
					))}

				{(segments.length > 0 || jobs.transcribe.status === 'running') && <TranscriptPreview segments={segments} running={jobs.transcribe.status === 'running'} />}

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

function JobCard({ jobKey, job, onCancel }: { jobKey: JobKey; job: JobState; onCancel: () => void }) {
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
							<button key={o.name} type="button" className="download" onClick={() => downloadOutput(o).catch((e) => alert(e.message))}>
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
