<p align="center">
  <img src="assets/icon.svg" width="84" alt="VideoFrame & Transcript Studio: a slide with a red recording dot above two lines of transcript">
</p>

<h1 align="center">VideoFrame &amp; Transcript Studio</h1>

<p align="center">
  <b>Slides and a full transcript from hours of recorded lectures, entirely in your browser.</b><br>
  Drop a whole course of recordings. You get every slide as an image and every word as text.<br>
  Nothing is uploaded, nothing to install, no account.
</p>

<p align="center">
  <a href="https://giovannibishara.github.io/VideoFrameStudio/"><b>▶ Open the app</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/GiovanniBishara/VideoFrameStudio/releases/latest"><b>⬇ Download the single file</b></a>
  &nbsp;·&nbsp;
  <a href="#how-the-transcription-works">How the transcription works</a>
  &nbsp;·&nbsp;
  <a href="LEGGIMI.md">Guida in italiano</a>
</p>

<p align="center">
  <a href="https://github.com/GiovanniBishara/VideoFrameStudio/actions/workflows/ci.yml"><img src="https://github.com/GiovanniBishara/VideoFrameStudio/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/TypeScript-6-17202a" alt="TypeScript 6">
  <img src="https://img.shields.io/badge/React-19-17202a" alt="React 19">
  <img src="https://img.shields.io/badge/runs%20on-WebGPU%20%C2%B7%20WebCodecs-c2410c" alt="Runs on WebGPU and WebCodecs">
  <img src="https://img.shields.io/badge/license-MIT-17202a" alt="MIT">
</p>

<p align="center">
  <img src="docs/demo.gif" width="760" alt="Three lecture recordings are dropped into the app and appear in a queue. The queue is started, each lecture goes from 'In coda' to 'In elaborazione' to 'Completato', and the results show a FRAMES.zip ready to download">
</p>

University lectures are often recorded and shared as hour-long videos. To study from them you need two things: the slides, including the formulas written on the board, and the words. This app extracts both from many recordings in one go. Everything runs on your own computer, on its GPU, and the videos are never uploaded.

*The interface is in Italian: it was built for Italian university students.*

## What you get

For every video, three files:

| File | Contents |
| --- | --- |
| **`FRAMES.zip`** | The frames, in order, with `frames_index.csv` (exact timestamp of each one). **Smart** mode saves one image per slide, formula or whiteboard state and ignores the moving cursor and the presenter's webcam. There are also modes for one frame every N seconds and for every single frame. |
| **`TRASCRIZIONE.txt`** | The full transcript from OpenAI Whisper (`large-v3-turbo` or `small`), split into paragraphs with timestamps. Optionally also **`SOTTOTITOLI.srt`**. |
| **`VIDEO_COMPRESSO.mp4`** | *Optional.* H.264 compressed to a size you choose. FPS and resolution are unchanged and the audio is copied bit for bit. |

You can drop **many videos at once**. They are processed one at a time, each in its own sub-folder. The Whisper model is loaded once for the whole queue, and while the tab is visible a Wake Lock keeps the PC awake.

## Try it

1. Open **https://giovannibishara.github.io/VideoFrameStudio/** in Chrome or Edge on a desktop.
2. Drop one or more videos (MP4, MOV, MKV, WebM, even several GB each).
3. Pick the functions you need, then press **AVVIA ELABORAZIONE**. Results are saved in the browser or straight into a folder you choose.

The first transcription downloads the Whisper model once (about 1.4 GB for *Alta precisione*, about 300 MB for *Veloce*). After that it stays in the browser cache.

