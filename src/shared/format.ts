// Funzioni di formattazione condivise (pure, testate in Node).

export function pad(n: number, width: number): string {
	return String(Math.trunc(n)).padStart(width, '0');
}

/** 3725.4 -> "01h02m05s" (per i nomi dei file). */
export function hmsForFilename(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds + 1e-6));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return `${pad(h, 2)}h${pad(m, 2)}m${pad(sec, 2)}s`;
}

/** 3725.4 -> "01:02:05.400". */
export function hmsMillis(seconds: number): string {
	const totalMs = Math.max(0, Math.round(seconds * 1000));
	const h = Math.floor(totalMs / 3_600_000);
	const m = Math.floor((totalMs % 3_600_000) / 60_000);
	const s = Math.floor((totalMs % 60_000) / 1000);
	const ms = totalMs % 1000;
	return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

/** 3725.4 -> "01:02:05". */
export function hms(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds + 1e-6));
	return `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor((s % 3600) / 60), 2)}:${pad(s % 60, 2)}`;
}

/** Formato SRT: 00:01:02,345 */
export function srtTime(seconds: number): string {
	return hmsMillis(seconds).replace('.', ',');
}

export function frameFileName(index: number, timestamp: number, ext: string): string {
	return `frame_${pad(index, 6)}_${hmsForFilename(timestamp)}.${ext}`;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes)) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = bytes;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toLocaleString('it-IT', { maximumFractionDigits: i >= 3 ? 2 : 1 })} ${units[i]}`;
}

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h} h ${m} min`;
	if (m > 0) return `${m} min ${sec} s`;
	return `${sec} s`;
}

export function formatNumber(n: number, digits = 0): string {
	return n.toLocaleString('it-IT', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** Numero decimale con virgola per CSV italiano. */
export function csvDecimal(n: number, digits = 3): string {
	return n.toFixed(digits).replace('.', ',');
}

/**
 * Stima del tempo residuo: restituita solo se sufficientemente attendibile
 * (almeno 3% di avanzamento e 8 secondi di misura).
 */
export function estimateEta(fraction: number | null, elapsedMs: number): number | null {
	if (fraction === null || fraction < 0.03 || elapsedMs < 8000 || fraction >= 1) return null;
	return (elapsedMs * (1 - fraction)) / fraction;
}
