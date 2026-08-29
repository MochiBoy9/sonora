# Sonora

A music player for the files already on your computer — the shape of Spotify or
SoundCloud, but the library is a folder on your disk. Nothing is uploaded,
nothing is streamed, and there is no account. The browser reads the files
directly and the index lives in local storage on the device.

No build step, no dependencies, no framework. Open it and it runs.

---

## Running it

Module scripts and web workers need a real origin, so `file://` will not work.
Any static server does:

```bash
cd sonora
python3 -m http.server 8000      # or: npx serve .
```

Then open <http://localhost:8000> and click **Add music**.

## Adding your music

Three routes in, depending on what the browser supports:

| Route | Where it works | Persists across sessions |
| --- | --- | --- |
| **Add music** → directory picker | Chrome, Edge, Opera, Arc | Yes — the folder reconnects itself on launch |
| **Add music** → folder upload dialog | Firefox, Safari, everything else | Library and artwork persist; the folder must be re-picked once per session |
| **Drag and drop** a folder or files onto the window | Everywhere | As above, depending on the API available |

On browsers without the File System Access API the library still survives a
reload — every title, album, cover and playlist comes back instantly — but the
files themselves are out of reach until you point at the folder again. The app
says so with a banner rather than showing tracks that silently refuse to play.

**Formats.** Any audio file. MP3, M4A/AAC/ALAC, FLAC, Ogg Vorbis, Opus, WAV,
AIFF, WebM, Matroska, CAF, AU, WMA, APE, WavPack, Musepack, DSD — if it is an
audio container, Sonora indexes it, reads what tags it has and shows it in the
library. Suffixes are only most of the story: a file the operating system calls
`audio/*` is taken on that alone, and once a file is in, the parser identifies it
by its magic number rather than its name — a container renamed to something
meaningless still reads its own tags.

Decoding is still the browser's job, and no browser decodes everything. A file
this browser cannot play is *not* hidden — it keeps its title, artist and cover,
and its row is marked **no decoder** so the reason is on screen rather than in a
console. Playback skips it and says which format it was.

## Using it

| | |
| --- | --- |
| `Space` | play / pause |
| `←` `→` | seek 5s (hold `Shift` for 30s) |
| `↑` `↓` | volume |
| `N` / `P` | next / previous |
| `S` / `R` | shuffle / repeat |
| `M` | mute |
| `Q` | queue panel |
| `V` | immersive visualiser |
| `/` or `⌘K` | search |

Right-click any track, album or artist for play-next, add-to-queue, add-to-playlist
and go-to-album. Drag rows in the queue to reorder. Drag the sidebar edge to resize it.

---

## How it works

```
index.html          shell, intro markup, inline SVG icon sprite
css/
  base.css          design tokens, reset, typography
  intro.css         the welcome sequence
  layout.css        app frame: sidebar, main, right pane, player bar
  components.css    buttons, artwork, rows, cards, sliders, overlays
  views.css         page headers, heroes, shelves, settings, queue
  visualizer.css    spectrum canvases and the immersive stage
js/
  app.js            routing, navigation, search, shortcuts, theming, ingestion
  library.js        the collection: scanning, indexes, artwork, playlists
  player.js         playback, queue, Web Audio graph, spectrum analysis
  tags.js           ID3v2/ID3v1, MP4, FLAC, Ogg, RIFF, AIFF, Matroska reader
  metadata.worker.js  the import pipeline, off the main thread
  db.js             IndexedDB persistence
  virtual.js        windowed list and grid rendering
  motion.js         ~3 KB animation core: springs, one shared ticker, WAAPI
  intro.js          the opening sequence
  backdrop.js       the WebGL depth field behind the interface
  visualizer.js     four spectrum renderers over one analyser reading
  stage.js          the full-screen immersive view
  views.js          every route
  playerbar.js      transport bar
  queue.js          now playing + queue panel
  ui.js             shared widgets: menus, dialogs, toasts, track rows
  util.js           DOM and data helpers
```

**Metadata is read by hand.** `tags.js` parses ID3v2.2/2.3/2.4 (including
unsynchronisation, all four text encodings and embedded APIC art), ID3v1, MP4
iTunes atoms, FLAC `STREAMINFO`/`VORBIS_COMMENT`/`PICTURE`, Ogg Vorbis and Opus
comment headers, RIFF `INFO` chunks, AIFF `COMM`/`NAME`/`AUTH` plus the ID3
chunk that usually rides along with them, and Matroska/WebM EBML — walking the
tree far enough to reach `Info`, `Tags` and the cover attachment while stepping
over the clusters, which are the entire weight of the file. Track length comes
from the container where that is cheap — FLAC sample counts, MP4 `mvhd`, MP3
Xing/VBRI headers, RIFF byte rates, AIFF frame counts, Matroska duration — and
is corrected from the decoder on first play. A file whose suffix means nothing
is identified by its first sixteen bytes. Untagged files fall back to reading
the shape of the path (`Artist/Album/03 Title.mp3`).

Only the bytes that are needed get read: the first 128 KB of each file is
buffered once, and the chains of small reads that tag structures require become
array indexing. Larger structures fall back to `Blob.slice`.

**Import runs in a worker.** Tags are parsed, the embedded cover is decoded once
per album, re-encoded to a ~448px WebP and reduced to an accent colour — all off
the main thread, so scrolling stays smooth while thousands of files are still
being read.

**Lists are virtualised.** Only the rows intersecting the viewport exist in the
DOM; nodes are recycled through a pool and positioned with transforms. A 50,000
track list costs the same as a 30 row one.

**The library paints before it scans.** On launch the whole collection comes out
of IndexedDB and renders; reconnecting to disk happens afterwards, in the
background, and only re-parses files whose size or modification time changed.