**Offline single file.** Each [release](https://github.com/GiovanniBishara/VideoFrameStudio/releases/latest) contains `VideoFrameStudio.html`: open it with a double click, no server needed. When opened from disk, the app asks for a folder and writes the results there as they are produced. `SHA256SUMS.txt` lets you verify the download.

A computer with a GPU is recommended. Integrated graphics work fine, a dedicated GPU is many times faster. Without WebGPU, the transcription runs on the CPU and is much slower.

## How the transcription works

Whisper reads audio in 30-second windows. A long lecture means hundreds of windows, and every window is a chance to silently lose a sentence. The app is designed around one rule: **missing speech must be either recovered or declared, never hidden.**

- **Seek-based windowing, as in OpenAI's reference implementation.** When a sentence is cut at the end of a window, the next window starts again from that sentence. Nothing is split in half or written twice.
- **Two decoding rules from the original Whisper, which Transformers.js does not enforce.** The app adds them as custom logits processors:
  - the first timestamp of a window must fall within 1 s, so the model cannot skip the start of the window;
  - timestamps never go backwards.
- **Temperature fallback: 0, then 0.2, then 0.4.** A window is redone when its text repeats itself (gzip compression ratio > 2.4), echoes the prompt, or has a low average log-probability (< −1, computed at temperature 1).
- **Second pass.** Spans with clear speech energy but no text are transcribed again on their own and put back in place, with their real timestamps.
- **Nothing is hidden.**
  - Audio that still fails is written into the text as `[PARTE NON TRASCRITTA hh:mm:ss–hh:mm:ss]`, and the file becomes `TRASCRIZIONE_INCOMPLETA.txt`.
  - Windows that stay uncertain are flagged in the live preview and counted in the summary, so you know what to listen to again.
- **Course vocabulary.** A *Corso e termini tecnici* field is passed to Whisper as its native initial prompt (`<|startofprev|>`), so names like Nusselt or Prandtl are spelled right. If a window's text just copies the prompt, the window is redone without it.

Speed matters on a laptop, but never at the cost of accuracy:
- **Encoder reuse.** When a window is retried, the encoder output (the heaviest part) is computed once and reused. The text stays the same.
- **Measured, not guessed.** The log reports:
  - where the time went: first pass, retries, second pass, waiting for audio;
  - encoder time versus milliseconds per generated token;
  - real-time speed every 10 minutes of audio, which shows thermal throttling.
- **The project rule.** Any optimization that could change the text is accepted only after a word-by-word comparison with a reference transcript ([CLAUDE.md](CLAUDE.md)).

## Built for very large files

- **Reading.** The video is read in chunks through [Mediabunny](https://mediabunny.dev)'s `BlobSource` and is never loaded whole into RAM. Decoding uses WebCodecs, with hardware acceleration when the browser offers it.
- **Audio.** It is resampled to 16 kHz mono by a streaming anti-aliased resampler. At most 10 minutes of decoded audio (about 38 MB) are kept ahead of the model.
- **Frames.** JPEG and PNG encoding is spread over several Web Workers with `OffscreenCanvas`. Video decoding (WebCodecs) and Whisper (WebGPU) run in parallel, because they use different parts of the GPU.
- **ZIP.** Archives are written as a stream by a custom ZIP64 writer: more than 4 GB and more than 65,535 files are fine. Already-compressed images are stored without being compressed again.
- **Saving.** Results go to disk progressively, either through the Origin Private File System or into a folder the user picks (File System Access API). An existing file is never overwritten.

## Under the hood

```
src/
├── main.tsx                  React UI: queue, options, live progress, downloads
├── app/system.ts             capability checks (WebCodecs, WebGPU, storage), probing, downloads, wake lock
├── workerUrls.ts             workers as module files (site) or inlined blobs (single-file build)
├── workers/
│   ├── frames.worker.ts      decode → choose frames → encode in parallel → streaming ZIP
│   ├── encoder.worker.ts     JPEG/PNG with OffscreenCanvas
│   ├── transcribe.worker.ts  audio decode → 16 kHz mono → Whisper (Transformers.js, WebGPU or WASM)
│   └── compress.worker.ts    H.264 re-encode to a target size, with one corrective pass
└── shared/
    ├── transcribeCore.ts     windowing, retries, second pass, gap accounting (no model inside)
    ├── whisperRules.ts       timestamp rules and log-probability tracking
    ├── smart.ts              slide and whiteboard change detection
    ├── zip.ts                streaming ZIP/ZIP64 writer, CRC-32
    ├── resample.ts           streaming resampler
    ├── transcriptText.ts     paragraphs, timestamps, SRT
    └── outfile.ts            browser storage, folder or in-memory output
```

A few decisions worth mentioning:

- **The transcription logic contains no model.** `transcribeCore.ts` only sees an `AsrEngine` interface. Windowing, retries and the second pass are unit tested with a simulated recognizer, and the real Whisper engine plugs into the same interface.
- **Smart frames.** Each frame becomes a 320×180 grayscale thumbnail split into 10×10 blocks.
  - A frame is saved when enough blocks change and the picture has settled. A cursor touches too few blocks to count.
  - Regions that never stop changing, such as a webcam or an embedded video, are learned and excluded.
  - Before every change, the last state is saved too: a full whiteboard is captured just before it is erased.
- **One codebase, two builds.** esbuild produces:
  - a static site with module workers;
  - a single HTML file with the workers inlined as classic blob workers, the only kind Chrome accepts from a page opened from disk.
- **The app never fails silently.** If the start button cannot be used, the reason appears under it. A banner warns when the page is inside a preview frame or the browser lacks WebCodecs, and unexpected errors are shown on the page.

## Tests

```bash
npm install
npm test
```

The unit tests check:
- **ZIP and ZIP64 output**, read back with Python's `zipfile` and with `unzip`;
- **the resampler**;
- **slide and whiteboard detection**;
- **transcript formatting**;
- **the transcription pipeline.**

The pipeline is tested with a simulated recognizer that "hears" synthetic tones as numbered sentences. This makes completeness, order and timestamps checkable exactly:

| Scenario | What must happen |
| --- | --- |
| 40-minute lecture with a 2-minute pause | Every sentence appears once, in order, with timestamps within 60 ms. The pause is recognized as silence. |
| Wrong text with low confidence at temperature 0 | The window is redone at 0.2, the confident text is kept. |
| Low confidence on every attempt | The text is kept and flagged *bassa confidenza*, never dropped. |
| The model skips one sentence per window | The second pass recovers every one, with exact timestamps. |
| The model fails 4 times on a window | A gap is written into the text and the transcript is marked incomplete. |
| Whisper's timestamp rules, confidence math | Checked against hand-computed logits and a full log-softmax. |

End-to-end tests drive the real interface in headless Chrome with Playwright. They use generated videos whose frames carry their own number in binary, so every extracted image can be checked:

```bash
python3 tests/make_test_videos.py ./test-videos 20
npm run build:test && (cd dist-test && python3 -m http.server 8123) &
node tests/browser.test.mjs "http://127.0.0.1:8123/?test-asr" test-videos/breve.mp4 out all
python3 tests/verify.py test-videos/breve.mp4 out all 5
```

The simulated recognizer exists only in the test build. The build fails if it ever ends up in a published bundle.

## Development

```bash
npm install
npm run dev            # http://localhost:5173
npm run typecheck
npm test
npm run build          # dist/: static site
npm run build:single   # dist-single/VideoFrameStudio.html
```

On every push, CI runs the type check, the tests, both builds and an `npm audit`, then publishes the site to GitHub Pages. A new version number in `package.json` publishes a release, with its tag, containing the single file, the site as a ZIP, and their checksums. Dependabot proposes dependency and Action updates every week, and Actions are pinned to exact commits.

## Privacy

Videos and results never leave the computer. The page makes three kinds of request:
- the fonts, from Google Fonts;
- the Transformers.js library, pinned to 4.3.2, from the jsDelivr CDN;
- the Whisper model files, from Hugging Face, once (then they are cached).

There is no analytics, no telemetry and no backend. See [SECURITY.md](SECURITY.md).

## Roadmap

- [ ] Speaker-aware paragraphs (lecturer vs. questions from the room)
- [ ] A voice activity detector to skip long pauses, admitted only if the word-by-word comparison shows no loss
- [ ] OCR of the extracted slides, merged with the transcript into one study document
- [ ] Self-hosted fonts, so that only the model download needs the network

## License

[MIT](LICENSE) © Giovanni Bishara. [Mediabunny](https://github.com/Vanilagy/mediabunny) is MPL-2.0, and its notice is kept in the built files. The Whisper models are released by OpenAI under the MIT license.
