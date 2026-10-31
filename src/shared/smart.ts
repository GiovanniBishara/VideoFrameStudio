// Rilevamento dei cambiamenti di contenuto per videolezioni (slide, lavagna,
// formule). Lavora su miniature in scala di grigi 320x180 divise in blocchi
// 10x10: un blocco è "cambiato" se contiene abbastanza pixel con differenza
// marcata. Il cursore o il puntatore toccano pochi blocchi e restano sotto soglia;
// le zone che cambiano di continuo (webcam, video incorporati) vengono escluse.

export const THUMB_W = 320;
export const THUMB_H = 180;
const BS = 10;
const BX = THUMB_W / BS; // 32
const BY = THUMB_H / BS; // 18
const NB = BX * BY;

/** Differenza di grigio oltre la quale un pixel è considerato cambiato. */
const PIXEL_DIFF = 25;
/** Pixel cambiati necessari perché un blocco 10x10 sia cambiato. */
const PIXELS_PER_BLOCK = 4;
/** Blocchi minimi: sopra l'impronta tipica del cursore (2-4 blocchi). */
const MIN_BLOCKS = 6;
/** Blocchi minimi per considerare "diverso" lo stato finale prima di un cambio (più del solo cursore). */
const MINOR_BLOCKS = MIN_BLOCKS;
/** Attività (media mobile) oltre la quale un blocco è considerato dinamico. */
const DYNAMIC_ACTIVITY = 0.35;

export interface SmartDecision {
	keepPrevious: boolean;
	keepCurrent: boolean;
}

export function rgbaToGray(rgba: Uint8ClampedArray, out: Uint8Array): Uint8Array {
	for (let i = 0, j = 0; j < out.length; i += 4, j++) {
		out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
	}
	return out;
}

/** Soglia di blocchi cambiati, in frazione dei blocchi attivi, dalla sensibilità 1..100. */
export function sensitivityToFraction(sensitivity: number): number {
	const s = Math.min(100, Math.max(1, sensitivity));
	// scala logaritmica: 1 -> 20%, 100 -> 0,5%
	const hi = Math.log(0.2);
	const lo = Math.log(0.005);
	return Math.exp(hi + ((s - 1) / 99) * (lo - hi));
}

export class ChangeDetector {
	private ref: Uint8Array | null = null;
	private prev: Uint8Array | null = null;
	private prevKept = false;
	private pendingSince: number | null = null;
	private activity = new Float32Array(NB);
	private readonly fraction: number;

	/** Statistiche per il riepilogo. */
	analyzed = 0;
	dynamicBlocks = 0;

	constructor(
		sensitivity: number,
		private ignoreDynamic: boolean,
		private maxWaitSec = 4,
	) {
		this.fraction = sensitivityToFraction(sensitivity);
	}

	private changedBlocks(a: Uint8Array, b: Uint8Array): Uint8Array {
		const changed = new Uint8Array(NB);
		for (let by = 0; by < BY; by++) {
			for (let bx = 0; bx < BX; bx++) {
				let count = 0;
				for (let y = 0; y < BS; y++) {
					let idx = (by * BS + y) * THUMB_W + bx * BS;
					for (let x = 0; x < BS; x++, idx++) {
						const d = a[idx] - b[idx];
						if (d > PIXEL_DIFF || d < -PIXEL_DIFF) count++;
					}
				}
				changed[by * BX + bx] = count >= PIXELS_PER_BLOCK ? 1 : 0;
			}
		}
		return changed;
	}

	private count(changed: Uint8Array, mask: Uint8Array): number {
		let n = 0;
		for (let i = 0; i < NB; i++) if (changed[i] && mask[i]) n++;
		return n;
	}

	push(gray: Uint8Array, t: number): SmartDecision {
		this.analyzed++;
		const frame = gray.slice();
		if (!this.ref || !this.prev) {
			this.ref = frame;
			this.prev = frame;
			this.prevKept = true;
			return { keepPrevious: false, keepCurrent: true };
		}
		const changedPrev = this.changedBlocks(this.prev, frame);
		for (let i = 0; i < NB; i++) this.activity[i] = this.activity[i] * 0.9 + changedPrev[i] * 0.1;

		const mask = new Uint8Array(NB);
		let active = 0;
		let dynamic = 0;
		for (let i = 0; i < NB; i++) {
			const isDynamic = this.ignoreDynamic && this.activity[i] > DYNAMIC_ACTIVITY;
			mask[i] = isDynamic ? 0 : 1;
			if (isDynamic) dynamic++;
			else active++;
		}
		this.dynamicBlocks = dynamic;
		if (active === 0) {
			// Tutto è dinamico (es. video a schermo intero): nessun criterio affidabile.
			this.prev = frame;
			this.prevKept = false;
			return { keepPrevious: false, keepCurrent: false };
		}
		const threshold = Math.max(MIN_BLOCKS, this.fraction * active);
		// "Stabile" = tra due campioni cambia meno di quanto può muovere il cursore.
		const stableThreshold = Math.max(MIN_BLOCKS - 1, threshold * 0.3);

		const nKept = this.count(this.changedBlocks(this.ref, frame), mask);
		const nPrev = this.count(changedPrev, mask);
		let keepPrevious = false;
		let keepCurrent = false;

		if (nKept >= threshold) {
			// Il cambiamento è avvenuto tra il frame precedente e questo:
			// conserva anche lo stato finale precedente (es. lavagna completa prima di cancellare).
			if (this.pendingSince === null && nPrev >= threshold && !this.prevKept) {
				const nPrevVsRef = this.count(this.changedBlocks(this.ref, this.prev), mask);
				if (nPrevVsRef >= MINOR_BLOCKS) {
					keepPrevious = true;
					this.ref = this.prev;
				}
			}
			const waited = this.pendingSince !== null && t - this.pendingSince >= this.maxWaitSec;
			if (nPrev <= stableThreshold || waited) {
				keepCurrent = true;
				this.ref = frame;
				this.pendingSince = null;
			} else if (this.pendingSince === null) {
				this.pendingSince = t;
			}
		} else {
			this.pendingSince = null;
		}
		this.prev = frame;
		this.prevKept = keepCurrent;
		return { keepPrevious, keepCurrent };
	}

	/** A fine video: se un cambiamento era in attesa di stabilizzarsi, va conservato l'ultimo frame. */
	finish(): boolean {
		return this.pendingSince !== null && !this.prevKept;
	}
}
