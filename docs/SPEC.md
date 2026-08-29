# Sonora — Feature Specification & UX Plan

**Version** 2.2 · **Status** implemented and verified unless a section says
otherwise · **Audience** full-stack, design, QA

---

## 0. How to read this

Every numbered feature below is **built and passing tests in this repository**.
The specification is written as a specification anyway — objective, story,
behaviour, acceptance criteria, data, API, accessibility, budgets — so that it
can be split into tickets, argued with, regression-tested, or handed to
someone re-implementing Sonora on a different stack.

Where a decision was forced by a browser constraint rather than chosen, the
constraint is named. Those are the parts most likely to be re-litigated by
someone who has not hit them yet.

Sections marked **▸ Backlog** are specified but *not* built; they are the
natural next tickets and are collected again in §16.

---

## 1. High-level overview

### 1.1 What Sonora is

A music player that reads a listener's own files off their own drive, in the
browser, with no server, no build step, no dependencies and no account. It
opens offline, on a plane, forever. Everything it knows lives in IndexedDB on
the device.

That constraint is the product, not an implementation detail. Every feature
below is measured against it: *does this still work with the network unplugged,
and does it send anything anywhere the listener did not ask for?*

### 1.2 The four features in this release

| # | Feature | One line | Default |
|---|---------|----------|---------|
| F1 | **Auto-reconnect & resume** | The app opens where you left it — queue, track, playhead — without being asked. | On |
| F2 | **Band Overview** | Optional online context for an artist: biography, activity, discography, line-up, with citations. | **Off** |
| F3 | **File selection & album auto-merge** | Pick loose files as well as folders; an album split across folders lands as one album. | On |
| F4 | **Circle Analysis Center** | Listening *time* — the honest metric — drawn as area-proportional circles by artist, genre or year. | On |
| F5 | **The Rack** | Ten-band parametric EQ, dynamics, space, stereo width, and pitch and speed as two separate controls. | Unity |
| F6 | **Looks** | Nineteen visual settings and eight named looks, all of it CSS custom properties. | Aqua |

### 1.3 The shape of the change

```
js/audio.js     NEW   the rack: EQ, dynamics, space, stereo, pitch, speed
js/pitch-worklet.js NEW  pitch without tempo, on the audio thread
js/sound.js     NEW   the Sound page: the response curve and every control
js/looks.js     NEW   nineteen visual settings and eight named looks
css/aero.css    NEW   the material: atmosphere, glass, sheen, specular edges
css/sound.css   NEW   the rack's own layout
js/session.js   NEW   reconnect + resume, the playhead mirror
js/stats.js     NEW   the listening-time meter
js/circles.js   NEW   the Circle Analysis Center (hand-packed SVG)
js/band.js      NEW   the only module that touches the network
js/library.js   CHG   album merge, loose-file root, guessed-artist verdict
js/tags.js      CHG   records which fields it had to guess from the folder tree
js/player.js    CHG   setQueueSilently, cue, moveInQueue
js/db.js        CHG   schema v1 → v2, adds the `band` cache store
js/app.js       CHG   Analysis and Sound routes, add-music menu, look boot
js/views.js     CHG   Circle view, Band Overview, the Look panel, settings
js/backdrop.js  CHG   selectable scenes, bubbles, look-driven intensity
js/gl.js        CHG   sphereLines, for the bubbles
css/base.css    CHG   the shape and material tokens the look engine writes
tools/layout.mjs NEW  eight widths × eight routes: overflow, overlap, centring
tools/audio.mjs  NEW  does the rack change the sound, measured after the rack
```

### 1.4 What did **not** change

The offline guarantee. With F2 switched off — its default — Sonora issues
**zero** network requests beyond loading its own files. A smoke test asserts
this by counting intercepted requests before anyone opts in.

---

## 2. Design language

> **Techy retro-futurism, with subtle fringes of aero.**

The interface reads as a piece of instrumentation: something with a serial
number, calibrated, drawn in hairlines on a dark drafting surface, lit by one
electric cyan. Aero enters at the *fringes only* — the frosted panels, the
specular top edge on raised surfaces, the sense of depth behind glass — never
as the whole look. Aero was a material; retro-futurism is the argument.

### 2.1 Principles

1. **Vector, not decoration.** Every shape is drawable with a pen: hairlines,
   chamfers, ticks, brackets, wireframe. No blobs, no soft illustration, no
   drop-shadowed cards pretending to be paper.
2. **Corners are cut by default, and the cut is a setting.** Every `clip-path`
   in the app is one of three shape tokens that read `--k` off the element
   using them, so the corner style — chamfer, rounded, square — and its size
   are preferences rather than a rewrite. A hard-coded radius is a bug; a
   `border-radius: var(--radius)` beside a shape token is correct.
3. **One accent, earned.** Cyan `0 209 255` → blue `58 132 255`. Album colour
   lives in a *separate* token (`--art-rgb`) and is allowed only next to the
   artwork it came from, so the chrome never drifts.
4. **Numbers are monospace.** Durations, counts, percentages, timecodes — all
   `--mono` with `tabular-nums`, so nothing twitches as it counts.
5. **Depth is real, not painted.** The background is WebGL: a wireframe grid,
   tunnel rings, a rotating icosahedron and rising bubbles, all reacting to the
   audio, over an atmosphere of three enormous soft lights. Panels sit above it
   on glass you can see through. Nothing fakes a shadow that a light source
   would not cast.
6. **Aero at the fringes, never as the whole look.** Gloss, frost, specular
   edges and bubbles are the wet-glass borrowing; the hairlines, chamfers,
   mono labels and wireframe are the instrument. Aero was a material;
   retro-futurism is the argument. Both are dials — at zero gloss the app is
   the flat instrument it was, and it still holds together.
7. **Motion explains, then stops.** One shared `requestAnimationFrame` ticker
   for the whole app. Transitions are short (120/220/420 ms) and always
   directional — a thing arrives from where it came from.

### 2.2 Tokens (`css/base.css`)

| Group | Tokens |
|---|---|
| Ground | `--bg` `--bg-grad` `--surface` `--surface-2` `--surface-3` |
| Hairlines | `--line` `--line-2` `--line-3` (cyan at 13% / 26% / 46%) |
| Glass | `--glass` `--glass-2` `--glass-bar` `--blur: blur(24px) saturate(150%)` |
| Text | `--text` `--text-2` `--text-3` `--on-accent` |
| Accent | `--accent-rgb` `--accent-2-rgb` `--aero-rgb` `--art-rgb` + `-soft` `-line` `-glow` `-grad` |
| Geometry | `--cut` `--cut-sm` `--cut-lg` `--radius` `--hair` `--k` |
| Shape | `--nick-ne` `--nick-nw` `--nick-all` — the three chamfers, blanked to square the app |
| Material | `--gloss` `--frost` `--glow` `--grid-a` `--parallax` `--sheen` `--spec` |
| Space | `--sidebar-w` `--pane-w` `--player-h` `--topbar-h` `--gutter` `--pad` `--row-h` `--scale` |
| Motion | `--dur-1..3`, `--ease`, `--ease-soft`, `--ease-back`, `--ease-step` |

Anything a listener can change is one of these, written by `looks.apply()`. A
component that reads a setting directly is a component that will be missed the
next time one is added.

Colours are stored as **channel triplets** (`--accent-rgb: 0 209 255`) so any
component can take an alpha of them without a second token. Every new colour
must be added in this form.

Both themes are complete palettes. The light theme is a drafting table — ice
white, ink-blue hairlines, the same cyan doing the same job — not an inversion.

### 2.3 The aero fringe, precisely

Permitted: `backdrop-filter` frost on floating surfaces; a 1px specular
highlight on the top edge of raised panels; a faint inner glow on the focused
control; translucency that lets the 3D backdrop show through.

Not permitted: gloss gradients across whole buttons; reflections; bevels;
skeuomorphic glass *objects*; anything that costs a compositor layer per row in
a virtualised list.

### 2.4 Component vocabulary

`.cut` `.cut-sm` `.cut-lg` `.cut-both` chamfers · `.brackets` corner ticks ·
`.label` mono uppercase micro-label · `.grad-text` accent gradient text ·
`.segmented` mode switch · `.band-card` context card · `.link-state` connection
readout · `body::before` 44px graph-paper grid.

