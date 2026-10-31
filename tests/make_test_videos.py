#!/usr/bin/env python3
"""Genera i video di prova (con ffmpeg) e i dati attesi per i test automatici.

- breve.mp4: 60 s, 1280x720, 30 fps. Nell'angolo in alto a sinistra il numero
  del fotogramma è scritto in binario (11 quadrati bianco/nero), così si può
  verificare che ogni immagine estratta sia esattamente il fotogramma giusto.
  6 slide (una ogni 10 s), cursore che si muove, "webcam" sempre animata.
  Audio: frasi simulate (toni) note in anticipo.
- lungo.mp4: N minuti 1920x1080 30 fps ad alto bitrate (file > 1 GB se lungo),
  slide ogni 60 s, stessa struttura.
"""
import json
import math
import struct
import subprocess
import sys
import wave
import random

out_dir = sys.argv[1]
long_minutes = float(sys.argv[2]) if len(sys.argv) > 2 else 20
long_bitrate = sys.argv[3] if len(sys.argv) > 3 else '8M'
SR = 48000


def tone_wav(path, total, seed):
    rnd = random.Random(seed)
    sentences = []
    t = 0.8
    i = 1
    while t < total - 8:
        dur = 2 + rnd.random() * 7
        sentences.append({'id': i % 150 or 150, 'start': round(t, 3), 'dur': round(dur, 3)})
        t += dur + 0.3 + rnd.random() * 2.5
        i += 1
    import numpy as np
    n = int(total * SR)
    samples = np.zeros(n, dtype=np.float64)
    for s in sentences:
        f = 300 + 10 * s['id']
        i0 = int(s['start'] * SR)
        i1 = min(n, int((s['start'] + s['dur']) * SR))
        k = np.arange(i1 - i0)
        samples[i0:i1] = 0.3 * np.sin(2 * np.pi * f * k / SR)
    samples += (np.random.default_rng(seed).random(n) - 0.5) * 0.002
    x = (np.clip(samples, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(np.repeat(x, 2).tobytes())
    return sentences


def slides_filter(width, height, total, every, bits):
    n_slides = int(math.ceil(total / every))
    fs = max(24, height // 20)
    parts = []
    for k in range(n_slides):
        a, b = k * every, (k + 1) * every
        lines = [f'Lezione - slide {k + 1}', f'Formula {k + 1}: f(x) = x^{k + 2} + {k * 3 + 1}x', 'Teorema ' + 'ABCDEFGHIJ'[k % 10] * (k % 5 + 3)]
        for j, text in enumerate(lines):
            parts.append(
                f"drawtext=text='{text}':fontsize={fs}:fontcolor=black:x={width // 12}:y={height // 6 + j * fs * 2}:enable='between(t,{a},{b})'"
            )
    # cursore: piccolo rettangolo scuro che si sposta continuamente
    parts.append(f"drawbox=x='mod(t*237,{width - 60})':y='{height // 2}+mod(t*91,{height // 4})':w={max(8, width // 120)}:h={max(12, height // 50)}:color=black@1:t=fill")
    chain = ','.join(parts)
    if bits:
        # numero del fotogramma in binario: 11 quadrati 16x16 in alto a sinistra
        chain += ",format=yuv420p,geq=lum='if(lt(Y,16)*lt(X,176),255*mod(floor(N/pow(2,floor(X/16))),2),lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)'"
    return chain


def make(path, width, height, total, every, bits, bitrate, seed, preset):
    wav = path.replace('.mp4', '.wav')
    sentences = tone_wav(wav, total, seed)
    cam_w, cam_h = width // 5, height // 5
    graph = (
        f"color=c=white:s={width}x{height}:r=30:d={total}[bg];"
        f"testsrc2=s={cam_w}x{cam_h}:r=30:d={total}[cam];"
        f"[bg][cam]overlay=x={width - cam_w - 20}:y={height - cam_h - 20},{slides_filter(width, height, total, every, bits)}[v]"
    )
    cmd = [
        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
        '-filter_complex', graph, '-i', wav,
        '-map', '[v]', '-map', '0:a',
        '-c:v', 'libx264', '-preset', preset, '-pix_fmt', 'yuv420p', '-g', '60',
        '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', '2M' if bits else '16M',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path,
    ]
    subprocess.run(cmd, check=True)
    with open(path.replace('.mp4', '.json'), 'w') as f:
        json.dump({'duration': total, 'slides_every': every, 'sentences': sentences}, f)


make(f'{out_dir}/breve.mp4', 1280, 720, 60, 10, True, '2M', 1, 'veryfast')
print('breve.mp4 pronto', flush=True)
if long_minutes > 0:
    make(f'{out_dir}/lungo.mp4', 1920, 1080, long_minutes * 60, 60, False, long_bitrate, 2, 'ultrafast')
    print('lungo.mp4 pronto', flush=True)
