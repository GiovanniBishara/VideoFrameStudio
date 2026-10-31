// Tipi minimi per la parte di Transformers.js 4.3.2 usata (verificata sul codice sorgente).
export const env: {
	allowLocalModels: boolean;
	useBrowserCache: boolean;
	backends: { onnx: { wasm: { numThreads?: number; wasmPaths?: unknown } } };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pipeline(task: string, model: string, options?: Record<string, unknown>): Promise<any>;