---

## 3. Feature specifications

---

## F1 · Auto-reconnect and resume

> `js/session.js`, `js/player.js`, `js/app.js`, Settings → Connection

### F1.1 Objective

Opening Sonora should feel like un-pausing it. The listener's queue, track and
playhead come back on their own, from the same folders, with no dialog, no
re-picking, and no silent failure.

### F1.2 User stories

- *As a listener*, I reopen the tab and the record I was halfway through is
  loaded at the second I stopped, so I press one key and carry on.
- *As a listener whose folder is no longer reachable*, I am told that in one
  short sentence rather than shown an empty player.
- *As a listener who explicitly disconnected*, nothing reconnects behind my
  back until I say so.

### F1.3 Behaviour

**Saving.** A snapshot is written to IndexedDB, debounced 1500 ms, on every
track change, queue change, play/pause, and every 4 s of playback. It holds:
current track id, playhead, duration, the first 500 queue ids, index, origin,
shuffle, repeat, and a timestamp. A whole 40,000-track shuffle is not carried;
the head of it is what "where I was" means.

**The playhead mirror.** IndexedDB is asynchronous, and a write started while
the page is being torn down does not land — so the playhead alone is *also*
written to `localStorage` (`sonora:playhead`, `"<seconds>|<trackId>"`) once a
second and on `pagehide`, `visibilitychange` and track change. On restore, the
mirror wins if it names the same track. It is two numbers; it is the difference
between coming back at 0:02 and coming back at 0:00.

**Restoring**, once, after the library has painted:

1. If auto-connect is off, or the listener explicitly disconnected → phase
   `off`. Nothing else happens.
2. Read the snapshot. No snapshot, or its track is no longer in the library →
   phase `ready`.
3. Rebuild the queue with `player.setQueueSilently(ids, index, origin)` —
   **this happens either way**, because the list of what was playing is still
   true even when the audio is out of reach.
4. Poll `library.isAvailable(trackId)` every 180 ms for up to **2500 ms** while
   the roots reconnect in the background.
5. Available → `player.cue(track, position)` loads and seeks, and returns
   whether the browser allowed playback. Playing → phase `resumed`. Refused →
   phase `ready` with a toast carrying one **Resume** button.
6. Not available → phase `failed`, readout "Folder not connected", a toast
   pointing at Settings, **and an armed resume** (below).

**The armed resume.** After a failure, `session` listens for `library.roots`
and `library.change`. The moment the track becomes available — because the
listener reconnected that folder for any reason at all — the resume completes
itself. One shot: if they start playing something else first, the old session
has been answered and the arm stands down.

**Autoplay is not ours to decide.** Browsers refuse `play()` without a prior
gesture on the origin. Pretending to have resumed and sitting silent would be
worse than saying so, so Sonora restores everything, tries to start, and
reports honestly.

**The file-input constraint.** A folder opened through `<input webkitdirectory>`
hands its files over exactly once, on the gesture that opened it, and no script
can re-open it. Chromium's `showDirectoryPicker` handles *can* be persisted and
re-acquired. So route capability differs, and the UI must not promise what the
route cannot do:

| Route | Reconnect without a gesture | Landing phase |
|---|---|---|
| `showDirectoryPicker` handle | yes (permission permitting) | `resumed` / `ready` |
| `<input webkitdirectory>` | no, by design | `failed` + armed resume |

**Explicit disconnect** sets `sonora:disconnected`, pauses, forgets the
session, and holds phase `off` until Reconnect is pressed.

### F1.4 Acceptance criteria

| # | Criterion | Measure |
|---|---|---|
| AC-1.1 | The reconnect attempt settles within 3 s of the library painting. | `session.state.ms < 3000` — **measured 2785 ms** at the poll ceiling, i.e. worst case. |
| AC-1.2 | The previous track is identified and cued without user action. | `session.state.restored.trackId` equals the pre-reload track. |
| AC-1.3 | The playhead returns within 1 s of where it stopped. | Snapshot position vs. pre-reload elapsed. **Measured exact.** |
| AC-1.4 | The queue returns intact. | `player.state.queue.length` equals the pre-reload length. |
| AC-1.5 | The status indicator is non-intrusive: a topbar readout, never a modal, and it self-hides 4 s after a success. | `#link-state` (a polite live region) hidden on `resumed`/`ready`; visible and explanatory on `failed`. **Verified.** |
| AC-1.6 | A failure states a reason and offers a route out. | Readout "Folder not connected" + toast → Settings. |
| AC-1.7 | An armed resume completes on its own when the folder returns. | Re-add the folder; the track cues with no further input. |
| AC-1.8 | An explicit disconnect is respected across reloads. | Phase `off`, no cue, no request. |
| AC-1.9 | Turning auto-connect off disables the whole feature. | `sonora:autoconnect = '0'` → phase `off`. |

### F1.5 States

`idle → connecting → { resumed | ready | failed | off }`

Every phase is emitted on `session.events('phase')` and mirrored to
`#link-state[data-phase]` for styling and for tests.

### F1.6 API surface

```js
session.state                    // { phase, message, restored, ms }
session.events.on('phase', fn)   // → unsubscribe
session.watch()                  // start saving; call once at boot
session.restore(notify)          // → 'resumed'|'ready'|'failed'|'off'|'none'
session.disconnect()
session.reconnect(notify)
session.forget()
session.autoConnectEnabled()  session.isDisconnected()

player.setQueueSilently(ids, index, origin)   // rebuild without starting
player.cue(track, position)                   // → Promise<boolean> playing
```

### F1.7 Accessibility

`#link-state` carries `role="status"` and `aria-live="polite"`, so a failed
reconnect is announced without interrupting anything. The Resume toast is
focusable and its button is reachable by keyboard. Nothing about the resume
steals focus.

### F1.8 Budgets

Restore adds ≤ 3 s wall-clock and no measurable main-thread work beyond one
IndexedDB read and up to fourteen `isAvailable` map lookups. Saving costs one
debounced IndexedDB write per 1.5 s of activity and one `localStorage.setItem`
per second of playback.

---

## F2 · Band Overview (online analysis)

> `js/band.js`, `js/views.js`, `js/db.js`, Settings → Online

### F2.1 Objective

Give the listener the context a sleeve used to carry — who this is, when they
were active, what else they made — without turning an offline player into a
telemetry client.

### F2.2 User stories

- *As a listener*, I open an artist page and can ask for a biography,
  discography and line-up, with links back to where each fact came from.
- *As a listener*, I can go deeper on one album without loading context for
  every album I own.
- *As a private person*, I can read exactly what would leave my device before
  anything leaves it, and revoke it later in one place.

### F2.3 Behaviour

**Off until asked.** `sonora:online` is unset by default. No request is issued
until the listener opts in, and opting in happens through a consent dialog that
enumerates what is sent.

**Sources.** MusicBrainz (`ws/2`) and Wikipedia (`api/rest_v1/page/summary`).
Both public, both CORS-enabled, both keyless. No account, no third-party
script, no analytics.

**Rate limiting.** One request at a time, at most one per 1.1 s, through a
promise chain. MusicBrainz publishes a limit and enforces it with 503s; a burst
from a library page would earn a block for everyone behind the same address.

> **The queue wraps single requests only.** A queued task that awaits another
> queued task waits for a link in a chain it is itself holding up, and the whole
> thing stops forever. Orchestration stays outside the queue; only leaves go in.
> This was a real deadlock — one request, then a permanent hang — and it is the
> single most repeatable way to break this module.

**Caching.** Every answer is stored in the IndexedDB `band` store for **30
days**, keyed `artist:<lowercased name>` / `release:<artist>::<title>`. The
second look at an artist costs nothing and works on a plane. `band.peek(key)`
reads the cache *without* the ability to fetch, so a cached overview can be
shown without touching the network at all.

**Timeouts.** Every request carries an `AbortController` with a 9 s ceiling and
`credentials: 'omit'`, `referrerPolicy: 'no-referrer'`.

**The four cards.**

