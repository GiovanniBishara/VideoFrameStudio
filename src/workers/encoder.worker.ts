// Worker di codifica immagini: riceve un ImageBitmap a piena risoluzione e
// restituisce i byte JPG/PNG. Più istanze lavorano in parallelo.

interface Job {
	id: number;
	bitmap: ImageBitmap;
	format: 'jpeg' | 'png';
	quality: number;
}

let canvas: OffscreenCanvas | null = null;
let bitmapCtx: ImageBitmapRenderingContext | null = null;
let ctx2d: OffscreenCanvasRenderingContext2D | null = null;

// Verifica una volta sola se l'esportazione diretta da 'bitmaprenderer' funziona
// (evita una copia per frame); altrimenti si usa il contesto 2D.
const modeReady: Promise<'bitmap' | '2d'> = (async () => {
	try {
		const src = new OffscreenCanvas(2, 2);
		const sctx = src.getContext('2d')!;
		sctx.fillStyle = '#f00';
		sctx.fillRect(0, 0, 2, 2);
		const bmp = src.transferToImageBitmap();
		const c = new OffscreenCanvas(2, 2);
		const bctx = c.getContext('bitmaprenderer');
		if (!bctx) return '2d';
		bctx.transferFromImageBitmap(bmp);
		const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
		return blob.size > 0 ? 'bitmap' : '2d';
	} catch {
		return '2d';
	}
})();

async function encode(job: Job, mode: 'bitmap' | '2d'): Promise<ArrayBuffer> {
	const { bitmap } = job;
	if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
		canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		bitmapCtx = mode === 'bitmap' ? canvas.getContext('bitmaprenderer') : null;
		ctx2d = mode === '2d' ? canvas.getContext('2d', { alpha: false }) : null;
	}
	if (bitmapCtx) {
		bitmapCtx.transferFromImageBitmap(bitmap); // nessuna copia
	} else {
		ctx2d!.drawImage(bitmap, 0, 0);
		bitmap.close();
	}
	const blob = await canvas.convertToBlob({
		type: job.format === 'png' ? 'image/png' : 'image/jpeg',
		quality: job.format === 'jpeg' ? job.quality : undefined,
	});
	return blob.arrayBuffer();
}

self.onmessage = async (e: MessageEvent<Job>) => {
	const job = e.data;
	try {
		const buf = await encode(job, await modeReady);
		(self as unknown as Worker).postMessage({ id: job.id, buf }, [buf]);
	} catch (err) {
		try {
			job.bitmap.close();
		} catch {
			/* già chiuso */
		}
		(self as unknown as Worker).postMessage({ id: job.id, error: String((err as Error)?.message ?? err) });
	}
};
