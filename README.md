# Sonora

A music player for the files already on your computer — the shape of Spotify or
SoundCloud, but the library is a folder on your disk. Nothing is uploaded,
nothing is streamed, and there is no account. The browser reads the files
directly and the index lives in local storage on the device.

No build step, no dependencies, no framework. Open it and it runs.

It also reopens where you left it, folds an album back together when it is
split across folders, draws what you have actually been listening to, gives you
a full processing rack to bend the sound with, lets you rebuild the interface
around your own colour, and — only if you ask it to — will look an artist up
online. All of it is specified in full in [`docs/SPEC.md`](docs/SPEC.md).

---

## Running it

Module scripts and web workers need a real origin, so `file://` will not work.
Any static server does:

```bash
cd sonora
python3 -m http.server 8000      # or: npx serve .
```

On a Windows machine with neither Python nor Node — which is most of them —
the runtime is already there:

```bash
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```

Then open <http://localhost:8000> (or `:8123` for the PowerShell one) and click
**Add music**.

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
| `F` | favourite what is playing |
| `Q` | queue panel |
| `V` | immersive visualiser |
| `B` | bypass the rack (A/B what it is doing) |
| `E` | open the Sound page |
| `/` or `⌘K` | search |
| `?` | the whole list, on screen |

That table is not maintained by hand in two places: `?` opens the same array
`bindKeys` reads, so a shortcut cannot exist undocumented and cannot be
documented without existing.

Right-click any track, album or artist for play-next, add-to-queue, favourite,
add-to-playlist and go-to-album. Drag rows in the queue to reorder. Drag the
sidebar edge to resize it.

## The Rack

`Sound` in the sidebar, or `E` from anywhere.

Ten bands, a curve you can grab, and every knob a decent amplifier has: a
preamp, bass and treble shelves, a compressor with a real threshold and ratio,
a limiter so a boost cannot clip, stereo width from mono to wide, balance, and
five reverbs — Room, Chamber, Plate, Hall, Cathedral — built out of decaying
noise rather than downloaded, because a room *is* a dense cloud of reflections
and Sonora is not going to ship a megabyte of impulse responses.

**Pitch and speed are two different knobs.** `playbackRate` moves both, because
that is what spinning a record faster does. Here, *speed* changes the tempo and
leaves the key alone, and *pitch* changes the key and leaves the tempo alone —
±12 semitones, using a delay line read at a different rate than it is written,
with two read heads half a grain apart so it never clicks. Either works on its
own. Both at once is a legitimate thing to want.

The curve in the middle is not a drawing of the slider positions. It is the
combined response of the actual filters, asked of the filters themselves — so
it shows you the places where neighbouring bands overlap and add, which is
where an equaliser surprises you. Drag a handle or move its fader; they are the
same edit. Double-click a handle to flatten that band, or use the arrow keys.

Eleven presets, and you can save your own. **`B` bypasses the whole rack from
anywhere**, which is the only honest way to tell whether any of it is helping.

## The ones you keep

A star on every row, on the transport, and on `F`. **Favourites** in the
sidebar collects them.

The order is the order you starred them in, newest first — not alphabetical,
not by album. It is a record of decisions rather than of music, and sorting it
would throw the only information it has away, so that list is the one track
table in the app with no sortable header.

The mark is kept beside the library rather than on the track record, which
matters more than it sounds. A re-import rewrites every row it finds on disk;
a star has to survive that, because it is a fact about you and not about the
file. And a star whose track is currently out of reach — a folder you have not
reconnected — is kept, not swept: the folder comes back tomorrow and so does
the mark.

## Making it yours

**Settings → Look.** Nineteen things, and eight looks to start from.

The hue the whole app is lit by, and how far its gradient travels around the
wheel. Saturation. How much of that colour bleeds into the panels. Whether
corners are chamfered, rounded or square, and how big. Density and text size.
How much gloss sits on a raised surface, how far the glass blurs, how much the
accent blooms, how visible the graph paper is. Which of the five backdrop
scenes is drawn, how strongly, and whether bubbles rise through it. How far
panels lift when you point at them. How much anything is allowed to move.

None of it is a theme file. Every setting writes CSS custom properties, and
every stylesheet reads only those — so `Plain` really does switch everything
off and leave a working app, and `Solar` really is a daylit one.

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
  sound.css         the rack's own layout
  aero.css          the material: atmosphere, glass, sheen, specular edges
js/
  app.js            routing, navigation, search, shortcuts, theming, ingestion
  library.js        the collection: scanning, indexes, album merging, playlists,
                    favourites
  player.js         playback, queue, Web Audio graph, spectrum analysis
  audio.js          the rack: EQ, dynamics, space, stereo, pitch, speed
  pitch-worklet.js  pitch without tempo, on the audio thread
  sound.js          the Sound page: the response curve and every control
  looks.js          nineteen visual settings and eight named looks
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
  serve.ps1         a static server for Windows machines without Python or Node
  smoke.mjs         interactions.mjs   perf.mjs
  layout.mjs        eight widths × eight routes: overflow, overlap, centring
  audio.mjs         does the rack change the sound, measured after the rack
