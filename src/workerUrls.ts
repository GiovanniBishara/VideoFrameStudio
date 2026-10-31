// Creazione dei worker. Nella versione pubblicata su un sito i worker sono file
// (moduli ES) accanto all'app; nella versione "file unico" (un .html aperto con
// doppio clic) il loro codice è incorporato: diventano worker classici da URL blob,
// l'unica forma che Chrome accetta per una pagina aperta da disco (origine "null").

declare const __INLINE_WORKERS__: Record<string, string> | null;

export type WorkerName = 'frames.worker' | 'encoder.worker' | 'transcribe.worker' | 'compress.worker';

/** Come raggiungere il codice del worker di codifica, che viene creato dentro il worker dei frame. */
export type WorkerSpec = { url: string } | { code: string };

export function workerSpec(name: WorkerName): WorkerSpec {
	if (__INLINE_WORKERS__) return { code: __INLINE_WORKERS__[name] };
	return { url: new URL(`./${name}.js`, import.meta.url).href };
}

export function createWorkerFromSpec(spec: WorkerSpec, name: string): Worker {
	if ('code' in spec) {
		// L'URL blob va creato nel contesto che crea il worker (con origine "null" non è condivisibile).
		const url = URL.createObjectURL(new Blob([spec.code], { type: 'text/javascript' }));
		return new Worker(url, { name });
	}
	return new Worker(spec.url, { type: 'module', name });
}

export function createWorker(name: WorkerName): Worker {
	return createWorkerFromSpec(workerSpec(name), name);
}
