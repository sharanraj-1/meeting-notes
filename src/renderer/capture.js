// Captures your mic and your computer's audio, mixes them into one 2-channel
// 16 kHz stream (left = mic, right = computer), and hands out PCM chunks.

export async function startCapture({ onChunk, onLevel }) {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });

  let display;
  try {
    // The main process answers this with Windows loopback audio (see main.js).
    display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  } catch (err) {
    mic.getTracks().forEach((t) => t.stop());
    throw new Error(`Couldn't capture computer audio: ${err.message}`);
  }
  display.getVideoTracks().forEach((t) => t.stop()); // we only want the sound
  const systemTracks = display.getAudioTracks();
  if (systemTracks.length === 0) {
    mic.getTracks().forEach((t) => t.stop());
    throw new Error("Couldn't capture computer audio: no audio track was returned.");
  }

  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('pcm-worklet.js');

  const merger = ctx.createChannelMerger(2);
  ctx.createMediaStreamSource(mic).connect(merger, 0, 0);
  ctx.createMediaStreamSource(new MediaStream(systemTracks)).connect(merger, 0, 1);

  const node = new AudioWorkletNode(ctx, 'pcm-interleaver', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
  });
  merger.connect(node);
  // A worklet only runs while connected to the output; route it through a muted gain.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  node.port.onmessage = (e) => {
    onChunk?.(e.data.pcm);
    onLevel?.(e.data.level);
  };

  return {
    micLabel: mic.getAudioTracks()[0]?.label ?? 'Microphone',
    async stop() {
      node.port.onmessage = null;
      mic.getTracks().forEach((t) => t.stop());
      display.getTracks().forEach((t) => t.stop());
      await ctx.close();
    },
  };
}
