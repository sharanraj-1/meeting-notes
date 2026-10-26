import { startCapture } from './capture.js';
import { renderMarkdown } from './markdown.js';

const api = window.api;
const $ = (id) => document.getElementById(id);

const state = {
  info: null,
  meetings: [],
  current: null, // full meeting being viewed
  rec: null, // { meetingId, capture, startedAt, tick }
  interim: new Map(), // channel -> element
  aiBuffer: '',
  aiBusy: false,
};

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function clock(totalSec) {
  const t = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    return fn(...args);
  };
  return wrapped;
}

function showBanner(message, { error = false, actions = [] } = {}) {
  const b = $('banner');
  b.replaceChildren(el('span', { class: 'msg' }, message), ...actions.map(([label, fn, cls]) => el('button', { class: `btn ${cls ?? ''}`, onclick: fn }, label)));
  b.classList.toggle('error', error);
  b.hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
}

// ---------- status & list ----------

async function renderStatus() {
  const { info } = state;
  const storeError = await api.storeError();
  const rows = [];
  if (storeError) rows.push(el('div', { class: 'warn' }, `Supabase error: ${storeError}`));
  else if (info.storeKind === 'supabase') rows.push(el('div', { class: 'ok' }, `Supabase · ${new URL(info.storeLabel).host}`));
  else rows.push(el('div', { class: 'warn', title: info.storeLabel }, 'Saving on this computer (Supabase not set up)'));
  rows.push(
    info.notes
      ? el('div', { class: 'ok' }, `AI notes: ${info.notes.name === 'openrouter' ? 'Claude via OpenRouter' : 'Claude'}`)
      : el('div', { class: 'warn' }, 'AI notes: no key set'),
  );
  $('status').replaceChildren(...rows);
}

// Sidebar switch between on-device Whisper and Deepgram. Locked while recording.
function renderEngineSwitch() {
  const { engines, transcription } = state.info;
  const current = engines.find((e) => e.id === transcription.kind);
  const buttons = engines.map((e) =>
    el(
      'button',
      {
        role: 'radio',
        'aria-checked': String(e.id === transcription.kind),
        title: e.detail,
        onclick: () => switchEngine(e.id),
      },
      e.label,
    ),
  );
  buttons.forEach((b, i) => {
    b.disabled = Boolean(state.rec) || !engines[i].available;
  });
  $('engine-switch').replaceChildren(...buttons);
  $('engine-detail').textContent = state.rec ? 'Stop recording to switch.' : current?.detail ?? '';
}

async function switchEngine(id) {
  if (state.rec || id === state.info.transcription.kind) return;
  try {
    state.info = await api.setEngine(id);
  } catch (err) {
    showBanner(err.message, { error: true });
  }
  renderEngineSwitch();
}

async function loadList() {
  const q = $('search').value;
  try {
    state.meetings = await api.searchMeetings(q);
  } catch (err) {
    state.meetings = [];
    showBanner(`Couldn't load meetings: ${err.message}`, { error: true });
  }
  renderList();
}

function renderList() {
  const nav = $('meeting-list');
  if (state.meetings.length === 0) {
    nav.replaceChildren(el('div', { class: 'list-empty' }, $('search').value ? 'No matches.' : 'No meetings yet.'));
    return;
  }
  const nodes = [];
  let lastDay = null;
  for (const m of state.meetings) {
    const day = dayLabel(m.started_at);
    if (day !== lastDay) {
      nodes.push(el('div', { class: 'group-label' }, day));
      lastDay = day;
    }
    const live = state.rec?.meetingId === m.id;
    nodes.push(
      el(
        'button',
        { class: `meeting-item${state.current?.id === m.id ? ' active' : ''}`, onclick: () => openMeeting(m.id) },
        el('span', { class: 't' }, m.title || 'Untitled meeting'),
        el('span', { class: 's' }, live ? el('span', { class: 'live' }, '● Recording') : `${timeOf(m.started_at)}${m.source_app ? ` · ${m.source_app}` : ''}`),
      ),
    );
  }
  nav.replaceChildren(...nodes);
}

// ---------- meeting view ----------

async function openMeeting(id) {
  await saveNotes.flush();
  try {
    state.current = await api.getMeeting(id);
  } catch (err) {
    showBanner(`Couldn't open that meeting: ${err.message}`, { error: true });
    return;
  }
  renderMeeting();
  renderList();
}

