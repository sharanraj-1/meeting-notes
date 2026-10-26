// Voice activity segmenter for on-device transcription.
//
// Whisper transcribes whole clips, not a live stream, so we cut each audio
// channel into utterances: start when the level rises above the background
// noise, end after a short pause (or at a maximum length), keep a little
// audio from just before the speech started so first syllables aren't lost.
// Silence never reaches the model, which saves CPU and avoids Whisper's
// habit of "hearing" words in silence.

class Segmenter {
  constructor({
    sampleRate = 16000,
    frameMs = 30,
    startFrames = 3, // ~90 ms of speech to open an utterance
    endSilenceMs = 700,
    minSpeechMs = 300,
    maxUtteranceMs = 20000,
    preRollMs = 240,
    minThreshold = 0.01,
  } = {}) {
    this.sampleRate = sampleRate;
    this.frameLen = Math.round((sampleRate * frameMs) / 1000);
    this.frameSec = this.frameLen / sampleRate;
    this.startFrames = startFrames;
    this.endSilenceFrames = Math.ceil(endSilenceMs / frameMs);
    this.minSpeechFrames = Math.ceil(minSpeechMs / frameMs);
    this.maxFrames = Math.floor(maxUtteranceMs / frameMs);
    this.preRollFrames = Math.ceil(preRollMs / frameMs) + startFrames;
    this.minThreshold = minThreshold;

    this.carry = new Float32Array(0);
    this.frameIndex = 0;
    this.noise = minThreshold / 2;
    this.preRoll = [];
    this.speechRun = 0;
    this.utt = null; // { frames, startFrame, speechFrames, silence, peak }
  }

  get threshold() {
    return Math.max(this.minThreshold, this.noise * 3);
  }

  // Feed samples (Float32Array, -1..1). Returns finished utterances.
  push(samples) {
    const out = [];
    let data = samples;
    if (this.carry.length) {
      data = new Float32Array(this.carry.length + samples.length);
      data.set(this.carry);
      data.set(samples, this.carry.length);
    }
    let i = 0;
    for (; i + this.frameLen <= data.length; i += this.frameLen) {
      const u = this.processFrame(data.subarray(i, i + this.frameLen));
      if (u) out.push(u);
    }
    this.carry = data.slice(i);
    return out;
  }

  processFrame(frame) {
    let sum = 0;
    for (let k = 0; k < frame.length; k++) sum += frame[k] * frame[k];
    const rms = Math.sqrt(sum / frame.length);
    const speech = rms > this.threshold;
    const index = this.frameIndex++;
    const copy = Float32Array.from(frame);

    if (!this.utt) {
      if (!speech) this.noise = this.noise * 0.98 + rms * 0.02;
      this.preRoll.push(copy);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      this.speechRun = speech ? this.speechRun + 1 : 0;
      if (this.speechRun >= this.startFrames) {
        this.utt = {
          frames: this.preRoll,
          startFrame: index - this.preRoll.length + 1,
          speechFrames: this.speechRun,
          silence: 0,
          peak: rms,
        };
        this.preRoll = [];
        this.speechRun = 0;
      }
      return null;
    }

    const u = this.utt;
    u.frames.push(copy);
    u.peak = Math.max(u.peak, rms);
    if (speech) {
      u.speechFrames++;
      u.silence = 0;
    } else {
      u.silence++;
    }
    if (u.silence >= this.endSilenceFrames || u.frames.length >= this.maxFrames) return this.close();
    return null;
  }

  close() {
    const u = this.utt;
    this.utt = null;
    if (!u || u.speechFrames < this.minSpeechFrames) return null;
    // Trim most of the trailing silence, keep a short tail.
    const keep = Math.max(1, u.frames.length - Math.max(0, u.silence - 5));
    const frames = u.frames.slice(0, keep);
    const audio = new Float32Array(frames.length * this.frameLen);
    frames.forEach((f, n) => audio.set(f, n * this.frameLen));
    const start = u.startFrame * this.frameSec;
    return { audio, start, end: start + frames.length * this.frameSec, peak: u.peak };
  }

  // End of recording: return whatever is in progress.
  flush() {
    return this.close();
  }
}

// Whisper sometimes invents stock phrases for noise or very short clips.
const STOCK_PHRASES = new Set([
  'you', 'thank you', 'thanks', 'thank you very much', 'thanks for watching', 'thank you for watching',
  'bye', 'okay', 'so', 'please subscribe', 'subtitles by the amaraorg community',
]);

function cleanTranscript(text, durationSec) {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (/^[\[(♪*].*[\])♪*]$/.test(t)) return ''; // [BLANK_AUDIO], (music), ♪ ...
  const bare = t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  if (!bare) return '';
  if (durationSec < 2.5 && STOCK_PHRASES.has(bare)) return '';
  return t;
}

module.exports = { Segmenter, cleanTranscript };
