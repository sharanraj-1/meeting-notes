// Live transcription over Deepgram's streaming API (optional: used when
// DEEPGRAM_API_KEY is set; otherwise the app transcribes on-device).
//
// One WebSocket carries both audio sources as a 2-channel, 16 kHz, 16-bit
// interleaved stream (multichannel=true): channel 0 is your microphone,
// channel 1 is what your computer is playing (the other people on the call).
// Deepgram transcribes each channel separately, which is how we know who said what.
//
// Reliability behaviour modelled on what Granola's desktop client does
// (found with REA), written from scratch here:
//  - reconnects automatically: first retry immediately, then backoff
//    (1-5 s randomised start, x1.3 each time, capped at 10 s)
//  - while disconnected, audio is queued (up to 2 minutes) and replayed on
//    reconnect, and timestamps stay continuous across connections
//  - KeepAlive every 3 s so Deepgram doesn't drop a quiet connection
//  - stall detection: if audio is going out but nothing has come back for
//    30 s, the connection is assumed dead and replaced
//  - keyterm prompting (names, jargon) to help Nova-3 spell things right
// The API key stays in this (main) process; the renderer only ever sends audio.

const WebSocket = require('ws');
const { EventEmitter } = require('node:events');

const SAMPLE_RATE = 16000;
const CHANNELS = 2;
const BYTES_PER_SEC = SAMPLE_RATE * CHANNELS * 2;
const CHANNEL_SPEAKER = ['You', 'Them'];
const KEYTERM_CHAR_BUDGET = 400;

const DEFAULTS = {
  keepAliveMs: 3000,
  stallMs: 30000,
  stallCheckMs: 5000,
  maxQueueMs: 120000,
  minReconnectMs: 1000 + Math.random() * 4000,
  maxReconnectMs: 10000,
  growFactor: 1.3,
  connectTimeoutMs: 10000,
  startTimeoutMs: 20000,
};

// Keeps keyterms while they fit in Deepgram's prompt budget, skipping blanks and duplicates.
function pickKeyterms(terms = []) {
  const out = [];
  const seen = new Set();
  let used = 0;
  for (const raw of terms) {
    const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
    const key = t.toLowerCase();
    if (!t || t.length > 60 || seen.has(key)) continue;
    if (used + t.length > KEYTERM_CHAR_BUDGET) break;
    seen.add(key);
    out.push(t);
    used += t.length;
  }
  return out;
}

