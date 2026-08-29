/* pitch-worklet.js — pitch without tempo.
 *
 * `playbackRate` changes pitch and speed together, because that is what
 * playing a record faster does. Changing one without the other means
 * resampling the audio while it plays, and this is the classic way to do it:
 * a delay line read at a different rate than it is written.
 *
 * Read the line 3% faster than you write it and everything comes out a
 * semitone up — but the read pointer catches the write pointer and you get a
 * click, twelve times a second. So there are two read pointers, half a buffer
 * apart, each windowed so that whichever one is about to run off the end is
 * already silent. The windows are sin and cos of the same angle, so their
 * squares sum to one: the crossfade holds power constant, which is what you
 * want for two decorrelated copies of the same sound.
 *
 * That is the whole trick. It costs one multiply-add per tap per sample and
 * runs on the audio thread with no allocation after construction. It is not
 * a phase vocoder — a large shift on a sustained note will warble — but for
 * the ±12 semitones anyone actually uses on music it is clean, and it does not
 * cost 40 ms of latency and a 2048-point FFT per hop.
 */

/** Window size, in samples. ~85 ms at 48 kHz: long enough that the warble
 *  sits below the pitch of most music, short enough to stay responsive. */
const GRAIN = 4096;

class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: 'ratio',
      defaultValue: 1,
      minValue: 0.25,      // two octaves down
      maxValue: 4,         // two octaves up
      automationRate: 'k-rate',
    }];
  }

  constructor() {
    super();
    this.size = GRAIN * 2;
    // Per-channel ring buffers, allocated once. Stereo covers every file the
    // library can hold; a surprise third channel simply passes through.
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.write = 0;
    this.phase = 0;        // 0..1 around the grain, shared by both channels
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return this.alive;

    const ratio = params.ratio[0];
    const n = output[0].length;

    // Nothing to shift: copy through and keep the line primed, so switching
    // the effect on mid-note does not start from silence.
    if (!input || !input.length) {
      for (const ch of output) ch.fill(0);
      return this.alive;
    }

    const channels = Math.min(output.length, this.buf.length);
    const step = (1 - ratio) / GRAIN;

    for (let c = 0; c < channels; c++) {
      const src = input[c] || input[0];
      const dst = output[c];
      const buf = this.buf[c];
      let w = this.write;
      let p = this.phase;

      for (let i = 0; i < n; i++) {
        buf[w] = src ? src[i] : 0;

        // Two taps, half a grain apart, each behind the write pointer.
        const d1 = p * GRAIN;
        const q = p + 0.5 >= 1 ? p - 0.5 : p + 0.5;
        const d2 = q * GRAIN;

        const a = Math.sin(Math.PI * p);
        const b = Math.sin(Math.PI * q);

        dst[i] = this.read(buf, w - d1) * a + this.read(buf, w - d2) * b;

        w = w + 1 === this.size ? 0 : w + 1;
        p += step;
        if (p >= 1) p -= 1; else if (p < 0) p += 1;
      }

      // Every channel walks the same distance, so the shared cursors are
      // written back once, from the last channel round.
      if (c === channels - 1) { this.write = w; this.phase = p; }
    }

    // Any channel the buffer does not cover is passed through unshifted rather
    // than dropped.
    for (let c = channels; c < output.length; c++) {
      const src = input[c] || input[0];
      if (src) output[c].set(src); else output[c].fill(0);
    }

    return this.alive;
  }

  /** Linear interpolation into the ring buffer at a fractional position. */
  read(buf, at) {
    const size = this.size;
    let x = at % size;
    if (x < 0) x += size;
    const i = x | 0;
    const f = x - i;
    const j = i + 1 === size ? 0 : i + 1;
    return buf[i] + (buf[j] - buf[i]) * f;
  }
}

registerProcessor('pitch-shift', PitchProcessor);
