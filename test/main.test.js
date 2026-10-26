const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const { buildListenUrl, parseResult, DeepgramStream } = require('../src/main/deepgram');
const { EchoFilter, overlap } = require('../src/main/echo');
const { parseRegQuery, meetingAppName } = require('../src/main/meetingDetector');
const { LocalStore } = require('../src/main/db');
const { buildUserMessage, formatTranscript } = require('../src/main/notes');

test('Deepgram URL asks for two separately transcribed channels', () => {
  const url = new URL(buildListenUrl({ language: 'en' }));
  assert.equal(url.searchParams.get('channels'), '2');
  assert.equal(url.searchParams.get('multichannel'), 'true');
  assert.equal(url.searchParams.get('encoding'), 'linear16');
  assert.equal(url.searchParams.get('sample_rate'), '16000');
  assert.equal(url.searchParams.get('mip_opt_out'), 'true');
});

test('parseResult labels mic as You and computer audio as Them / Speaker N', () => {
  const you = parseResult({
    type: 'Results', channel_index: [0, 2], start: 1.5, duration: 2, is_final: true,
    channel: { alternatives: [{ transcript: 'hello there' }] },
  });
  assert.deepEqual(you, { channel: 0, speaker: 'You', text: 'hello there', start: 1.5, end: 3.5, isFinal: true });

  const them = parseResult({
    type: 'Results', channel_index: [1, 2], start: 4, duration: 1, is_final: false,
    channel: { alternatives: [{ transcript: 'hi', words: [{ speaker: 1 }, { speaker: 1 }, { speaker: 0 }] }] },
  });
  assert.equal(them.speaker, 'Speaker 2');
  assert.equal(them.isFinal, false);

  assert.equal(parseResult({ type: 'Results', channel_index: [1, 2], channel: { alternatives: [{ transcript: '  ' }] } }), null);
  assert.equal(parseResult({ type: 'Metadata' }), null);
});

test('DeepgramStream sends auth + audio and emits transcripts (fake server)', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = wss.address().port;
  const received = { auth: null, bytes: 0, closeStream: false };

  wss.on('connection', (socket, req) => {
    received.auth = req.headers.authorization;
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        received.bytes += data.length;
        socket.send(JSON.stringify({
          type: 'Results', channel_index: [1, 2], start: 0, duration: 1, is_final: true,
          channel: { alternatives: [{ transcript: 'from the call' }] },
        }));
      } else if (JSON.parse(data.toString()).type === 'CloseStream') {
        received.closeStream = true;
        socket.close(1000);
      }
    });
  });

  const stream = new DeepgramStream({ apiKey: 'test-key', url: `ws://127.0.0.1:${port}` });
  const got = new Promise((resolve) => stream.once('transcript', resolve));
  await stream.start();
  stream.sendAudio(new Int16Array(3200).buffer);
  const seg = await got;
  await stream.stop();
  wss.close();

  assert.equal(received.auth, 'Token test-key');
  assert.equal(received.bytes, 6400);
  assert.equal(received.closeStream, true);
  assert.equal(seg.speaker, 'Them');
  assert.equal(seg.text, 'from the call');
});

test('DeepgramStream refuses to start without a key', () => {
  assert.throws(() => new DeepgramStream({ apiKey: '' }), /DEEPGRAM_API_KEY/);
});

test('echo filter drops mic lines that repeat what the call just said', () => {
  const f = new EchoFilter();
  assert.equal(f.accept({ channel: 1, text: 'Can everyone see my screen now?', start: 10, end: 12 }), true);
  assert.equal(f.accept({ channel: 0, text: 'can everyone see my screen', start: 10.3, end: 12.4 }), false);
  assert.equal(f.accept({ channel: 0, text: 'Yes, I can see it fine.', start: 13, end: 14 }), true);
  assert.equal(f.accept({ channel: 0, text: 'can everyone see my screen', start: 40, end: 42 }), true);
  assert.ok(overlap('a b c d', 'a b x y') === 0.5);
});

test('registry parser finds apps currently holding the mic', () => {
  const out = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone',
    '    Value    REG_SZ    Allow',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\MSTeams_8wekyb3d8bbwe',
    '    LastUsedTimeStart    REG_QWORD    0x1dd5baba8c07049',
    '    LastUsedTimeStop    REG_QWORD    0x0',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1dd5baba8c07049',
    '    LastUsedTimeStop    REG_QWORD    0x1dd5bababfa22c4',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Users#me#AppData#Roaming#Zoom#bin#Zoom.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1dd5baba8c07049',
    '    LastUsedTimeStop    REG_QWORD    0x0',
  ].join('\r\n');
  const apps = parseRegQuery(out);
  const inUse = apps.filter((a) => a.inUse).map((a) => meetingAppName(a.key));
  assert.deepEqual(inUse, ['Microsoft Teams', 'Zoom']);
  assert.equal(apps.find((a) => a.key.endsWith('chrome.exe')).inUse, false);
  assert.equal(meetingAppName('C:#Users#me#Projects#meeting-notes#node_modules#electron#dist#electron.exe'), null);
});

test('local store round-trips meetings, notes, transcripts and search', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-')), 'meetings.json');
  const store = new LocalStore(file);
  const m = await store.createMeeting({ title: 'Roadmap sync', source_app: 'Zoom' });
  await store.updateMeeting(m.id, { user_notes: 'pricing?' });
  await store.addSegment(m.id, { channel: 1, speaker: 'Them', text: 'We ship the beta in March', start: 2, end: 4 });
  await store.addSegment(m.id, { channel: 0, speaker: 'You', text: 'Sounds good', start: 0, end: 1 });

  const reopened = new LocalStore(file);
  const full = await reopened.getMeeting(m.id);
  assert.equal(full.user_notes, 'pricing?');
  assert.deepEqual(full.segments.map((s) => s.speaker), ['You', 'Them']);
  assert.equal((await reopened.searchMeetings('beta')).length, 1);
  assert.equal((await reopened.searchMeetings('nothing-like-this')).length, 0);
  await reopened.deleteMeeting(m.id);
  assert.equal((await reopened.listMeetings()).length, 0);
});

test('Claude prompt carries notes and a timestamped transcript', () => {
  const msg = buildUserMessage({
    title: 'Sync',
    userNotes: '- budget',
    segments: [{ speaker: 'Them', text: 'Budget is 10k', start_sec: 65 }],
  });
  assert.match(msg, /<my_notes>\n- budget\n<\/my_notes>/);
  assert.match(msg, /\[01:05\] Them: Budget is 10k/);
  assert.equal(formatTranscript([]), '');
});

test('markdown renderer escapes HTML and renders tasks', async () => {
  const { renderMarkdown } = await import('../src/renderer/markdown.js');
  const html = renderMarkdown('# Title\n\n## Action items\n- [ ] Sam: send <deck>\n- **bold** point');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /class="task"/);
  assert.match(html, /&lt;deck&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.doesNotMatch(html, /<deck>/);
});
