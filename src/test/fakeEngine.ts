// SOLO PER I TEST AUTOMATICI (escluso dalla build pubblicata).
// Simula un riconoscitore: ogni "frase" dell'audio di prova è un tono di
// frequenza 300 + 10·N Hz; il motore la "trascrive" come "frase N" con i
// timestamp misurati. Una frase che tocca il bordo della finestra viene
// restituita senza fine, come fa Whisper: così si verifica che la logica di
// avanzamento non perda né duplichi nulla e che i timestamp siano corretti.

import { SAMPLE_RATE, type AsrEngine, type RawSegment, type WindowRequest } from '../shared/transcribeCore';

export class FakeToneEngine implements AsrEngine {
	hasPrompt = false;
	promptText = '';
	calls = 0;

	async detectLanguage(): Promise<string | null> {
		return 'it';
	}

	async transcribeWindow(audio: Float32Array, _req: WindowRequest): Promise<RawSegment[]> {
		this.calls++;
		const frame = SAMPLE_RATE / 50; // 20 ms
		const nFrames = Math.floor(audio.length / frame);
		const voiced: boolean[] = [];
		for (let f = 0; f < nFrames; f++) {
			let s = 0;
			for (let i = f * frame; i < (f + 1) * frame; i++) s += audio[i] * audio[i];
			voiced.push(Math.sqrt(s / frame) > 0.02);
		}
		const segs: RawSegment[] = [];
		let f = 0;
		while (f < nFrames) {
			if (!voiced[f]) {
				f++;
				continue;
			}
			const a = f;
			while (f < nFrames && voiced[f]) f++;
			const b = f;
			const startSample = a * frame;
			const endSample = b * frame;
			// frequenza dagli attraversamenti dello zero (con isteresi, misurata tra il primo e l'ultimo)
			let crossings = 0;
			let sign = 0;
			let firstCross = -1;
			let lastCross = -1;
			for (let i = startSample; i < endSample; i++) {
				const v = audio[i];
				const sgn = v > 0.05 ? 1 : v < -0.05 ? -1 : 0;
				if (sgn !== 0 && sign !== 0 && sgn !== sign) {
					crossings++;
					if (firstCross < 0) firstCross = i;
					lastCross = i;
				}
				if (sgn !== 0) sign = sgn;
			}
			const freq = crossings > 1 ? (crossings - 1) / 2 / ((lastCross - firstCross) / SAMPLE_RATE) : 0;
			const id = Math.round((freq - 300) / 10);
			const touchesEnd = b >= nFrames - 1;
			segs.push({
				start: Math.round((startSample / SAMPLE_RATE) * 50) / 50,
				end: touchesEnd ? null : Math.round((endSample / SAMPLE_RATE) * 50) / 50,
				text: `frase ${id}.`,
			});
		}
		await new Promise((r) => setTimeout(r, 5));
		return segs;
	}
}