function buildListenUrl({ language = 'en', model = 'nova-3', keyterms = [] } = {}) {
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
    // Mixed-language mode works best with faster endpointing.
    endpointing: language === 'multi' ? '100' : '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
    diarize: 'true',
    // Opt out of Deepgram's Model Improvement Program, so your audio isn't kept for training.
    mip_opt_out: 'true',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (const term of pickKeyterms(keyterms)) url.searchParams.append('keyterm', term);
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

function reconnectDelay(attempt, { minReconnectMs, maxReconnectMs, growFactor }) {
  if (attempt <= 1) return 0;
  return Math.min(minReconnectMs * growFactor ** (attempt - 2), maxReconnectMs);
}

class DeepgramStream extends EventEmitter {
  // `url` and `options` are for tests (a fake server, short timers).
  constructor({ apiKey, language = 'en', keyterms = [], url, options = {} }) {
    super();
    if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set. Add it to your .env file.');
    this.kind = 'deepgram';
    this.apiKey = apiKey;
    this.url = url ?? buildListenUrl({ language, keyterms });
    this.opts = { ...DEFAULTS, ...options };

    this.ws = null;
    this.stopping = false;
    this.fatal = null;
    this.attempt = 0;
    this.timers = new Set();
    this.queue = []; // audio waiting for a connection: { buf, at }
    this.bytesBefore = 0; // audio sent on earlier connections + audio dropped from the queue
    this.bytesThisConn = 0;
    this.offsetSec = 0;
    this.lastAudioAt = 0;
    this.lastMessageAt = 0;
  }

  // Resolves once the first connection is open. Rejects on a bad key, or if
  // Deepgram can't be reached at all within startTimeoutMs.
  start() {
    return new Promise((resolve, reject) => {
      const giveUp = setTimeout(() => {
        this.stopping = true;
        this.cleanup();
        reject(new Error("Couldn't reach Deepgram. Check your internet connection."));
      }, this.opts.startTimeoutMs);
      this.once('open', () => {
        clearTimeout(giveUp);
        resolve();
      });
      this.once('fatal', (err) => {
        clearTimeout(giveUp);
        reject(err);
      });
      this.connect();
    });
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  every(fn, ms) {
    const t = setInterval(fn, ms);
    this.timers.add(t);
    return t;
  }

  cleanup() {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
  }

  connect() {
    if (this.stopping || this.fatal) return;
    this.attempt++;
    const ws = new WebSocket(this.url, {
      headers: { Authorization: `Token ${this.apiKey}` },
      handshakeTimeout: this.opts.connectTimeoutMs,
    });
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      const reconnected = this.everOpened === true;
      this.everOpened = true;
      this.attempt = 0;
      this.bytesBefore += this.bytesThisConn;
      this.bytesThisConn = 0;
      this.offsetSec = this.bytesBefore / BYTES_PER_SEC;
      this.lastMessageAt = Date.now();

      const queued = this.drainQueue();
      for (const buf of queued) this.sendNow(buf);

      this.every(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, this.opts.keepAliveMs);
      this.every(() => this.checkStall(ws), this.opts.stallCheckMs);

      if (reconnected) this.emit('status', { state: 'reconnected', replayedSec: queued.reduce((n, b) => n + b.length, 0) / BYTES_PER_SEC });
      this.emit('open');
    });

    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode;
      if (code === 401 || code === 402 || code === 403) {
        this.fatal =
          code === 401
            ? new Error('Deepgram rejected the API key (401). Check DEEPGRAM_API_KEY in .env.')
            : code === 402
              ? new Error('Your Deepgram account is out of credit (402).')
              : new Error('Deepgram refused this key (403). It may lack permission for live transcription.');
        this.emit('fatal', this.fatal);
        this.emit('error', this.fatal);
      }
      ws.terminate();
    });

    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws || isBinary) return;
      this.lastMessageAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const seg = parseResult(msg);
      if (seg) this.emit('transcript', { ...seg, start: seg.start + this.offsetSec, end: seg.end + this.offsetSec });
      else if (msg.type === 'Error' || msg.err_code) this.emit('error', new Error(msg.description || msg.err_msg || 'Deepgram error'));
    });

    ws.on('error', () => {
      /* 'close' follows and handles reconnecting */
    });

    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.cleanup();
      this.ws = null;
      if (this.stopping) {
        this.emit('close', { code, expected: true });
        return;
      }
      if (this.fatal) {
        this.emit('close', { code, expected: false });
        return;
      }
      const delay = reconnectDelay(this.attempt + 1, this.opts);
      this.emit('status', { state: 'reconnecting', attempt: this.attempt + 1, inMs: Math.round(delay) });
      this.later(() => this.connect(), delay);
    });
  }

  // Audio is flowing but Deepgram has gone quiet: replace the connection.
  checkStall(ws) {
    const now = Date.now();
    const sendingAudio = now - this.lastAudioAt < this.opts.stallMs;
    if (sendingAudio && now - this.lastMessageAt > this.opts.stallMs && ws.readyState === WebSocket.OPEN) {
      this.emit('status', { state: 'stalled' });
      ws.terminate();
    }
  }

  sendNow(buf) {
    this.ws.send(buf);
    this.bytesThisConn += buf.length;
  }

  drainQueue() {
    this.evictOld(Date.now());
    const bufs = this.queue.map((q) => q.buf);
    this.queue = [];
    return bufs;
  }

  // Drop queued audio older than maxQueueMs; count it so timestamps stay aligned.
  evictOld(now) {
    while (this.queue.length && now - this.queue[0].at > this.opts.maxQueueMs) {
      this.bytesBefore += this.queue.shift().buf.length;
    }
  }

  // `chunk` is interleaved Int16 PCM: [mic, system, mic, system, ...].
  sendAudio(chunk) {
    if (this.stopping) return;
    const now = Date.now();
    this.lastAudioAt = now;
    const buf = Buffer.from(chunk);
    if (this.ws?.readyState === WebSocket.OPEN) this.sendNow(buf);
    else {
      this.queue.push({ buf, at: now });
      this.evictOld(now);
    }
  }

  // Ask Deepgram to flush the last words, then close.
  stop() {
    this.stopping = true;
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        this.cleanup();
        ws?.terminate();
        return resolve();
      }
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

module.exports = { DeepgramStream, buildListenUrl, parseResult, pickKeyterms, reconnectDelay, SAMPLE_RATE, CHANNELS, BYTES_PER_SEC };
