# VideoFrame & Transcript Studio: note per lo sviluppo

Web app che gira tutta nel browser. Per ogni video produce tre risultati:
- i frame, in un archivio ZIP;
- la trascrizione, fatta con Whisper;
- facoltativamente, una versione compressa del video.

Il video non viene mai caricato su un server. L'interfaccia e i commenti nel codice sono in italiano: mantenerli così.

## Comandi

```bash
npm install
npm run typecheck
npm test               # test unitari: devono passare tutti
npm run build          # dist/ (sito, pubblicato su GitHub Pages dalla CI)
npm run build:single   # dist-single/VideoFrameStudio.html (file unico, worker incorporati)
npm run dev            # http://localhost:5173
```

## Regola non negoziabile: la correttezza della trascrizione

La trascrizione non si sacrifica mai per la velocità. Le modifiche si dividono in due tipi.

- **Modifiche che non cambiano il testo**: misure dei tempi, riuso dell'encoder, impostazioni. Il risultato deve essere identico.
- **Modifiche che possono cambiarlo**: rilevatore di voce, precisione numerica, finestre in batch, nuove soglie. Entrano solo dopo un confronto **parola per parola** con una trascrizione di riferimento sullo stesso spezzone. Se manca anche una frase o il testo peggiora, non entrano.

Le parti non trascritte non si nascondono mai. Finiscono nel testo come `[PARTE NON TRASCRITTA …]` e il file prende il nome `TRASCRIZIONE_INCOMPLETA.txt`.

## Dove sono le cose

- `src/shared/transcribeCore.ts`: logica indipendente dal modello e testata con il motore finto. Contiene:
  - le finestre da 30 s con avanzamento "a seek";
  - i nuovi tentativi a temperatura 0 / 0,2 / 0,4;
  - la seconda passata sui tratti di voce senza testo;
  - il conteggio dei buchi.
- `src/shared/whisperRules.ts`: due regole del Whisper originale che Transformers.js non applica (primo timestamp entro 1 s, tempi crescenti). Contiene anche la confidenza per finestra (`LogprobTracker`).
- `src/workers/transcribe.worker.ts`: decodifica audio e motore Whisper. Il worker resta vivo tra i video della coda e il modello caricato viene riusato.
- `src/main.tsx`: interfaccia e coda di più video. Se il pulsante AVVIA non si può usare, sotto deve sempre comparire il motivo.

## Attenzione

- Transformers.js è fissata alla **4.3.2** e viene caricata dal CDN (`TRANSFORMERS_URL`). Il worker usa tre parti interne della libreria:
  - `_prepare_encoder_decoder_kwargs_for_generation`, per riusare l'encoder;
  - `forward_params`;
  - il formato di `logits_processor`, per le regole e la confidenza.

  Ognuna ha un controllo che la spegne da sola se non funziona, con un avviso nel registro. Se si aggiorna la libreria, riverificarle tutte e tre.
- Il motore finto (`src/test/fakeEngine.ts`) deve restare solo nella build di test. `build.mjs` fallisce se finisce nella build pubblicata.
- Nel file unico aperto da disco (origine `null`) i worker sono classici, creati da URL blob: Chrome non accetta worker-modulo in quel caso.

## Rilasci

Per pubblicare una versione basta cambiare `version` in `package.json` (e aggiornare `CHANGELOG.md` e `docs/release-notes.md`) con un commit su `main`. Il workflow `release.yml` fa il resto:
- esegue i controlli dei tipi e i test;
- costruisce il file unico e il sito;
- calcola i checksum;
- crea la release `v<versione>` con il suo tag.
