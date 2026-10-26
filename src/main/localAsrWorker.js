// On-device transcription worker (OpenAI Whisper via transformers.js).
//
// Runs in its own process (Electron utility process, or a plain Node child
// process in tests) so loading the model and transcribing never freezes the
// window. It receives the same interleaved 2-channel PCM the Deepgram path
// gets, splits it per channel, cuts it into utterances, and transcribes them
// one at a time. The model downloads once to the cache folder, then works offline.
//
// argv: <modelId> <cacheDir> <language>

const { pathToFileURL } = require('node:url');
const { Segmenter, cleanTranscript } = require('./segmenter');

const [modelId, cacheDir, language = 'en'] = process.argv.slice(2);
const SAMPLE_RATE = 16000;
const SPEAKERS = ['You', 'Them'];
const multilingual = !modelId.endsWith('.en');

// Same API whether we're an Electron utility process or a Node child process.
const port = process.parentPort ?? {
  on: (ev, cb) => process.on(ev, (data) => cb({ data })),
  postMessage: (m) => process.send(m),
};
const post = (m) => port.postMessage(m);

const segmenters = [new Segmenter(), new Segmenter()];
const queue = [];
let asr = null;
let loading = null;
let busy = false;
let stopping = false;

function loadModel() {
  loading ??= (async () => {
    const lib = await import(pathToFileURL(require.resolve('@huggingface/transformers')).href);
    lib.env.cacheDir = cacheDir;
    const files = new Map();
    let lastPost = 0;
    asr = await lib.pipeline('automatic-speech-recognition', modelId, {
      dtype: 'q8',
      device: 'cpu',
      progress_callback: (p) => {
        if (p.status !== 'progress' || !p.total) return;
        files.set(p.file, [p.loaded, p.total]);
        const now = Date.now();
        if (now - lastPost < 250) return;
        lastPost = now;
        let loaded = 0;
        let total = 0;
        for (const [l, t] of files.values()) {
          loaded += l;
          total += t;
        }
        post({ type: 'status', state: 'downloading', loaded, total });
      },
    });
    post({ type: 'status', state: 'ready', model: modelId });
  })();
  return loading;
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    await loadModel();
    while (queue.length) {
      const u = queue.shift();
      const out = await asr(u.audio, multilingual ? { language, task: 'transcribe' } : {});
      const text = cleanTranscript(out.text, u.end - u.start);
      if (text) {
        post({
          type: 'transcript',
          seg: { channel: u.channel, speaker: SPEAKERS[u.channel], text, start: u.start, end: u.end, isFinal: true },
        });
      }
    }
  } catch (err) {
    post({ type: 'error', message: `On-device transcription failed: ${err.message}` });
    queue.length = 0;
  } finally {
    busy = false;
    if (queue.length) pump();
    else if (stopping) post({ type: 'drained' });
  }
}

function enqueue(channel, utterances) {
  for (const u of utterances) {
    if (u) queue.push({ channel, ...u });
  }
  if (queue.length) {
    post({ type: 'pending', count: queue.length });
    pump();
  }
}

function onAudio(pcm) {
  const ints = ArrayBuffer.isView(pcm)
    ? new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2)
    : new Int16Array(pcm);
  const frames = ints.length / 2;
  const mic = new Float32Array(frames);
  const sys = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    mic[i] = ints[i * 2] / 32768;
    sys[i] = ints[i * 2 + 1] / 32768;
  }
  enqueue(0, segmenters[0].push(mic));
  enqueue(1, segmenters[1].push(sys));
}

port.on('message', ({ data }) => {
  switch (data?.type) {
    case 'warmup':
      loadModel().catch((err) => post({ type: 'error', message: `Couldn't load the speech model: ${err.message}` }));
      break;
    case 'audio':
      if (!stopping) onAudio(data.pcm);
      break;
    case 'stop':
      stopping = true;
      enqueue(0, [segmenters[0].flush()]);
      enqueue(1, [segmenters[1].flush()]);
      if (!busy && queue.length === 0) post({ type: 'drained' });
      break;
  }
});

post({ type: 'started', sampleRate: SAMPLE_RATE });
