// Regole di decodifica del Whisper originale (openai/whisper, decoding.py) che
// Transformers.js 4.3.2 non applica, e misura della confidenza per finestra.
//
// 1. Il primo timestamp di ogni finestra deve cadere entro 1 s: senza questa regola
//    il modello può iniziare a scrivere a metà finestra e perdere i secondi iniziali.
// 2. I timestamp non tornano mai indietro: dopo un testo il timestamp di chiusura deve
//    avanzare; subito dopo una chiusura il segmento successivo può iniziare allo stesso istante.
// 3. La confidenza è la media del log-probabilità dei token scelti, riportata a
//    temperatura 1 (come avg_logprob di Whisper): sotto -1 la finestra viene rifatta.

/** Indice massimo del primo timestamp: 50 × 0,02 s = 1 s (max_initial_timestamp di Whisper). */
export const MAX_INITIAL_TIMESTAMP_INDEX = 50;

/**
 * Applica le regole sui timestamp ai logit del prossimo token, in place.
 * @param generated token già generati in questa finestra (senza il prompt iniziale)
 * @param logits logit del prossimo token
 * @param timestampBegin id del primo token timestamp (<|0.00|>)
 */
export function applyTimestampRules(generated: number[], logits: Float32Array, timestampBegin: number): void {
	if (generated.length === 0) {
		const last = timestampBegin + MAX_INITIAL_TIMESTAMP_INDEX;
		if (last + 1 < logits.length) logits.fill(-Infinity, last + 1);
		return;
	}
	let lastTimestamp = -1;
	for (let i = generated.length - 1; i >= 0; i--) {
		if (generated[i] >= timestampBegin) {
			lastTimestamp = generated[i];
			break;
		}
	}
	if (lastTimestamp < 0) return;
	const n = generated.length;
	const lastWasTimestamp = generated[n - 1] >= timestampBegin;
	const penultimateWasTimestamp = n < 2 || generated[n - 2] >= timestampBegin;
	// Chiusura appena emessa (testo poi timestamp): il prossimo segmento può partire da lì.
	// In tutti gli altri casi il prossimo timestamp deve essere strettamente successivo.
	const firstAllowed = lastWasTimestamp && !penultimateWasTimestamp ? lastTimestamp : lastTimestamp + 1;
	const stop = Math.min(firstAllowed, logits.length);
	if (stop > timestampBegin) logits.fill(-Infinity, timestampBegin, stop);
}

/** log(Σ exp(logit·scale)), calcolato in modo stabile e senza allocazioni. */
export function logSumExp(logits: Float32Array, scale = 1): number {
	let max = -Infinity;
	for (let i = 0; i < logits.length; i++) {
		const v = logits[i] * scale;
		if (v > max) max = v;
	}
	if (max === -Infinity) return -Infinity;
	let sum = 0;
	for (let i = 0; i < logits.length; i++) {
		const v = logits[i];
		if (v !== -Infinity) sum += Math.exp(v * scale - max);
	}
	return max + Math.log(sum);
}

/** log-softmax in un nuovo array; `scale` riporta i logit a temperatura 1. Usato come riferimento nei test. */
export function logSoftmax(logits: Float32Array, scale = 1): Float32Array {
	const lse = logSumExp(logits, scale);
	const out = new Float32Array(logits.length);
	for (let i = 0; i < logits.length; i++) out[i] = logits[i] * scale - lse;
	return out;
}

/**
 * Media del log-probabilità dei token scelti durante la generazione.
 * Rispetto a calcolare l'intero log-softmax evita un array da ~52.000 valori a ogni parola.
 */
export class LogprobTracker {
	private pending: Float32Array | null = null;
	private pendingLse = 0;
	private readonly scale: number;
	sum = 0;
	count = 0;

	constructor(temperature: number) {
		// il campionamento a temperatura T divide i logit per T: si riportano a T = 1
		this.scale = temperature > 0 ? temperature : 1;
	}

	/** Da chiamare a ogni passo con i logit finali (dopo tutte le regole). */
	step(previousToken: number | null, logits: Float32Array) {
		this.consume(previousToken);
		this.pending = logits;
		this.pendingLse = logSumExp(logits, this.scale);
	}

	/** Da chiamare a fine generazione con l'ultimo token prodotto. */
	finish(lastToken: number | null) {
		this.consume(lastToken);
		this.pending = null;
	}

	private consume(token: number | null) {
		if (this.pending && token !== null && token >= 0 && token < this.pending.length) {
			const lp = this.pending[token] * this.scale - this.pendingLse;
			if (Number.isFinite(lp)) {
				this.sum += lp;
				this.count++;
			}
		}
		this.pending = null;
	}

	get average(): number | null {
		return this.count > 0 ? this.sum / this.count : null;
	}
}
