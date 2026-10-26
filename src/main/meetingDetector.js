// Meeting detection.
//
// Granola notices a meeting by watching which apps are using the microphone.
// Windows records this per app in the registry: while an app holds the mic,
// its LastUsedTimeStop is 0. We poll that every few seconds and fire
// "meeting-started" when a known meeting app (Zoom, Teams, a browser for
// Meet, ...) starts using the mic, and "meeting-ended" when it lets go.

const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
const POLL_MS = 4000;

// Matched against the app's registry key name, lower-cased.
const MEETING_APPS = [
  { match: /zoom\.exe$|zoom/, name: 'Zoom' },
  { match: /msteams|ms-teams\.exe$|teams\.exe$/, name: 'Microsoft Teams' },
  { match: /webex|ciscocollabhost\.exe$/, name: 'Webex' },
  { match: /slack/, name: 'Slack' },
  { match: /whatsapp/, name: 'WhatsApp' },
  { match: /discord/, name: 'Discord' },
  { match: /skype/, name: 'Skype' },
  { match: /chrome\.exe$/, name: 'Google Chrome' },
  { match: /msedge\.exe$/, name: 'Microsoft Edge' },
  { match: /firefox\.exe$/, name: 'Firefox' },
  { match: /brave\.exe$/, name: 'Brave' },
  { match: /arc\.exe$/, name: 'Arc' },
];

// Parses `reg query <ROOT> /s` output into [{ key, inUse }].
function parseRegQuery(output) {
  const apps = [];
  let current = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('HKEY_')) {
      current = { key: line.slice(line.lastIndexOf('\\') + 1), start: null, stop: null };
      apps.push(current);
      continue;
    }
    const m = line.match(/^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-fA-F]+)/);
    if (m && current) {
      const value = BigInt(m[2]);
      if (m[1] === 'LastUsedTimeStart') current.start = value;
      else current.stop = value;
    }
  }
  return apps
    .filter((a) => a.key !== 'microphone' && a.key !== 'NonPackaged')
    .map((a) => ({ key: a.key, inUse: a.start !== null && a.start > 0n && a.stop === 0n }));
}

function meetingAppName(key) {
  // Desktop apps are stored as their full path with "#" for "\".
  const k = key.toLowerCase().replaceAll('#', '\\');
  if (k.includes('electron.exe') || k.includes('meeting-notes')) return null; // that's us
  return MEETING_APPS.find((a) => a.match.test(k))?.name ?? null;
}

function queryMicUsers() {
  return new Promise((resolve) => {
    execFile('reg', ['query', ROOT, '/s'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => {
      // reg exits non-zero on some machines even when it printed everything.
      resolve(parseRegQuery(stdout || ''));
    });
  });
}

class MeetingDetector extends EventEmitter {
  constructor() {
    super();
    this.active = new Set();
    this.timer = null;
  }

  start() {
    if (process.platform !== 'win32' || this.timer) return;
    const tick = async () => {
      const users = await queryMicUsers();
      const now = new Set(users.filter((u) => u.inUse).map((u) => meetingAppName(u.key)).filter(Boolean));
      for (const app of now) if (!this.active.has(app)) this.emit('meeting-started', app);
      for (const app of this.active) if (!now.has(app)) this.emit('meeting-ended', app);
      this.active = now;
    };
    tick();
    this.timer = setInterval(tick, POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { MeetingDetector, parseRegQuery, meetingAppName };
