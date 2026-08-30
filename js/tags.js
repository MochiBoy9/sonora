/* tags.js — audio metadata reader.
 *
 * Reads tags straight out of the file with no dependencies. The only thing it
 * ever touches is a Blob, and it reads as few bytes as it can get away with:
 * an ID3 header tells us its own length, MP4 atoms are walked 16 bytes at a
 * time until `moov` shows up, FLAC blocks are chained. A 12 MB FLAC usually
 * costs us ~40 KB of reads.
 *
 * Supported: ID3v2.2/2.3/2.4 + ID3v1 (mp3), MP4/iTunes atoms (m4a/mp4/aac),
 * FLAC (Vorbis comments + PICTURE), Ogg Vorbis/Opus, RIFF INFO (wav),
 * AIFF chunks (+ embedded ID3), and Matroska/WebM EBML tags and attachments.
 * Files whose suffix says nothing are identified by their magic number.
 * Duration comes from the container where it is cheap to compute
 * (STREAMINFO, mvhd, Xing/VBRI, RIFF fmt) and is filled in by the audio
 * element later when it is not.
 */

const utf8    = new TextDecoder('utf-8');
const latin1  = new TextDecoder('windows-1252');
const utf16le = new TextDecoder('utf-16le');
const utf16be = new TextDecoder('utf-16be');

const MAX_TAG   = 24 << 20;    // never buffer more than 24 MB of tag data
const MAX_IMAGE = 12 << 20;

const HEAD = 128 << 10;   // one read covers almost every tag layout

/**
 * Random-access window over a Blob, with the head of the file cached.
 *
 * Tag structures are chains of small reads — a FLAC block list or a RIFF chunk
 * walk costs a dozen 4-byte reads — and each `slice().arrayBuffer()` is a
 * separate async hop. Priming the first 128 KB turns those into array indexing
 * and cuts import time roughly in half.
 */
class Reader {
  constructor(blob) {
    this.blob = blob;
    this.size = blob.size;
    this.head = null;
    this.headLen = 0;
  }

  async prime() {
    if (this.head) return;
    this.headLen = Math.min(this.size, HEAD);
    this.head = new Uint8Array(await this.blob.slice(0, this.headLen).arrayBuffer());
  }

  async at(offset, length) {
    if (offset >= this.size || length <= 0) return new Uint8Array(0);
    const end = Math.min(this.size, offset + length);
    if (!this.head && offset < HEAD) await this.prime();
    // Views into the cached head are read-only by convention; every caller that
    // keeps bytes around (artwork) copies with .slice() first.
    if (this.head && end <= this.headLen) return this.head.subarray(offset, end);
    return new Uint8Array(await this.blob.slice(offset, end).arrayBuffer());
  }
}

/* ------------------------------------------------------------------ bytes */

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u24 = (b, i) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u16le = (b, i) => (b[i] | (b[i + 1] << 8)) >>> 0;
/** ID3 synchsafe integer: 7 usable bits per byte. */
const syncsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];

const ascii = (b, i, n) => {
  let s = '';
  for (let j = 0; j < n; j++) s += String.fromCharCode(b[i + j]);
  return s;
};

const trimNul = (s) => s.replace(/[\u0000\ufeff]+/g, '').trim();

function decodeText(bytes, encoding) {
  if (!bytes.length) return '';
  switch (encoding) {
    case 0: return trimNul(latin1.decode(bytes));
    case 1: {                                        // UTF-16 with BOM
      if (bytes.length < 2) return '';
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return trimNul(utf16le.decode(bytes.subarray(2)));
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return trimNul(utf16be.decode(bytes.subarray(2)));
      return trimNul(utf16le.decode(bytes));
    }
    case 2: return trimNul(utf16be.decode(bytes));
    default: return trimNul(utf8.decode(bytes));
  }
}

/** Index of the string terminator for a given ID3 encoding, from `start`. */
function endOfString(b, start, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  for (let i = start; i < b.length; i++) if (b[i] === 0) return i;
  return b.length;
}

const mimeOf = (bytes) => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes.length > 12 && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
};

/* ------------------------------------------------------------------ ID3v2 */

/** Reverses the FF 00 padding inserted by the unsynchronisation scheme. */
function deUnsync(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

const ID3_TEXT = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TPE2: 'albumArtist', TP2: 'albumArtist',
  TALB: 'album', TAL: 'album',
  TRCK: 'track', TRK: 'track',
  TPOS: 'disc', TPA: 'disc',
  TCON: 'genre', TCO: 'genre',
  TYER: 'year', TYE: 'year', TDRC: 'year', TDRL: 'year',
  TCOM: 'composer', TCM: 'composer',
  TLEN: 'lengthMs',
};

