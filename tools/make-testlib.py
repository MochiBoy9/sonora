#!/usr/bin/env python3
"""Builds a synthetic music library for testing Sonora.

Writes real containers with real tags so the metadata reader is exercised for
each format it claims to support:

  FLAC  — STREAMINFO + VORBIS_COMMENT + PICTURE, CONSTANT subframes (decodes)
  MP3   — ID3v2.3 with APIC, Xing header, zero-payload Layer III frames (decodes)
  WAV   — RIFF LIST/INFO tags, an actual sine tone (decodes)
  M4A   — ftyp/moov with an iTunes ilst including covr (tags only)
  OGG   — Vorbis identification + comment headers (tags only)

Usage: python3 tools/make-testlib.py <output-dir>
"""

import math
import os
import struct
import sys
import zlib

# --------------------------------------------------------------------- PNG

def png(width, height, pixel):
    """Minimal PNG encoder. `pixel(x, y) -> (r, g, b)`."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)                                   # filter: none
        for x in range(width):
            raw.extend(pixel(x, y))

    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 6))
            + chunk(b'IEND', b''))


def cover(seed, size=320):
    """A deterministic two-tone gradient with a soft disc, as stand-in art."""
    h = (seed * 47) % 360
    def hsl(hh, s, l):
        c = (1 - abs(2 * l - 1)) * s
        x = c * (1 - abs(((hh / 60.0) % 2) - 1))
        m = l - c / 2
        r, g, b = [(c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)][int(hh / 60) % 6]
        return (int((r + m) * 255), int((g + m) * 255), int((b + m) * 255))

    a = hsl(h, 0.62, 0.52)
    b = hsl((h + 48) % 360, 0.55, 0.22)

    def pixel(x, y):
        t = (x + y) / (2.0 * size)
        r = int(a[0] * (1 - t) + b[0] * t)
        g = int(a[1] * (1 - t) + b[1] * t)
        bl = int(a[2] * (1 - t) + b[2] * t)
        dx, dy = x - size * 0.5, y - size * 0.42
        d = math.hypot(dx, dy) / (size * 0.30)
        if d < 1.0:
            k = (1.0 - d) ** 2 * 0.55
            r = int(r + (255 - r) * k)
            g = int(g + (255 - g) * k)
            bl = int(bl + (255 - bl) * k)
        return (min(255, r), min(255, g), min(255, bl))

    return png(size, size, pixel)


# --------------------------------------------------------------------- FLAC

def crc8(data):
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xff if crc & 0x80 else (crc << 1) & 0xff
    return crc


def crc16(data):
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x8005) & 0xffff if crc & 0x8000 else (crc << 1) & 0xffff
    return crc


def flac_file(tags, art, seconds, rate=44100):
    block = 4096
    total = int(seconds * rate)
    frames = (total + block - 1) // block
    total = frames * block

    streaminfo = bytearray()
    streaminfo += struct.pack('>HH', block, block)      # min/max block size
    streaminfo += b'\x00\x00\x00' * 2                   # min/max frame size: unknown
    # 20 bits rate, 3 bits (channels-1), 5 bits (bps-1), 36 bits total samples
    packed = (rate << 44) | (0 << 41) | (15 << 36) | total
    streaminfo += packed.to_bytes(8, 'big')
    streaminfo += b'\x00' * 16                          # MD5: not computed

    def meta(kind, data, last=False):
        return bytes([kind | (0x80 if last else 0)]) + len(data).to_bytes(3, 'big') + data

    vendor = b'sonora-testgen'
    comments = [f'{k}={v}'.encode('utf-8') for k, v in tags.items()]
    vc = struct.pack('<I', len(vendor)) + vendor + struct.pack('<I', len(comments))
    for c in comments:
        vc += struct.pack('<I', len(c)) + c

    pic = struct.pack('>I', 3)                          # front cover
    pic += struct.pack('>I', len(b'image/png')) + b'image/png'
    pic += struct.pack('>I', 0)                         # empty description
    pic += struct.pack('>IIII', 320, 320, 24, 0)
    pic += struct.pack('>I', len(art)) + art

    out = bytearray(b'fLaC')
    out += meta(0, bytes(streaminfo))
    out += meta(4, vc)
    out += meta(6, pic, last=True)

    # Audio: one CONSTANT subframe per frame — valid FLAC for digital silence.
    for n in range(frames):
        head = bytearray(b'\xff\xf8')                   # sync + fixed blocksize
        head += bytes([0xc0 | 0x09])                    # blocksize 4096, rate 44.1k
        head += bytes([0x08])                           # mono, 16-bit
        head += utf8_number(n)
        head.append(crc8(bytes(head)))
        body = bytearray(head)
        body += b'\x00'                                 # CONSTANT subframe header
        body += b'\x00\x00'                             # constant sample = 0
        body += struct.pack('>H', crc16(bytes(body)))
        out += body
    return bytes(out)


def utf8_number(n):
    """FLAC's UTF-8-alike coding for frame numbers."""
    if n < 0x80:
        return bytes([n])
    if n < 0x800:
        return bytes([0xc0 | (n >> 6), 0x80 | (n & 0x3f)])
    if n < 0x10000:
        return bytes([0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)])
    return bytes([0xf0 | (n >> 18), 0x80 | ((n >> 12) & 0x3f),
                  0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)])


