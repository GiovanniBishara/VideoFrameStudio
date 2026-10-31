# VideoFrame & Transcript Studio

Web app che, caricando una sola volta un video (anche oltre 1 GB), produce:

- **FRAMES.zip** – fotogrammi in ordine cronologico, con `frames_index.csv`
- **TRASCRIZIONE.txt** – trascrizione completa con Whisper (opzionale `SOTTOTITOLI.srt`)
- **VIDEO_COMPRESSO.mp4** – solo se richiesto, H.264 verso una dimensione obiettivo

Tutto avviene nel browser (Chrome o Edge su Windows 11): il video non viene caricato su nessun server.
Gratuito, senza account, senza installare programmi.

## Come usarla

### A. File unico (il modo più semplice)

Apri `VideoFrameStudio.html` con doppio clic in Chrome o Edge. Funziona da disco, senza server.

### B. Pubblicata su un sito gratuito (consigliato per l'uso continuativo)

La cartella `dist/` è un sito statico: basta caricarla su un hosting gratuito con HTTPS, per esempio:

- **Netlify Drop**: vai su https://app.netlify.com/drop e trascina la cartella `dist` nella pagina.
- **Cloudflare Pages** o **GitHub Pages**: carica il contenuto di `dist/` come sito statico.

Con un indirizzo `https://` il browser conserva in modo affidabile la cache del modello Whisper
(scaricato una sola volta) e l'archivio dei risultati.

Al primo uso della trascrizione servono internet e circa 1,4 GB di download (modello "Alta precisione")
o circa 300 MB (modello "Veloce"); dalle volte successive il modello è nella cache del browser.

## Come funziona

| Parte | Tecnologia |
|---|---|
| Lettura del video (MP4, MOV, MKV, WebM) a blocchi, senza caricarlo in RAM | Mediabunny 1.65 (`BlobSource`) |
| Decodifica video, con accelerazione hardware quando il browser la offre | WebCodecs tramite `VideoSampleSink` |
| Codifica JPG/PNG su più core in parallelo | Web Worker + `OffscreenCanvas.convertToBlob` |
| ZIP in streaming (ZIP64 oltre 4 GB / 65.535 file), file già compressi salvati senza ricompressione | scrittore ZIP interno (`src/shared/zip.ts`), testato con Python `zipfile` e `unzip` |
| Scrittura progressiva su disco | Origin Private File System (`FileSystemSyncAccessHandle`) o cartella scelta (File System Access API) |
| Audio → 16 kHz mono con filtro anti-aliasing, a blocchi (max 10 min in memoria) | `src/shared/resample.ts` |
| Riconoscimento vocale | Transformers.js 4.3.2 + Whisper multilingue (`onnx-community/whisper-large-v3-turbo` o `whisper-small`), WebGPU, ripiego WebAssembly |
| Compressione | Mediabunny `Conversion` → H.264 MP4, `hardwareAcceleration: 'prefer-hardware'` |

### Trascrizione lunga, senza buchi né doppioni

Whisper lavora su finestre da 30 s. L'app usa l'algoritmo "a seek" di Whisper: se l'ultima frase di una
finestra è tagliata, la finestra successiva riparte dall'inizio di quella frase (sovrapposizione), quindi
nessuna frase viene spezzata o ripetuta. Ogni secondo di audio finisce nel testo, in una zona di silenzio
riconosciuta (nessun tratto di almeno 200 ms sopra -50 dBFS), oppure, se il modello fallisce 4 volte, in un
segnaposto esplicito `[PARTE NON TRASCRITTA …]`: in quel caso il file si chiama `TRASCRIZIONE_INCOMPLETA.txt`.

Controlli di qualità come nell'implementazione originale di Whisper: rapporto di compressione del testo
(> 2,4 = ripetizioni anomale → nuovo tentativo con `no_repeat_ngram_size`), frasi tipiche che il modello
inventa sul silenzio scartate solo se l'audio in quel punto è davvero silenzioso.

Il campo "Corso e termini tecnici" diventa il prompt iniziale di Whisper (`<|startofprev|>`), una funzione
nativa del modello. Il rilevamento automatico della lingua usa il token di lingua predetto da Whisper.

### Estrazione intelligente

Miniature 320×180 in scala di grigi divise in blocchi 10×10. Un frame viene salvato quando cambia una quota
di blocchi superiore alla soglia (sensibilità regolabile) e il contenuto si è stabilizzato; il cursore tocca
pochi blocchi e non basta. Le zone che cambiano di continuo (webcam del docente in Webex, video incorporati)
vengono riconosciute ed escluse. Prima di un cambio viene salvato anche lo stato finale (es. lavagna piena
prima di essere cancellata).

## Sviluppo

```bash
npm install
npm run dev            # http://localhost:5173
npm run build          # dist/
npm run build:single   # dist-single/VideoFrameStudio.html
```

Test (richiedono Python 3 con Pillow, ffmpeg, Chrome e Playwright):

```bash
npx esbuild tests/unit.test.ts --bundle --platform=node --format=esm --outfile=unit.mjs && node unit.mjs
python3 tests/make_test_videos.py ./video-prova 20
npm run build:test && (cd dist-test && python3 -m http.server 8123) &
node tests/browser.test.mjs "http://127.0.0.1:8123/?test-asr" video-prova/breve.mp4 out all
python3 tests/verify.py video-prova/breve.mp4 out all 5
```

La build di test contiene un motore di riconoscimento simulato (toni → "frase N") che permette di verificare
in automatico completezza, ordine e timestamp della trascrizione; la build pubblicata lo esclude (il build
fallisce se ci finisse dentro).

## Limiti noti

- La velocità di Whisper dipende dalla GPU: senza WebGPU (o con WebGPU solo emulato) la trascrizione gira
  su CPU ed è molto più lenta.
- La dimensione finale della compressione dipende dal codificatore hardware: se supera l'obiettivo l'app lo
  dichiara e, se attivato, ripete una volta con bitrate corretto.
- Con il file unico aperto da disco alcune versioni del browser potrebbero non conservare la cache del
  modello tra una sessione e l'altra; con la versione pubblicata su `https://` la cache è stabile.
