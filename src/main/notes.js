// AI meeting notes, Granola style: your rough notes are the outline, the
// transcript fills in the detail. Streams Markdown back as Claude writes it.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';

const SYSTEM_PROMPT = `You turn a meeting into clear, useful notes.

You get two things: the notes the user typed during the meeting, and a transcript.
In the transcript, "You" is the user and every other label is someone else on the call.

Write the notes in Markdown:
- Start with a one-line "# " title that says what the meeting was about.
- Use the user's own notes as the backbone. Keep every point they wrote, in their order and wording where it works, and fill in the detail the transcript adds. A topic that only appears in the transcript still gets covered if it mattered.
- Group by topic under "## " headings, with short bullets.
- End with "## Action items" as "- [ ] Owner: task (due date if one was said)". Leave it out if nobody committed to anything.
- Stick to what was actually said. If something is unclear in the transcript, say so instead of guessing. Don't invent names, numbers or dates.
- Be concise. No preamble, no closing remarks, just the notes.`;

function formatTranscript(segments) {
  return segments
    .map((s) => {
      const t = Math.max(0, Math.floor(s.start_sec ?? s.start ?? 0));
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(t % 60).padStart(2, '0');
      return `[${mm}:${ss}] ${s.speaker}: ${s.text}`;
    })
    .join('\n');
}

function buildUserMessage({ title, userNotes, segments }) {
  return [
    `Meeting: ${title || 'Untitled meeting'}`,
    '',
    '<my_notes>',
    userNotes?.trim() || '(I did not type any notes.)',
    '</my_notes>',
    '',
    '<transcript>',
    formatTranscript(segments) || '(No speech was transcribed.)',
    '</transcript>',
  ].join('\n');
}

// onText(delta) is called as text streams in. Resolves with the full Markdown.
async function enhanceNotes({ apiKey, title, userNotes, segments, onText, signal }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to your .env file.');
  const client = new Anthropic({ apiKey });

  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      // If a safety classifier declines, retry on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage({ title, userNotes, segments }) }],
    },
    { signal },
  );

  stream.on('text', (delta) => onText?.(delta));
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined to write notes for this meeting.');
  }
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (message.stop_reason === 'max_tokens') return `${text}\n\n_(Notes were cut off because they hit the length limit.)_`;
  return text;
}

module.exports = { enhanceNotes, buildUserMessage, formatTranscript, MODEL };