# --------------------------------------------------------------------- MP3

def syncsafe(n):
    return bytes([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])


def id3v23(tags, art):
    frames = bytearray()

    def text(fid, value):
        payload = b'\x00' + value.encode('latin-1', 'replace')
        return fid + struct.pack('>I', len(payload)) + b'\x00\x00' + payload

    for fid, value in tags.items():
        frames += text(fid.encode(), value)

    if art:
        payload = b'\x00' + b'image/png\x00' + b'\x03' + b'\x00' + art
        frames += b'APIC' + struct.pack('>I', len(payload)) + b'\x00\x00' + payload

    frames += b'\x00' * 512                             # padding, as real files have
    return b'ID3\x03\x00\x00' + syncsafe(len(frames)) + bytes(frames)


def mp3_file(tags, art, seconds):
    """MPEG-1 Layer III, 64 kbps mono: valid headers, zeroed data → silence."""
    rate, bitrate, samples_per_frame = 44100, 64000, 1152
    frame_len = (144 * bitrate) // rate                 # 208 bytes
    count = max(1, int(seconds * rate / samples_per_frame))

    header = bytes([0xff, 0xfb, 0x50, 0xc4])            # 64 kbps, 44.1 kHz, mono
    side_info = 17                                      # MPEG-1 mono

    # First frame carries the Xing header so players know the exact length.
    xing = bytearray(header) + b'\x00' * side_info
    xing += b'Xing' + struct.pack('>I', 0x01) + struct.pack('>I', count)
    xing += b'\x00' * (frame_len - len(xing))

    silent = header + b'\x00' * (frame_len - 4)
    return id3v23(tags, art) + bytes(xing) + silent * (count - 1)


# --------------------------------------------------------------------- WAV

def wav_file(tags, seconds, rate=22050, freq=220.0):
    n = int(seconds * rate)
    pcm = bytearray()
    for i in range(n):
        # A quiet tone with a slow tremolo, so the analyser has something to show.
        env = 0.22 * (0.6 + 0.4 * math.sin(2 * math.pi * 0.4 * i / rate))
        pcm += struct.pack('<h', int(32767 * env * math.sin(2 * math.pi * freq * i / rate)))

    info = bytearray(b'INFO')
    for key, value in tags.items():
        data = value.encode('latin-1', 'replace') + b'\x00'
        if len(data) % 2:
            data += b'\x00'
        info += key.encode() + struct.pack('<I', len(data)) + data

    fmt = struct.pack('<HHIIHH', 1, 1, rate, rate * 2, 2, 16)
    chunks = (b'fmt ' + struct.pack('<I', len(fmt)) + fmt
              + b'LIST' + struct.pack('<I', len(info)) + bytes(info)
              + b'data' + struct.pack('<I', len(pcm)) + bytes(pcm))
    return b'RIFF' + struct.pack('<I', 4 + len(chunks)) + b'WAVE' + chunks


# --------------------------------------------------------------------- MP4

def atom(kind, payload):
    return struct.pack('>I', len(payload) + 8) + kind + payload


def ilst_text(kind, value):
    data = atom(b'data', struct.pack('>II', 1, 0) + value.encode('utf-8'))
    return atom(kind, data)


