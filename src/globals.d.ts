// Tipi delle API disponibili solo nei Dedicated Worker (assenti nella lib DOM di TypeScript).
interface FileSystemSyncAccessHandle {
	read(buffer: ArrayBufferView, options?: { at?: number }): number;
	write(buffer: ArrayBufferView, options?: { at?: number }): number;
	truncate(size: number): void;
	getSize(): number;
	flush(): void;
	close(): void;
}
