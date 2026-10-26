// The only bridge between the UI and the main process. The page gets these
// functions and nothing else: no Node, no API keys.

const { contextBridge, ipcRenderer } = require('electron');

function on(channel) {
  return (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  storeError: () => ipcRenderer.invoke('app:store-error'),

  listMeetings: () => ipcRenderer.invoke('meetings:list'),
  searchMeetings: (q) => ipcRenderer.invoke('meetings:search', q),
  getMeeting: (id) => ipcRenderer.invoke('meetings:get', id),
  createMeeting: (input) => ipcRenderer.invoke('meetings:create', input),
  updateMeeting: (id, patch) => ipcRenderer.invoke('meetings:update', id, patch),
  deleteMeeting: (id) => ipcRenderer.invoke('meetings:delete', id),

  startRecording: (meetingId) => ipcRenderer.invoke('rec:start', meetingId),
  sendAudio: (chunk) => ipcRenderer.send('rec:audio', chunk),
  stopRecording: () => ipcRenderer.invoke('rec:stop'),
  onTranscript: on('rec:transcript'),
  onRecordingError: on('rec:error'),

  enhanceNotes: (meetingId) => ipcRenderer.invoke('notes:enhance', meetingId),
  onNotesDelta: on('notes:delta'),

  onMeetingDetected: on('detect:started'),
  onStartRequested: on('detect:start-requested'),
  onMeetingEnded: on('detect:ended'),

  smokeResult: (result) => ipcRenderer.send('smoke:result', result),
});