/** Reads an ID3v2 tag at `base` — the head of an mp3, or a chunk inside AIFF. */
async function readID3v2(reader, out, base = 0) {
  const head = await reader.at(base, 10);
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return 0;

  const major = head[3];
  const flags = head[5];
  const size  = syncsafe(head, 6);
  if (size <= 0 || size > MAX_TAG) return 10 + Math.max(0, size);

  let body = await reader.at(base + 10, size);
  if (flags & 0x80) body = deUnsync(body);            // whole-tag unsynchronisation

  let p = 0;
  if (flags & 0x40) p += Math.max(0, u32(body, 0));   // skip extended header

  const idLen   = major <= 2 ? 3 : 4;
  const sizeLen = major <= 2 ? 3 : 4;
  const flagLen = major <= 2 ? 0 : 2;

  while (p + idLen + sizeLen + flagLen <= body.length) {
    const id = ascii(body, p, idLen);
    if (id.charCodeAt(0) === 0) break;                // reached the padding
    let len = major <= 2 ? u24(body, p + 3)
            : major >= 4 ? syncsafe(body, p + 4)
            : u32(body, p + 4);
    const fflags = flagLen ? u16(body, p + idLen + sizeLen) : 0;
    const sizeAt = p + idLen;
    p += idLen + sizeLen + flagLen;

    // Some v2.4 writers emit plain 32-bit sizes; some v2.3 writers emit
    // synchsafe ones. If the declared length overruns, try the other reading.
    if (len < 0 || p + len > body.length) {
      const alt = major >= 4 ? u32(body, sizeAt) : syncsafe(body, sizeAt);
      if (alt > 0 && p + alt <= body.length) len = alt;
    }
    if (len <= 0 || p + len > body.length) break;

    let frame = body.subarray(p, p + len);
    if (fflags & 0x0001) frame = frame.subarray(4);   // data-length indicator
    if (fflags & 0x0002) frame = deUnsync(frame);     // per-frame unsync

    const field = ID3_TEXT[id];
    if (field && frame.length > 1) {
      const text = decodeText(frame.subarray(1, endOfString(frame, 1, frame[0])), frame[0]);
      if (text && !out[field]) out[field] = text;
    } else if ((id === 'APIC' || id === 'PIC') && !out.picture && frame.length > 4) {
      out.picture = readAPIC(frame, id === 'PIC');
    }
    p += len;
  }
  return base + 10 + size + ((flags & 0x10) ? 10 : 0);   // + footer, if present
}

function readAPIC(f, legacy) {
  const enc = f[0];
  let p;
  if (legacy) p = 4;                                   // enc + 3-char image format
  else p = endOfString(f, 1, 0) + 1;                   // mime type, always latin1
  p += 1;                                              // picture type byte
  p = endOfString(f, p, enc) + (enc === 1 || enc === 2 ? 2 : 1);   // description
  if (p >= f.length) return null;
  const data = f.subarray(p);
  if (!data.length || data.length > MAX_IMAGE) return null;
  return new Blob([data.slice()], { type: mimeOf(data) });
}

async function readID3v1(reader, out) {
  if (reader.size < 128) return;
  const b = await reader.at(reader.size - 128, 128);
  if (ascii(b, 0, 3) !== 'TAG') return;
  const str = (i, n) => trimNul(latin1.decode(b.subarray(i, i + n)));
  out.title  ||= str(3, 30);
  out.artist ||= str(33, 30);
  out.album  ||= str(63, 30);
  out.year   ||= str(93, 4);
  if (!out.track && b[125] === 0 && b[126]) out.track = String(b[126]);
  if (!out.genre && b[127] < 80) out.genre = ID3_GENRES[b[127]] || '';
}

/* ------------------------------------------------------- mp3 frame / duration */

const MPEG_RATE = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],   // MPEG-1 L3
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],       // MPEG-2/2.5 L3
];
const MPEG_SR = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];

