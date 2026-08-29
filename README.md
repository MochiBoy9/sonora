# Sonora

A music player for the files already on your computer — the shape of Spotify or
SoundCloud, but the library is a folder on your disk. Nothing is uploaded,
nothing is streamed, and there is no account. The browser reads the files
directly and the index lives in local storage on the device.

No build step, no dependencies, no framework. Open it and it runs.

It also reopens where you left it, folds an album back together when it is
split across folders, draws what you have actually been listening to, and — only
if you ask it to — will look an artist up online. Those four are described
below and specified in full in [`docs/SPEC.md`](docs/SPEC.md).

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
| **Add music → Add a folder…** → directory picker | Chrome, Edge, Opera, Arc | Yes — the folder reconnects itself on launch |
| **Add music → Add a folder…** → folder upload dialog | Firefox, Safari, everything else | Library and artwork persist; the folder must be re-picked once per session |
| **Add music → Add files…** | Everywhere | Pick loose files from anywhere; they land under **Selected files** |
| **Drag and drop** a folder or files onto the window | Everywhere | As above, depending on the API available |

Both routes are offered on every browser. Which *picker* opens depends on what
the browser has, but choosing "a folder" always gets you a folder — that
distinction matters, because the artist and album of an untagged rip are read
from the folder tree, and losing the path loses them.

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

### One album, however it is filed

Half a record ripped with an album-artist tag and half without lands as two
albums in most players. Sonora folds them back into one.

The trick is knowing what is a real name. An untagged file is never nameless —
the tag reader falls back to the folder tree, because `Artist/Album/03 Title.mp3`
is a near-universal convention and reading it is what makes untagged music
usable at all. So half of *Graduation* sitting in `Unsorted/Rips` arrives
claiming to be by an artist called *"Unsorted"*. The reader now records which
fields it had to guess, and a guessed artist counts as no artist when two albums
with the same title are compared. Records that both name themselves never merge,
so every *Greatest Hits* ever pressed stays where it is.

When an import merges something, the summary says so by name.

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

## Picking up where you left off

Sonora writes down what you were playing — the track, the second you were at,
and the queue around it — and puts it back on the next launch. No dialog, no
"restore session?", nothing to click. On a browser that can hold a folder
permission it reconnects the folder too, and the music is cued within about two
seconds of the library painting.

Whether it *starts* is not Sonora's decision. Browsers refuse to play audio
without a prior gesture on the page, so when that happens the readout in the
top bar says **Ready to resume** and gives you one button. Pretending to have
resumed and then sitting in silence would be worse.

When the folder itself is out of reach — a folder opened through the upload
dialog hands its files over once and cannot be reopened by script — the readout
says **Folder not connected**, the queue still comes back, and the resume arms
itself: reconnect that folder for any reason at all and the track cues at the
second you left it, without being asked twice.

Auto-connect and an explicit **Disconnect** both live in **Settings →
Connection**. A disconnect is remembered; nothing reconnects behind your back.

## The Circle Analysis Center

Play counts lie. A track skipped at four seconds counts the same as one played
to the end, so a play-count chart rewards indecision. **Analysis** in the
sidebar measures the thing that is true instead — seconds of audio that actually
reached the speakers — and draws it.

One circle per artist, genre or year. The **area** of each is proportional to
the time, which is the honest way to draw this; scaling the radius instead makes
a two-hour artist look four times a one-hour artist, and is how most charts of
this kind mislead. Hover for the exact figure and share, click to pin two side
by side, drag to arrange, double-click to play everything in one. It updates
while you listen, and a circle you have moved stays where you put it.

**Reset view** undoes an arrangement. **Reset data**, a deliberately separate
button behind a confirmation, throws away the measurements.

## Looking a band up

Off by default, and the only part of Sonora that touches the network.

Any artist page can fetch context: a biography, when they were active, a
discography with the records you already own linked back into your library, and
the line-up — from MusicBrainz and Wikipedia, both public, both keyless. Any
release can be looked at more closely on request.

Before the first request, a dialog says exactly what leaves the device:

> the artist name — to MusicBrainz, for biography, line-up and discography; the
> matching page title — to Wikipedia, for the summary paragraph. Nothing else.
> Not your library, not your listening history, not a file name.

Requests are spaced a second apart because MusicBrainz asks for that, and every
answer is cached on the device for a month — so a second look costs nothing and
works on a plane. **Settings → Online** turns it back off and clears the cache,
and shows how many answers are being kept.

---

## How it works

