// Runs on the audio thread. Input is a 2-channel stream at 16 kHz
// (channel 0 = mic, channel 1 = computer audio). We convert each 128-frame
// block to interleaved 16-bit PCM, batch ~100 ms, and post it to the page
// along with a loudness level per channel for the meters.

class PcmInterleaver extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batchFrames = Math.round(sampleRate / 10);
    this.buf = new Int16Array(this.batchFrames * 2);
    this.filled = 0;
    this.sumSq = [0, 0];
  }

  process(inputs) {
    const input = inputs[0];
    const mic = input[0];
    const sys = input[1] ?? null;
    if (!mic) return true;

    for (let i = 0; i < mic.length; i++) {
      const a = Math.max(-1, Math.min(1, mic[i]));
      const b = sys ? Math.max(-1, Math.min(1, sys[i])) : 0;
      this.sumSq[0] += a * a;
      this.sumSq[1] += b * b;
      this.buf[this.filled * 2] = a < 0 ? a * 0x8000 : a * 0x7fff;
      this.buf[this.filled * 2 + 1] = b < 0 ? b * 0x8000 : b * 0x7fff;
      this.filled++;
      if (this.filled === this.batchFrames) {
        const out = this.buf;
        this.port.postMessage(
          {
            pcm: out.buffer,
            level: [Math.sqrt(this.sumSq[0] / this.filled), Math.sqrt(this.sumSq[1] / this.filled)],
          },
          [out.buffer],
        );
        this.buf = new Int16Array(this.batchFrames * 2);
        this.filled = 0;
        this.sumSq = [0, 0];
      }
    }
    return true;
  }
}

registerProcessor('pcm-interleaver', PcmInterleaver);
