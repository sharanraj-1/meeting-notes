// Main process: window, audio permissions, recording, storage, AI notes.

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  Notification,
  desktopCapturer,
  ipcMain,
  net,
  protocol,
  session,
  shell,
} = require('electron');

const ROOT = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const { DeepgramStream } = require('./deepgram');
const { LocalTranscriber, modelFor } = require('./localAsr');
const { EchoFilter } = require('./echo');
const { MeetingDetector } = require('./meetingDetector');
const { enhanceNotes, notesProvider } = require('./notes');
const { openStore } = require('./db');

const LANGUAGE = () => process.env.TRANSCRIPTION_LANGUAGE || process.env.DEEPGRAM_LANGUAGE || 'en';

// Deepgram when there's a key (fastest, most accurate), otherwise free
// on-device Whisper that needs no account at all.
function createTranscriber(meeting) {
  if (process.env.DEEPGRAM_API_KEY) {
    const extra = (process.env.DEEPGRAM_KEYTERMS || '').split(',');
    const fromTitle = (meeting?.title || '').split(/[,;|·]/);
    return new DeepgramStream({
      apiKey: process.env.DEEPGRAM_API_KEY,
      language: LANGUAGE(),
      keyterms: [...extra, ...fromTitle].filter((t) => t && !/^untitled meeting$/i.test(t.trim())),
    });
  }
  return new LocalTranscriber({ cacheDir: path.join(DATA_DIR, 'models'), language: LANGUAGE() });
}

const SMOKE = process.argv.includes('--smoke');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
// Meetings (when Supabase isn't set up) and the speech model live here, inside
// the project, so they're in the same place however the app is launched.
const DATA_DIR = process.env.MEETING_NOTES_DATA_DIR || path.join(ROOT, 'data');

