// Scrittore ZIP in streaming, metodo STORE (nessuna ricompressione: JPG e PNG
// sono già compressi, ricomprimerli costerebbe tempo senza guadagno), con
// supporto ZIP64 per archivi oltre 4 GB o con più di 65.535 file.
// Le voci vengono scritte una dopo l'altra: in RAM resta solo l'indice centrale
// (circa 100 byte per file).

export interface ZipSink {
	append(data: Uint8Array): Promise<void>;
}

const CRC_TABLE = (() => {
	// Tabelle slicing-by-8 per CRC-32 (polinomio 0xEDB88320).
	const t = new Uint32Array(8 * 256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[i] = c >>> 0;
	}
	for (let i = 0; i < 256; i++) {
		let c = t[i];
		for (let s = 1; s < 8; s++) {
			c = t[c & 0xff] ^ (c >>> 8);
			t[s * 256 + i] = c >>> 0;
		}
	}
	return t;
})();

export function crc32(data: Uint8Array, prev = 0): number {
	const t = CRC_TABLE;
	let c = ~prev >>> 0;
	let i = 0;
	const n = data.length;
	for (; i + 8 <= n; i += 8) {
		const a = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) ^ c;
		const b = data[i + 4] | (data[i + 5] << 8) | (data[i + 6] << 16) | (data[i + 7] << 24);
		c =
			t[7 * 256 + (a & 0xff)] ^
			t[6 * 256 + ((a >>> 8) & 0xff)] ^
			t[5 * 256 + ((a >>> 16) & 0xff)] ^
			t[4 * 256 + (a >>> 24)] ^
			t[3 * 256 + (b & 0xff)] ^
			t[2 * 256 + ((b >>> 8) & 0xff)] ^
			t[256 + ((b >>> 16) & 0xff)] ^
			t[b >>> 24];
	}
	for (; i < n; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return ~c >>> 0;
}

interface Entry {
	name: Uint8Array;
	crc: number;
	size: number;
	offset: number;
	time: number;
	date: number;
}

const enc = new TextEncoder();
const U32 = 0xffffffff;

function dosDateTime(d: Date) {
	const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
	const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	return { time, date };
}

function setU64(v: DataView, off: number, n: number) {
	v.setUint32(off, n % 0x100000000, true);
	v.setUint32(off + 4, Math.floor(n / 0x100000000), true);
}

export class ZipWriter {
	private entries: Entry[] = [];
	private offset = 0;
	private finished = false;
	private stamp = dosDateTime(new Date());

	constructor(private sink: ZipSink) {}

	/** Byte già scritti nell'archivio. */
	get bytesWritten() {
		return this.offset;
	}

	get entryCount() {
		return this.entries.length;
	}

	/** Dimensione che avrebbe l'archivio aggiungendo un file di `size` byte con nome `name` e chiudendolo. */
	projectedSizeWith(name: string, size: number): number {
		const nameLen = enc.encode(name).length;
		const cdCurrent = this.entries.reduce((s, e) => s + 46 + e.name.length + 12, 0);
		return this.offset + 30 + nameLen + size + cdCurrent + 46 + nameLen + 12 + 98;
	}

	async add(name: string, data: Uint8Array): Promise<void> {
		if (this.finished) throw new Error('ZIP già chiuso');
		if (data.byteLength >= U32) throw new Error('File singolo troppo grande per lo ZIP');
		const nameBytes = enc.encode(name);
		const crc = crc32(data);
		const header = new Uint8Array(30 + nameBytes.length);
		const v = new DataView(header.buffer);
		v.setUint32(0, 0x04034b50, true);
		v.setUint16(4, 20, true); // versione necessaria
		v.setUint16(6, 0x0800, true); // nomi in UTF-8
		v.setUint16(8, 0, true); // STORE
		v.setUint16(10, this.stamp.time, true);
		v.setUint16(12, this.stamp.date, true);
		v.setUint32(14, crc, true);
		v.setUint32(18, data.byteLength, true);
		v.setUint32(22, data.byteLength, true);
		v.setUint16(26, nameBytes.length, true);
		v.setUint16(28, 0, true);
		header.set(nameBytes, 30);
		const entryOffset = this.offset;
		await this.sink.append(header);
		await this.sink.append(data);
		this.offset += header.byteLength + data.byteLength;
		this.entries.push({
			name: nameBytes,
			crc,
			size: data.byteLength,
			offset: entryOffset,
			time: this.stamp.time,
			date: this.stamp.date,
		});
	}