function renderMeta() {
  const m = state.current;
  const bits = [new Date(m.started_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })];
  if (m.source_app) bits.push(m.source_app);
  if (m.ended_at) bits.push(clock((new Date(m.ended_at) - new Date(m.started_at)) / 1000));
  $('meta').textContent = bits.join(' · ');
}

function renderMeeting() {
  const m = state.current;
  $('empty').hidden = true;
  $('meeting').hidden = false;
  hideBanner();
  $('title').value = m.title;
  $('user-notes').value = m.user_notes ?? '';
  renderMeta();
  renderAiNotes(m.enhanced_notes);
  renderTranscript(m.segments ?? []);
  renderRecordButton();
}

function renderAiNotes(markdown) {
  const box = $('ai-notes');
  if (markdown) box.innerHTML = renderMarkdown(markdown);
  else box.replaceChildren(el('div', { class: 'placeholder' }, 'After the meeting, click "Write AI notes". Claude combines your notes with the transcript into a clean summary with action items.'));
  $('enhance').textContent = markdown ? 'Rewrite AI notes' : 'Write AI notes';
}

function segmentNode(seg, interim = false) {
  const you = seg.channel === 0;
  return el(
    'div',
    { class: `seg ${you ? 'you' : 'them'}${interim ? ' interim' : ''}` },
    el('div', { class: 'who' }, seg.speaker, el('time', {}, clock(seg.start_sec ?? seg.start ?? 0))),
    el('div', { class: 'txt' }, seg.text),
  );
}

function renderTranscript(segments) {
  const box = $('transcript');
  state.interim.clear();
  if (segments.length === 0) {
    const live = state.rec?.meetingId === state.current?.id;
    const onDevice = state.info?.transcription?.kind === 'local';
    const listening = onDevice
      ? 'Listening… each line appears a moment after someone finishes speaking.'
      : 'Listening… words will appear here as people talk.';
    box.replaceChildren(el('div', { class: 'placeholder' }, live ? listening : 'No transcript yet. Start recording and it will appear here live.'));
  } else {
    box.replaceChildren(...segments.map((s) => segmentNode(s)));
    box.scrollTop = box.scrollHeight;
  }
  $('transcript-hint').textContent = lineCount();
}

function onTranscript(seg) {
  if (!state.rec || state.current?.id !== state.rec.meetingId) return;
  const box = $('transcript');
  box.querySelector('.placeholder')?.remove();
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;

  const prev = state.interim.get(seg.channel);
  if (!seg.isFinal) {
    const node = segmentNode(seg, true);
    if (prev) prev.replaceWith(node);
    else box.append(node);
    state.interim.set(seg.channel, node);
  } else {
    prev?.remove();
    state.interim.delete(seg.channel);
    if (!seg.dropped) {
      box.append(segmentNode(seg));
      state.current.segments.push({ ...seg, start_sec: seg.start, end_sec: seg.end });
      $('transcript-hint').textContent = `${state.current.segments.length} lines`;
    }
  }
  if (stick) box.scrollTop = box.scrollHeight;
}

const saveNotes = debounce(async () => {
  const m = state.current;
  if (!m) return;
  const user_notes = $('user-notes').value;
  if (user_notes === m.user_notes) return;
  m.user_notes = user_notes;
  try {
    await api.updateMeeting(m.id, { user_notes });
  } catch (err) {
    showBanner(`Couldn't save your notes: ${err.message}`, { error: true });
  }
}, 600);

async function saveTitle() {
  const m = state.current;
  const title = $('title').value.trim() || 'Untitled meeting';
  if (!m || title === m.title) return;
  m.title = title;
  await api.updateMeeting(m.id, { title });
  const item = state.meetings.find((x) => x.id === m.id);
  if (item) item.title = title;
  renderList();
}

async function newMeeting({ source_app = null, autoStart = false } = {}) {
  if (state.rec) {
    showBanner('Stop the current recording before starting a new meeting.', { error: true });
    return;
  }
  const title = source_app ? `${source_app} meeting, ${timeOf(new Date().toISOString())}` : 'Untitled meeting';
  try {
    const m = await api.createMeeting({ title, source_app });
    await loadList();
    await openMeeting(m.id);
    if (autoStart) await startRecording();
    else $('title').select();
  } catch (err) {
    showBanner(`Couldn't create a meeting: ${err.message}`, { error: true });
  }
}

