// Composizione del testo finale: paragrafi leggibili, timestamp opzionali, SRT.
// Nessuna parola viene tolta o riassunta: si cambia solo l'impaginazione.

import { hms, srtTime } from './format';
import type { TranscriptGap, TranscriptSegment } from './types';

const PARAGRAPH_PAUSE = 2.0; // secondi di pausa che aprono un nuovo paragrafo
const PARAGRAPH_SOFT_LIMIT = 600; // caratteri: oltre, si va a capo alla fine della frase
const PARAGRAPH_HARD_LIMIT = 1400;

function endsSentence(text: string) {
	return /[.!?…»"”)]\s*$/.test(text.trim());
}

interface Item {
	kind: 'seg' | 'gap';
	start: number;
	end: number;
	text: string;
}

function merge(segments: TranscriptSegment[], gaps: TranscriptGap[]): Item[] {
	const items: Item[] = [
		...segments.map((s) => ({ kind: 'seg' as const, start: s.start, end: s.end, text: s.text })),
		...gaps.map((g) => ({
			kind: 'gap' as const,
			start: g.start,
			end: g.end,
			text: `[PARTE NON TRASCRITTA ${hms(g.start)}–${hms(g.end)}: ${g.reason}]`,
		})),
	];
	return items.sort((a, b) => a.start - b.start);
}

export function buildParagraphs(segments: TranscriptSegment[], gaps: TranscriptGap[] = []) {
	const items = merge(segments, gaps);
	const paragraphs: { start: number; text: string }[] = [];
	let cur: { start: number; parts: string[]; len: number; lastEnd: number } | null = null;
	const push = () => {
		if (cur && cur.parts.length) paragraphs.push({ start: cur.start, text: cur.parts.join(' ').replace(/\s+/g, ' ').trim() });
		cur = null;
	};
	for (const it of items) {
		if (it.kind === 'gap') {
			push();
			paragraphs.push({ start: it.start, text: it.text });
			continue;
		}
		const text = it.text.trim();
		if (!text) continue;
		if (cur) {
			const c = cur as { start: number; parts: string[]; len: number; lastEnd: number };
			const pause = it.start - c.lastEnd;
			const lastText = c.parts[c.parts.length - 1] ?? '';
			const breakHere =
				(pause >= PARAGRAPH_PAUSE && endsSentence(lastText)) ||
				(c.len >= PARAGRAPH_SOFT_LIMIT && endsSentence(lastText)) ||
				c.len >= PARAGRAPH_HARD_LIMIT;
			if (breakHere) push();
		}
		if (!cur) cur = { start: it.start, parts: [], len: 0, lastEnd: it.end };
		const c = cur as { start: number; parts: string[]; len: number; lastEnd: number };
		c.parts.push(text);
		c.len += text.length + 1;
		c.lastEnd = it.end;
	}
	push();
	return paragraphs;
}

export function buildTxt(
	segments: TranscriptSegment[],
	gaps: TranscriptGap[],
	mode: 'none' | 'paragraph' | 'segment',
	header: string[],
): string {
	const lines: string[] = [];
	if (header.length) {
		lines.push(...header, '', '');
	}
	if (mode === 'segment') {
		for (const it of merge(segments, gaps)) {
			lines.push(it.kind === 'gap' ? it.text : `[${hms(it.start)}] ${it.text.trim()}`);
		}
	} else {
		for (const p of buildParagraphs(segments, gaps)) {
			lines.push(mode === 'paragraph' ? `[${hms(p.start)}] ${p.text}` : p.text);
			lines.push('');
		}
	}
	return lines.join('\r\n').replace(/(\r\n)+$/, '') + '\r\n';
}

export function buildSrt(segments: TranscriptSegment[]): string {
	const out: string[] = [];
	let i = 1;
	for (const s of segments) {
		const text = s.text.trim();
		if (!text) continue;
		const end = Math.max(s.end, s.start + 0.5);
		out.push(String(i++), `${srtTime(s.start)} --> ${srtTime(end)}`, ...wrapSubtitle(text), '');
	}
	return out.join('\r\n');
}

function wrapSubtitle(text: string, max = 84): string[] {
	if (text.length <= max) return [text];
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let line = '';
	for (const w of words) {
		if ((line + ' ' + w).trim().length > max && line) {
			lines.push(line);
			line = w;
		} else line = (line + ' ' + w).trim();
	}
	if (line) lines.push(line);
	return lines;
}
