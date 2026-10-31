// Scrittura progressiva degli output, senza accumulare i file in RAM.
// Ordine di preferenza: cartella scelta dall'utente (File System Access API),
// Origin Private File System del browser (OPFS), memoria (ultimo ripiego).

import type { OutputRef, OutputTarget } from './types';

export const OPFS_PREFIX = 'vfts-';

interface Backend {
	writeAt(data: Uint8Array, position: number): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
	memoryBlob?(): Blob;
}

class SyncHandleBackend implements Backend {
	constructor(private handle: FileSystemSyncAccessHandle) {}
	async writeAt(data: Uint8Array, position: number) {
		let written = 0;
		while (written < data.byteLength) {
			const n = this.handle.write(data.subarray(written), { at: position + written });
			if (n <= 0) throw new Error('Scrittura su disco non riuscita (spazio esaurito?)');
			written += n;
		}
	}
	async close() {
		this.handle.flush();
		this.handle.close();
	}
	async abort() {
		try {
			this.handle.close();
		} catch {
			/* già chiuso */
		}
	}
}

class WritableBackend implements Backend {
	private pending: Uint8Array[] = [];
	private pendingBytes = 0;
	private pendingStart = 0;
	private static readonly BATCH = 8 * 1024 * 1024;
	constructor(private writable: FileSystemWritableFileStream) {}
	private async flush() {
		if (this.pendingBytes === 0) return;
		const buf = new Uint8Array(this.pendingBytes);
		let o = 0;
		for (const p of this.pending) {
			buf.set(p, o);
			o += p.byteLength;
		}
		const start = this.pendingStart;
		this.pending = [];
		this.pendingBytes = 0;
		await this.writable.write({ type: 'write', position: start, data: buf });
	}
	async writeAt(data: Uint8Array, position: number) {
		// Accoda le scritture contigue, scrive in blocchi grandi.
		if (this.pendingBytes > 0 && position !== this.pendingStart + this.pendingBytes) {
			await this.flush();
		}
		if (this.pendingBytes === 0) this.pendingStart = position;
		// copia: il chiamante potrebbe riutilizzare il buffer
		this.pending.push(data.slice());
		this.pendingBytes += data.byteLength;
		if (this.pendingBytes >= WritableBackend.BATCH) await this.flush();
	}
	async close() {
		await this.flush();
		await this.writable.close();
	}
	async abort() {
		try {
			await this.writable.abort();
		} catch {
			/* ignorato */
		}
	}
}

/** Ultimo ripiego: pagine da 16 MB in memoria (solo se OPFS non è disponibile). */
class MemoryBackend implements Backend {
	private pages: Uint8Array[] = [];
	private size = 0;
	private static readonly PAGE = 16 * 1024 * 1024;
	async writeAt(data: Uint8Array, position: number) {
		let off = 0;
		while (off < data.byteLength) {
			const abs = position + off;
			const pi = Math.floor(abs / MemoryBackend.PAGE);
			const po = abs % MemoryBackend.PAGE;
			while (this.pages.length <= pi) this.pages.push(new Uint8Array(MemoryBackend.PAGE));
			const n = Math.min(MemoryBackend.PAGE - po, data.byteLength - off);
			this.pages[pi].set(data.subarray(off, off + n), po);
			off += n;
		}
		this.size = Math.max(this.size, position + data.byteLength);
	}
	async close() {}
	async abort() {
		this.pages = [];
	}
	memoryBlob(): Blob {
		const parts: BlobPart[] = [];
		let remaining = this.size;
		for (const p of this.pages) {
			if (remaining <= 0) break;
			const n = Math.min(p.byteLength, remaining);
			parts.push(p.subarray(0, n) as Uint8Array<ArrayBuffer>);
			remaining -= n;
		}
		return new Blob(parts);
	}
}

export class OutFile {
	/** Dimensione logica del file (massima posizione scritta). */
	size = 0;
	private cursor = 0;
	private closed = false;