async function mp3Duration(reader, start, out) {
  const win = await reader.at(start, 8192);
  for (let i = 0; i + 4 < win.length; i++) {
    if (win[i] !== 0xff || (win[i + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (win[i + 1] >> 3) & 3;            // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer   = (win[i + 1] >> 1) & 3;            // 1 = Layer III
    if (verBits === 1 || layer !== 1) continue;
    const brIdx = (win[i + 2] >> 4) & 15;
    const srIdx = (win[i + 2] >> 2) & 3;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) continue;

    const mpeg1   = verBits === 3;
    const bitrate = MPEG_RATE[mpeg1 ? 0 : 1][brIdx] * 1000;
    const rate    = MPEG_SR[verBits === 3 ? 0 : verBits === 2 ? 1 : 2][srIdx];
    const samples = mpeg1 ? 1152 : 576;
    const mono    = ((win[i + 3] >> 6) & 3) === 3;
    if (!bitrate || !rate) continue;

    // A Xing/Info/VBRI header sits at a fixed offset inside the first frame.
    const side = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const x = i + 4 + side;
    const tag = x + 4 <= win.length ? ascii(win, x, 4) : '';
    if (tag === 'Xing' || tag === 'Info') {
      const flags = u32(win, x + 4);
      if (flags & 1) {
        const frames = u32(win, x + 8);
        if (frames > 0) { out.duration = (frames * samples) / rate; return; }
      }
    } else if (i + 40 <= win.length && ascii(win, i + 36, 4) === 'VBRI') {
      const frames = u32(win, i + 36 + 14);
      if (frames > 0) { out.duration = (frames * samples) / rate; return; }
    }
    out.duration = ((reader.size - start) * 8) / bitrate;   // assume CBR
    out.bitrate = bitrate;
    return;
  }
}

/* ------------------------------------------------------------------ MP4 */

const MP4_FIELD = {
  '©nam': 'title', '©ART': 'artist', 'aART': 'albumArtist', '©alb': 'album',
  '©day': 'year', '©gen': 'genre', '©wrt': 'composer',
};

async function readMP4(reader, out) {
  const moov = await findAtom(reader, 0, reader.size, 'moov');
  if (!moov || moov.size > MAX_TAG) return false;
  const body = await reader.at(moov.body, moov.size - (moov.body - moov.start));
  walkMP4(body, out);
  return true;
}

/** Scans top-level atoms without reading their payloads. */
async function findAtom(reader, from, until, want) {
  let p = from;
  while (p + 8 <= until) {
    const h = await reader.at(p, 16);
    if (h.length < 8) return null;
    let size = u32(h, 0);
    const type = ascii(h, 4, 4);
    let bodyAt = p + 8;
    if (size === 1) {                                  // 64-bit extended size
      size = u32(h, 8) * 4294967296 + u32(h, 12);
      bodyAt = p + 16;
    } else if (size === 0) size = until - p;
    if (size < 8) return null;
    if (type === want) return { start: p, size, body: bodyAt };
    p += size;
  }
  return null;
}

/** Recursive descent through the atoms we care about, all in memory. */
function walkMP4(b, out, from = 0, to = b.length, path = '') {
  let p = from;
  while (p + 8 <= to) {
    let size = u32(b, p);
    const type = ascii(b, p + 4, 4);
    let body = p + 8;
    if (size === 1) { size = u32(b, p + 8) * 4294967296 + u32(b, p + 12); body = p + 16; }
    else if (size === 0) size = to - p;
    if (size < 8 || p + size > to) return;
    const end = p + size;

    if (type === 'udta' || type === 'ilst' || type === 'trak' || type === 'mdia') {
      walkMP4(b, out, body, end, path + type + '/');
    } else if (type === 'meta') {
      walkMP4(b, out, body + 4, end, path + type + '/');   // version+flags first
    } else if (type === 'mvhd') {
      const version = b[body];
      const ts  = version === 1 ? u32(b, body + 20) : u32(b, body + 12);
      const dur = version === 1 ? u32(b, body + 24) * 4294967296 + u32(b, body + 28)
                                : u32(b, body + 16);
      if (ts > 0 && dur > 0 && dur !== 0xffffffff) out.duration = dur / ts;
    } else if (path.endsWith('ilst/')) {
      readIlstItem(b, type, body, end, out);
    }
    p = end;
  }
}

function readIlstItem(b, type, from, to, out) {
  const dataAtom = findChild(b, from, to, 'data');
  if (!dataAtom) return;
  const kind = u32(b, dataAtom.body) & 0xffffff;        // well-known data type
  const payload = b.subarray(dataAtom.body + 8, dataAtom.end);

  if (type === 'covr') {
    if (!out.picture && payload.length && payload.length < MAX_IMAGE) {
      out.picture = new Blob([payload.slice()], { type: kind === 14 ? 'image/png' : mimeOf(payload) });
    }
    return;
  }
  if (type === 'trkn' || type === 'disk') {
    if (payload.length >= 4) {
      const n = u16(payload, 2), total = payload.length >= 6 ? u16(payload, 4) : 0;
      if (n) out[type === 'trkn' ? 'track' : 'disc'] = total ? n + '/' + total : String(n);
    }
    return;
  }
  if (type === 'gnre' && payload.length >= 2) {
    if (!out.genre) out.genre = ID3_GENRES[u16(payload, 0) - 1] || '';
    return;
  }

  const field = MP4_FIELD[type];
  if (field && kind === 1 && !out[field]) out[field] = trimNul(utf8.decode(payload));
}

function findChild(b, from, to, want) {
  let p = from;
  while (p + 8 <= to) {
    const size = u32(b, p);
    if (size < 8 || p + size > to) return null;
    if (ascii(b, p + 4, 4) === want) return { body: p + 8, end: p + size };
    p += size;
  }
  return null;
}

/* ------------------------------------------------------------------ FLAC */

async function readFLAC(reader, out) {
  const head = await reader.at(0, 4);
  if (ascii(head, 0, 4) !== 'fLaC') return false;
  let p = 4;
  for (let guard = 0; guard < 64; guard++) {
    const h = await reader.at(p, 4);
    if (h.length < 4) break;
    const last = (h[0] & 0x80) !== 0;
    const type = h[0] & 0x7f;
    const size = u24(h, 1);
    if (size > 0 && size < MAX_TAG) {
      if (type === 0) {                                 // STREAMINFO
        const b = await reader.at(p + 4, Math.min(size, 34));
        if (b.length >= 18) {
          // Bit-packed, not byte-aligned: 20 bits of sample rate, then 3 of
          // channel count and 5 of bit depth, then 36 of total samples. Both
          // counts are stored one less than they are.
          const rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
          const total = ((b[13] & 0x0f) * 4294967296) + u32(b, 14);
          if (rate > 0 && total > 0) out.duration = total / rate;
          out.sampleRate = rate;
          out.channels = ((b[12] >> 1) & 0x07) + 1;
          out.bitDepth = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1;
        }
      } else if (type === 4) {                          // VORBIS_COMMENT
        readVorbisComment(await reader.at(p + 4, size), out, 0);
      } else if (type === 6 && !out.picture) {          // PICTURE
        readFlacPicture(await reader.at(p + 4, Math.min(size, MAX_IMAGE)), out);
      }
    }
    p += 4 + size;
    if (last) break;
  }
  return true;
}

function readFlacPicture(b, out) {
  if (b.length < 32) return;
  let p = 4;                                            // picture type
  const mimeLen = u32(b, p); p += 4;
  if (mimeLen > 256 || p + mimeLen > b.length) return;
  const mime = ascii(b, p, mimeLen); p += mimeLen;
  const descLen = u32(b, p); p += 4 + descLen;
  p += 16;                                              // width, height, depth, colours
  if (p + 4 > b.length) return;
  const dataLen = u32(b, p); p += 4;
  if (dataLen <= 0 || p + dataLen > b.length) return;
  const data = b.subarray(p, p + dataLen);
  out.picture = new Blob([data.slice()], { type: mime.startsWith('image/') ? mime : mimeOf(data) });
}

const VORBIS_FIELD = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist',
  'ALBUM ARTIST': 'albumArtist', TRACKNUMBER: 'track', DISCNUMBER: 'disc',
  DATE: 'year', YEAR: 'year', GENRE: 'genre', COMPOSER: 'composer',
};

function readVorbisComment(b, out, p) {
  if (p + 4 > b.length) return;
  const vendorLen = u32le(b, p); p += 4 + vendorLen;
  if (p + 4 > b.length) return;
  let count = u32le(b, p); p += 4;
  if (count > 512) count = 512;
  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const len = u32le(b, p); p += 4;
    if (len <= 0 || p + len > b.length) break;
    const eq = b.indexOf(0x3d, p);                      // '='
    if (eq > 0 && eq < p + len) {
      const key = ascii(b, p, eq - p).toUpperCase();
      const field = VORBIS_FIELD[key];
      if (field) {
        if (!out[field]) out[field] = trimNul(utf8.decode(b.subarray(eq + 1, p + len)));
      } else if (key === 'METADATA_BLOCK_PICTURE' && !out.picture) {
        try {
          const raw = atob(latin1.decode(b.subarray(eq + 1, p + len)));
          const bytes = new Uint8Array(raw.length);
          for (let j = 0; j < raw.length; j++) bytes[j] = raw.charCodeAt(j);
          readFlacPicture(bytes, out);
        } catch { /* malformed base64 */ }
      }
    }
    p += len;
  }
}