// Serve the UI from app://ui/ instead of file:// so the audio worklet module
// loads like it would from a normal web origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win = null;
let store = null;
let detector = null;
let recording = null; // { meetingId, stream, echo }
let notesAbort = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Meeting Notes',
    backgroundColor: '#f7f5f0',
    show: !SMOKE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadURL('app://ui/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function setUpAudioCapture() {
  const ses = session.defaultSession;

  // Let our own page use the microphone and screen/audio capture.
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc.getURL().startsWith('app://ui/') && ['media', 'display-capture'].includes(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    return Boolean(wc?.getURL().startsWith('app://ui/')) && ['media', 'display-capture'].includes(permission);
  });

  // The trick. When the page calls getDisplayMedia(), don't show a picker:
  // hand back the screen plus Windows "loopback" audio, which is everything
  // your speakers or headphones are playing. The page throws the video away
  // and keeps the audio. No bot joins the call; we just hear what you hear.
  ses.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const [screen] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        callback({ video: screen, audio: 'loopback' });
      } catch (err) {
        console.error('display-media-request failed', err);
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    storeKind: store.kind,
    storeLabel: store.label,
    transcription: process.env.DEEPGRAM_API_KEY
      ? { kind: 'deepgram', label: 'Deepgram (live)' }
      : { kind: 'local', label: `On-device Whisper (${modelFor(LANGUAGE()).split('/').pop()})` },
    notes: notesProvider(),
    platform: process.platform,
    smoke: SMOKE,
  }));

  ipcMain.handle('meetings:list', () => store.listMeetings());
  ipcMain.handle('meetings:search', (_e, q) => (q?.trim() ? store.searchMeetings(q.trim()) : store.listMeetings()));
  ipcMain.handle('meetings:get', (_e, id) => store.getMeeting(id));
  ipcMain.handle('meetings:create', (_e, input) => store.createMeeting(input ?? {}));
  ipcMain.handle('meetings:update', (_e, id, patch) => {
    const allowed = {};
    for (const k of ['title', 'user_notes', 'enhanced_notes']) if (k in patch) allowed[k] = patch[k];
    return store.updateMeeting(id, allowed);
  });
  ipcMain.handle('meetings:delete', (_e, id) => store.deleteMeeting(id));

  ipcMain.handle('rec:start', async (_e, meetingId) => {
    if (recording) throw new Error('Already recording.');
    const existing = await store.getMeeting(meetingId).catch(() => ({ segments: [] }));
    const stream = createTranscriber(existing);
    const echo = new EchoFilter();
    recording = { meetingId, stream, echo };

    // When resuming a meeting, continue the clock from where the transcript left off.
    const offset = existing.segments.reduce((max, s) => Math.max(max, s.end_sec), 0);
    if (offset > 0) await store.updateMeeting(meetingId, { ended_at: null }).catch(() => {});

    stream.on('transcript', async (raw) => {
      const seg = { ...raw, start: raw.start + offset, end: raw.end + offset };
      if (!seg.isFinal) return send('rec:transcript', seg);
      if (!echo.accept(seg)) return send('rec:transcript', { ...seg, dropped: true });
      send('rec:transcript', seg);
      try {
        await store.addSegment(meetingId, seg);
      } catch (err) {
        send('rec:error', `Couldn't save part of the transcript: ${err.message}`);
      }
    });
    stream.on('status', (status) => send('rec:status', { ...status, kind: stream.kind }));
    stream.on('error', (err) => send('rec:error', err.message));
    stream.on('close', ({ expected, code }) => {
      if (!expected) send('rec:error', `Transcription stopped unexpectedly (code ${code}). Stop and start recording to continue.`);
    });

    try {
      await stream.start();
    } catch (err) {
      recording = null;
      throw err;
    }
    return true;
  });

  // Audio arrives here ~10 times a second as interleaved 16-bit PCM.
  ipcMain.on('rec:audio', (_e, chunk) => {
    recording?.stream.sendAudio(chunk);
  });

  ipcMain.handle('rec:stop', async () => {
    if (!recording) return null;
    const { meetingId, stream } = recording;
    await stream.stop();
    recording = null;
    return store.updateMeeting(meetingId, { ended_at: new Date().toISOString() });
  });

  ipcMain.handle('notes:enhance', async (_e, meetingId) => {
    notesAbort?.abort();
    notesAbort = new AbortController();
    const m = await store.getMeeting(meetingId);
    const markdown = await enhanceNotes({
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      openrouterKey: process.env.OPENROUTER_API_KEY,
      title: m.title,
      userNotes: m.user_notes,
      segments: m.segments,
      signal: notesAbort.signal,
      onText: (delta) => send('notes:delta', { meetingId, delta }),
    });
    notesAbort = null;
    await store.updateMeeting(meetingId, { enhanced_notes: markdown });
    return markdown;
  });

  ipcMain.on('smoke:result', (_e, result) => {
    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
    app.exit(result.ok ? 0 : 1);
  });
}

function startMeetingDetection() {
  detector = new MeetingDetector();
  detector.on('meeting-started', (appName) => {
    send('detect:started', appName);
    if (recording || !Notification.isSupported()) return;
    const n = new Notification({
      title: `${appName} is using your microphone`,
      body: 'Click to start taking notes for this meeting.',
    });
    n.on('click', () => {
      win?.show();
      win?.focus();
      send('detect:start-requested', appName);
    });
    n.show();
  });
  detector.on('meeting-ended', (appName) => send('detect:ended', appName));
  detector.start();
}

app.whenReady().then(async () => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(RENDERER_DIR)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  store = openStore({
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SECRET_KEY,
    localFile: path.join(DATA_DIR, 'meetings.json'),
  });
  try {
    await store.check();
  } catch (err) {
    console.error(err.message);
    store.error = err.message;
  }

  setUpAudioCapture();
  registerIpc();
  createWindow();
  if (!SMOKE) startMeetingDetection();
  if (SMOKE) setTimeout(() => {
    console.log('SMOKE_RESULT {"ok":false,"error":"timed out"}');
    app.exit(1);
  }, 30000);
});

ipcMain.handle('app:store-error', () => store?.error ?? null);

app.on('window-all-closed', async () => {
  detector?.stop();
  if (recording) {
    const { meetingId, stream } = recording;
    recording = null;
    await stream.stop().catch(() => {});
    await store.updateMeeting(meetingId, { ended_at: new Date().toISOString() }).catch(() => {});
  }
  app.quit();
});