async function deleteMeeting() {
  const m = state.current;
  if (!m) return;
  if (state.rec?.meetingId === m.id) {
    showBanner('Stop recording before deleting this meeting.', { error: true });
    return;
  }
  if (!confirm(`Delete "${m.title}" and its transcript? This can't be undone.`)) return;
  await api.deleteMeeting(m.id);
  state.current = null;
  $('meeting').hidden = true;
  $('empty').hidden = false;
  await loadList();
}

// ---------- recording ----------

function renderRecordButton() {
  const btn = $('record');
  const live = state.rec && state.rec.meetingId === state.current?.id;
  const busyElsewhere = state.rec && !live;
  btn.classList.toggle('on', Boolean(live));
  btn.textContent = live ? 'Stop' : state.current?.ended_at ? 'Resume recording' : 'Start recording';
  btn.disabled = Boolean(busyElsewhere);
  btn.title = busyElsewhere ? 'Another meeting is recording' : '';
  $('meters').hidden = !live;
  $('timer').hidden = !live;
  renderEngineSwitch();
}

function setLevel(level) {
  // RMS of speech is small; scale it so normal talking fills most of the bar.
  const pct = (v) => `${Math.min(100, Math.round(Math.sqrt(v) * 260))}%`;
  $('meter-you').style.width = pct(level[0]);
  $('meter-them').style.width = pct(level[1]);
}

async function startRecording() {
  const m = state.current;
  if (!m || state.rec) return;
  const btn = $('record');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    await api.startRecording(m.id);
    let capture;
    try {
      capture = await startCapture({ onChunk: (pcm) => api.sendAudio(pcm), onLevel: setLevel });
    } catch (err) {
      await api.stopRecording();
      throw err;
    }
    state.rec = { meetingId: m.id, capture, startedAt: Date.now() };
    state.rec.tick = setInterval(() => {
      $('timer').textContent = clock((Date.now() - state.rec.startedAt) / 1000);
    }, 500);
    $('timer').textContent = '00:00';
    hideBanner();
    if (m.segments.length === 0) renderTranscript([]);
  } catch (err) {
    showBanner(`Couldn't start recording: ${err.message}`, { error: true });
  } finally {
    btn.disabled = false;
    renderRecordButton();
    renderList();
  }
}

async function stopRecording() {
  const rec = state.rec;
  if (!rec) return;
  $('record').disabled = true;
  $('record').textContent = 'Finishing…';
  clearInterval(rec.tick);
  await rec.capture.stop().catch(() => {});
  try {
    const updated = await api.stopRecording();
    if (updated && state.current?.id === updated.id) {
      state.current.ended_at = updated.ended_at;
      renderMeta();
    }
  } catch (err) {
    showBanner(`Problem while stopping: ${err.message}`, { error: true });
  }
  state.rec = null;
  for (const node of state.interim.values()) node.remove();
  state.interim.clear();
  renderRecordButton();
  renderList();
  if (state.current?.id === rec.meetingId && state.current.segments.length > 0) {
    showBanner('Recording saved. Want a clean write-up?', { actions: [['Write AI notes', () => { hideBanner(); enhance(); }, 'primary']] });
  }
}

function lineCount() {
  const n = state.current?.segments?.length ?? 0;
  return n ? `${n} lines` : '';
}

function onRecordingStatus(s) {
  const hint = $('transcript-hint');
  const mb = (b) => Math.round(b / 1e6);
  switch (s.state) {
    case 'downloading':
      // Also fires while loading an already-downloaded model; only show real downloads.
      if (s.loaded < s.total) hint.textContent = `Downloading speech model: ${mb(s.loaded)} of ${mb(s.total)} MB (first time only)`;
      break;
    case 'ready':
    case 'reconnected':
      hint.textContent = lineCount();
      break;
    case 'transcribing':
      hint.textContent = `${lineCount() ? `${lineCount()} · ` : ''}transcribing…`;
      break;
    case 'reconnecting':
    case 'stalled':
      hint.textContent = 'Connection dropped. Reconnecting; your audio is being kept.';
      break;
  }
}

// ---------- AI notes ----------

function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  $('user-notes').hidden = name !== 'mine';
  $('ai-pane').hidden = name !== 'ai';
}

