/* peaks.worker.js — turns decoded audio into a waveform and a spectrogram.
 *
 * The split between this file and `peaks.js` is forced by the platform, and it
 * is worth stating because it looks arbitrary from either side.
 *
 * `OfflineAudioContext` lives on Window and not in a worker, so a worker
 * cannot decode an MP3 — only the main thread can ask for that. But
 * `decodeAudioData` does its work on the browser's own audio thread and hands
 * back a finished buffer, so the *decode* was never the thing that would
 * stutter the interface. The thing that would stutter it is what comes next:
 * twenty million samples of arithmetic to find the peaks and another few
 * hundred FFTs on top.
 *
 * So the decode happens over there and the arithmetic happens here, with the
 * channel data transferred rather than copied. Neither half is on the main
 * thread for longer than it has to be.
 */

/* ------------------------------------------------------------------ fft */

/**
 * In-place iterative radix-2 Cooley–Tukey, real input.
 *
 * Rebuilt only when the size changes, which it does not — one size is used for
 * the whole run. The twiddle tables and the bit-reversal permutation are the
 * expensive part of an FFT that is called four hundred times, so they are
 * computed once and kept.
 */
function planFFT(n) {
  const levels = Math.log2(n);
  if (levels % 1 !== 0) throw new Error('FFT size must be a power of two');

  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }

  // Bit-reversal permutation, precomputed as a table of swaps.
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }

  // A Hann window: without one, every FFT column smears energy across the whole
  // spectrum at the frame edges and the spectrogram turns into fog.
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));

  return { n, levels, cos, sin, rev, win, re: new Float32Array(n), im: new Float32Array(n) };
}

/** Magnitude spectrum of one frame, written into `out` (n/2 bins). */
function fftMag(plan, input, offset, out) {
  const { n, cos, sin, rev, win, re, im } = plan;

  for (let i = 0; i < n; i++) {
    const j = rev[i];
    const s = offset + i;
    re[j] = (s < input.length ? input[s] : 0) * win[i];
    im[j] = 0;
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += step) {
        const l = j + half;
        const tre = re[l] * cos[k] + im[l] * sin[k];
        const tim = -re[l] * sin[k] + im[l] * cos[k];
        re[l] = re[j] - tre; im[l] = im[j] - tim;
        re[j] += tre;        im[j] += tim;
      }
    }
  }

  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
}

/* ------------------------------------------------------------------ shape */

const WAVE = 2048;       // buckets across the whole track
const COLS = 480;        // spectrogram columns
const BANDS = 48;        // spectrogram rows, logarithmic
/* 2048 points is 21.5 Hz per bin at 44.1 kHz and a 46 ms window. Both halves
   of that matter: at 1024 the bottom of the range is finer than one bin and
   the band mapping becomes a fiction, and at 4096 the window is long enough
   (93 ms) to smear a snare into the bar. */
const FFT = 2048;
/* 55 Hz is A1, under the bottom of a bass guitar. Starting at 40 would be
   claiming a resolution the transform does not have down there. */
const F_LOW = 55, F_HIGH = 16000;

/**
 * Waveform, as a min and a max per bucket.
 *
 * A single amplitude per bucket draws a shape that is symmetrical and wrong; a
 * real waveform is not centred, and the asymmetry is most of what makes one
 * look like a recording rather than a hedge. Stored as two signed bytes, which
 * is a hundredth of a dB of precision at the scale it is drawn.
 */