| Card | Contents |
|---|---|
| **Biography** | Wikipedia summary paragraph + "Read on Wikipedia" |
| **Activity** | Type, area, began, ended/active, top tags |
| **Discography** | Up to 12 release groups, newest first; owned ones link into the library; each has a **Deepen** action |
| **Line-up & links** | Members with dates; official pages, minus Wikidata |

**Deepening** (`analyseRelease`) is per-release and only on request: one extra
lookup, separately cached.

**Failure is a sentence, not a stack trace:** `offline` → "No connection — this
needs the internet." · `not-found` → "Nothing found online for “X”." ·
`consent` → "Online lookups are switched off." · anything else → "Lookup failed
— the service may be busy. Try again in a moment." The rest of the app is
unaffected in every case.

### F2.4 Acceptance criteria

| # | Criterion | Measure |
|---|---|---|
| AC-2.1 | With the feature off, Sonora makes zero network requests. | Intercepted request count is 0 before opt-in. **Verified.** |
| AC-2.2 | Consent is requested before the first request, and lists what is sent. | Dialog names artist name → MusicBrainz, page title → Wikipedia, "nothing else". **Verified.** |
| AC-2.3 | When online and consented, the overview renders **≥ 4 cards**. | 4 cards. **Verified.** |
| AC-2.4 | Album/song analysis is one click from the overview and does not run by default. | Per-release **Deepen** toggle. |
| AC-2.5 | Every claim carries a citation or link. | Biography → Wikipedia URL; discography/line-up → MusicBrainz ids; links card → source URLs. |
| AC-2.6 | A second look at the same artist issues no new requests. | Request counter unchanged across a repeat view. **Verified 3 → 3.** |
| AC-2.7 | Requests are spaced ≥ 1 s and never overlap. | Serialised chain, 1100 ms floor. |
| AC-2.8 | Offline, the panel says so and nothing else breaks. | `isOnline()` guard before any fetch. |
| AC-2.9 | Consent is revocable and the cache is clearable, both in Settings. | Toggle + "Clear cache" with a live entry count. |

### F2.5 API surface

```js
band.isEnabled()  band.setEnabled(on)  band.isOnline()
band.analyseArtist(name)          // → the overview object (cached 30d)
band.analyseRelease(artist, title)
band.peek(key)                    // cache only, never fetches
band.clearCache()
band.events.on('consent', fn)
```

Returned shape:

```js
{ name, mbid, disambiguation, type, area, began, ended, active,
  tags: string[],
  bio: { extract, url, thumb } | null,
  releases: [{ title, year, type, mbid }],
  members: [{ name, mbid, ended }],
  links:   [{ label, url }],
  fetchedAt }
```

### F2.6 Auto-suggestion **▸ Backlog**

Specified, not built: when an artist page is opened for the *third* time and
lookups are already enabled, offer the overview inline once, dismissible
permanently per artist. Never auto-run before consent, and never for more than
one artist per session.

### F2.7 Accessibility

Cards are `<article>` with a heading each; the dialog traps focus and returns
it; external links carry `rel="noreferrer noopener"` and an "opens in a new
tab" affordance; status messages are a live region.

### F2.8 Budgets

`band.js` is **lazily imported** — it is not in the boot path and costs nothing
until an artist page asks for it. First overview: ≤ 4 sequential requests
(≈ 4.4 s at the rate limit, dominated by politeness, not by us). Cached
overview: one IndexedDB read, < 5 ms.

---

## F3 · File selection and auto-merge by album

> `js/library.js`, `js/tags.js`, `js/app.js`

### F3.1 Objective

Let people add music the way it is actually stored — a folder, a handful of
loose files, a rip that ended up in two places — and have the library show one
album per album regardless.

### F3.2 User stories

- *As a listener*, I can add three files from my Downloads folder without
  pointing Sonora at the whole folder.
- *As someone with a messy drive*, half of *Graduation* tagged and half of it
  loose in `Unsorted/Rips` shows up as **one** album with four tracks in the
  right order.
- *As someone with fifteen "Greatest Hits"*, they stay fifteen albums.

### F3.3 Behaviour — selection

Both routes are offered **on every browser**, from the same "Add music" menu:

- **Add a folder…** → `showDirectoryPicker()` where available, otherwise
  `<input webkitdirectory>`.
- **Add files…** → `showOpenFilePicker()` where available, otherwise
  `<input multiple accept=…>`.

> Regression worth knowing: an earlier build chose the *route* by which API
> existed, so on Firefox and Safari "Add a folder" fell through to the loose
> file input and lost the folder path — and with it the artist and album that
> the tag reader infers from the tree. The menu now always offers both, and the
> fallback for each is the fallback *for that route*.

Loose files land under a single synthetic root, `d:loose` — "Selected files" —
which is skipped by folder rescans and listed in Settings like any other.

### F3.4 Behaviour — merge

Albums are keyed by `hash(albumArtist + album)`, which is correct right up until
the tags disagree, and across a hand-assembled library they disagree constantly.

After the index is built, albums whose **normalised titles match** are
reconsidered. They merge when their artists also match once normalised, **or
when one side has no artist worth the name.**

That last phrase does the real work, because **an untagged rip is never
nameless.** The tag reader falls back to the folder tree — `Artist/Album/03
Title.mp3` is a near-universal convention and reading it is what makes untagged
music usable — so half of *Graduation* sitting in `Unsorted/Rips` arrives
claiming to be by *"Unsorted"*. Comparing that to *"Cassia Bloom"* finds two
different artists and refuses to merge.

So the tag reader now records **provenance**: `tags.guessed` lists the fields it
had to take from the path. `decorate()` resolves it once, at import, into
`track.namedArtist` — because by the second call `albumArtist` has already been
filled in from `artist` and the evidence is gone — and stores it with the
track. An album is `named` if *any* of its tracks actually claimed its artist.
A guessed artist counts as **no artist** when albums are compared.

Two records that both named themselves still never merge, so every "Greatest
Hits" ever pressed stays separate.

**Order of operations.** Merging runs **before** the artist index is built.
Absorbing an album can hand its tracks a real artist, and an artist index built
first would leave a page behind for a folder name that no longer names
anything. After the fold, tracks whose artist was only ever a guess adopt the
survivor's — `artist`, `albumArtist`, `artistKey` and the search string.

**The survivor** is the album with the most tracks, so the artwork already
stored under its key stays attached. Track order is by disc, then track number,
then title — so the merged album reads 1, 2, 3, 4 across both folders.

**The visual cue.** When an import merges anything, the completion toast says
so by name: *"Added 50 tracks · merged “Graduation”"*, with an **Open** action
when exactly one album was folded. Merging is a claim about the listener's
library and should never be silent.

### F3.5 Acceptance criteria

| # | Criterion | Measure |
|---|---|---|
| AC-3.1 | Individual files can be selected, not only folders, on every supported browser. | Both menu items present with either API set. **Verified.** |
| AC-3.2 | Importing ≥ 2 tracks of one album from different folders yields **one** album entity. | Graduation: 2 folders → 1 album. **Verified.** |
| AC-3.3 | Every track from both folders is in it. | 4 tracks. **Verified.** |
| AC-3.4 | Track order is retained across the merge. | Sorted disc → track → title. |
| AC-3.5 | The merged album keeps the artist that had one. | "Cassia Bloom", not "Unsorted". **Verified.** |
| AC-3.6 | The album page is reachable from any of its tracks. | `track.albumKey` re-pointed to the survivor. **Verified.** |
| AC-3.7 | Distinct albums sharing a title do not merge. | 3,000-track library: 300 albums in, **300 albums out.** |
| AC-3.8 | Metadata integrity: no field is invented, only re-attributed, and only when it was a guess. | Merge touches artist fields only, guarded by `namedArtist`. |
| AC-3.9 | The import readout names what was merged. | Toast lists merged album titles. |
| AC-3.10 | The merge survives a reload. | `namedArtist` is persisted with the track; re-derived on load. **Verified.** |

### F3.6 API surface

```js
library.canPickFiles()          // showOpenFilePicker available?
library.addFiles()              // → { added } | null
library.events.on('scan', (running, report) => …)  // report: { added, merged[] }
tags.readTags(blob, path, name) // → { …, guessed: 'artist album' }
track.namedArtist               // boolean, decided once, persisted
album.named                     // any track claimed this artist
album.merged                    // how many albums folded into this one
```

