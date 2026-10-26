// User settings that persist between launches (data/settings.json).
// For now: which transcription engine to use.

const fs = require('node:fs');
const path = require('node:path');

const ENGINES = ['local', 'deepgram'];

class Settings {
  constructor(file, env = process.env) {
    this.file = file;
    this.env = env;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first run */
    }
  }

  get hasDeepgramKey() {
    return Boolean(this.env.DEEPGRAM_API_KEY);
  }

  // What the user picked; until they pick, Deepgram if there's a key.
  get engineChoice() {
    const saved = this.data.transcriptionEngine;
    if (ENGINES.includes(saved)) return saved;
    return this.hasDeepgramKey ? 'deepgram' : 'local';
  }

  // What will actually run: Deepgram needs a key, so fall back to on-device without one.
  get engine() {
    return this.engineChoice === 'deepgram' && !this.hasDeepgramKey ? 'local' : this.engineChoice;
  }

  setEngine(engine) {
    if (!ENGINES.includes(engine)) throw new Error(`Unknown transcription engine: ${engine}`);
    if (engine === 'deepgram' && !this.hasDeepgramKey) throw new Error('Add DEEPGRAM_API_KEY to .env to use Deepgram.');
    this.data.transcriptionEngine = engine;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { Settings, ENGINES };