```
index.html          shell, intro markup, inline SVG icon sprite
css/
  base.css          design tokens, chamfers, reset, typography
  intro.css         the welcome sequence
  layout.css        app frame: sidebar, main, right pane, transport
  components.css    buttons, artwork, rows, cards, sliders, overlays
  views.css         page headers, heroes, shelves, settings, queue
  visualizer.css    spectrum canvases and the immersive stage
js/
  app.js            routing, navigation, search, shortcuts, theming, ingestion
  library.js        the collection: scanning, indexes, album merging, playlists
  player.js         playback, queue, Web Audio graph, spectrum analysis
  session.js        reconnect and resume: what you were playing, put back
  stats.js          the listening-time meter, rolled up by artist, genre, year
  circles.js        the Circle Analysis Center, packed by hand into one SVG
  band.js           the one module that talks to the internet, off by default
  tags.js           ID3v2/ID3v1, MP4, FLAC, Ogg, RIFF, AIFF, Matroska reader
  metadata.worker.js  the import pipeline, off the main thread
  db.js             IndexedDB persistence
  virtual.js        windowed list and grid rendering
  motion.js         animation core: springs, one shared ticker, WAAPI, text
  gl.js             the 3D layer: shaders, 4×4 matrices, wireframe geometry
  intro.js          the opening sequence, in three dimensions
  backdrop.js       the wireframe world behind the interface
  visualizer.js     four spectrum renderers over one analyser reading
  stage.js          the full-screen immersive view
  views.js          every route
  playerbar.js      transport bar
  queue.js          now playing + queue panel
  ui.js             shared widgets: menus, dialogs, toasts, track rows
  util.js           DOM and data helpers
docs/
  SPEC.md           the full specification: features, flows, data model, budgets
tools/
  make-testlib.py   a synthetic library with real containers and real tags
  smoke.mjs         interactions.mjs   perf.mjs
```

## The look

Sonora is drawn as an instrument rather than as a stack of cards.

**Nothing is rounded by accident.** There are no border radii in the app at
all: corners are either square or cut on a 45° with `clip-path`, from one token
(`--cut`) that every panel, button, sleeve and dialog shares. Surfaces are
separated by tinted hairlines instead of shadows, panels carry corner brackets,
and the whole window sits on a faint 44px grid — so the interface reads as
something drawn on graph paper, which is what makes the 3D world behind it
believable.

**Two accents, deliberately separate.** `--accent-rgb` is the instrument's own
electric cyan, and it never moves: it is the colour that points at things, and
an interface whose pointing colour changes every three minutes is one you
cannot learn. `--art-rgb` is the colour of the album currently playing, and it
is only ever used beside that album's artwork — the hero wash, the sleeve glow,
the far end of a spectrum gradient. One loud cover can tint its own corner of
the app; it cannot repaint the controls.

**Numbers are monospace, labels are small caps.** Times, counts, track indices,
sort headers and section titles are set in the mono stack with wide tracking,
because an instrument's readouts should line up in columns and never reflow as
the digits change.

**Light is a drafting table, not an inversion.** The light theme is ice white
with ink-blue hairlines and the same cyan doing the same job, and the 3D world
paints itself as a darker tint there, because light added to white is
invisible.

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

**There is always an introduction, and it is a 3D scene.** Five wireframe bars
stand on a grid plane and rise out of the floor in sequence while the camera
swings around and settles, with tunnel rings running past; the wordmark
assembles a letter at a time over the top. The markup ships in `index.html`,
not built by a module, so it is on screen at first paint rather than after the
JavaScript arrives, and the flat SVG mark it ships with is also the fallback for
machines without WebGL. It plays while the library is being read out of
IndexedDB — the time it takes is time that was being spent anyway — and the
first key, click or scroll skips it. A repeat visit gets the same sequence at
roughly half the length. If the scripts never load at all, a CSS animation
removes it after eight seconds rather than leaving a locked door.

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

**Four renderers, three places.** `visualizer.js` draws square bars with
falling peak caps, an oscilloscope over a ticked axis, spokes around an
instrument dial, or **mesh** — the last second of spectrum drawn as a wireframe
surface running away toward a horizon, which is a spectrogram you can read as a
landscape. The same renderer runs inside the now-playing artwork, as a hairline
along the top of the transport, and full-bleed on the immersive stage (`V`). The
stage puts the artwork on a real perspective tilt that follows the pointer and
leans into the beat, and hides its own chrome when the pointer goes still.

**The background is a wireframe world.** `backdrop.js` is one WebGL canvas
behind the whole app, drawing an actual 3D scene rather than a gradient
pretending to be one: a ground plane of lines running to the horizon, scrolling
toward the camera and rippling with the bass; square tunnel sections receding
into the distance and swelling on a beat; a wireframe icosahedron turning above
the horizon; and a fullscreen pass for the horizon glow, the vignette and the
scanlines. Perspective is a real projection matrix — `js/gl.js` carries a
column-major 4×4 stack and the geometry builders, and every matrix routine
writes into a caller-owned array, so a frame allocates nothing.

Geometry is uploaded once and animated entirely in the vertex shader, which
makes a frame four draw calls. It renders below native resolution because it is
soft by construction, and it watches its own frame budget: a device that cannot
hold the pace gets it at half rate, and then not at all. No WebGL, or a lost
context, and the CSS gradients that were always underneath are simply what you
see.

