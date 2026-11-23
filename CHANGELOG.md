# Changelog

## 1.2.0

**Transcription that does not silently lose speech, and a queue of videos.**

- **Whisper's original decoding rules**, added as custom logits processors because Transformers.js 4.3.2 does not enforce them:
  - the first timestamp of every window falls within 1 s;
  - timestamps never go backwards.
- **Temperature fallback, 0 → 0.2 → 0.4.** A window is redone when its text repeats itself, echoes the prompt, or has low average log-probability. Windows that stay uncertain are flagged *bassa confidenza* and counted in the summary.
- **Second pass.** Spans with clear speech but no text are transcribed again and merged back in place.
- **Long leading silences** are skipped, so each window starts on speech.
- **16-bit decoder** on GPUs that support it. The previous version used 4-bit.
- **Encoder reuse.** When a window is retried, the encoder output is reused: the text is identical and the retry is faster.
- **Timing in the log.** It shows the first pass, retries, the second pass, waiting for audio, encoder time versus time per token, and real-time speed every 10 minutes.
- **Queue of videos.**
  - Drop many recordings at once. They are processed one at a time, each in its own sub-folder.
  - Downloads are prefixed with the video name.
  - The model stays loaded between videos, and a Wake Lock keeps the PC awake.
- **Fixed:** a duplicate at the boundary between windows was compared with the wrong previous segment.

## 1.1.0

**The app never stops without saying why.**

- If the start button cannot be used, the reason is shown under it: no video, no folder chosen, nothing enabled.
- A banner appears when the page runs inside a preview frame, where the browser blocks video processing, or in a browser without WebCodecs.
- Unexpected errors are shown on the page, not only in the console.
- Clear messages when the folder picker is cancelled or write permission is denied.

## 1.0.0

First release.

- **Frames.** Three modes: smart (one image per slide, formula or whiteboard state, ignoring cursor and webcam), every N seconds, or every frame. Results go into a streaming ZIP64 archive with a CSV index of timestamps.
- **Transcription** with Whisper `large-v3-turbo` or `small`, on WebGPU with WebAssembly fallback.
  - Seek-based 30-second windows.
  - The course vocabulary is passed to Whisper as its prompt.
  - Paragraphs or per-segment timestamps, plus SRT subtitles.
  - Gaps are always declared in the text.
- **Compression** to a target size with H.264, keeping FPS, resolution and audio. One corrective pass if the encoder overshoots.
- **Large files.** Chunked reading, bounded audio buffer, results written progressively to browser storage or to a chosen folder.
- **Two builds.** A static site, and a single HTML file that works when opened from disk.
- **Tests.** Unit tests, plus end-to-end tests in headless Chrome on generated videos whose frames carry their own number.
