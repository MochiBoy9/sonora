/* meter-worklet.js — the crest factor, measured on the audio thread.
 *
 * The listening meter used to run on a requestAnimationFrame callback, reading
 * 2048 floats out of an AnalyserNode once a frame. That works and it is honest
 * about what it is, but it is a *sample* of the signal rather than the signal:
 * frames stop in a background tab, stutter under load, and an analyser only
 * ever hands back its most recent window — everything between two frames is
 * simply never looked at. The figure it produced was therefore a peak-against-
 * RMS over a thinner and unevenly spaced subset of the track.
 *
 * A worklet sees every sample. `process` is called once per 128-frame block by
 * the audio thread itself, which does not stop because the tab is hidden and
 * does not skip because the compositor is busy. The peak is a true peak and
 * the RMS is over the whole listen, so the crest factor stops being an
 * estimate and becomes a measurement.
 *
 * It costs one pass over 128 floats per block per channel and no allocation
 * after construction. Summaries are posted about eight times a second, which
 * is often enough for a readout and rare enough that the port is not a cost.
 */

/* How many blocks between posts. At 48 kHz a block is 2.67 ms, so 48 blocks
   is about eight posts a second. */
const POST_EVERY = 48;

/* Silence is not part of the master, and counting it wrecks the figure.
 *
 * This node is connected for as long as the graph exists, so it is handed
 * blocks of nothing before the first track starts, between tracks, and while
 * the transport is paused. Those samples have no peak to contribute and a
 * great deal of zero to contribute to the mean square, which drags the RMS
 * down while the peak stays where it is — and the crest factor is the ratio of
 * the two. Measured: an 0.8 sine whose true crest factor is 3.01 dB came out
 * at 13.6 dB, because about nine tenths of what had been accumulated was
 * silence.
 *
 * So blocks below the floor are skipped entirely. This is a gate, which is the
 * same device BS.1770 uses and for the same reason. -70 dBFS is far below any
 * music and comfortably above dither, so nothing real is ever thrown away. */
const GATE = 3.16e-4;             // 10^(-70/20)

/* Blocks to ignore after a reset.
 *
 * Starting a deck mid-waveform is a discontinuity, and a discontinuity through
 * a resampler rings: the first few milliseconds of a track overshoot well past
 * anything in the music. That transient belongs to the switch, not to the
 * master, and it lands squarely on the one statistic that keeps whatever it is
 * given — the peak. Measured: a 0.8 sine read a peak of 1.008 with a perfectly
 * correct RMS of 0.5657, purely from the click at the track change.
 *
 * 75 blocks is about 200 ms at 48 kHz. Every real meter has a window like this
 * for the same reason. */
const SETTLE = 75;

class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.peak = 0;
    this.sumSq = 0;
    this.samples = 0;
    this.blocks = 0;
    this.settle = SETTLE;
    /* Phase correlation, over the post window rather than over the listen.
     *
     * The crest factor is a property of the master and is right to accumulate
     * for the whole track. Correlation is not: it is what the two channels are
     * doing *now*, and a track that is wide in the chorus and mono in the
     * verse has no meaningful whole-track figure. So these three reset at
     * every post, which makes the readout a moving eighth-of-a-second window
     * — about the integration time of a real correlation meter. */
    this.xy = 0; this.xx = 0; this.yy = 0;
    // Reset without tearing the node down and rebuilding the graph, which is
    // what a track change needs: same node, new tally.
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'reset') {
        this.peak = 0; this.sumSq = 0; this.samples = 0; this.blocks = 0;
        this.xy = 0; this.xx = 0; this.yy = 0;
        this.settle = SETTLE;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    // No input connected yet, or a silent gap between sources. Either way
    // there is nothing to measure and the node must stay alive.
    if (!input || !input.length) return true;

    // Still settling after a reset: the switch transient is not the music.
    if (this.settle > 0) { this.settle--; return true; }

    let peak = 0;
    let sum = 0;
    let n = 0;

    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      if (!ch) continue;
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v * v;
      }
      n += ch.length;
    }

    // Gated: a block quieter than the floor is silence between tracks rather
    // than a quiet passage, and it is dropped whole — both its zero peak and
    // its zero energy. See GATE above for what including it did.
    if (n && Math.sqrt(sum / n) >= GATE) {
      if (peak > this.peak) this.peak = peak;
      this.sumSq += sum;
      this.samples += n;

      /* S4. Three more sums over the same 128 floats we have already walked,
         which is the whole cost of the meter: no second tap, no second pass
         over the signal, and nothing allocated. Mono sources have one channel,
         where correlation is by definition +1 and there is nothing to
         measure. */
      if (input.length > 1 && input[0] && input[1]) {
        const L = input[0], R = input[1];
        const m = L.length < R.length ? L.length : R.length;
        for (let i = 0; i < m; i++) {
          const l = L[i], r = R[i];
          this.xy += l * r;
          this.xx += l * l;
          this.yy += r * r;
        }
      }
    }

    if (++this.blocks >= POST_EVERY) {
      this.blocks = 0;
      /* Normalised here rather than on the main thread: the three raw sums are
         about to be thrown away, and a ratio is one number instead of three.
         A denominator of zero is silence in one channel or both, where there
         is no phase relationship to report — `null` says so, which is a
         different statement from "the channels cancel". */
      const den = Math.sqrt(this.xx * this.yy);
      const corr = den > 1e-12 ? Math.max(-1, Math.min(1, this.xy / den)) : null;
      this.xy = 0; this.xx = 0; this.yy = 0;
      // Plain numbers rather than a buffer: four of them, eight times a
      // second, is not worth a transfer.
      this.port.postMessage({ peak: this.peak, sumSq: this.sumSq, samples: this.samples, corr });
    }
    // Always. Returning false lets the browser collect the node, and a meter
    // that stops measuring the moment the music goes quiet is not a meter.
    return true;
  }
}

registerProcessor('sonora-meter', MeterProcessor);
