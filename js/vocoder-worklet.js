/* vocoder-worklet.js — pitch without tempo, the expensive way.
 *
 * `pitch-worklet.js` next door is a two-tap delay line with overlapping
 * windows, and it is the right tool for what it does: a semitone or two of
 * correction, no latency worth the name, one multiply-add per tap per sample.
 * Past about seven semitones its own comment is honest about what happens —
 * "a large shift on a sustained note will warble" — and it does, because two
 * decorrelated copies of the same sustained note crossfaded against each other
 * is a chorus effect with a schedule.
 *
 * This is the other way. A short-time Fourier transform, one frame at a time:
 * work out what frequency each bin *actually* holds by looking at how its phase
 * moved since the last frame, advance that phase by the stretch factor, and
 * add the frames back up further apart than they were taken. That gives a
 * longer signal at the same pitch; reading it back at the same factor gives
 * the original length at a different pitch. Because the phase is advanced
 * rather than re-used, partials stay coherent across frames, and a sustained
 * note stays a note.
 *
 * WHAT IT COSTS, said plainly because the setting that turns it on says it too:
 *   — latency. One frame plus a hop, which is 2048 + 512 samples: about 53 ms
 *     at 48 kHz, against roughly 4 ms for the delay line.
 *   — arithmetic. Two 2048-point real FFTs per hop per channel, so about
 *     190 FFTs a second at 48 kHz for a stereo file, against nothing.
 * On anything made in the last decade that is a few per cent of one core. On
 * something older it is not, which is why this is a choice and not a default.
 *
 * Everything is allocated in the constructor. `process` does arithmetic and
 * nothing else — no `new`, no closures, no growth — because it runs on the
 * audio thread and a collection there is a click.
 */

const N = 2048;                   // frame size
const HOP = N / 4;                // 75% overlap: standard for a Hann window
const BINS = N / 2 + 1;
const TWO_PI = Math.PI * 2;

/* A Hann window, applied on the way in and again on the way out.
 *
 * Overlap-adding w² frames spaced `hop` apart sums to Σw² / hop, and for Hann
 * Σw² is 3N/8. At the analysis hop of N/4 that is the familiar 1.5 — but the
 * synthesis hop is the analysis hop times the stretch, so the constant is only
 * a constant at unity. Dividing by 1.5 regardless cost 3 dB at +7 semitones and
 * gained about the same going down, which made the two shifters impossible to
 * compare: louder wins, which is the whole reason the level match next door
 * exists. So the normalisation follows the hop. */
const WIN = new Float32Array(N);
for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / N);
const WIN_SQ_SUM = 0.375 * N;     // Σ w² over one Hann window

/* Bit-reversal permutation and twiddles, computed once for the whole module
   rather than per instance: they depend only on N. */
const REV = new Uint16Array(N);
for (let i = 0, j = 0; i < N; i++) {
  REV[i] = j;
  let bit = N >> 1;
  for (; j & bit; bit >>= 1) j ^= bit;
  j ^= bit;
}
const COS = new Float32Array(N / 2);
const SIN = new Float32Array(N / 2);
for (let i = 0; i < N / 2; i++) {
  COS[i] = Math.cos(-TWO_PI * i / N);
  SIN[i] = Math.sin(-TWO_PI * i / N);
}

/** In-place iterative radix-2 complex FFT. `inverse` conjugates and scales. */
function fft(re, im, inverse) {
  for (let i = 0; i < N; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const step = N / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = COS[t];
        const wi = inverse ? -SIN[t] : SIN[t];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr;        im[a] += xi;
      }
    }
  }
  if (inverse) {
    const s = 1 / N;
    for (let i = 0; i < N; i++) { re[i] *= s; im[i] *= s; }
  }
}

/** One channel's worth of state. Nothing here is allocated after construction. */
class Channel {
  constructor() {
    this.inBuf = new Float32Array(N * 4);
    this.inWrite = 0;
    this.inFill = 0;

    /* The stretched signal, written by overlap-add and read by the resampler.
       Both positions are absolute sample counts rather than ring offsets, and
       masked only when indexing: comparing two ring offsets to decide whether
       the reader has caught the writer is the classic way to get this wrong,
       and a count that grows is exact for five thousand years at 48 kHz. */
    this.outBuf = new Float32Array(N * 8);
    this.outWrite = 0;            // absolute sample index of the next frame
    this.readPos = 0;             // absolute fractional read head
    this.primed = false;          // has enough been written to start reading

    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
    this.lastPhase = new Float32Array(BINS);
    this.sumPhase = new Float32Array(BINS);
    this.frame = new Float32Array(N);
  }

  reset() {
    this.inBuf.fill(0); this.outBuf.fill(0);
    this.inWrite = 0; this.inFill = 0;
    this.outWrite = 0; this.readPos = 0; this.primed = false;
    this.lastPhase.fill(0); this.sumPhase.fill(0);
  }