	private constructor(
		private backend: Backend,
		private storage: OutputRef['storage'],
		private internalName: string,
		readonly downloadName: string,
		private dirHandle: FileSystemDirectoryHandle | null,
	) {}

	static async open(target: OutputTarget, runId: string, downloadName: string): Promise<OutFile> {
		if (target.kind === 'dir') {
			const name = await uniqueName(target.handle, downloadName);
			const fh = await target.handle.getFileHandle(name, { create: true });
			const writable = await fh.createWritable({ keepExistingData: false });
			return new OutFile(new WritableBackend(writable), 'dir', name, name, target.handle);
		}
		try {
			const root = await navigator.storage.getDirectory();
			const internal = `${OPFS_PREFIX}${runId}-${downloadName}`;
			const fh = await root.getFileHandle(internal, { create: true });
			// FileSystemSyncAccessHandle: disponibile solo nei Dedicated Worker, è il modo più veloce.
			const anyFh = fh as FileSystemFileHandle & {
				createSyncAccessHandle?: () => Promise<FileSystemSyncAccessHandle>;
			};
			if (typeof anyFh.createSyncAccessHandle === 'function') {
				const h = await anyFh.createSyncAccessHandle();
				h.truncate(0);
				return new OutFile(new SyncHandleBackend(h), 'opfs', internal, downloadName, root);
			}
			const writable = await fh.createWritable({ keepExistingData: false });
			return new OutFile(new WritableBackend(writable), 'opfs', internal, downloadName, root);
		} catch (err) {
			console.warn('OPFS non disponibile, uso la memoria', err);
			return new OutFile(new MemoryBackend(), 'memory', downloadName, downloadName, null);
		}
	}

	get usesMemory() {
		return this.storage === 'memory';
	}

	async writeAt(data: Uint8Array, position: number) {
		await this.backend.writeAt(data, position);
		this.size = Math.max(this.size, position + data.byteLength);
	}

	async append(data: Uint8Array) {
		await this.writeAt(data, this.cursor);
		this.cursor += data.byteLength;
	}

	get position() {
		return this.cursor;
	}

	/** WritableStream compatibile con StreamTarget di Mediabunny (chunk con position). */
	asStreamTargetWritable(): WritableStream<{ type: 'write'; data: Uint8Array; position: number }> {
		return new WritableStream({
			write: async (chunk) => {
				await this.writeAt(chunk.data, chunk.position);
			},
		});
	}

	async close(): Promise<OutputRef> {
		if (!this.closed) {
			this.closed = true;
			await this.backend.close();
		}
		return {
			storage: this.storage,
			name: this.internalName,
			downloadName: this.downloadName,
			bytes: this.size,
			blob: this.backend.memoryBlob?.(),
		};
	}

	/** Chiude ed elimina il file parziale. */
	async discard() {
		if (this.closed) return;
		this.closed = true;
		await this.backend.abort();
		if (this.dirHandle && this.storage !== 'memory') {
			try {
				await this.dirHandle.removeEntry(this.internalName);
			} catch {
				/* ignorato */
			}
		}
	}
}

async function uniqueName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
	const dot = name.lastIndexOf('.');
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	for (let i = 1; i < 1000; i++) {
		const candidate = i === 1 ? name : `${base} (${i})${ext}`;
		try {
			await dir.getFileHandle(candidate);
		} catch {
			return candidate;
		}
	}
	return `${base}-${Date.now()}${ext}`;
}

/** Elimina un output già chiuso (es. primo tentativo di compressione scartato). */
export async function removeOutput(target: OutputTarget, ref: OutputRef): Promise<void> {
	try {
		if (ref.storage === 'opfs') await (await navigator.storage.getDirectory()).removeEntry(ref.name);
		else if (ref.storage === 'dir' && target.kind === 'dir') await target.handle.removeEntry(ref.name);
	} catch {
		/* ignorato */
	}
}