**Animation is one rAF loop.** Springs, the playhead, the visualisers and the
backdrop share a single ticker; everything else is handed to the compositor
through the Web Animations API. Only `transform`, `opacity` and `filter` are
animated, so no animation can trigger layout. A paused player unregisters its
frame callback entirely, so an idle Sonora asks for no frames at all.
`prefers-reduced-motion` turns the lot off — the visualiser and the backdrop
draw one still frame and then stop.

**There is always an introduction.** The opening sequence ships as markup in
`index.html`, not as something a module builds, so it is on screen at first
paint rather than after the JavaScript arrives. It plays while the library is
being read out of IndexedDB — the time it takes is time that was being spent
anyway — and the first key, click or scroll skips it. A repeat visit gets the
same sequence at roughly half the length. If the scripts never load at all, a
CSS animation removes it after eight seconds rather than leaving a locked door.

**The spectrum is banded once per frame.** `player.analysis()` reads the
`AnalyserNode` at 2048 points and folds it into 64 logarithmic bands between 32
Hz and 16 kHz — logarithmic because that is how hearing is arranged, and a
linear spectrum puts nine tenths of its width above the note range. Bands are
tilted to undo the natural roll-off of recorded music, smoothed with a fast
attack and a slow release, and capped by peaks that fall under their own weight.
Bass energy against its own running average gives a beat, with a refractory
period so one kick does not register three times. Every visualiser on screen
reads that same object, so the FFT is banded once no matter how many canvases
are drawing.

**Four renderers, three places.** `visualizer.js` draws bars, an oscilloscope,
a rotating radial ring or stacked ribbons; the same renderer runs inside the
now-playing artwork, as a hairline along the top of the transport bar, and
full-bleed on the immersive stage (`V`). The stage puts the artwork on a real
perspective tilt that follows the pointer and leans into the beat, and hides its
own chrome when the pointer goes still.

**The background is a 3D scene.** `backdrop.js` is one WebGL canvas behind the
whole app: an aurora of three slow metaballs in the current accent colour, and a
few thousand points scattered through a volume, rotated and projected with a
real perspective divide, looping toward the camera. Bass widens the field, level
brightens it, a beat pushes a pulse through it. Two draw calls, static geometry,
and it renders below native resolution because it is soft by construction. On a
light page the same shapes are painted as a darker tint, because light added to
white is invisible. It watches its own frame budget: a device that cannot hold
the pace gets it at half rate, and then not at all. No WebGL, or a lost context,
and the CSS gradients that were always underneath are simply what you see.

**Every chrome surface is glass.** The sidebar, top bar, queue panel, player
bar, heroes, menus and dialogs are translucent and blurred, so the scene behind
them is present without ever competing with a track title. Surfaces are declared
as channel triplets and composed into opaque and translucent forms, which is
what makes one set of tokens serve both.

**The interface takes its colour from the artwork.** The accent is extracted in
the worker by quantising a 24×24 sample and picking the most vivid mid-tone that
covers enough of the cover, then eased into a CSS custom property that every
accented surface reads from.

---

## Measured

Chromium, 3,000 tracks across 300 albums, 1460×900:

| | |
| --- | --- |
| Import (parse + index + thumbnail + persist) | 6.4–7.3 s — ~410–470 files/second |
| Cold start from IndexedDB to a painted library | 250 ms |
| First paint: Songs / Albums / Artists | 41 / 20 / 28 ms |
| Scroll frame time, 60-frame flick | median **16.7 ms**, p95 16.8 ms |
| Live DOM nodes while scrolling | 27 (songs), 30 (albums) |
| Search latency per keystroke | 0.2–6 ms |
| JS heap | 10 MB |

Reproduce with `tools/perf.mjs` (below).

The backdrop and the visualisers do not change that. Re-measured after they were
added, on a slower machine than the table above: scroll frame time is still a
median of 16.7 ms with 27 live nodes, import holds at ~475 files/second, and the
JS heap is 6–7 MB. The spectrum is banded once per frame and shared; the
backdrop is two draw calls over static geometry at a capped pixel ratio, and
backs itself off when frames start slipping.

## Testing

The tools generate a synthetic library with real containers and real tags — the
FLAC and MP3 files decode as actual silence, so playback is exercised end to end.

```bash
npm i playwright                                   # only needed for the browser tests
python3 tools/make-testlib.py /tmp/testlib         # 45 tracks, 6 formats, embedded art
python3 tools/make-testlib.py /tmp/biglib --bulk 3000
python3 -m http.server 8123 &                      # the tests expect this port

node tools/smoke.mjs        /tmp/testlib ./shots   # boot, intro, import, metadata, playback,
                                                   # visualiser, stage, persistence
node tools/interactions.mjs /tmp/testlib           # keyboard, dragging, sorting, queue editing
node tools/perf.mjs         /tmp/biglib            # the table above
```

Set `SONORA_CHROMIUM=/path/to/chrome` to run against a Chromium that is already
on the machine instead of the one Playwright downloads for itself.

## Notes

- Everything stays on the device. There are no network requests after the page
  loads — no fonts, no CDNs, no analytics.
- The library index, cover thumbnails and playlists live in IndexedDB. **Settings
  → Clear library** removes them; your audio files are never touched, and the app
  never writes to your music folder.
- Light, dark and system themes; the theme is applied before first paint so there
  is no flash.
- The visualiser style, the backdrop and the artwork tint are all switchable in
  **Settings → Appearance** and **Visualiser**; the choice follows every canvas
  in the app at once.
- Works down to ~520px wide: the sidebar collapses to an icon rail and the queue
  panel becomes an overlay.