async function enhance() {
  const m = state.current;
  if (!m || state.aiBusy) return;
  showTab('ai');
  if (!state.info.notes) {
    $('ai-status').textContent = 'Add OPENROUTER_API_KEY or ANTHROPIC_API_KEY to .env and restart to use AI notes.';
    return;
  }
  await saveNotes.flush();
  if ((m.segments?.length ?? 0) === 0 && !m.user_notes.trim()) {
    $('ai-status').textContent = 'Nothing to work from yet: record the meeting or type some notes first.';
    return;
  }
  state.aiBusy = true;
  state.aiBuffer = '';
  $('enhance').disabled = true;
  $('ai-status').textContent = 'Writing…';
  $('ai-notes').replaceChildren(el('div', { class: 'placeholder' }, 'Reading the transcript…'));
  try {
    const { markdown, model, notice } = await api.enhanceNotes(m.id);
    if (state.current?.id === m.id) {
      m.enhanced_notes = markdown;
      renderAiNotes(markdown);
    }
    $('ai-status').textContent = notice ?? `Saved · written by ${model}`;
  } catch (err) {
    // Electron prefixes errors from the main process; show just our message.
    const msg = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    $('ai-status').textContent = `Couldn't write notes: ${msg}`;
    if (state.current?.id === m.id) renderAiNotes(m.enhanced_notes);
  } finally {
    state.aiBusy = false;
    $('enhance').disabled = false;
  }
}

function onNotesDelta({ meetingId, delta }) {
  if (state.current?.id !== meetingId) return;
  state.aiBuffer += delta;
  $('ai-notes').innerHTML = renderMarkdown(state.aiBuffer);
}

// ---------- meeting detection ----------

function onMeetingDetected(appName) {
  if (state.rec) return;
  showBanner(`${appName} is using your microphone. Take notes for this meeting?`, {
    actions: [
      ['Start notes', () => newMeeting({ source_app: appName, autoStart: true }), 'primary'],
      ['Dismiss', hideBanner, 'ghost'],
    ],
  });
}

function onMeetingEnded(appName) {
  if (!state.rec) return;
  showBanner(`${appName} stopped using your microphone. Did the meeting end?`, {
    actions: [
      ['Stop recording', stopRecording, 'primary'],
      ['Keep going', hideBanner, 'ghost'],
    ],
  });
}

// ---------- smoke test (npm run smoke) ----------

async function runSmoke() {
  const result = { ok: false, store: state.info.storeKind };
  try {
    result.meetings = (await api.listMeetings()).length;
    let chunks = 0;
    let bytes = 0;
    const peak = [0, 0];
    const capture = await startCapture({
      onChunk: (pcm) => {
        chunks++;
        bytes += pcm.byteLength;
      },
      onLevel: (l) => {
        peak[0] = Math.max(peak[0], l[0]);
        peak[1] = Math.max(peak[1], l[1]);
      },
    });
    await new Promise((r) => setTimeout(r, 3000));
    await capture.stop();
    Object.assign(result, { chunks, bytes, peak, micLabel: capture.micLabel, ok: chunks >= 20 && bytes === chunks * 6400 });
    const md = renderMarkdown('# T\n- [ ] A: do it\n**b**');
    result.markdown = md.includes('<h1>T</h1>') && md.includes('class="task"');
    result.ok = result.ok && result.markdown;
  } catch (err) {
    result.error = err.message;
  }
  api.smokeResult(result);
}

// ---------- wire up ----------

async function init() {
  state.info = await api.info();
  if (state.info.smoke) return runSmoke();

  await renderStatus();
  renderEngineSwitch();
  await loadList();

  $('new-meeting').addEventListener('click', () => newMeeting());
  $('empty-new').addEventListener('click', () => newMeeting());
  $('search').addEventListener('input', debounce(loadList, 250));
  $('title').addEventListener('change', saveTitle);
  $('title').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());
  $('user-notes').addEventListener('input', () => saveNotes());
  $('record').addEventListener('click', () => (state.rec ? stopRecording() : startRecording()));
  $('delete').addEventListener('click', deleteMeeting);
  $('enhance').addEventListener('click', enhance);
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));

  api.onTranscript(onTranscript);
  api.onRecordingError((msg) => showBanner(msg, { error: true }));
  api.onRecordingStatus(onRecordingStatus);
  api.onNotesDelta(onNotesDelta);
  api.onMeetingDetected(onMeetingDetected);
  api.onStartRequested((appName) => newMeeting({ source_app: appName, autoStart: true }));
  api.onMeetingEnded(onMeetingEnded);

  window.addEventListener('beforeunload', () => saveNotes.flush());
}

init();