/* ------------------------------------------------------------------ Ogg */

/**
 * Reassembles the opening pages into a continuous packet stream, so comment
 * headers that span page boundaries (common once art is embedded) survive.
 */
async function readOgg(reader, out) {
  const head = await reader.at(0, 4);
  if (ascii(head, 0, 4) !== 'OggS') return false;

  const raw = await reader.at(0, Math.min(reader.size, 1 << 20));
  const chunks = [];
  let p = 0, total = 0;
  while (p + 27 <= raw.length && ascii(raw, p, 4) === 'OggS' && chunks.length < 24) {
    const segs = raw[p + 26];
    const table = p + 27;
    if (table + segs > raw.length) break;
    let bodyLen = 0;
    for (let i = 0; i < segs; i++) bodyLen += raw[table + i];
    const bodyAt = table + segs;
    if (bodyAt + bodyLen > raw.length) break;
    chunks.push(raw.subarray(bodyAt, bodyAt + bodyLen));
    total += bodyLen;
    p = bodyAt + bodyLen;
  }
  const stream = new Uint8Array(total);
  { let o = 0; for (const c of chunks) { stream.set(c, o); o += c.length; } }

  // The identification header gives us the sample rate for the duration maths.
  let rate = 0;
  if (stream.length > 28 && ascii(stream, 1, 6) === 'vorbis') rate = u32le(stream, 12);
  else if (stream.length > 12 && ascii(stream, 0, 8) === 'OpusHead') rate = 48000;

  for (let i = 0; i + 8 < stream.length; i++) {
    if (stream[i] === 0x03 && ascii(stream, i + 1, 6) === 'vorbis') {
      readVorbisComment(stream, out, i + 7); break;
    }
    if (stream[i] === 0x4f && ascii(stream, i, 8) === 'OpusTags') {
      readVorbisComment(stream, out, i + 8); break;
    }
  }

  if (rate > 0) {
    const tailLen = Math.min(reader.size, 65536);
    const tail = await reader.at(reader.size - tailLen, tailLen);
    for (let i = tail.length - 27; i >= 0; i--) {
      if (tail[i] === 0x4f && ascii(tail, i, 4) === 'OggS') {
        const granule = u32le(tail, i + 6) + u32le(tail, i + 10) * 4294967296;
        if (granule > 0) out.duration = granule / rate;
        break;
      }
    }
  }
  return true;
}

