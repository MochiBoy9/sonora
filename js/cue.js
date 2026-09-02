/* cue.js — one file, several tracks.
 *
 * L15. A large part of the world's carefully ripped music is one FLAC per side
 * with a .cue beside it: live sets, DJ mixes, anything from before the CD, and
 * most of what people call an "image rip". Sonora saw one forty-five-minute
 * track with no title.
 *
 * A cue sheet is a plain text index into an audio file. What matters here is
 * three lines of it:
 *
 *   FILE "Side A.flac" WAVE      which file the indexes are into
 *   TRACK 01 AUDIO               a track begins
 *   INDEX 01 00:00:00            where, as MM:SS:FF with 75 frames a second
 *
 * plus TITLE and PERFORMER, which appear both at the top (the album) and
 * inside each TRACK (that track's own). REM lines carry everything else people
 * have ever wanted — GENRE, DATE, DISCID — and the two worth reading are here.
 *
 * WHAT THIS DOES NOT DO. Multi-FILE sheets, where each track names its own
 * file, are not the case this exists for — those are already a folder of
 * tracks and Sonora reads them as one. INDEX 00 is the pre-gap and is
 * deliberately ignored: a track starts where its INDEX 01 says, which is what
 * every player and every pressing plant means by it.
 */

/** MM:SS:FF — frames, not milliseconds, and there are 75 of them to a second. */
function timeOf(text) {
  const m = /^(\d+):(\d+):(\d+)$/.exec(String(text).trim());
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]) + (+m[3]) / 75;
}

/** Strips the quotes a cue sheet puts around anything with a space in it. */
const unquote = (s) => String(s || '').trim().replace(/^"(.*)"$/, '$1').trim();

/**
 * Parses a cue sheet.
 *
 * @returns {{file: string, album: string, performer: string, genre: string,
 *            date: string, tracks: Array}|null}
 */
export function parse(text) {
  const lines = String(text).split(/\r?\n/);
  const out = { file: '', album: '', performer: '', genre: '', date: '', tracks: [] };
  let current = null;
  let files = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const [, word, rest = ''] = /^(\S+)\s*(.*)$/.exec(line) || [];
    if (!word) continue;

    switch (word.toUpperCase()) {
      case 'FILE': {
        files++;
        // Only the first. See the note above on multi-FILE sheets.
        if (files === 1) out.file = unquote(rest.replace(/\s+(WAVE|MP3|AIFF|FLAC|BINARY|MOTOROLA)\s*$/i, ''));
        break;
      }
      case 'TITLE':
        if (current) current.title = unquote(rest); else out.album = unquote(rest);
        break;
      case 'PERFORMER':
        if (current) current.artist = unquote(rest); else out.performer = unquote(rest);
        break;
      case 'REM': {
        const [, key, value = ''] = /^(\S+)\s*(.*)$/.exec(rest) || [];
        if (!key) break;
        if (/^GENRE$/i.test(key)) out.genre = unquote(value);
        if (/^DATE$/i.test(key)) out.date = unquote(value);
        break;
      }
      case 'TRACK': {
        const n = parseInt(rest, 10);
        if (!isFinite(n)) break;
        current = { number: n, title: '', artist: '', start: null };
        out.tracks.push(current);
        break;
      }
      case 'INDEX': {
        if (!current) break;
        const [, idx, at = ''] = /^(\d+)\s+(.*)$/.exec(rest) || [];
        // 01 is the track proper; 00 is the pre-gap and belongs to what came
        // before it, which is why it is ignored rather than averaged in.
        if (parseInt(idx, 10) !== 1) break;
        const t = timeOf(at);
        if (t !== null) current.start = t;
        break;
      }
      default: break;
    }
  }

  // A sheet with no usable index is not a sheet, whatever else it contains.
  out.tracks = out.tracks.filter((t) => t.start !== null);
  if (files > 1) out.multiFile = true;
  return out.file && out.tracks.length ? out : null;
}

/**
 * Turns a parsed sheet plus the file it indexes into library tracks.
 *
 * Each one is the same file with a start and an end, and an id built from the
 * file's id and the track number — so a cue track has a stable identity that
 * survives a rescan, and a favourite or a correction stays attached to the
 * right piece of music rather than to the whole side.
 *
 * The last track's end is the file's own duration, which is not known until
 * the file has been read; `null` means "to the end", and the player treats it
 * that way.
 */
export function expand(sheet, file) {
  const out = [];
  for (let i = 0; i < sheet.tracks.length; i++) {
    const t = sheet.tracks[i];
    const next = sheet.tracks[i + 1];
    const end = next ? next.start : null;
    out.push({
      id: file.id + '#' + String(t.number).padStart(2, '0'),
      sourceId: file.id,
      path: file.path,
      name: file.name,
      size: file.size,
      mtime: file.mtime,
      rootId: file.rootId,
      title: t.title || `Track ${t.number}`,
      artist: t.artist || sheet.performer || file.artist || '',
      albumArtist: sheet.performer || t.artist || '',
      album: sheet.album || file.album || '',
      genre: sheet.genre || '',
      year: parseInt(sheet.date, 10) || 0,
      track: t.number,
      disc: 1,
      cueStart: t.start,
      cueEnd: end,
      duration: end === null ? Math.max(0, (file.duration || 0) - t.start) : end - t.start,
      addedAt: file.addedAt || Date.now(),
      // Everything the spec block prints belongs to the file, not the segment.
      bitrate: file.bitrate, sampleRate: file.sampleRate,
      bitDepth: file.bitDepth, channels: file.channels,
      guessed: '',
      fromCue: true,
    });
  }
  return out;
}

export { isCueFile } from './util.js';
