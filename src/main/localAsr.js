// Free, on-device transcription. Same interface as DeepgramStream
// (start / sendAudio / stop, 'transcript' 'status' 'error' 'close' events),
// so main.js can use either without caring which.

const path = require('node:path');
const { EventEmitter } = require('node:events');

const WORKER = path.join(__dirname, 'localAsrWorker.js');

function modelFor(language) {
  if (process.env.LOCAL_WHISPER_MODEL) return process.env.LOCAL_WHISPER_MODEL;
  return language === 'en' ? 'onnx-community/whisper-base.en' : 'onnx-community/whisper-base';
}

// Default: an Electron utility process. Tests pass a Node child_process fork instead.
function electronFork(script, args) {
  const { utilityProcess } = require('electron');
  const child = utilityProcess.fork(script, args, { serviceName: 'On-device transcription', stdio: 'pipe' });
  return {
    send: (m) => child.postMessage(m),
    onMessage: (cb) => child.on('message', cb),
    onExit: (cb) => child.on('exit', cb),
    kill: () => child.kill(),
    stderr: child.stderr,
  };
}

class LocalTranscriber extends EventEmitter {
  constructor({ cacheDir, language = 'en', fork = electronFork }) {
    super();
    this.kind = 'local';
    this.model = modelFor(language);
    this.args = [this.model, cacheDir, language];
    this.fork = fork;
    this.child = null;
    this.drained = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const child = this.fork(WORKER, this.args);
      this.child = child;
      let started = false;
      child.stderr?.on('data', (d) => console.error(`[asr] ${d}`));
      child.onMessage((msg) => {
        switch (msg.type) {
          case 'started':
            started = true;
            child.send({ type: 'warmup' });
            resolve();
            break;
          case 'status':
            this.emit('status', msg);
            break;
          case 'pending':
            this.emit('status', { state: 'transcribing', pending: msg.count });
            break;
          case 'transcript':
            this.emit('transcript', msg.seg);
            break;
          case 'error':
            this.emit('error', new Error(msg.message));
            break;
          case 'drained':
            this.drained?.();
            break;
        }
      });
      child.onExit((code) => {
        this.drained?.();
        if (!started) reject(new Error(`On-device transcription process exited (code ${code}).`));
        else this.emit('close', { code, expected: this.stopping === true });
      });
    });
  }

  sendAudio(chunk) {
    this.child?.send({ type: 'audio', pcm: chunk });
  }

  // Finishes transcribing everything already recorded, then shuts the worker down.
  async stop() {
    if (!this.child) return;
    this.stopping = true;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 90000);
      this.drained = () => {
        clearTimeout(timer);
        resolve();
      };
      this.child.send({ type: 'stop' });
    });
    this.child.kill();
    this.child = null;
  }
}

module.exports = { LocalTranscriber, modelFor };