/* ------------------------------------------------------------------ RIFF */

const RIFF_FIELD = { INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'year', IGNR: 'genre', ITRK: 'track' };

async function readWAV(reader, out) {
  const head = await reader.at(0, 12);
  if (ascii(head, 0, 4) !== 'RIFF' || ascii(head, 8, 4) !== 'WAVE') return false;
  let p = 12, byteRate = 0;
  for (let guard = 0; guard < 64 && p + 8 <= reader.size; guard++) {
    const h = await reader.at(p, 8);
    if (h.length < 8) break;
    const id = ascii(h, 0, 4);
    const size = u32le(h, 4);
    if (id === 'fmt ') {
      const b = await reader.at(p + 8, Math.min(size, 16));
      if (b.length >= 12) byteRate = u32le(b, 8);
      // The rest of the chunk was already in hand; it just was not being read.
      if (b.length >= 8)  { out.channels = u16le(b, 2); out.sampleRate = u32le(b, 4); }
      if (b.length >= 16) out.bitDepth = u16le(b, 14);
    } else if (id === 'data') {
      if (byteRate > 0) out.duration = size / byteRate;
    } else if (id === 'LIST' && size < (1 << 20)) {
      const b = await reader.at(p + 8, size);
      if (ascii(b, 0, 4) === 'INFO') {
        let q = 4;
        while (q + 8 <= b.length) {
          const key = ascii(b, q, 4);
          const len = u32le(b, q + 4);
          if (len <= 0 || q + 8 + len > b.length) break;
          const field = RIFF_FIELD[key];
          if (field && !out[field]) out[field] = trimNul(latin1.decode(b.subarray(q + 8, q + 8 + len)));
          q += 8 + len + (len & 1);
        }
      }
    }
    if (size <= 0) break;
    p += 8 + size + (size & 1);
  }
  return true;
}

