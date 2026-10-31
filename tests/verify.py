#!/usr/bin/env python3
"""Verifica i file scaricati dall'app rispetto al video di prova.

uso: verify.py <video> <cartella-output> <scenario> [target_mb]
"""
import csv
import io
import json
import re
import subprocess
import sys
import zipfile

from PIL import Image

video, out, scenario = sys.argv[1:4]
target_mb = float(sys.argv[4]) if len(sys.argv) > 4 else None
truth = json.load(open(video.replace('.mp4', '.json')))
fails = 0


def check(cond, msg):
    global fails
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        fails += 1


def ffprobe(path, *args):
    return subprocess.run(['ffprobe', '-v', 'error', *args, path], capture_output=True, text=True, check=True).stdout


def video_pts(path):
    out_ = ffprobe(path, '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0')
    return [float(x.strip(',')) for x in out_.split() if x.strip(',')]


def frame_bits(img):
    g = img.convert('L')
    n = 0
    for b in range(11):
        if g.getpixel((b * 16 + 8, 8)) > 128:
            n |= 1 << b
    return n


import glob, os
zips = sorted(glob.glob(os.path.join(out, 'FRAMES*.zip')))
if scenario in ('all', 'interval', 'smart', 'large'):
    print('FRAMES')
    check(len(zips) >= 1, f'archivi ZIP presenti: {[os.path.basename(z) for z in zips]}')
    entries = []
    rows = []
    for zp in zips:
        z = zipfile.ZipFile(zp)
        check(z.testzip() is None, f'{os.path.basename(zp)}: CRC di tutte le voci corretti')
        names = z.namelist()
        entries += [(zp, n) for n in names if n.startswith('frame_')]
        data = z.read('frames_index.csv').decode('utf-8-sig')
        rows += list(csv.reader(io.StringIO(data), delimiter=';'))[1:]
    names = [n for _, n in entries]
    check(names == sorted(names), 'frame in ordine cronologico nei nomi')
    check(all(re.fullmatch(r'frame_\d{6}_\d{2}h\d{2}m\d{2}s\.(jpg|png)', n) for n in names), 'nomi nel formato frame_000001_00h00m01s.jpg')
    check(len(rows) == len(names), f'indice CSV completo ({len(rows)} righe per {len(names)} frame)')
    pts = video_pts(video)
    if scenario == 'all':
        check(len(names) == len(pts), f'tutti i fotogrammi estratti: {len(names)} su {len(pts)}')
        maxdiff = max(abs(float(r[1].replace(',', '.')) - p) for r, p in zip(rows, pts))
        check(maxdiff < 0.0015, f'timestamp del CSV uguali a quelli del video (scarto max {maxdiff * 1000:.2f} ms)')
    if scenario in ('all', 'interval') and 'breve' in video:
        # ogni immagine deve essere esattamente il fotogramma dichiarato
        wrong = 0
        z_cache = {}
        for (zp, n), r in zip(entries, rows):
            z = z_cache.setdefault(zp, zipfile.ZipFile(zp))
            img = Image.open(io.BytesIO(z.read(n)))
            ts = float(r[1].replace(',', '.'))
            expected = round(ts * 30)
            if frame_bits(img) != expected:
                wrong += 1
        check(wrong == 0, f'contenuto di ogni immagine = fotogramma del suo timestamp ({len(entries) - wrong}/{len(entries)})')
        img = Image.open(io.BytesIO(zipfile.ZipFile(entries[0][0]).read(entries[0][1])))
        check(img.size == (1280, 720), f'risoluzione originale {img.size}')
    if scenario == 'interval':
        step = 0.5
        ts = [float(r[1].replace(',', '.')) for r in rows]
        check(len(ts) == int(truth['duration'] / step), f'un frame ogni {step} s: {len(ts)} immagini')
        check(all(abs(t - i * step) < 0.034 for i, t in enumerate(ts)), 'ogni frame è quello all\'istante richiesto (entro un fotogramma)')
    if scenario == 'smart':
        ts = [float(r[1].replace(',', '.')) for r in rows]
        every = truth['slides_every']
        slides = int(truth['duration'] // every)
        print(f'        frame tenuti agli istanti: {ts}')
        found = [any(k * every <= t < k * every + 2 for t in ts) for k in range(slides)]
        check(all(found), f'ogni slide ({slides}) catturata entro 2 s dal cambio')
        check(len(ts) <= slides * 2, f'niente immagini quasi identiche: {len(ts)} frame per {slides} slide (cursore e webcam ignorati)')

if scenario in ('all', 'smart', 'large'):
    print('TRASCRIZIONE')
    txt = open(os.path.join(out, 'TRASCRIZIONE.txt'), encoding='utf-8-sig').read()
    ids = [int(x) for x in re.findall(r'frase (\d+)\.', txt)]
    exp = [s['id'] for s in truth['sentences']]
    check(ids == exp, f'tutte le {len(exp)} frasi, nell\'ordine, senza duplicati (trovate {len(ids)})')
    stamps = re.findall(r'^\[(\d\d):(\d\d):(\d\d)\] frase (\d+)', txt, re.M)
    # ogni paragrafo inizia con la frase successiva all'ultima già vista: confronto in sequenza
    ok = True
    pos = 0
    sent = truth['sentences']
    for h, m, s_, i in stamps:
        while pos < len(sent) and sent[pos]['id'] != int(i):
            pos += 1
        if pos >= len(sent) or abs(int(h) * 3600 + int(m) * 60 + int(s_) - int(sent[pos]['start'])) > 1:
            ok = False
            break
        pos += 1
    check(len(stamps) > 0 and ok, f'timestamp di inizio paragrafo corretti ({len(stamps)} paragrafi)')

if scenario in ('all', 'compress'):
    print('COMPRESSIONE')
    mp4 = os.path.join(out, 'VIDEO_COMPRESSO.mp4')
    size = os.path.getsize(mp4)
    if target_mb:
        check(size <= target_mb * 1048576, f'dimensione {size / 1048576:.2f} MB ≤ obiettivo {target_mb} MB')
    info = json.loads(ffprobe(mp4, '-show_streams', '-show_format', '-of', 'json'))
    orig = json.loads(ffprobe(video, '-show_streams', '-show_format', '-of', 'json'))
    v = [s for s in info['streams'] if s['codec_type'] == 'video'][0]
    vo = [s for s in orig['streams'] if s['codec_type'] == 'video'][0]
    a = [s for s in info['streams'] if s['codec_type'] == 'audio']
    check(v['codec_name'] == 'h264', 'video H.264')
    check((v['width'], v['height']) == (vo['width'], vo['height']), f"risoluzione originale {v['width']}x{v['height']}")
    check(v['r_frame_rate'] == vo['r_frame_rate'] and v['avg_frame_rate'] == vo['avg_frame_rate'], f"FPS originali {v['avg_frame_rate']}")
    n_out = len(video_pts(mp4))
    n_in = len(video_pts(video))
    check(n_out == n_in, f'stesso numero di fotogrammi ({n_out}/{n_in})')
    check(len(a) == 1 and a[0]['codec_name'] == 'aac', 'audio presente (AAC copiato)')
    dv = float(v['duration'])
    da = float(a[0]['duration'])
    check(abs(dv - float(vo['duration'])) < 0.05 and abs(da - dv) < 0.1, f'durate allineate: video {dv:.3f} s, audio {da:.3f} s')
    # sincronia: l'audio dell'originale e del compresso deve essere identico (copiato)
    def audio_md5(p):
        return subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-map', '0:a', '-f', 'md5', '-'], capture_output=True, text=True).stdout.strip()
    check(audio_md5(mp4) == audio_md5(video), 'audio identico all\'originale (nessuna ricodifica, nessuno spostamento)')
    if 'breve' in video:
        # il fotogramma N del compresso deve mostrare ancora il numero N
        bad = 0
        for n in (0, 450, 901, 1799):
            png = subprocess.run(['ffmpeg', '-v', 'error', '-i', mp4, '-vf', f'select=eq(n\\,{n})', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'], capture_output=True).stdout
            if frame_bits(Image.open(io.BytesIO(png))) != n:
                bad += 1
        check(bad == 0, 'fotogrammi nella posizione giusta dopo la compressione (verifica a campione su 4)')

print(f'\n{fails} verifiche fallite' if fails else '\nTutte le verifiche superate')
sys.exit(1 if fails else 0)