### F3.7 Formats

Unchanged and complete: MP3 (ID3v2/v1), MP4/M4A/AAC, FLAC, Ogg/Opus, WAV
(RIFF INFO), AIFF (80-bit extended sample rates), Matroska/WebM, WMA. Unknown
suffixes are sniffed by magic bytes. A container the browser cannot decode is
still indexed, named and shown — labelled honestly rather than hidden — and
`MediaError` codes, not `canPlayType` (which lies), set `track.undecodable`.

### F3.8 Budgets

Merge is O(albums) grouping plus O(collisions²) within a title bucket, run once
per reindex behind a `requestAnimationFrame`. Measured at 3,000 tracks / 300
albums: no detectable change to the 8–9 s import (≈ 310–425 files/s, dominated
by parsing and artwork encoding in the worker).

---

## F4 · Circle Analysis Center

> `js/circles.js`, `js/stats.js`, route `#/circles`, nav "Analysis"

### F4.1 Objective

Answer *"what have I actually been listening to?"* with the metric that is true
— **time** — instead of the one that is easy.

### F4.2 Why time, not plays

Play counts lie. A track skipped at four seconds counts the same as one played
to the end, so a play-count chart rewards indecision. Sonora measures seconds
of audio that actually reached the speakers. This is the headline metric of the
whole view and is stated in full at the top of the page.

### F4.3 Behaviour — the meter

Driven by the shared rAF ticker rather than `timeupdate`, and credited **only
while the element is genuinely playing** — so seeking, pausing, buffering and a
track that fails to decode all cost nothing. Anything under **2 s** is a skip,
not a listen, and is discarded. Totals flush to IndexedDB every 20 s, on pause,
on track change and on `pagehide`.

### F4.4 Behaviour — the drawing

**Three modes**, persisted to `sonora:circle-mode`: **Artists · Genre · Year**.

**Area is the message.** Radius is `√(seconds / max) × 100`, which makes *area*
proportional to time — twice the circle is twice the listening. Radius-scaled
charts are the usual way this kind of picture lies. A floor of 9 units keeps
the long tail clickable.

**Packing** is done by hand, not by a library: circles are placed largest-first
on an expanding spiral, rejecting collisions, then the whole arrangement is
centred on its bounding box and scaled to fit the 1000-unit viewBox. For the
60 slices this ever draws it costs well under a millisecond, and it is
deterministic — switching modes and switching back puts everything where it
was.

> The centring was a real bug: an earlier `fit()` scaled around the origin,
> which is the *first* circle, not the centre — so large datasets drifted off
> frame. It scales around the bounding-box centre now, and labels rescale with
> it.

**Interaction.**

| Gesture | Result |
|---|---|
| Hover | Tooltip: exact time (`4h 12m`), share of total, play count |
| Click | Pin — the circle keeps its tooltip so two can be compared side by side |
| Drag | Move a circle to arrange a comparison by hand |
| Double-click | Play everything in that bucket (also Shift/Alt-click, or `P`) |
| Mode switch | Relayout, interpolated on the shared ticker |
| **Reset view** | Unpin everything, release dragged positions, re-pack. Appears only when there is an arrangement to undo. |
| **Reset data** | Throw away the listening totals, behind a confirmation. Deliberately a *different* button: one undoes a picture, the other destroys months of measurement. |

**Live.** `stats.events('change')` refreshes the view while music plays: the
circle you are listening to grows as you listen. A circle the listener has
**dragged keeps where they put it** across those refreshes — an arrangement
that dissolves under you every twenty seconds is worse than no arrangement.

**Scale.** Capped at the top 60 buckets — beyond that the picture stops being
readable before it stops being computable. **▸ Backlog:** an "and 240 more"
aggregate circle, and a search field to pull a specific artist into view.

**Empty state.** Before there is anything to draw: "Play something. This fills
in as you listen." Never an empty circle.

**Reduced motion.** `prefers-reduced-motion` renders the final layout directly,
with no interpolation.

### F4.5 Acceptance criteria

| # | Criterion | Measure |
|---|---|---|
| AC-4.1 | Total listening time per listener is shown as the headline figure. | `#circle-total`, e.g. "35 MIN across 9 artists". **Verified.** |
| AC-4.2 | Three modes — Artists, Genre, Year — and switching relayouts. | Segmented control; layout recomputed. **Verified.** |
| AC-4.3 | Region size is proportional to listening time **by area**. | `r = √(s/max)·100`; ratio of areas checked against ratio of seconds. **Verified.** |
| AC-4.4 | Hover reveals exact values. | Tooltip: time, share, plays. **Verified.** |
| AC-4.5 | A circle can be pinned and compared. | Click pins; pinned tooltips persist. **Verified.** |
| AC-4.6 | Circles can be dragged, the arrangement survives a live refresh, and it can be reset without touching the data. | Pointer drag + **Reset view**. **Verified.** |
| AC-4.7 | The view updates in real time as playback continues. | `stats.events('change')` → refresh. |
| AC-4.8 | Large datasets stay legible and fast. | Top 60; layout < 1 ms; one transform pass per frame. |
| AC-4.9 | Listening data is resettable. | Settings → Listening data → Reset, behind a confirm. |

### F4.6 API surface

```js
stats.init()                       // load totals, start the meter
stats.byMode('artist'|'genre'|'year', { limit })
   // → [{ key, label, seconds, plays, share }] largest first
stats.total()  stats.forTrack(id)  stats.trackedCount()  stats.MODES
stats.reset()
stats.events.on('change', fn)

circles.mountCircles(host)         // → { refresh(), destroy() }
```

### F4.7 Accessibility

The mode switch is a real `role="tablist"` with `aria-selected`. Each circle is
focusable, labelled `"<name>, <time>, <share> of listening"`, and responds to
Enter/Space (pin) and `P` (play). **▸ Backlog:** a table view of the same numbers,
toggleable, for screen-reader users who would rather read than navigate a
canvas of circles — the drawing is the *illustration*, and the numbers should
never live only inside it.

---

---

## F5 · The Rack (audio processing)

> `js/audio.js`, `js/pitch-worklet.js`, `js/sound.js`, `css/sound.css`, route `#/sound`

### F5.1 Objective

Give the listener more control over the sound than any streaming service
offers, without a plugin, an account, or a second application — and make the
controls legible enough that someone who has never seen an equaliser can tell
what one does.

### F5.2 User stories

- *As a listener with bad headphones*, I can pull the boxy 250 Hz out and put
  the air back at 10 kHz, and hear the difference immediately.
- *As someone learning a part*, I can slow a track to 70% without it dropping
  a tone, or drop it a semitone without it slowing down.
- *As someone falling asleep*, I can compress the dynamics so the loud bits
  stop waking me up.
- *As anyone*, I can press one key to hear it without any of that, because
  that is the only way to tell whether it is helping.

### F5.3 The chain

```
gain → [rack] → analyser → speakers

  preamp → 31 62 125 250 500 1k 2k 4k 8k 16k → bass shelf → treble shelf
         → pitch (detour) → compressor → mid/side width → balance
         → dry + convolver·wet → limiter → out
```

Ten bands: the ends are shelves, the eight between are bells at Q 1.1 — about
1.3 octaves, wide enough to cover the spectrum without gaps and narrow enough
that each one does something. Range ±12 dB.

**The chain is always connected.** Bypassing an effect sets it to unity — a
biquad at 0 dB is transparent, a compressor at a ratio of 1 is transparent —
because rewiring a live graph clicks. Every parameter change is a 20 ms
`setTargetAtTime` ramp for the same reason.

**The reverb is made of noise.** A convolution reverb needs a recording of a
real space, and shipping one would mean shipping a megabyte of audio into an
app whose whole argument is that it has no dependencies. Exponentially decaying
noise is the textbook stand-in and sounds like a room because a room *is* a
dense cloud of decaying reflections; a one-pole filter that closes as the tail
decays supplies the air, and six discrete early reflections supply the size.
Five spaces: Room, Chamber, Plate, Hall, Cathedral.

**Stereo width is a real mid/side matrix**, not a pan law: mid = (L+R)/2,
side = (L−R)/2, out = mid ± width·side. The node feeding it is pinned to two
channels explicitly, so a mono recording stays in both ears rather than
becoming a one-eared one at any width setting.