/* ------------------------------------------------------------------ AIFF */

const AIFF_FIELD = { NAME: 'title', AUTH: 'artist', ANNO: 'comment' };

/**
 * AIFF is RIFF with the bytes the other way round. COMM carries the frame
 * count and an 80-bit float sample rate; anything richer than NAME/AUTH is
 * usually an ID3 chunk bolted on the side, which the mp3 reader already knows.
 */
async function readAIFF(reader, out) {
  const head = await reader.at(0, 12);
  if (head.length < 12 || ascii(head, 0, 4) !== 'FORM') return false;
  const form = ascii(head, 8, 4);
  if (form !== 'AIFF' && form !== 'AIFC') return false;

  let p = 12;
  for (let guard = 0; guard < 64 && p + 8 <= reader.size; guard++) {
    const h = await reader.at(p, 8);
    if (h.length < 8) break;
    const id = ascii(h, 0, 4);
    const size = u32(h, 4);
    if (size < 0) break;

    if (id === 'COMM') {
      const b = await reader.at(p + 8, Math.min(size, 18));
      if (b.length >= 18) {
        const frames = u32(b, 2);
        const rate = extended80(b, 8);
        if (frames > 0 && rate > 0) out.duration = frames / rate;
      }
    } else if (id === 'ID3 ' || id === 'id3 ') {
      await readID3v2(reader, out, p + 8);
    } else if (AIFF_FIELD[id] && size > 0 && size < (1 << 16)) {
      const b = await reader.at(p + 8, size);
      const field = AIFF_FIELD[id];
      if (!out[field]) out[field] = trimNul(latin1.decode(b));
    }
    if (size <= 0) break;
    p += 8 + size + (size & 1);
  }
  return true;
}

/** IEEE 754 80-bit extended, which is what AIFF stores a sample rate as. */
function extended80(b, i) {
  const sign = b[i] & 0x80 ? -1 : 1;
  const exp = ((b[i] & 0x7f) << 8) | b[i + 1];
  let mantissa = 0;
  for (let j = 0; j < 8; j++) mantissa = mantissa * 256 + b[i + 2 + j];
  if (exp === 0 && mantissa === 0) return 0;
  return sign * mantissa * Math.pow(2, exp - 16383 - 63);
}

/* ------------------------------------------------------------------ Matroska */

const MKV = {
  SEGMENT: 0x18538067, INFO: 0x1549a966, TIMESCALE: 0x2ad7b1, DURATION: 0x4489,
  TITLE: 0x7ba9, TAGS: 0x1254c367, TAG: 0x7373, SIMPLE: 0x67c8,
  TAG_NAME: 0x45a3, TAG_STRING: 0x4487, TAG_BINARY: 0x4485,
  ATTACHMENTS: 0x1941a469, FILE: 0x61a7, FILE_MIME: 0x4660, FILE_DATA: 0x465c,
  SEEKHEAD: 0x114d9b74, CLUSTER: 0x1f43b675, TRACKS: 0x1654ae6b,
};

const MKV_TAG_FIELD = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', 'ALBUM ARTIST': 'albumArtist',
  ALBUMARTIST: 'albumArtist', PART_NUMBER: 'track', DISC: 'disc', DATE: 'year',
  DATE_RELEASED: 'year', DATE_RELEASE: 'year', GENRE: 'genre', COMPOSER: 'composer',
};

/** EBML variable-length integer. Element ids keep their marker bit, sizes don't. */
function vint(b, p, keepMarker) {
  const first = b[p];
  if (first === undefined || first === 0) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 8 || p + len > b.length) return null;
  let value = keepMarker ? first : (first & (mask - 1));
  let unknown = keepMarker ? false : (first & (mask - 1)) === (mask - 1);
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[p + i];
    if (!keepMarker && b[p + i] !== 0xff) unknown = false;
  }
  return { value, len, unknown };
}

const ebmlUint = (b, from, to) => { let v = 0; for (let i = from; i < to; i++) v = v * 256 + b[i]; return v; };
const ebmlFloat = (b, from, to) => {
  const dv = new DataView(b.buffer, b.byteOffset + from, to - from);
  return to - from === 4 ? dv.getFloat32(0) : to - from === 8 ? dv.getFloat64(0) : 0;
};
const ebmlText = (b, from, to) => trimNul(utf8.decode(b.subarray(from, to)));

