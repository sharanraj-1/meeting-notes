const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');

const { DeepgramStream, buildListenUrl, pickKeyterms, reconnectDelay, BYTES_PER_SEC } = require('../src/main/deepgram');
const { Segmenter, cleanTranscript } = require('../src/main/segmenter');
const { enhanceWithOpenRouter, notesProvider } = require('../src/main/notes');

const FAST = { keepAliveMs: 50, stallMs: 300, stallCheckMs: 50, minReconnectMs: 20, maxReconnectMs: 50, startTimeoutMs: 2000 };

function result(channel, start, text) {
  return JSON.stringify({
    type: 'Results', channel_index: [channel, 2], start, duration: 1, is_final: true,
    channel: { alternatives: [{ transcript: text }] },
  });
}

test('keyterms are de-duplicated and kept within a 400-character budget', () => {
  const terms = pickKeyterms(['Priya', 'priya', '  ', 'Acme Corp', 'x'.repeat(61), ...Array(60).fill(0).map((_, i) => `term number ${i}`)]);
  assert.deepEqual(terms.slice(0, 2), ['Priya', 'Acme Corp']);
  assert.ok(terms.join('').length <= 400);
  const url = new URL(buildListenUrl({ keyterms: ['Priya', 'Acme Corp'] }));
  assert.deepEqual(url.searchParams.getAll('keyterm'), ['Priya', 'Acme Corp']);
  assert.equal(new URL(buildListenUrl({ language: 'multi' })).searchParams.get('endpointing'), '100');
});

test('reconnect backoff: immediate first retry, then grows, capped', () => {
  const o = { minReconnectMs: 1000, maxReconnectMs: 10000, growFactor: 1.3 };
  assert.equal(reconnectDelay(1, o), 0);
  assert.equal(reconnectDelay(2, o), 1000);
  assert.equal(reconnectDelay(3, o), 1300);
  assert.equal(reconnectDelay(30, o), 10000);
});

test('Deepgram stream reconnects, replays queued audio, keeps timestamps continuous', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = wss.address().port;
  let connections = 0;
  const bytesPerConn = [];

  wss.on('connection', (socket) => {
    const n = connections++;
    bytesPerConn[n] = 0;
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (JSON.parse(data.toString()).type === 'CloseStream') socket.close(1000);
        return;
      }
      bytesPerConn[n] += data.length;
      // First connection: answer once, then drop after 1 s of audio.
      if (n === 0 && bytesPerConn[0] === BYTES_PER_SEC) {
        socket.send(result(1, 0, 'before the drop'));
        setTimeout(() => socket.terminate(), 10);
      }
      // Second connection: answer at its own t=0.5 s.
      if (n === 1 && bytesPerConn[1] === BYTES_PER_SEC / 2) socket.send(result(0, 0.5, 'after the drop'));
    });
  });

  const stream = new DeepgramStream({ apiKey: 'k', url: `ws://127.0.0.1:${port}`, options: FAST });
  const segs = [];
  const statuses = [];
  stream.on('transcript', (s) => segs.push(s));
  stream.on('status', (s) => statuses.push(s.state));
  stream.on('error', () => {});
  await stream.start();

  const tenth = Buffer.alloc(BYTES_PER_SEC / 10);
  const dropped = new Promise((r) => stream.once('status', r));
  for (let i = 0; i < 10; i++) stream.sendAudio(tenth); // 1 s on connection 1
  await dropped; // server dropped us; reconnect is scheduled but hasn't run yet
  for (let i = 0; i < 10; i++) stream.sendAudio(tenth); // 1 s while disconnected -> queued
  await new Promise((r) => stream.once('open', r));
  await new Promise((r) => setTimeout(r, 100));
  await stream.stop();
  wss.close();

  assert.equal(connections, 2);
  assert.equal(bytesPerConn[1], BYTES_PER_SEC, 'queued audio was replayed on the new connection');
  assert.ok(statuses.includes('reconnecting') && statuses.includes('reconnected'));
  assert.deepEqual(segs.map((s) => [s.text, s.start]), [['before the drop', 0], ['after the drop', 1.5]]);
});

test('Deepgram stream rejects start on a bad key instead of retrying forever', async () => {
  const wss = new WebSocketServer({ port: 0, verifyClient: (_info, cb) => cb(false, 401, 'Unauthorized') });
  const stream = new DeepgramStream({ apiKey: 'bad', url: `ws://127.0.0.1:${wss.address().port}`, options: FAST });
  stream.on('error', () => {});
  await assert.rejects(stream.start(), /401/);
  wss.close();
});