### F5.4 Pitch and speed, separately

`playbackRate` moves pitch and tempo together, because that is what spinning a
record faster does. Sonora offers them as two controls:

| Control | Range | How |
|---|---|---|
| **Speed** | 0.5×–2× | `playbackRate` with `preservesPitch`, re-applied on every source load because some engines reset it |
| **Pitch** | ±12 semitones | A delay line read at a different rate than it is written, in an AudioWorklet |

The shifter is the classic two-tap delay-line design. Read the line 3% faster
than you write it and everything comes out a semitone up — but the read pointer
catches the write pointer and clicks twelve times a second. So there are two
read pointers half a grain apart, windowed by `sin(πp)` and `sin(π(p+½))`,
whose squares sum to one: a constant-power crossfade, which is what two
decorrelated copies of the same sound want. One multiply-add per tap per
sample, no allocation after construction, no FFT.

It is not a phase vocoder and a large shift on a sustained note will warble.
For the ±12 semitones anyone actually uses on music it is clean, and it does
not cost 40 ms of latency.

> **Ordering matters, and getting it wrong is two bugs at once.** Everything
> about the shifter is configured *after* the node exists and never from
> `apply()`. Reading the node from `apply()` means the first call finds
> nothing constructed, so the ratio is never written and the audio plays at
> its original pitch; and the crossfade to the wet path starts before there
> is anything on the wet path, so the sound drops out for as long as the
> module takes to fetch. Both of those shipped in the first draft and both
> are covered by tests now.

The worklet module is not fetched until someone asks for a pitch change, and
the signal routes around the node entirely at zero semitones — it costs an
audio-thread hop and 85 ms of delay line, which is not worth paying for
nothing.

### F5.5 The page

The centre is the **response curve**: the combined shape of all twelve filters,
obtained from `getFrequencyResponse()` on the filters themselves rather than
derived from the slider positions. What is on screen is what is in the signal,
including the skirts where neighbouring bands overlap and add — which is where
an equaliser surprises you.

The curve layer is stretched to fill its box, because a curve squeezed into a
band in the middle does not read as a curve. Labels and handles are HTML on
top, positioned in percent, so text stays crisp and handles stay circular
whatever shape the box is.

Drag a handle or move its fader: both are the same edit, and both redraw from
the same measurement. Double-click a handle to flatten that band; arrow keys
move it in 0.5 dB steps, Shift for 3 dB, Home for flat.

Eleven presets (Flat, Bass Boost, Sub, Vocal, Acoustic, Electronic, Loudness,
Late Night, Spoken, Classical, Headphones) and any number of saved racks. One
line under the title says what the rack is doing in plain language.

### F5.6 Acceptance criteria

| # | Criterion | Measure |
|---|---|---|
| AC-5.1 | Moving a band changes the audio, not only the picture. | Analyser (which sits after the rack) reads a ≥6% band change on a ±12 dB move. **Verified.** |
| AC-5.2 | Bypass returns the untouched signal. | Within 25% of the flat reading. **Verified.** |
| AC-5.3 | Pitch changes the key without the tempo. | A 240 Hz tone reads 357 Hz at +7 semitones and 181 Hz at −5, with RMS preserved. **Verified in an OfflineAudioContext.** |
| AC-5.4 | Speed changes the tempo without the key. | `playbackRate` 1.5, `preservesPitch` true. **Verified.** |
| AC-5.5 | Nothing clicks when a control moves. | Every parameter is ramped, never stepped. |
| AC-5.6 | The curve matches the filters. | Read from `getFrequencyResponse`, not from the sliders. |
| AC-5.7 | Every band is reachable without a pointer. | Handles are `role="slider"` buttons with arrow, Shift-arrow and Home. **Verified.** |
| AC-5.8 | The rack survives a reload. | Debounced to IndexedDB; restored before the graph exists. **Verified.** |
| AC-5.9 | Someone who never opens the page pays nothing. | The worklet is fetched on first pitch change; the graph is unity otherwise. |
| AC-5.10 | A browser without AudioWorklet loses pitch and nothing else. | `canPitch()`; the failure is reported once and the dry path stays up. |

### F5.7 API surface

```js
rack.attach(ctx, media)      // → { input, output }; called once by the player
rack.bindElement(media)      // speed works before any graph exists
rack.state                   // the whole rack, plain data
rack.set(patch)  rack.setBand(i, dB)  rack.setComp(patch)  rack.setSpace(patch)
rack.usePreset(id)  rack.reset()  rack.isDefault()  rack.canPitch()
rack.response(freqs)         // → Float32Array of dB, measured off the filters
rack.savedRacks()  rack.saveRack(name)  rack.deleteRack(name)  rack.loadRack(r)
rack.BANDS  rack.PRESETS  rack.SPACES
rack.events.on('change' | 'ready' | 'racks' | 'pitch-unavailable', fn)
rack.__debug()               // node state and gain reduction, for the tests
```

### F5.8 Accessibility

Every control is a native `input[type=range]` or `button` with a label and a
live text readout — the curve is an illustration of numbers that are also
written down, never the only way to read a value. Handles are focusable
sliders with `aria-valuenow` and `aria-valuetext` in hertz and decibels. `B`
bypasses from anywhere; `E` opens the page.

### F5.9 Budgets

About 40 Web Audio nodes, built once. Parameter changes are `setTargetAtTime`
calls, not graph edits. The curve is 220 samples through twelve filters, only
on the Sound page. Measured: no change to import throughput, route paint or
scroll frame time.

---

## F6 · Looks (interface customisation)

> `js/looks.js`, `css/aero.css`, Settings → Look

### F6.1 Objective

Let the interface be the listener's rather than ours, without letting it become
unusable — and without every component having to know that a preference exists.

### F6.2 How it works

Nineteen settings, declared once in `looks.SCHEMA`:

| Group | Settings |
|---|---|
| Base | theme (system / dark / light) |
| Colour | accent hue, second hue (as a spread), saturation, surface tint, extra contrast |
| Form | corner style (chamfer / rounded / square), corner size, density, text size |
| Material | gloss, frost, bloom, graph paper |
| Depth | backdrop scene, scene intensity, bubbles, parallax, motion |

`apply()` turns the whole set into CSS custom properties on the root element.
The stylesheets read those properties and nothing else, so **no component knows
a setting exists** — adding one is a line in `looks.js` and it appears in the
panel, correctly grouped, with its hint, its units and its keyboard handling
already working.

Three things make that possible:

1. **Colours are stored as hue, chroma and lightness** and converted here, so
   one slider moves the accent, its partner, every hairline, every glow and the
   panel tint together and they stay in the same family. Accent *lightness* is
   not a setting — it is whatever keeps the contrast on the current ground.
2. **The chamfer is three shape tokens** (`--nick-ne`, `--nick-nw`,
   `--nick-all`) that read `--k` off whatever element uses them. Every
   `clip-path` in the app is one of those three. Setting them to `none` turns
   every corner in the app square at once, which is how a corner style becomes
   a preference rather than a rewrite.
3. **The look is cached as its own output.** `apply()` writes the finished
   `style` attribute and data-attributes to `localStorage`; four lines of
   inline script in the document head replay them before first paint. A module
   cannot run before first paint, and a second implementation there would
   drift — this one cannot, because it is not an implementation.

Eight named looks (Aqua, Blueprint, Lagoon, Ultraviolet, Ember, Solar,
Graphite, Plain) are patches over the defaults, so each says only what makes it
itself and gains any setting added later for free.

### F6.3 Acceptance criteria

| # | Criterion | Measure |
|---|---|---|
| AC-6.1 | Every setting takes effect immediately, with no reload. | Custom properties on `:root`. |
| AC-6.2 | A look survives a reload with no flash of the previous one. | Head script replays the cached output. |
| AC-6.3 | Contrast holds at every hue. | Accent lightness is derived from the ground, not chosen. |
| AC-6.4 | "Plain" removes every effect and the app still works. | Gloss, bloom, grid, scene, parallax all at zero. |
| AC-6.5 | A corrupt or partial stored look leaves the defaults. | Each field validated against its own spec on load. |
| AC-6.6 | Nothing in the panel can produce an unreadable interface. | Ranges are bounded; text and background are never both settable. |