/**
 * Walks the EBML tree far enough to find Info, Tags and the cover attachment.
 * Clusters — the actual audio, and all of the file's weight — are stepped over
 * without being read.
 */
function walkEBML(b, out, from, to, ctx, depth = 0) {
  if (depth > 6) return;
  let p = from;
  while (p < to) {
    const id = vint(b, p, true);
    if (!id) return;
    const size = vint(b, p + id.len, false);
    if (!size) return;
    const body = p + id.len + size.len;
    const end = size.unknown ? to : Math.min(to, body + size.value);
    if (end <= body && !size.unknown) { p = body; continue; }

    switch (id.value) {
      case MKV.SEGMENT: case MKV.INFO: case MKV.TAGS: case MKV.TAG:
      case MKV.ATTACHMENTS: case MKV.FILE:
        walkEBML(b, out, body, end, ctx, depth + 1);
        break;
      case MKV.SIMPLE: {
        const tag = { name: '', value: '' };
        walkEBML(b, out, body, end, tag, depth + 1);
        const field = MKV_TAG_FIELD[tag.name.toUpperCase()];
        if (field && tag.value && !out[field]) out[field] = tag.value;
        break;
      }
      case MKV.TAG_NAME: if (ctx) ctx.name = ebmlText(b, body, end); break;
      case MKV.TAG_STRING: if (ctx) ctx.value = ebmlText(b, body, end); break;
      case MKV.TIMESCALE: if (ctx) ctx.scale = ebmlUint(b, body, end) || 1000000; break;
      case MKV.DURATION: if (ctx) ctx.duration = ebmlFloat(b, body, end); break;
      // The segment title is the file's name for itself; a TITLE tag is the
      // track's, and wins. Held aside until the tag list has had its say.
      case MKV.TITLE: if (ctx && !ctx.segmentTitle) ctx.segmentTitle = ebmlText(b, body, end); break;
      case MKV.FILE_MIME: if (ctx) ctx.mime = ebmlText(b, body, end); break;
      case MKV.FILE_DATA:
        if (!out.picture && end - body > 0 && end - body < MAX_IMAGE) {
          const data = b.subarray(body, end);
          const mime = ctx && ctx.mime && ctx.mime.startsWith('image/') ? ctx.mime : mimeOf(data);
          if (mime.startsWith('image/')) out.picture = new Blob([data.slice()], { type: mime });
        }
        break;
      case MKV.CLUSTER: case MKV.SEEKHEAD: case MKV.TRACKS: break;   // nothing for us in here
      default: break;
    }
    if (size.unknown) return;
    p = end;
  }
}

/** Matroska and WebM — same container, and the one people forget carries tags. */
async function readMatroska(reader, out) {
  const head = await reader.at(0, 4);
  if (head.length < 4 || u32(head, 0) !== 0x1a45dfa3) return false;
  // Tags and attachments live before the clusters in every muxer worth the
  // name; 2 MB covers a front cover without dragging in the audio.
  const b = await reader.at(0, Math.min(reader.size, 2 << 20));
  const ctx = { scale: 1000000, duration: 0, segmentTitle: '' };
  walkEBML(b, out, 0, b.length, ctx);
  if (ctx.duration > 0 && !out.duration) out.duration = (ctx.duration * ctx.scale) / 1e9;
  if (ctx.segmentTitle && !out.title) out.title = ctx.segmentTitle;
  return true;
}

/* ------------------------------------------------------------------ sniffing */

/**
 * What a file *is*, when its name refuses to say. Extensions are a hint, not a
 * fact — a container renamed to `.audio` still starts with its magic number.
 */