def m4a_file(tags, art, seconds, timescale=1000):
    items = b''.join([
        ilst_text(b'\xa9nam', tags['title']),
        ilst_text(b'\xa9ART', tags['artist']),
        ilst_text(b'\xa9alb', tags['album']),
        ilst_text(b'aART', tags['albumartist']),
        ilst_text(b'\xa9day', tags['year']),
        ilst_text(b'\xa9gen', tags['genre']),
        atom(b'trkn', atom(b'data', struct.pack('>II', 0, 0) +
                           struct.pack('>HHHH', 0, int(tags['track']), int(tags['total']), 0))),
        atom(b'covr', atom(b'data', struct.pack('>II', 14, 0) + art)),
    ])
    meta = atom(b'meta', b'\x00\x00\x00\x00'
                + atom(b'hdlr', b'\x00' * 8 + b'mdirappl' + b'\x00' * 9)
                + atom(b'ilst', items))
    mvhd = atom(b'mvhd', struct.pack('>BBBBIIII', 0, 0, 0, 0, 0, 0, timescale,
                                     int(seconds * timescale))
                + b'\x00' * 80)
    moov = atom(b'moov', mvhd + atom(b'udta', meta))
    ftyp = atom(b'ftyp', b'M4A ' + struct.pack('>I', 512) + b'M4A isomiso2')
    return ftyp + moov + atom(b'mdat', b'\x00' * 2048)


# --------------------------------------------------------------------- OGG

def ogg_page(serial, seq, granule, packet, first=False, last=False):
    segments = []
    remaining = len(packet)
    while remaining >= 255:
        segments.append(255)
        remaining -= 255
    segments.append(remaining)

    flags = (0x02 if first else 0) | (0x04 if last else 0)
    header = (b'OggS' + bytes([0, flags]) + struct.pack('<q', granule)
              + struct.pack('<III', serial, seq, 0) + bytes([len(segments)]) + bytes(segments))
    page = bytearray(header + packet)

    crc = 0
    for byte in page:                                   # Ogg's CRC-32, poly 0x04c11db7
        crc ^= byte << 24
        crc &= 0xffffffff
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04c11db7) & 0xffffffff if crc & 0x80000000 else (crc << 1) & 0xffffffff
    page[22:26] = struct.pack('<I', crc)
    return bytes(page)


def ogg_file(tags, seconds, rate=44100):
    ident = (b'\x01vorbis' + struct.pack('<I', 0) + bytes([1]) + struct.pack('<I', rate)
             + struct.pack('<iii', 0, 128000, 0) + bytes([0xb8, 0x01]))

    vendor = b'sonora-testgen'
    comments = [f'{k}={v}'.encode('utf-8') for k, v in tags.items()]
    body = struct.pack('<I', len(vendor)) + vendor + struct.pack('<I', len(comments))
    for c in comments:
        body += struct.pack('<I', len(c)) + c
    comment = b'\x03vorbis' + body + b'\x01'
    setup = b'\x05vorbis' + b'\x00' * 64

    return (ogg_page(1, 0, 0, ident, first=True)
            + ogg_page(1, 1, 0, comment)
            + ogg_page(1, 2, int(seconds * rate), setup, last=True))


# --------------------------------------------------------------------- library

ALBUMS = [
    ('Nova Kestrel',     'Paper Lanterns',     2021, 'Dream Pop',   'flac',
     ['Harbour Lights', 'Paper Lanterns', 'Slow Weather', 'Cassette Sun', 'Midnight Ferry']),
    ('Nova Kestrel',     'Second Daylight',    2024, 'Dream Pop',   'flac',
     ['Second Daylight', 'Glass Corridor', 'Static Bloom', 'Long Way Around']),
    ('The Meridian Set', 'Hollow Season',      2019, 'Indie Rock',  'mp3',
     ['Hollow Season', 'Trellis', 'Bright Antenna', 'Copper Wire', 'Tidewater', 'Low Ceiling']),
    ('The Meridian Set', 'Field Recordings',   2022, 'Indie Rock',  'mp3',
     ['Marginalia', 'Field Recording No. 4', 'Almost Autumn', 'Understory']),
    ('Ambrose Vale',     'Quiet Machines',     2020, 'Ambient',     'wav',
     ['Quiet Machines', 'Iron Garden', 'Blue Hour', 'Fathom']),
    ('Ambrose Vale',     'Tessellate',         2023, 'Ambient',     'wav',
     ['Tessellate', 'Interior Weather', 'Small Hours']),
    ('Juniper Ash',      'Salt & Ember',       2018, 'Folk',        'm4a',
     ['Salt & Ember', 'Cartwheel', 'The Long Field', 'Winterlight', 'Ferryman']),
    ('Juniper Ash',      'Hearthlight',        2025, 'Folk',        'm4a',
     ['Hearthlight', 'Two Rivers', 'Ash Wednesday']),
    ('Cobalt Harbour',   'Signal Drift',       2022, 'Electronic',  'ogg',
     ['Signal Drift', 'Nightbus', 'Refraction', 'Undertow', 'Terminal Blue']),
    ('Cobalt Harbour',   'Analogue Weekend',   2024, 'Electronic',  'ogg',
     ['Analogue Weekend', 'Sunday Static', 'Neon Rain']),
]