  /**
   * Analyses one frame and overlap-adds it back at `synHop` samples on.
   *
   * The whole vocoder is in the middle of this: the phase difference between
   * this frame and the last, minus the phase the bin's centre frequency would
   * have advanced by on its own, wrapped to ±π, is how far the partial in that
   * bin is from the bin's centre. That gives its true frequency, and the true
   * frequency scaled by the stretch is what the output phase advances by.
   */
  step(readAt, synHop) {
    const { re, im, lastPhase, sumPhase } = this;
    const mask = this.inBuf.length - 1;
    for (let i = 0; i < N; i++) {
      re[i] = this.inBuf[(readAt + i) & mask] * WIN[i];
      im[i] = 0;
    }
    fft(re, im, false);

    const expected = TWO_PI * HOP / N;
    const scale = synHop / HOP;
    for (let k = 0; k < BINS; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const phase = Math.atan2(im[k], re[k]);

      let delta = phase - lastPhase[k] - k * expected;
      lastPhase[k] = phase;
      // Wrapped to ±π: the phase advance is only known modulo a turn, and the
      // nearest interpretation is the right one for anything that is actually
      // a partial rather than noise.
      delta -= TWO_PI * Math.round(delta / TWO_PI);

      sumPhase[k] += (k * expected + delta) * scale;
      const out = sumPhase[k];
      re[k] = mag * Math.cos(out);
      im[k] = mag * Math.sin(out);
      // Hermitian symmetry: the top half is the conjugate of the bottom, and
      // filling it keeps the inverse transform real.
      if (k > 0 && k < N / 2) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
    }
    fft(re, im, true);

    const omask = this.outBuf.length - 1;
    const norm = synHop / WIN_SQ_SUM;
    for (let i = 0; i < N; i++) {
      this.outBuf[(this.outWrite + i) & omask] += re[i] * WIN[i] * norm;
    }
    this.outWrite += synHop;
  }
}

class VocoderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: 'ratio',
      defaultValue: 1,
      minValue: 0.25,
      maxValue: 4,
      automationRate: 'k-rate',
    }];
  }

  constructor() {
    super();
    this.channels = [new Channel(), new Channel()];
    this.pending = 0;             // input samples since the last analysis frame
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'reset') {
        for (const c of this.channels) c.reset();
        this.pending = 0;
      }
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;

    const ratio = Math.max(0.25, Math.min(4, params.ratio ? params.ratio[0] : 1));
    const synHop = Math.max(1, Math.round(HOP * ratio));
    const n = output[0].length;
    const chans = Math.min(output.length, this.channels.length);

    /* In. Every channel is written first, because the analysis below steps all
       of them at the same instants — a vocoder that framed the two channels at
       different times would move the stereo image around. */
    for (let c = 0; c < chans; c++) {
      const ch = this.channels[c];
      const src = input && input[Math.min(c, input.length - 1)];
      const mask = ch.inBuf.length - 1;
      for (let i = 0; i < n; i++) ch.inBuf[(ch.inWrite + i) & mask] = src ? src[i] : 0;
      ch.inWrite = (ch.inWrite + n) & mask;
      ch.inFill += n;
    }

    /* Analyse whatever whole hops have arrived. One frame per 512 samples of
       input, so a 128-sample block produces one every fourth call — the loop
       is for the blocks just after a reset, not for the steady state. */
    this.pending += n;
    while (this.pending >= HOP && this.channels[0].inFill >= N + HOP) {
      this.pending -= HOP;
      for (let c = 0; c < chans; c++) {
        const ch = this.channels[c];
        const mask = ch.inBuf.length - 1;
        // The frame ending `pending` samples before the write head: everything
        // after that has arrived since this frame was due.
        ch.step((ch.inWrite - N - this.pending) & mask, synHop);
      }
    }

    /* Out. The stretched buffer read back at `ratio` samples per sample, which
       undoes the stretch in time and leaves the shift in pitch. Linear
       interpolation between neighbours: the material has already been through
       an FFT and back, and a higher-order kernel here would be polishing one
       facet of a rougher stone. */
    for (let c = 0; c < chans; c++) {
      const ch = this.channels[c];
      const omask = ch.outBuf.length - 1;
      const dst = output[c];
      /* Nothing to read yet. A sample at position x is only finished once
         overlap-add has passed x + N, so the read head trails the write head
         by a frame — which is where the vocoder's latency comes from and why
         the setting that turns it on says so out loud. */
      if (!ch.primed) {
        if (ch.outWrite < N * 2) { dst.fill(0); continue; }
        ch.primed = true;
        ch.readPos = ch.outWrite - N * 2;
      }
      for (let i = 0; i < n; i++) {
        const p = ch.readPos;
        const i0 = Math.floor(p);
        const f = p - i0;
        const a = ch.outBuf[i0 & omask];
        const b = ch.outBuf[(i0 + 1) & omask];
        dst[i] = a + (b - a) * f;
        /* Cleared behind the read head. Overlap-add *adds* into this buffer,
           so a frame left in place would be added to again on the next lap
           round and the output would grow without bound. Two samples back, so
           the interpolator never reads a slot this has just zeroed. */
        ch.outBuf[(i0 - 2) & omask] = 0;
        ch.readPos = p + ratio;
      }
    }
    // Any channels beyond the two this keeps state for get silence rather than
    // whatever was in the buffer.
    for (let c = chans; c < output.length; c++) output[c].fill(0);
    return true;
  }
}

registerProcessor('pitch-vocoder', VocoderProcessor);