### F6.7 The Aero layer

`css/aero.css` is the Frutiger Aero half of the aesthetic, kept in one file so
it can be turned off by one slider:

- **The atmosphere** — three enormous soft lights behind everything. This is
  the single move that separates a dark interface from one that looks like it
  is underwater, and it is why the glass has anything to refract.
- **Glass, not paint** — content surfaces are translucent so the lit world
  shows through them.
- **A specular top edge** on every raised surface: one pixel of light where
  the panel meets the air.
- **A radial sheen** across the top of raised controls, brightest where the
  horizon light is.
- **Bubbles** — wireframe spheres rising through the 3D scene, each on its own
  clock, brighter towards the top the way a wet surface is.

Every effect multiplies by `--gloss`, `--frost` or `--glow`. At zero the file
contributes nothing and the app is the flat instrument it was.

> **Two performance rules were learned the hard way and are load-bearing.**
>
> `backdrop-filter` never goes on a surface that scrolls. It reads back
> everything behind the element on every frame; putting it on the shelves took
> the scroll from a 16.7 ms median to 66 ms. The frost belongs on the chrome,
> which does not move.
>
> The atmosphere does not animate. The chrome above it is frosted, so anything
> drifting behind that glass forces the blur to be recomputed every frame: a
> 34-second drift turned a 17 ms scroll into 35 ms, and pausing the animation
> did not give it back — once Chromium has an animation on a full-viewport
> layer it keeps paying for it whether it is running or not. The motion in this
> app belongs to the wireframe world, which is drawn on the GPU and throttles
> itself.

---

## 4. User flows

### 4.1 First run

```
load → 3D intro (wireframe bars rise, camera settles, letters stagger in)
     → app revealed, empty state
     → "Add music" → menu → folder | files
     → worker parses; grid fills progressively; progress in the topbar
     → import completes → toast: "50 tracks added · Graduation put back together"
```

The intro plays once per load, is skippable by any key or click, and is
replaced by a single still frame under `prefers-reduced-motion`.

### 4.2 Returning (the common path)

```
load → intro → library paints from IndexedDB (measured: 939 ms cold, 3,000 tracks)
     → session.restore()
        ├─ resumed → readout "Resumed", self-hides after 4 s, audio continues
        ├─ ready   → readout "Ready to resume" + toast with one Resume button
        ├─ failed  → readout "Folder not connected" + toast → Settings
        │            queue still restored · resume armed
        └─ off     → readout "Disconnected"
```

### 4.3 Reconnecting after a failure

```
Settings → Connection → Reconnect now      (or simply add the folder again)
     → roots re-acquire → armed resume fires → track cues at its saved second
```

No second act of remembering is asked of the listener.

### 4.4 Asking about a band

```
Artist page → "Look up online"
     ├─ first time → consent dialog (exactly what is sent) → Not now | Enable
     └─ enabled    → 4 cards, ≤ 4 requests, ≥ 1 s apart
        → owned releases link into the library
        → any release → "Deepen" → one more lookup, cached separately
        → returning later → cache hit, zero requests
```

### 4.5 Reading the analysis

```
Nav → Analysis → circles packed by artist (default)
     → hover for exact numbers · click to pin · drag to arrange
     → mode switch → interpolated relayout
     → double-click a circle → play that artist / genre / year
     → grows live while music plays
```

### 4.6 Adding loose files

```
"Add music" → "Add files…" → pick 3 files anywhere on disk
     → they land under "Selected files"
     → any that belong to an album already present merge into it
     → toast names the merge
```

---

## 5. UI/UX design guidelines

### 5.1 Layout

Sidebar 252px · queue pane 352px · player 96px · topbar 62px · gutter 34px.
Breakpoints at 1100px (pane becomes an overlay), 860px (sidebar collapses to
icons), 620px (player condenses). Verified: **no horizontal overflow at 860px
or 520px.**

### 5.2 Typography

System sans for prose; `--mono` with `tabular-nums` for every number, timecode,
count and micro-label. `.label` is the mono uppercase 11px tracking-wide label
that names each region — it is the main carrier of the instrument feel.

### 5.3 Motion

- One shared ticker. New animation code hangs off `motion.tick`; a second rAF
  loop is a bug.
- `--dur-1` 120 ms for state, `--dur-2` 220 ms for movement, `--dur-3` 420 ms
  for arrivals.
- Exit animations race `anim.finished` against a timeout (`motion.settled`)
  — under software GL an animation may settle late, and a view that waits
  forever for it never leaves.
- `prefers-reduced-motion` has a still-frame path in the intro, the backdrop,
  the visualiser and the circles. Not "less motion" — no motion.

### 5.4 The backdrop

WebGL 1, hand-written GLSL ES 1.00: sky pass, scrolling grid plane, tunnel
rings, wireframe icosahedron, all reacting to the analyser.

> **The precision contract.** A name declared in *both* shader stages must
> carry the same precision, and the two stages have different defaults — vertex
> is `highp`, fragment must say. Getting it wrong does not warn at compile
> time: the program fails to link and the entire scene silently disappears.
> Every shared varying is qualified explicitly, and no uniform is shared at all
> (the audio level is folded into JS instead). Anyone touching these shaders
> must preserve that.

It throttles itself: average frame > 26 ms → half rate → off after 4 s of
strain. It also stops drawing entirely during an import, which is worth ~70
files/second.

### 5.5 Lists

Everything long is virtualised — songs, queue, album grid — with recycled nodes
positioned by transform. **DOM order therefore says nothing**; read
`data-index`. Measured: 28–30 live nodes for 3,000 rows, median frame 16.7 ms.

### 5.6 Feedback

Toasts are the only interruption, they carry at most one action, and they never
block. Errors are one sentence in plain language with a route out. Nothing
spins without saying what it is waiting for.

---

## 6. Data model

### 6.1 IndexedDB — `sonora`, version **2**

| Store | Key | Holds |
|---|---|---|
| `tracks` | `id` | Track records (see below) |
| `art` | album key | WebP thumbnail blobs (448px long edge) |
| `roots` | `id` | Folder handles / file-input roots, incl. `d:loose` |
| `playlists` | `id` | User playlists |
| `kv` | name | `session:v1`, `listen:v1`, `recent`, misc |
| `band` | `key` | **New in v2** — cached online answers |

### 6.2 Track

```js
{
  id, path, name, size, mtime, rootId,
  title, artist, albumArtist, album,
  track, disc, year, genre, duration,
  albumKey,                 // hash(albumArtist + album); re-pointed by a merge
  artistKey,                // hash(norm(albumArtist))
  accent,                   // [r,g,b] pulled from the artwork
  addedAt,
  guessed,                  // NEW  'artist album' — fields taken from the path
  namedArtist,              // NEW  boolean, decided once at import, persisted
  undecodable,              // set when a real MediaError says so
  search, sortTitle,        // derived
}
```

**Why `namedArtist` is stored rather than recomputed:** `decorate()` fills
`albumArtist` from `artist` when it is empty, so on the *second* call the
evidence of where the name came from is already gone. It is decided once, at
import, and travels with the record.

### 6.3 Album (derived, per reindex)

```js
{ key, title, sort, artist, artistKey, year, tracks[], duration, addedAt,
  accent, named /* any track claimed this artist */, merged /* how many folded in */ }
```

### 6.4 Session — `kv['session:v1']`

```js
{ trackId, position, duration, queue: string[] /* ≤500 */, index, origin,
  shuffle, repeat, savedAt }
```

Plus `localStorage['sonora:playhead'] = "<seconds>|<trackId>"` — the
synchronous mirror, and the only listening state outside IndexedDB.

### 6.5 Listening — `kv['listen:v1']`

`{ [trackId]: seconds }`. Rolled up on read, never on write, so adding a
grouping mode needs no migration. Buckets whose tracks have left the library are
skipped rather than shown under a blank label — a slice you cannot click into is
worse than no slice.

### 6.6 Band cache — `band` store

```js
{ key: 'artist:cassia bloom' | 'release:cassia bloom::graduation',
  data: { … }, at: <epoch ms> }        // TTL 30 days
```