```

## The look

Sonora is drawn as an instrument rather than as a stack of cards.

**Nothing is rounded by accident.** Out of the box there are no border radii at
all: corners are square or cut on a 45° with `clip-path`. Every one of those
chamfers is one of three shape tokens that read their size off the element
using them, which is what lets *Settings → Look* turn the whole app rounded or
square with one control instead of a rewrite. Surfaces are
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

**A cover is an object, not a picture.** Artwork is drawn the way a record is
photographed: lit from the upper left like every other raised surface in the
app, falling into shade at the lower right, with a bright arris along the top
edge and a dark one along the bottom. That shading is there when nobody is
touching it — which is the half most "3D card" effects leave out, and the
reason they look dead until you hover them. Point at one and it turns toward
you on a spring, a specular pool follows the cursor across the face, the rim
lights on the side facing the light, and the shadow swings the other way. There
is a second plane behind the face at a negative Z, so the turn reveals a real
edge rather than a shear.

The pointer is measured once, by the tilt, and published as three custom
properties; the stylesheet reads those. One listener, no filters, nothing that
can trigger layout — and every part of it is multiplied by the Look's own
`Gloss` and `Parallax`, so **Plain** really does hand back a flat picture.

**The album page is a showcase.** It is a page about a single object, so the
record stands on a floor at the centre of its own perspective, with a hairline
where it meets the surface and its own reflection falling away underneath —
a second draw of an image the browser has already decoded, dropped under a
mask. On Home, each shelf arrives as you reach it, its records rising out of
depth, held by an IntersectionObserver rather than a scroll handler so the
crossing is computed off the main thread. If that observer never reports, the
shelves show themselves anyway after two seconds: an entrance is a nicety, and
a nicety is not allowed to hold the page shut.

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
| Import (parse + index + thumbnail + persist) | 7.0–7.5 s — ~400–430 files/second |
| Cold start from IndexedDB to a painted library | 770–906 ms |
| First paint: Songs / Albums / Artists | 106 / 44 / 41 ms |
| Scroll frame time, 60-frame flick | median **16.7 ms**, p95 16.8 ms |
| Live DOM nodes while scrolling | 28 (songs), 30 (albums) |
| Search latency per keystroke | 0.3–0.5 ms |
| JS heap | 7 MB |

Reproduce with `tools/perf.mjs` (below).

The 3D world and the visualisers do not change what the lists cost. Re-measured
after the rework, on a slower machine than the table above (a container with a
software GL renderer, so the WebGL figures are a worst case): scroll frame time
is still a median of **16.7 ms** with 19–30 live nodes, import holds at
~370–410 files/second, and the JS heap is 6–10 MB.

Nor do the rack, the atmosphere or the look engine: with a full processing
chain in the graph and three enormous soft lights behind the interface, the
scroll is still a **16.7 ms median with a 16.8 ms p95** — every frame, on time.

Two things that were *not* free, and are worth knowing before adding anything
similar:

- **`backdrop-filter` on a surface that scrolls.** It reads back everything
  behind the element on every frame. Putting frost on the shelves took the
  scroll from 16.7 ms to 66 ms — three frames of work per frame, visible as
  stutter. The frost is on the chrome, which does not move.
- **Any animation on a full-viewport layer behind frosted chrome.** The blur
  has to be recomputed because its backdrop moved. A 34-second ambient drift
  behind the interface cost 18 ms per scroll frame, and pausing the animation
  did not give it back — Chromium keeps paying for an animation on that layer
  whether it is running or not. So the atmosphere holds still, and the motion
  in the app belongs to the wireframe world, which is drawn on the GPU and
  throttles itself.

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
node tools/layout.mjs       /tmp/testlib ./shots   # 8 widths × 8 routes: overflow,
                                                   # overlapping regions, unreachable
                                                   # controls, off-centre glyphs
node tools/audio.mjs        /tmp/testlib           # does the rack change the sound
```

`layout.mjs` is the one that found the off-centre transport icons, the one-pixel
sideways scroll and the 768px overflow; it now reports the app clean at 360, 414,
620, 768, 1024, 1280, 1680 and 2400 pixels on every route.

`audio.mjs` does not check that the sliders move. It plays a tone, reads the
app's own analyser — which sits *after* the rack — and checks that boosting the
low bands raises the low end, that cutting them lowers it, that bypass gives the
original back, and that a tone shifted up seven semitones has moved its energy
upward. The pitch shifter is separately verified in an `OfflineAudioContext`:
240 Hz becomes 357 Hz at +7 and 181 Hz at −5, with the level unchanged.

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
  in the app at once. Everything else about how it looks is in **Settings →
  Look**.
- The rack is saved with your library and comes back with it. If a track ever
  sounds wrong, press `B`: that is the whole rack out of the signal path, and
  it will tell you in one keystroke whether the problem is the file or a knob
  you left somewhere.
- The design owes its conventions to a few places worth naming: motion.dev and
  anime.js for spring-based orchestration, staggered timelines and treating text
  as a list of targets; KokonutUI and bklit-ui for the token-driven,
  customisation-first way of composing primitives. Both of those are React and
  Tailwind libraries, so nothing was imported — Sonora still ships with no
  dependencies, no build step and no network requests. What was borrowed is how
  they think, not their code.
- Works down to ~520px wide: the sidebar collapses to an icon rail and the queue
  panel becomes an overlay.