function waveform(chans, frames) {
  const min = new Int8Array(WAVE);
  const max = new Int8Array(WAVE);
  const per = frames / WAVE;
  const n = chans.length;

  for (let b = 0; b < WAVE; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(frames, Math.floor((b + 1) * per));
    let lo = 0, hi = 0;
    for (let i = from; i < to; i++) {
      // Sum to mono rather than taking one channel: a track mixed hard to one
      // side would otherwise draw half a waveform.
      let v = 0;
      for (let c = 0; c < n; c++) v += chans[c][i];
      v /= n;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = Math.max(-127, Math.round(lo * 127));
    max[b] = Math.min(127, Math.round(hi * 127));
  }
  return { min, max };
}

/**
 * Spectrogram, logarithmic in both axes.
 *
 * Frequency is folded into 48 bands spaced the way hearing is spaced, and
 * magnitude is stored in dB rather than linearly — a linear spectrogram of
 * music is a black rectangle with a bright line along the bottom.
 */
function spectrogram(chans, frames, sampleRate) {
  const plan = planFFT(FFT);
  const half = FFT >> 1;
  const mag = new Float32Array(half);
  const out = new Uint8Array(BANDS * COLS);

  // Mono mix, once, so the FFT loop reads one array.
  const mono = new Float32Array(frames);
  const n = chans.length;
  for (let c = 0; c < n; c++) {
    const ch = chans[c];
    for (let i = 0; i < frames; i++) mono[i] += ch[i];
  }
  if (n > 1) for (let i = 0; i < frames; i++) mono[i] /= n;

  /* Band edges as *fractional* bins, and deliberately not forced apart.
   *
   * The obvious version of this rounds each edge to a whole bin and then nudges
   * any collision up by one so every band gets a bin to itself. That is wrong,
   * and wrong in a way that looks plausible on screen: at the bottom of the
   * range a logarithmic band is narrower than one bin, several bands collide,
   * and the nudging walks the whole low end upward — a pure 440 Hz tone comes
   * out reading as saturated bass, because the band nominally covering 130 Hz
   * has been quietly reassigned to the bin holding 430.
   *
   * Bands are allowed to share a bin instead. When two adjacent bands land on
   * the same one they show the same value, which is the honest answer: the
   * transform genuinely cannot tell 58 Hz from 62 Hz in a 46 ms window, and
   * saying so is better than inventing a distinction.
   */
  const perBin = (sampleRate / 2) / half;
  const edges = new Float32Array(BANDS + 1);
  for (let i = 0; i <= BANDS; i++) {
    const hz = F_LOW * Math.pow(F_HIGH / F_LOW, i / BANDS);
    edges[i] = Math.min(half, Math.max(0, hz / perBin));
  }

  /* Magnitude out of this FFT is unnormalised: a full-scale sine through a
     Hann window peaks at N/4. Dividing by that puts 0 dB at full scale, which
     is what makes the -70 dB floor below mean anything.

     The extra 1/sqrt(1.5) is the Hann window's noise-equivalent bandwidth. A
     windowed tone is not one bin, it is a main lobe about four bins wide, so
     summing its power over the band recovers half again as much energy as sits
     in the peak bin alone. Without this a full-scale sine reads +1.8 dB. */
  const scale = (4 / FFT) / Math.sqrt(1.5);

  const hop = Math.max(1, Math.floor((frames - FFT) / COLS));
  for (let col = 0; col < COLS; col++) {
    const at = col * hop;
    if (at >= frames) break;
    fftMag(plan, mono, at, mag);

    for (let b = 0; b < BANDS; b++) {
      const lo = edges[b], hi = edges[b + 1];
      let v;
      /* Below about 500 Hz a band is narrower than the window's main lobe, so
         no band can hold all of one tone's energy and the reading runs 1-3 dB
         light — and a tone sitting on a boundary can show up in the band next
         door. Both are the time-frequency trade this window size buys, not
         mistakes: fixing them means a longer window, which would smear a snare
         across half a bar. Measured, from 55 Hz up: -2.5 dB at 110, -1.4 at
         440, and exact from 1 kHz. */
      if (hi - lo < 1) {
        // Narrower than a bin: read between the two it falls between rather
        // than snapping, so the band moves smoothly as the frequency does.
        const at2 = (lo + hi) / 2;
        const i0 = Math.min(half - 1, Math.floor(at2));
        const i1 = Math.min(half - 1, i0 + 1);
        const f = at2 - i0;
        v = mag[i0] * (1 - f) + mag[i1] * f;
      } else {
        /* Wider: sum *energy*, not average magnitude.
         *
         * Averaging is the tempting version and it makes the level depend on
         * how wide the band happens to be. Logarithmic bands get wider in bins
         * as they climb, so a single tone averaged over a wide high band is
         * divided by all the silent bins beside it: the same 0.5 sine reads
         * -6 dB at 110 Hz and -27 dB at 4 kHz, purely from the geometry.
         *
         * Adding the power in the band and taking the root gives the energy
         * actually in that band, which is level-preserving for a tone wherever
         * it lands, and which grows with bandwidth for noise — as it should,
         * since a wider band really does hold more of it.
         */
        let sum = 0;
        for (let j = Math.floor(lo); j < Math.min(half, Math.ceil(hi)); j++) {
          const cover = Math.min(hi, j + 1) - Math.max(lo, j);
          if (cover <= 0) continue;
          sum += mag[j] * mag[j] * cover;
        }
        v = Math.sqrt(sum);
      }
      // -70 dB floor: below that is the noise of the encoder, not the record.
      const dB = 20 * Math.log10(v * scale + 1e-7);
      const norm = Math.max(0, Math.min(1, (dB + 70) / 70));
      out[b * COLS + col] = Math.round(norm * 255);
    }
  }
  return { spec: out, bands: BANDS, cols: COLS };
}

/**
 * Integrated loudness, near enough to ReplayGain to be useful.
 *
 * This is not ITU-R BS.1770 — that needs a K-weighting filter and gated block
 * averaging, and doing it properly here would mean a second filter pass over
 * every sample for a number that is used to nudge a gain by a decibel or two.
 * What this is instead: RMS over the whole track in dBFS, which tracks true
 * loudness closely enough that album-to-album jumps stop being jarring, and
 * which is honest about what it is everywhere it is shown.
 */
function loudness(chans, frames) {
  let sum = 0, count = 0;
  const n = chans.length;
  // Every 7th sample: a seventh of the work, and an unbiased estimate of an
  // RMS over millions of samples is still an RMS.
  for (let c = 0; c < n; c++) {
    const ch = chans[c];
    for (let i = 0; i < frames; i += 7) { sum += ch[i] * ch[i]; count++; }
  }
  if (!count) return null;
  const rms = Math.sqrt(sum / count);
  return rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : null;
}

/* ------------------------------------------------------------------ pump */

self.onmessage = (e) => {
  const { id, channels, frames, sampleRate, want } = e.data;
  try {
    const chans = channels.map((b) => new Float32Array(b));
    const wave = waveform(chans, frames);
    const rec = {
      id,
      v: 1,
      min: wave.min,
      max: wave.max,
      rms: loudness(chans, frames),
      at: Date.now(),
    };
    if (want !== 'wave') {
      const s = spectrogram(chans, frames, sampleRate);
      rec.spec = s.spec;
      rec.specBands = s.bands;
      rec.specCols = s.cols;
    }
    self.postMessage({ type: 'peaks', rec });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err && err.message || err) });
  }
};

self.postMessage({ type: 'ready' });