def safe(name):
    return ''.join(c for c in name if c not in '/\\:*?"<>|').strip()


def bulk(root, count):
    """A large library of tiny WAVs, for measuring import and scroll cost."""
    os.makedirs(root, exist_ok=True)
    words = ['Amber', 'Harbour', 'Static', 'Vellum', 'Ceramic', 'Winter', 'Paper', 'Iron',
             'Marble', 'Hollow', 'Signal', 'Copper', 'Velvet', 'Meadow', 'Lantern', 'Quiet']
    per_album = 10
    albums = (count + per_album - 1) // per_album
    written = 0
    for a in range(albums):
        artist = f'{words[a % len(words)]} {words[(a // len(words) + 3) % len(words)]}'
        album = f'{words[(a * 5 + 1) % len(words)]} {words[(a * 3 + 7) % len(words)]} {2000 + a % 26}'
        folder = os.path.join(root, safe(artist), safe(album))
        os.makedirs(folder, exist_ok=True)
        for n in range(1, per_album + 1):
            if written >= count:
                break
            title = f'{words[(a + n) % len(words)]} {words[(a * 2 + n * 3) % len(words)]}'
            data = wav_file({
                'INAM': title, 'IART': artist, 'IPRD': album,
                'ICRD': str(2000 + a % 26), 'IGNR': 'Test', 'ITRK': str(n),
            }, 0.12, rate=8000, freq=200 + n * 10)
            with open(os.path.join(folder, f'{n:02d} {safe(title)}.wav'), 'wb') as fh:
                fh.write(data)
            written += 1
    print(f'{written} files across {albums} albums in {root}')


def main():
    if len(sys.argv) > 2 and sys.argv[2].startswith('--bulk'):
        return bulk(sys.argv[1], int(sys.argv[3]) if len(sys.argv) > 3 else 3000)

    root = sys.argv[1] if len(sys.argv) > 1 else 'testlib'
    os.makedirs(root, exist_ok=True)
    written = 0

    for index, (artist, album, year, genre, fmt, titles) in enumerate(ALBUMS):
        art = cover(index * 7 + 3)
        folder = os.path.join(root, safe(artist), safe(album))
        os.makedirs(folder, exist_ok=True)

        for n, title in enumerate(titles, start=1):
            seconds = 26 + ((n * 13 + index * 7) % 40)
            base = f'{n:02d} {safe(title)}'

            if fmt == 'flac':
                data = flac_file({
                    'TITLE': title, 'ARTIST': artist, 'ALBUM': album, 'ALBUMARTIST': artist,
                    'DATE': str(year), 'GENRE': genre, 'TRACKNUMBER': str(n),
                }, art, seconds)
                path = os.path.join(folder, base + '.flac')

            elif fmt == 'mp3':
                data = mp3_file({
                    'TIT2': title, 'TPE1': artist, 'TALB': album, 'TPE2': artist,
                    'TYER': str(year), 'TCON': genre, 'TRCK': f'{n}/{len(titles)}',
                }, art, seconds)
                path = os.path.join(folder, base + '.mp3')

            elif fmt == 'wav':
                data = wav_file({
                    'INAM': title, 'IART': artist, 'IPRD': album,
                    'ICRD': str(year), 'IGNR': genre, 'ITRK': str(n),
                }, seconds, freq=180 + n * 40 + index * 15)
                path = os.path.join(folder, base + '.wav')

            elif fmt == 'm4a':
                data = m4a_file({
                    'title': title, 'artist': artist, 'album': album, 'albumartist': artist,
                    'year': str(year), 'genre': genre, 'track': n, 'total': len(titles),
                }, art, seconds)
                path = os.path.join(folder, base + '.m4a')

            else:
                data = ogg_file({
                    'TITLE': title, 'ARTIST': artist, 'ALBUM': album, 'ALBUMARTIST': artist,
                    'DATE': str(year), 'GENRE': genre, 'TRACKNUMBER': str(n),
                }, seconds)
                path = os.path.join(folder, base + '.ogg')

            with open(path, 'wb') as fh:
                fh.write(data)
            written += 1

    total = sum(os.path.getsize(os.path.join(dp, f))
                for dp, _, fs in os.walk(root) for f in fs)
    print(f'{written} files across {len(ALBUMS)} albums in {root} ({total / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
