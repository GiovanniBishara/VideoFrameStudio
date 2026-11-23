# Security

VideoFrame & Transcript Studio processes recordings that may be private: lectures, meetings, interviews. This page explains:
- what data leaves the computer and what never does;
- how files from someone else are handled;
- how to report a problem.

## What leaves the computer

**Never:**
- the videos, the frames, the transcripts, the compressed video;
- the course vocabulary typed into the prompt field.

All processing happens in the browser tab. There is no backend, no analytics and no telemetry.

**The page does make three kinds of request:**

| Request | Why | When |
| --- | --- | --- |
| Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) | Interface fonts | Every time the page opens. If they are blocked, the app uses system fonts. |
| jsDelivr (`cdn.jsdelivr.net`) | The Transformers.js library, pinned to version 4.3.2 | First transcription; afterwards it comes from the browser cache. |
| Hugging Face (`huggingface.co`) | The Whisper model files (ONNX) | First transcription; afterwards the browser cache. |

Frame extraction and compression work fully offline. The single-file build (`VideoFrameStudio.html`) can be used without any network for them.

## Files from someone else

A video can come from anywhere, so the app treats it as untrusted input:

- **Parsing.** Containers are parsed by Mediabunny, which is plain JavaScript inside a Web Worker. Decoding is done by the browser's WebCodecs, inside the browser sandbox. The app never runs external programs.
- **Memory.** Videos are read in chunks, never loaded whole. Decoded audio waiting for the model is capped at 10 minutes, about 38 MB. A huge or malformed file can make processing fail, but it cannot fill the memory with audio.
- **Output names.** Sub-folder names come from video file names and are sanitized (characters invalid on Windows, macOS or Linux are replaced, length is limited). Output files never overwrite an existing file: `TRASCRIZIONE (2).txt` is used instead.
- **Storage.** The app writes only:
  - inside the folder the user explicitly picked, after the browser grants write permission;
  - inside the page's own private browser storage.

## Downloads

- Each release is built by GitHub Actions from the tagged source, never on a personal machine. The build log is public.
- Every release includes `SHA256SUMS.txt`. To check a download:
  - Windows (PowerShell): `Get-FileHash VideoFrameStudio.html`
  - macOS / Linux: `shasum -a 256 VideoFrameStudio.html`

  Then compare the result with the line in `SHA256SUMS.txt`.
- Workflows run with a read-only token. Only two jobs can write: the one that publishes GitHub Pages, and the one that creates the release. Third-party Actions are pinned to exact commits.
- CI runs `npm audit` on every change, and Dependabot proposes updates every week.

## Known limits

- Transformers.js is loaded from a CDN by URL. A dynamic import cannot carry a Subresource Integrity hash. The version is pinned in the URL, but integrity depends on jsDelivr serving the published package.
- The Whisper model files are downloaded from Hugging Face over HTTPS, without a separate checksum.

## Reporting a vulnerability

Please don't open a public issue. Use **Security → Report a vulnerability** on this repository, which is private to the maintainer. Include the steps or the file that reproduce the problem. You'll get an answer within a week.

Only the latest release is supported.