test('Deepgram stream replaces a connection that goes silent while audio flows', async () => {
  const wss = new WebSocketServer({ port: 0 });
  let connections = 0;
  wss.on('connection', () => connections++); // never answers
  const stream = new DeepgramStream({ apiKey: 'k', url: `ws://127.0.0.1:${wss.address().port}`, options: FAST });
  const statuses = [];
  stream.on('status', (s) => statuses.push(s.state));
  await stream.start();
  const timer = setInterval(() => stream.sendAudio(Buffer.alloc(3200)), 20);
  await new Promise((r) => setTimeout(r, 700));
  clearInterval(timer);
  await stream.stop();
  wss.close();
  assert.ok(statuses.includes('stalled'));
  assert.ok(connections >= 2);
});

function tone(seconds, amp = 0.3) {
  const a = new Float32Array(Math.round(16000 * seconds));
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * 220 * i) / 16000);
  return a;
}
const silence = (seconds) => new Float32Array(Math.round(16000 * seconds));

test('segmenter cuts speech at pauses and ignores silence and blips', () => {
  const seg = new Segmenter();
  const out = [];
  for (const part of [silence(1), tone(1.5), silence(1), tone(0.1), silence(1), tone(2), silence(1)]) {
    // feed in 100 ms pieces like the app does
    for (let i = 0; i < part.length; i += 1600) out.push(...seg.push(part.subarray(i, i + 1600)));
  }
  const last = seg.flush();
  if (last) out.push(last);
  assert.equal(out.length, 2, 'the 0.1 s blip is not an utterance');
  assert.ok(Math.abs(out[0].start - 1) < 0.35, `first starts near 1 s, got ${out[0].start}`);
  assert.ok(Math.abs(out[1].start - 4.6) < 0.35, `second starts near 4.6 s, got ${out[1].start}`);
  assert.ok(out[1].end - out[1].start >= 2);
});

test('segmenter splits very long speech at the maximum length', () => {
  const seg = new Segmenter({ maxUtteranceMs: 5000 });
  const out = seg.push(tone(12));
  assert.equal(out.length, 2);
  assert.ok(out.every((u) => u.end - u.start <= 5.01));
});

test('Whisper output cleanup drops noise placeholders and stock phrases', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] ', 3), '');
  assert.equal(cleanTranscript('(music)', 3), '');
  assert.equal(cleanTranscript('Thank you.', 1.2), '');
  assert.equal(cleanTranscript('Thank you.', 4), 'Thank you.');
  assert.equal(cleanTranscript('  We ship   Friday. ', 2), 'We ship Friday.');
});

test('AI notes provider: Anthropic key wins, then OpenRouter, else none', () => {
  assert.equal(notesProvider({ ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o' }).name, 'anthropic');
  assert.equal(notesProvider({ OPENROUTER_API_KEY: 'o' }).name, 'openrouter');
  assert.equal(notesProvider({}), null);
});

function sseResponse(lines, status = 200) {
  const body = (async function* () {
    for (const l of lines) yield new TextEncoder().encode(l);
  })();
  return { ok: status < 300, status, body, json: async () => ({ error: { message: 'nope' } }) };
}

test('OpenRouter notes stream text deltas and handle split lines and keep-alives', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init };
    return sseResponse([
      ': OPENROUTER PROCESSING\n\n',
      'data: {"choices":[{"delta":{"content":"# Ti"}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"tle"}}]}\n\ndata: {"choices":[{"delta":{},"fin',
      'ish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ]);
  };
  const deltas = [];
  const md = await enhanceWithOpenRouter({ apiKey: 'k', title: 'T', userNotes: '', segments: [], onText: (d) => deltas.push(d), fetchImpl });
  assert.equal(md, '# Title');
  assert.deepEqual(deltas, ['# Ti', 'tle']);
  assert.equal(sent.init.headers.Authorization, 'Bearer k');
  assert.equal(JSON.parse(sent.init.body).model, 'anthropic/claude-opus-5.5');
});

test('OpenRouter errors become readable messages', async () => {
  await assert.rejects(
    enhanceWithOpenRouter({ apiKey: 'k', segments: [], fetchImpl: async () => sseResponse([], 401) }),
    /rejected the API key/,
  );
  await assert.rejects(
    enhanceWithOpenRouter({ apiKey: 'k', segments: [], fetchImpl: async () => sseResponse([], 402) }),
    /out of credits/,
  );
});