Contains only what the public services returned. No identifiers, no history, no
file paths.

### 6.7 Preferences — `localStorage`

| Key | Default | Meaning |
|---|---|---|
| `sonora:autoconnect` | on | F1 master switch |
| `sonora:disconnected` | unset | explicit disconnect, survives reloads |
| `sonora:playhead` | — | the synchronous playhead mirror |
| `sonora:online` | **off** | F2 consent |
| `sonora:circle-mode` | `artist` | F4 mode |
| `sonora:viz` | `bars` | visualiser mode |
| `sonora:accent` | on | album colour beside artwork |
| `sonora:backdrop` | on | 3D backdrop |
| `sonora:theme` | system | dark / light / system |

Every read and write is wrapped: private mode throws on `localStorage`, and a
feature that dies because a preference could not be read is a feature that
dies on someone's browser.

---

## 7. Feature flags

Each module is independently switchable, and each degrades to *nothing* rather
than to a broken pane:

| Flag | Off means |
|---|---|
| Auto-connect | Library loads; no session restored; phase `off`. |
| Online lookups | The artist page shows no lookup affordance; `band.js` is never imported. |
| Backdrop | Static gradient; WebGL context never created. |
| Album accent | Chrome stays its own colour next to artwork. |
| The rack | Every node at unity; the pitch worklet is never fetched. |
| Gloss / frost / bloom | The Aero layer contributes nothing; the instrument remains. |

Rules for new modules: **lazy-import** anything not on the boot path
(`band.js`, `circles.js`, `stage.js` all are); **debounce** anything driven by
input or playback (session save 1.5 s, stats flush 20 s, search on input frame);
**cache** anything that crosses a process or network boundary; and never let a
disabled module leave a dead control on screen.

---

## 8. Performance budgets

Measured on the 3,000-track / 300-album library:

| Budget | Target | Measured |
|---|---|---|
| Import throughput | ≥ 300 files/s | 310–425 files/s |
| Route first paint | < 120 ms | 45–90 ms |
| Scroll frame | ≤ 16.8 ms | median 16.7 ms, p95 16.8 ms |
| Live DOM nodes, 3,000 rows | < 60 | 28–30 |
| Search keystroke | < 5 ms | 0.3–1.8 ms |
| JS heap | < 20 MB | 8–10 MB |
| Cold start to painted library | < 1.5 s | 770–906 ms |
| Reconnect settle | < 3 s | 2699 ms worst case |
| Rack in the graph | no measurable cost | no change to any figure above |

Regressions to watch for: a second rAF loop; a non-virtualised list; drawing
during import; an unthrottled backdrop; a `layout` read inside a render pass.

And two that this release found by measuring rather than by reasoning:

- **`backdrop-filter` on anything that scrolls.** It reads back everything
  behind the element every frame. On the shelves it cost 50 ms per scroll
  frame — three frames of work per frame.
- **Any animation on a full-viewport layer behind frosted chrome.** The blur
  has to be recomputed because its backdrop moved. A 34-second ambient drift
  cost 18 ms per scroll frame, and `animation-play-state: paused` did not give
  it back: the layer stays animated in the compositor either way.

Both are now stated in `css/aero.css` beside the code that obeys them.

---

## 9. Security and privacy

**The rule.** Sonora is offline by construction. F2 is the only exception, and
it is built to prove the rule rather than weaken it.

1. **Consent is prior, specific and informed.** No request is issued before the
   listener has read a dialog naming exactly what leaves the device: *the
   artist name* (to MusicBrainz) and *the matching page title* (to Wikipedia).
   Nothing else — not the library, not the listening history, not a file name,
   not a path, not an identifier.
2. **Consent is revocable in one place**, and revoking it stops all future
   requests immediately (`analyseArtist` throws `consent` before it fetches).
3. **The cache is inspectable and clearable.** Settings shows the number of
   cached answers and clears them on request.
4. **No sensitive data, ever.** Listening history, play counts, file paths,
   folder names and library contents never leave the device by any code path.
   There is no analytics, no telemetry, no error reporting, no third-party
   script, no font CDN, no account.
5. **Requests are minimal by construction:** `credentials: 'omit'`,
   `referrerPolicy: 'no-referrer'`, no cookies, no custom identifying headers,
   a 9 s abort ceiling.
6. **Local data stays local.** Everything else lives in IndexedDB and
   `localStorage` on the device and is removed by clearing site data.
7. **Third-party content is treated as data.** Biographies and link labels from
   MusicBrainz and Wikipedia are inserted as text, never as markup; external
   links carry `rel="noreferrer noopener"`.

**Privacy note shown in Settings → Online** (verbatim in the consent dialog):

> Sonora is offline by design. Turning this on sends one thing to two public
> services, and only when you ask for it: the artist name — to MusicBrainz, for
> biography, line-up and discography; the matching page title — to Wikipedia,
> for the summary paragraph. Nothing else. Not your library, not your listening
> history, not a file name. Answers are cached on this device for 30 days, and
> you can clear them or switch this off again in Settings.

---

## 10. Accessibility

| Area | Commitment |
|---|---|
| Contrast | Body text ≥ 7:1, secondary ≥ 4.5:1, in both themes. Hairlines are decorative and never the only signal. |
| Keyboard | Every action reachable without a pointer. Shortcuts: Space, ←/→, ↑/↓, M, S, R, N, P, Q, V, `/`, Esc. |
| Focus | A visible cyan focus ring on every interactive element; dialogs trap focus and return it. |
| Screen readers | Landmarks throughout; `aria-selected` on the mode switch; live regions for the connection readout, scan progress and lookup status; every icon button has an `aria-label`. |
| Motion | `prefers-reduced-motion` has a still-frame path in the intro, backdrop, visualiser and circles, and the Motion setting offers Full / Calm / None independently of the system. |
| Sizing | Text size, density and contrast are settings, so someone who needs 125% type does not have to zoom the whole layout to get it. |
| Audio controls | Every rack parameter is a native range or button with a live text readout; the response curve illustrates numbers that are also written down. |
| Colour | Never the only channel: pinned circles also gain a ring, the current queue row also gains a marker, undecodable tracks also carry a word. |
| Targets | ≥ 32px, ≥ 40px on coarse pointers. |

**▸ Backlog:** the table view of the circle data (§F4.7), and a keyboard route
for reordering the queue (drag is currently pointer-only).

---

## 11. Tech stack considerations

**What is here, and why it stays.** Vanilla ES modules, no build step, no
dependencies, no framework. `index.html` opens from a file server or a static
host and works. Anyone can read the whole thing. Adding a bundler would buy
tree-shaking Sonora does not need and cost the property that makes it
maintainable by one person.

| Concern | Choice | Note |
|---|---|---|
| Storage | IndexedDB | Blobs, structured records, no quota games. `localStorage` only for preferences and the playhead mirror. |
| Parsing | Module worker | Keeps a 3,000-file import off the main thread. Main-thread fallback for browsers without module workers. |
| Artwork | `OffscreenCanvas` → WebP | Decoded and re-encoded once per album, in the worker. |
| Audio analysis | `AnalyserNode`, fftSize 2048 | 64 log-folded bands, 32 Hz–16 kHz, asymmetric smoothing, peak caps, beat detection against a running bass average. |
| 3D | WebGL 1, hand-written GLSL | WebGL 2 buys nothing here and costs reach. |
| Charts | Hand-packed SVG | A charting library would be the largest thing in the app by an order of magnitude, for one chart. |
| Online | `fetch` + `AbortController` | Keyless, CORS-enabled, public endpoints only. |
| Tests | Playwright, three suites | Real Chromium, real files, real IndexedDB. Network code tested against route interception: real fetch, real parse, real cache, no live service. |

**If this were ported to a framework**, the load-bearing pieces are: the
virtualiser (recycled nodes, `data-index`, transform positioning), the single
shared ticker, the worker import pipeline, the provenance flag on tags, and the
shader precision contract. Everything else is replaceable.

---

## 12. API surface summary

New modules: `session` (§F1.6), `stats` and `circles` (§F4.6), `band` (§F2.5).

Changed, existing modules:

```js
// player.js
setQueueSilently(ids, index, origin)   // rebuild a queue without starting it
cue(track, position)                   // → Promise<boolean> — did it play?
moveInQueue(from, to)                  // keeps baseOrder in step for shuffle

// library.js
canPickFiles()  addFiles()             // loose-file route
events.on('scan', (running, { added, merged }) => …)

// tags.js
readTags(blob, path, name)             // → { …, guessed: 'artist album' }

// db.js  (v2)
getBand(key)  putBand(rec)  clearBands()  bandCount()
```

No existing signature changed meaning. `library.events('scan')` gained a second
argument; existing listeners ignore it.

---

## 13. Migration notes

**Schema v1 → v2** is additive and guarded. `onupgradeneeded` creates the
`band` store if absent; every other store is left alone. There is no data
migration, no rewrite, and no downtime — an existing library opens and paints
exactly as before.

**Rolling back to v1** is not possible in place: IndexedDB refuses to open a
database at a lower version. A rollback needs either a build that still
declares version 2 (and simply ignores the `band` store) or a deliberate
`deleteDatabase`, which loses the library. **Do not ship a rollback that lowers
`VERSION`.**

**Tracks imported before this release** have neither `guessed` nor
`namedArtist`. `decorate()` resolves the absence to `namedArtist: true` — the
pre-existing behaviour — so nothing merges retroactively on the strength of
evidence that was never recorded. **Re-importing a folder re-parses it and
merges correctly.** ▸ Backlog: a one-shot background re-tag pass to backfill
provenance on old libraries.

**Preferences** are all new keys with safe defaults; `sonora:online` defaults to
off, so an upgrading listener is not opted in to anything.

**Nothing is removed.** No store, no key, no exported function.

---

## 14. Changelog-ready summary

> ### Added
> - **Auto-reconnect and resume.** Sonora reopens where you left it: the queue,
>   the track and the playhead all come back, within 3 seconds. When a folder
>   cannot be reached, it says so, keeps the queue, and finishes the resume by
>   itself the moment the folder is back.
> - **Band Overview.** Optional, off by default: biography, activity,
>   discography and line-up for any artist, from MusicBrainz and Wikipedia,
>   with links back to every source. One consent dialog says exactly what
>   leaves your device — an artist name and a page title, and nothing else.
>   Answers are cached for 30 days, so a second look works offline.
> - **Circle Analysis Center.** Listening *time* — not play counts — drawn as
>   circles whose area is proportional to the hours. Group by artist, genre or
>   year; hover for exact figures, click to pin two side by side, drag to
>   arrange, double-click to play.
> - **Add individual files**, not just folders, on every browser.
> - **The Rack.** A ten-band parametric equaliser with a curve you can grab,
>   bass and treble shelves, a preamp, a compressor, a limiter, five reverbs
>   built out of noise rather than downloaded, stereo width and balance — and
>   pitch and speed as two separate controls, so you can drop a track a
>   semitone without slowing it down or slow it to 70% without it dropping a
>   tone. Eleven presets, and you can save your own. `B` bypasses the whole
>   thing from anywhere, which is the only way to tell whether it is helping.
> - **Looks.** Nineteen visual settings — the hue the whole app is lit by, how
>   sharp its corners are, how much glass and gloss it wears, how dense the
>   type is, how much of the 3D world is drawn behind it — and eight named
>   looks to start from: Aqua, Blueprint, Lagoon, Ultraviolet, Ember, Solar,
>   Graphite and Plain.
> - **A phone layout.** Below 560px the side rail becomes a row of tabs under
>   the transport and the whole width goes to the music.
>
> ### Changed
> - **The interface is deeper.** An atmosphere of three enormous soft lights
>   behind everything, glass you can see the world through, a specular edge
>   where each panel meets the air, and wireframe bubbles rising through the
>   3D scene.
> - **Albums split across folders now land as one album.** The tag reader
>   records which fields it had to guess from the folder tree, so half a record
>   sitting in `Unsorted/Rips` is no longer treated as an album by an artist
>   called "Unsorted". Albums that both name themselves still never merge.
> - The import summary says what it merged, by name.
>
> ### Fixed
> - "Add a folder" fell through to the loose-file picker on browsers without
>   the File System Access API, losing the folder path and the metadata read
>   from it.
> - The playhead could come back a second or two early, because the session
>   write started as the page closed never landed.
> - Circle packing scaled around the first circle rather than the centre of the
>   arrangement, pushing large datasets off frame.
> - An artist page could be left behind for a folder name after its tracks were
>   re-attributed by a merge.
> - Online lookups could deadlock after the first request (a queued task
>   awaiting its own queue).
> - A circle dragged into place in the Analysis view sprang back to the packed
>   layout on the next live refresh, which is every twenty seconds while music
>   plays.
> - The queue-row click test targeted the last row in a virtualised list, which
>   is below the fold — scrolling to it recycled the node about to be clicked.
> - The play button was a two-row grid holding two glyphs, so the visible one
>   sat in the top half of the button. Every swap button had it — play/pause,
>   mute, repeat, and the one on the immersive stage.
> - The play triangle's bounding box was centred on 13.5 of 24 units, and the
>   round play button added a 2px nudge on top of that.
> - The sort header put its icon on the text baseline; a track row's number,
>   meter and play button each found their own centre.
> - The queue panel's border made a "0px" grid column one pixel wide, so every
>   route in the app scrolled sideways by exactly one pixel, at every size.
> - The transport's columns had hard minimums adding to 796px with no
>   breakpoint between 761 and 900, so a 768px tablet overflowed.
> - The queue panel kept its named grid area at widths where that area no
>   longer existed, so a closed panel was auto-placed at a negative x and took
>   the transport with it.

---

## 15. Verification

Three Playwright suites, run against real Chromium, a real 50-file library and
a real 3,000-file library:

```
node tools/make-testlib.py <dir>      # 50 files, 9 formats, incl. the split album
node tools/smoke.mjs <lib> <shots>    # 60 checks: boot, import, metadata, merge,
                                      # circles, band, search, reload, reconnect
node tools/interactions.mjs <lib>     # sorting, keyboard, dragging, queue editing
node tools/perf.mjs <biglib>          # import, paint, scroll, search, heap
node tools/layout.mjs <lib> <shots>   # 8 widths × 8 routes: overflow, overlapping
                                      # regions, unreachable controls, glyph centring
node tools/audio.mjs <lib>            # does the rack change the sound — measured
                                      # on the app's own analyser, after the rack
```

Current state: **all five suites pass, with no console errors.** The layout
audit reports the app clean at 360, 414, 620, 768, 1024, 1280, 1680 and 2400
pixels on every route.

The Band Overview is tested against intercepted routes — real `fetch`, real
parse, real cache, no live service — which is also how the "zero requests
before consent" and "cached, not refetched" assertions are made.

> **Known limitation of this environment:** the container these suites run in
> blocks outbound connections to `musicbrainz.org` and `en.wikipedia.org` at
> the proxy. The module's request construction, parsing, caching, rate limiting
> and error handling are all exercised against stubs, but **it has not been run
> against the live services here.** That is the one thing to check by hand
> before release: open an artist page on a machine with open egress, accept the
> consent dialog, and confirm four populated cards and a cache hit on the
> second visit.

---

## 16. Backlog

| # | Item | Section |
|---|---|---|
| B-1 | Auto-suggest the Band Overview on a third artist-page visit, dismissible per artist | §F2.6 |
| B-2 | Table view of the circle data for screen readers | §F4.7, §10 |
| B-3 | "And 240 more" aggregate circle + search-to-focus for very large libraries | §F4.4 |
| B-4 | Keyboard route for reordering the queue | §10 |
| B-5 | One-shot background re-tag to backfill `guessed` on pre-2.1 libraries | §13 |
| B-6 | Per-album and per-song deep analysis surfaced on the album page, not only from the artist overview | §F2.3 |
| B-7 | Per-album and per-artist racks, so a badly mastered record can carry its own correction | §F5 |
| B-8 | Import and export a look or a rack as a file, for sharing | §F5.7, §F6.2 |
| B-9 | A phase-vocoder pitch mode for large shifts, behind a quality setting | §F5.4 |
| B-10 | Crossfade and gapless playback, which the rack's graph now makes reachable | §F5.3 |