async function sniff(reader) {
  const b = await reader.at(0, 16);
  if (b.length < 8) return '';
  const tag4 = ascii(b, 0, 4);
  if (tag4 === 'fLaC') return 'flac';
  if (tag4 === 'OggS') return 'ogg';
  if (tag4 === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wav';
  if (tag4 === 'FORM' && ascii(b, 8, 4).startsWith('AIF')) return 'aiff';
  if (tag4 === 'caff') return 'caf';
  if (u32(b, 0) === 0x1a45dfa3) return 'mkv';
  if (ascii(b, 4, 4) === 'ftyp') return 'mp4';
  if (tag4.startsWith('ID3')) return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
  return '';
}

/* ------------------------------------------------------------------ fallback */

const ID3_GENRES = ['Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop','Jazz','Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock','Techno','Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack','Euro-Techno','Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance','Classical','Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise','Alt. Rock','Bass','Soul','Punk','Space','Meditative','Instrumental Pop','Instrumental Rock','Ethnic','Gothic','Darkwave','Techno-Industrial','Electronic','Pop-Folk','Eurodance','Dream','Southern Rock','Comedy','Cult','Gangsta Rap','Top 40','Christian Rap','Pop/Funk','Jungle','Native American','Cabaret','New Wave','Psychedelic','Rave','Showtunes','Trailer','Lo-Fi','Tribal','Acid Punk','Acid Jazz','Polka','Retro','Musical','Rock & Roll','Hard Rock'];

/**
 * Last resort: read the shape of the path. "Artist/Album/03 Title.mp3" is a
 * near-universal convention, so even untagged rips come out usable.
 */
export function fromPath(path, name) {
  const out = {};
  const parts = String(path || '').split('/').filter(Boolean);
  const file = (name || parts[parts.length - 1] || '').replace(/\.[^.]+$/, '');
  let title = file.replace(/_/g, ' ').trim();

  const numbered = title.match(/^(\d{1,3})\s*[-._)\]]?\s+(.*)$/);
  if (numbered && numbered[2]) { out.track = String(parseInt(numbered[1], 10)); title = numbered[2].trim(); }

  const dashed = title.split(/\s+-\s+/);
  if (dashed.length >= 2) { out.artist = dashed[0].trim(); title = dashed.slice(1).join(' - ').trim(); }

  out.title = title || file || 'Unknown';
  if (parts.length >= 2) out.album = parts[parts.length - 2];
  if (parts.length >= 3 && !out.artist) out.artist = parts[parts.length - 3];
  return out;
}

/* ------------------------------------------------------------------ entry */

/** Which parser owns which suffix. Anything missing here gets sniffed. */
const FAMILY = {
  flac: 'flac',
  ogg: 'ogg', oga: 'ogg', opus: 'ogg', spx: 'ogg',
  wav: 'wav', wave: 'wav',
  aiff: 'aiff', aif: 'aiff', aifc: 'aiff',
  webm: 'mkv', weba: 'mkv', mka: 'mkv', mkv: 'mkv',
  m4a: 'mp4', m4b: 'mp4', m4r: 'mp4', m4p: 'mp4', mp4: 'mp4', aac: 'mp4', '3gp': 'mp4', '3g2': 'mp4',
  mp3: 'mp3', mp2: 'mp3', mpga: 'mp3', mpeg: 'mp3',
};

/** Reads whatever the container offers. Never throws — bad files just degrade. */
export async function readTags(blob, path, name) {
  const out = {};
  const reader = new Reader(blob);
  const n = name || '';
  const suffix = n.slice(n.lastIndexOf('.') + 1).toLowerCase();
  let kind = FAMILY[suffix] || '';

  try {
    // An unfamiliar suffix is not a dead end: ask the bytes instead.
    if (!kind) kind = await sniff(reader);

    if (kind === 'flac') {
      await readFLAC(reader, out);
    } else if (kind === 'ogg') {
      await readOgg(reader, out);
    } else if (kind === 'wav') {
      await readWAV(reader, out);
    } else if (kind === 'aiff') {
      await readAIFF(reader, out);
    } else if (kind === 'mkv') {
      await readMatroska(reader, out);
    } else if (kind === 'mp4') {
      if (!(await readMP4(reader, out))) await readID3v2(reader, out);
    } else {
      const after = await readID3v2(reader, out);
      if (!out.title) await readID3v1(reader, out);
      if (!out.duration) await mp3Duration(reader, after, out);
    }
  } catch { /* corrupt tags shouldn't cost us the track */ }

  // Fill the gaps from the path, never overwriting a real tag. What had to be
  // guessed is recorded: a folder called "Unsorted" is not an artist, and the
  // library needs to know the difference when it decides which albums are the
  // same album.
  const guess = fromPath(path, name);
  const guessed = [];
  for (const k in guess) if (!out[k]) { out[k] = guess[k]; guessed.push(k); }
  if (guessed.length) out.guessed = guessed.join(' ');

  if (!out.duration && out.lengthMs) {
    const ms = parseInt(out.lengthMs, 10);
    if (ms > 0) out.duration = ms / 1000;
  }
  delete out.lengthMs;
  return out;
}
