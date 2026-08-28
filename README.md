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

**Formats.** MP3, M4A/AAC, FLAC, OGG/Opus, WAV, WebM — whatever the browser can
decode. Tags are read for all of them (see below).

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
| `/` or `⌘K` | search |

Right-click any track, album or artist for play-next, add-to-queue, add-to-playlist
and go-to-album. Drag rows in the queue to reorder. Drag the sidebar edge to resize it.

---

## How it works

```
index.html          shell + inline SVG icon sprite
css/
  base.css          design tokens, reset, typography
  layout.css        app frame: sidebar, main, right pane, player bar
  components.css    buttons, artwork, rows, cards, sliders, overlays
  views.css         page headers, heroes, shelves, settings, queue
js/
  app.js            routing, navigation, search, shortcuts, theming, ingestion
  library.js        the collection: scanning, indexes, artwork, playlists
  player.js         playback, queue, Web Audio graph
  tags.js           ID3v2/ID3v1, MP4 atoms, FLAC, Ogg, RIFF metadata reader
  metadata.worker.js  the import pipeline, off the main thread
  db.js             IndexedDB persistence
  virtual.js        windowed list and grid rendering
  motion.js         ~3 KB animation core: springs, one shared ticker, WAAPI
  views.js          every route
  playerbar.js      transport bar
  queue.js          now playing + queue panel
  ui.js             shared widgets: menus, dialogs, toasts, track rows
  util.js           DOM and data helpers
```

**Metadata is read by hand.** `tags.js` parses ID3v2.2/2.3/2.4 (including
unsynchronisation, all four text encodings and embedded APIC art), ID3v1, MP4
iTunes atoms, FLAC `STREAMINFO`/`VORBIS_COMMENT`/`PICTURE`, Ogg Vorbis and Opus
comment headers, and RIFF `INFO` chunks. Track length comes from the container
where that is cheap — FLAC sample counts, MP4 `mvhd`, MP3 Xing/VBRI headers,
RIFF byte rates — and is corrected from the decoder on first play. Untagged
files fall back to reading the shape of the path (`Artist/Album/03 Title.mp3`).

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

**Animation is one rAF loop.** Springs, the playhead and the visualiser share a
single ticker; everything else is handed to the compositor through the Web
Animations API. Only `transform`, `opacity` and `filter` are animated, so no
animation can trigger layout. `prefers-reduced-motion` turns the lot off.

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

## Testing

The tools generate a synthetic library with real containers and real tags — the
FLAC and MP3 files decode as actual silence, so playback is exercised end to end.

```bash
npm i playwright                                   # only needed for the browser tests
python3 tools/make-testlib.py /tmp/testlib         # 42 tracks, 5 formats, embedded art
python3 tools/make-testlib.py /tmp/biglib --bulk 3000
python3 -m http.server 8123 &                      # the tests expect this port

node tools/smoke.mjs        /tmp/testlib ./shots   # boot, import, metadata, playback, persistence
node tools/interactions.mjs /tmp/testlib           # keyboard, dragging, sorting, queue editing
node tools/perf.mjs         /tmp/biglib            # the table above
```

## Notes

- Everything stays on the device. There are no network requests after the page
  loads — no fonts, no CDNs, no analytics.
- The library index, cover thumbnails and playlists live in IndexedDB. **Settings
  → Clear library** removes them; your audio files are never touched, and the app
  never writes to your music folder.
- Light, dark and system themes; the theme is applied before first paint so there
  is no flash.
- Works down to ~520px wide: the sidebar collapses to an icon rail and the queue
  panel becomes an overlay.
