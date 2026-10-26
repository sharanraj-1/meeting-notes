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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'anthropic/claude-opus-5.5';

// Picks the provider from whichever key is set. Anthropic first, then OpenRouter.
function notesProvider(env = process.env) {
  if (env.ANTHROPIC_API_KEY) return { name: 'anthropic', model: MODEL };
  if (env.OPENROUTER_API_KEY) return { name: 'openrouter', model: OPENROUTER_MODEL };
  return null;
}

// onText(delta) is called as text streams in. Resolves with the full Markdown.
async function enhanceNotes({ anthropicKey, openrouterKey, ...rest }) {
  if (anthropicKey) return enhanceWithAnthropic({ apiKey: anthropicKey, ...rest });
  if (openrouterKey) return enhanceWithOpenRouter({ apiKey: openrouterKey, ...rest });
  throw new Error('No AI key set. Add ANTHROPIC_API_KEY or OPENROUTER_API_KEY to your .env file.');
}

// OpenRouter speaks the OpenAI chat format and streams Server-Sent Events.
async function enhanceWithOpenRouter({ apiKey, title, userNotes, segments, onText, signal, fetchImpl = fetch }) {
  const res = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Meeting Notes',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      stream: true,
      max_tokens: 16000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage({ title, userNotes, segments }) },
      ],
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message ?? '';
    } catch {
      /* not JSON */
    }
    if (res.status === 401) throw new Error('OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY in .env.');
    if (res.status === 402) throw new Error('Your OpenRouter account is out of credits (402).');
    throw new Error(`OpenRouter error ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  let text = '';
  let finish = null;
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // ": OPENROUTER PROCESSING" keep-alives etc.
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (evt.error) throw new Error(`OpenRouter: ${evt.error.message ?? 'stream error'}`);
      const choice = evt.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        onText?.(delta);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
  }
  if (!text.trim()) throw new Error(finish === 'content_filter' ? 'The model declined to write notes for this meeting.' : 'OpenRouter returned no text.');
  if (finish === 'length') return `${text}\n\n_(Notes were cut off because they hit the length limit.)_`;
  return text;
}

async function enhanceWithAnthropic({ apiKey, title, userNotes, segments, onText, signal }) {
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

module.exports = { enhanceNotes, enhanceWithOpenRouter, notesProvider, buildUserMessage, formatTranscript, MODEL, OPENROUTER_MODEL };
