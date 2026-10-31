// Ricampionamento in streaming a 16 kHz mono (richiesto da Whisper), con filtro
// passa-basso sinc finestrato (Blackman) per evitare aliasing. Elabora i dati
// a blocchi: in memoria resta solo una piccola coda di campioni.

const ZERO_CROSSINGS = 8; // semi-ampiezza del kernel in unità di periodo di taglio
const PHASES = 512;

export class StreamingResampler {
	private readonly ratio: number; // campioni in ingresso per campione in uscita
	private readonly cutoff: number; // in cicli per campione d'ingresso
	private readonly halfWidth: number; // in campioni d'ingresso
	private readonly table: Float32Array; // (PHASES + 1) x tapsPerPhase
	private readonly taps: number;
	private history = new Float32Array(0);
	/** Posizione (in campioni di ingresso, relativa a history[0]) del prossimo campione da produrre. */
	private pos = 0;
	/** Identità: nessun filtro se le frequenze coincidono. */
	private readonly passthrough: boolean;

	constructor(
		readonly inRate: number,
		readonly outRate = 16000,
	) {
		this.ratio = inRate / outRate;
		this.passthrough = Math.abs(this.ratio - 1) < 1e-9;
		this.cutoff = 0.5 * Math.min(1, 1 / this.ratio) * 0.95;
		this.halfWidth = Math.ceil(ZERO_CROSSINGS / (2 * this.cutoff));
		this.taps = 2 * this.halfWidth;
		this.table = new Float32Array((PHASES + 1) * this.taps);
		for (let p = 0; p <= PHASES; p++) {
			const frac = p / PHASES;
			let sum = 0;
			for (let k = 0; k < this.taps; k++) {
				// distanza tra il campione k e la posizione frazionaria
				const x = k - (this.halfWidth - 1) - frac;
				const v = this.kernel(x);
				this.table[p * this.taps + k] = v;
				sum += v;
			}
			// normalizzazione: guadagno unitario in continua
			for (let k = 0; k < this.taps; k++) this.table[p * this.taps + k] /= sum;
		}
		this.pos = this.halfWidth - 1; // ritardo del filtro compensato: si parte con lo zero-padding iniziale
		this.history = new Float32Array(this.halfWidth - 1);
	}

	private kernel(x: number): number {
		const w = this.halfWidth;
		if (Math.abs(x) >= w) return 0;
		const t = 2 * this.cutoff * x;
		const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
		// finestra di Blackman centrata
		const n = (x + w) / (2 * w);
		const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * n) + 0.08 * Math.cos(4 * Math.PI * n);
		return 2 * this.cutoff * sinc * win;
	}

	/** Elabora un blocco mono e restituisce i campioni a 16 kHz disponibili. */
	process(input: Float32Array): Float32Array {
		if (this.passthrough) return input.slice();
		const buf = new Float32Array(this.history.length + input.length);
		buf.set(this.history, 0);
		buf.set(input, this.history.length);
		const out: number[] = [];
		const lastNeeded = (p: number) => Math.floor(p) + this.halfWidth;
		let p = this.pos;
		const result = new Float32Array(Math.max(0, Math.ceil((buf.length - this.halfWidth - p) / this.ratio) + 1));
		let n = 0;
		while (lastNeeded(p) < buf.length) {
			const base = Math.floor(p);
			const frac = p - base;
			const ph = Math.round(frac * PHASES);
			const off = ph * this.taps;
			const start = base - (this.halfWidth - 1);
			let acc = 0;
			for (let k = 0; k < this.taps; k++) acc += buf[start + k] * this.table[off + k];
			if (n < result.length) result[n++] = acc;
			else out.push(acc);
			p += this.ratio;
		}
		// conserva solo la coda necessaria
		const keepFrom = Math.max(0, Math.floor(p) - (this.halfWidth - 1));
		this.history = buf.slice(keepFrom);
		this.pos = p - keepFrom;
		if (out.length) {
			const merged = new Float32Array(n + out.length);
			merged.set(result.subarray(0, n));
			merged.set(out, n);
			return merged;
		}
		return result.subarray(0, n);
	}

	/** Svuota la coda a fine flusso (aggiunge silenzio per far uscire gli ultimi campioni). */
	flush(): Float32Array {
		if (this.passthrough) return new Float32Array(0);
		return this.process(new Float32Array(this.halfWidth + 1));
	}
}

/** Miscela canali planari in mono. */
export function mixToMono(planes: Float32Array[]): Float32Array {
	if (planes.length === 1) return planes[0];
	const n = planes[0].length;
	const out = new Float32Array(n);
	const g = 1 / planes.length;
	for (const p of planes) for (let i = 0; i < n; i++) out[i] += p[i] * g;
	return out;
}
