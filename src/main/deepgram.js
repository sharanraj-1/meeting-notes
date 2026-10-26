// Live transcription over Deepgram's streaming API.
//
// One WebSocket carries both audio sources as a 2-channel, 16 kHz, 16-bit
// interleaved stream (multichannel=true): channel 0 is your microphone,
// channel 1 is what your computer is playing (the other people on the call).
// Deepgram transcribes each channel separately, which is how we know who said what.
// The API key stays in this (main) process; the renderer only ever sends audio.

const WebSocket = require('ws');
const { EventEmitter } = require('node:events');

const SAMPLE_RATE = 16000;
const CHANNELS = 2;
const KEEPALIVE_MS = 8000;
const CHANNEL_SPEAKER = ['You', 'Them'];

function buildListenUrl({ language = 'en', model = 'nova-3' } = {}) {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  const params = {
    model,
    language,
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    channels: String(CHANNELS),
    multichannel: 'true',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
    diarize: 'true',
    // Opt out of Deepgram's Model Improvement Program, so your audio isn't kept for training.
    mip_opt_out: 'true',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// Turns one Deepgram "Results" message into a transcript event, or null if it
// carries no words. Diarization on the computer-audio channel splits "Them"
// into "Speaker 1", "Speaker 2", ... when more than one remote voice is heard.
function parseResult(msg) {
  if (!msg || msg.type !== 'Results') return null;
  const alt = msg.channel?.alternatives?.[0];
  const text = alt?.transcript?.trim();
  if (!text) return null;
  const channel = Array.isArray(msg.channel_index) ? msg.channel_index[0] : 0;
  let speaker = CHANNEL_SPEAKER[channel] ?? `Channel ${channel}`;
  if (channel === 1 && Array.isArray(alt.words) && alt.words.length > 0) {
    const counts = new Map();
    for (const w of alt.words) {
      if (typeof w.speaker === 'number') counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
    }
    if (counts.size > 0) {
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      speaker = `Speaker ${top + 1}`;
    }
  }
  return {
    channel,
    speaker,
    text,
    start: msg.start ?? 0,
    end: (msg.start ?? 0) + (msg.duration ?? 0),
    isFinal: Boolean(msg.is_final),
  };
}

class DeepgramStream extends EventEmitter {
  // `url` is only for tests (pointing at a fake server).
  constructor({ apiKey, language, url }) {
    super();
    if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set. Add it to your .env file.');
    this.apiKey = apiKey;
    this.url = url ?? buildListenUrl({ language });
    this.ws = null;
    this.keepAlive = null;
    this.lastAudioAt = 0;
    this.closing = false;
    this.pending = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });
      this.ws = ws;
      let opened = false;

      ws.on('open', () => {
        opened = true;
        for (const chunk of this.pending) ws.send(chunk);
        this.pending = [];
        this.keepAlive = setInterval(() => {
          if (Date.now() - this.lastAudioAt > KEEPALIVE_MS && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, KEEPALIVE_MS);
        this.emit('open');
        resolve();
      });

      ws.on('unexpected-response', (_req, res) => {
        const err = new Error(
          res.statusCode === 401
            ? 'Deepgram rejected the API key (401). Check DEEPGRAM_API_KEY in .env.'
            : `Deepgram refused the connection (HTTP ${res.statusCode}).`,
        );
        if (!opened) reject(err);
        else this.emit('error', err);
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const seg = parseResult(msg);
        if (seg) this.emit('transcript', seg);
        else if (msg.type === 'Error' || msg.err_code) this.emit('error', new Error(msg.description || msg.err_msg || 'Deepgram error'));
      });

      ws.on('error', (err) => {
        if (!opened) reject(err);
        else this.emit('error', err);
      });

      ws.on('close', (code, reason) => {
        clearInterval(this.keepAlive);
        this.emit('close', { code, reason: reason.toString(), expected: this.closing });
      });
    });
  }

  // `chunk` is interleaved Int16 PCM: [mic, system, mic, system, ...].
  sendAudio(chunk) {
    this.lastAudioAt = Date.now();
    const buf = Buffer.from(chunk);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
    else if (this.ws?.readyState === WebSocket.CONNECTING) this.pending.push(buf);
  }

  // Ask Deepgram to flush the last words, then close.
  stop() {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return resolve();
      this.closing = true;
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 5000);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.send(JSON.stringify({ type: 'CloseStream' }));
    });
  }
}

module.exports = { DeepgramStream, buildListenUrl, parseResult, SAMPLE_RATE, CHANNELS };