One trap worth naming, because it cost an evening: GLSL ES requires a name
declared in both shader stages to carry the same precision, and the two stages
have *different defaults*. A `float` uniform shared between a highp vertex
shader and a mediump fragment shader does not warn — the program fails to link
and the scene silently vanishes. Every shared varying here is qualified
explicitly, and no uniform is shared at all.

**Every chrome surface is glass.** The sidebar, top bar, queue panel, transport,
heroes, menus and dialogs are translucent and blurred, so the world behind them
is present without ever competing with a track title. Surfaces are declared as
channel triplets and composed into opaque and translucent forms, which is what
makes one set of tokens serve both.

**Motion is orchestrated, not decorated.** Springs retarget mid-flight, so the
nav marker and the artwork tilt follow the pointer rather than chasing it;
entrances stagger and wipe from the leading edge; headings resolve out of noise
one character at a time; counts roll up rather than appearing. All of it is
gated on the route having actually changed, because a title that re-dissolves
every time the library updates underneath reads as a fault rather than a
flourish.

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

The 3D world and the visualisers do not change what the lists cost. Re-measured
after the rework, on a slower machine than the table above (a container with a
software GL renderer, so the WebGL figures are a worst case): scroll frame time
is still a median of **16.7 ms** with 19–30 live nodes, import holds at
~370–410 files/second, and the JS heap is 6–10 MB.

Album merging and the listening meter do not show up in these numbers. The merge
is one grouping pass per reindex behind a `requestAnimationFrame`; on the 300-album
library it folds nothing and costs nothing measurable, and 300 albums go in and
300 come out — which is the more important result. The meter is credited from the
shared ticker and flushed every twenty seconds. Reconnecting settles in **2.8 s**
worst case, which is the file-availability poll running to its ceiling.

Two honest notes. Drawing the world costs the main thread something, so the
backdrop **stops while an import is running** — the worker's throughput is what
someone is actually waiting on, and the room can hold still for six seconds.
And cold start to a painted library reads slower here (~0.9 s against 250 ms on
the machine in the table) because the intro now compiles shaders and renders a
scene during boot; the library is painted behind it either way, and the intro is
on screen for longer than the difference.

## Testing

The tools generate a synthetic library with real containers and real tags — the
FLAC and MP3 files decode as actual silence, so playback is exercised end to end.

```bash
npm i playwright                                   # only needed for the browser tests
python3 tools/make-testlib.py /tmp/testlib         # 50 tracks, 9 formats, embedded art,
                                                   # incl. an album split across two folders
python3 tools/make-testlib.py /tmp/biglib --bulk 3000
python3 -m http.server 8123 &                      # the tests expect this port

node tools/smoke.mjs        /tmp/testlib ./shots   # boot, intro, import, metadata, album merge,
                                                   # visualiser, stage, circles, band overview,
                                                   # persistence, auto-reconnect
node tools/interactions.mjs /tmp/testlib           # keyboard, dragging, sorting, queue editing
node tools/perf.mjs         /tmp/biglib            # the table above
```

Set `SONORA_CHROMIUM=/path/to/chrome` to run against a Chromium that is already
on the machine instead of the one Playwright downloads for itself.

Band lookups are tested against intercepted routes — real `fetch`, real parse,
real cache, no live service. That is also how the suite proves that nothing is
requested before you consent, and that a second look at an artist is served from
the cache.

## Notes

- Everything stays on the device. With **Settings → Online** off — which is how
  it ships — Sonora makes no network requests after the page loads: no fonts, no
  CDNs, no analytics, no telemetry, no account. Turning band lookups on sends an
  artist name and a Wikipedia page title, and nothing else, and only when you
  ask for one. Your library, your listening history and your file names never
  leave the device by any code path.
- The library index, cover thumbnails, playlists, the saved session, listening
  totals and any cached lookups live in IndexedDB. **Settings → Clear library**
  removes the library; **Listening data → Reset** and **Online → Clear cache**
  remove the other two independently. Your audio files are never touched, and the
  app never writes to your music folder.
- Light, dark and system themes; the theme is applied before first paint so there
  is no flash.
- The visualiser style, the backdrop and the artwork tint are all switchable in
  **Settings → Appearance** and **Visualiser**; the choice follows every canvas
  in the app at once.
- The design owes its conventions to a few places worth naming: motion.dev and
  anime.js for spring-based orchestration, staggered timelines and treating text
  as a list of targets; KokonutUI and bklit-ui for the token-driven,
  customisation-first way of composing primitives. Both of those are React and
  Tailwind libraries, so nothing was imported — Sonora still ships with no
  dependencies, no build step and no network requests. What was borrowed is how
  they think, not their code.
- Works down to ~520px wide: the sidebar collapses to an icon rail and the queue
  panel becomes an overlay.