	async finish(): Promise<void> {
		if (this.finished) return;
		this.finished = true;
		const cdStart = this.offset;
		// Indice centrale, scritto a blocchi da ~4 MB.
		let chunk: Uint8Array[] = [];
		let chunkBytes = 0;
		const flush = async () => {
			if (!chunkBytes) return;
			const buf = new Uint8Array(chunkBytes);
			let o = 0;
			for (const c of chunk) {
				buf.set(c, o);
				o += c.byteLength;
			}
			chunk = [];
			chunkBytes = 0;
			await this.sink.append(buf);
		};
		for (const e of this.entries) {
			const needZip64 = e.offset >= U32;
			const extraLen = needZip64 ? 12 : 0;
			const rec = new Uint8Array(46 + e.name.length + extraLen);
			const v = new DataView(rec.buffer);
			v.setUint32(0, 0x02014b50, true);
			v.setUint16(4, 45, true); // creato da: v4.5, MS-DOS
			v.setUint16(6, needZip64 ? 45 : 20, true);
			v.setUint16(8, 0x0800, true);
			v.setUint16(10, 0, true);
			v.setUint16(12, e.time, true);
			v.setUint16(14, e.date, true);
			v.setUint32(16, e.crc, true);
			v.setUint32(20, e.size, true);
			v.setUint32(24, e.size, true);
			v.setUint16(28, e.name.length, true);
			v.setUint16(30, extraLen, true);
			v.setUint16(32, 0, true);
			v.setUint16(34, 0, true);
			v.setUint16(36, 0, true);
			v.setUint32(38, 0, true);
			v.setUint32(42, needZip64 ? U32 : e.offset, true);
			rec.set(e.name, 46);
			if (needZip64) {
				const x = 46 + e.name.length;
				v.setUint16(x, 0x0001, true);
				v.setUint16(x + 2, 8, true);
				setU64(v, x + 4, e.offset);
			}
			chunk.push(rec);
			chunkBytes += rec.byteLength;
			if (chunkBytes > 4 * 1024 * 1024) await flush();
		}
		await flush();
		let cdBytes = 0;
		for (const e of this.entries) cdBytes += 46 + e.name.length + (e.offset >= U32 ? 12 : 0);
		const cdEnd = cdStart + cdBytes;
		const count = this.entries.length;
		const needZip64End = count >= 0xffff || cdStart >= U32 || cdBytes >= U32;
		const tail: Uint8Array[] = [];
		if (needZip64End) {
			const r = new Uint8Array(56);
			const v = new DataView(r.buffer);
			v.setUint32(0, 0x06064b50, true);
			setU64(v, 4, 44);
			v.setUint16(12, 45, true);
			v.setUint16(14, 45, true);
			v.setUint32(16, 0, true);
			v.setUint32(20, 0, true);
			setU64(v, 24, count);
			setU64(v, 32, count);
			setU64(v, 40, cdBytes);
			setU64(v, 48, cdStart);
			tail.push(r);
			const l = new Uint8Array(20);
			const lv = new DataView(l.buffer);
			lv.setUint32(0, 0x07064b50, true);
			lv.setUint32(4, 0, true);
			setU64(lv, 8, cdEnd);
			lv.setUint32(16, 1, true);
			tail.push(l);
		}
		const eocd = new Uint8Array(22);
		const ev = new DataView(eocd.buffer);
		ev.setUint32(0, 0x06054b50, true);
		ev.setUint16(4, 0, true);
		ev.setUint16(6, 0, true);
		ev.setUint16(8, needZip64End ? 0xffff : count, true);
		ev.setUint16(10, needZip64End ? 0xffff : count, true);
		ev.setUint32(12, needZip64End ? U32 : cdBytes, true);
		ev.setUint32(16, needZip64End ? U32 : cdStart, true);
		ev.setUint16(20, 0, true);
		tail.push(eocd);
		for (const t of tail) await this.sink.append(t);
		this.offset = cdEnd + tail.reduce((s, t) => s + t.byteLength, 0);
	}
}
