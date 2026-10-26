# Meeting Notes

A Granola-style meeting notetaker for Windows. It records your meetings **without joining the call**, transcribes them **on your own computer for free** (or live with Deepgram if you add a key), writes clean notes with Claude, and stores everything in Supabase.

## How it works

Granola doesn't add a bot to your Zoom or Teams call. It listens to two things on your own computer, and so does this app:

| What | How | Shows up as |
| --- | --- | --- |
| Your voice | Your microphone (`getUserMedia`) | **You** |
| Everyone else | Windows *loopback* audio: a copy of whatever your speakers or headphones are playing (`getDisplayMedia` + Electron's `audio: 'loopback'`) | **Them** / **Speaker 1, 2…** |

```
 mic ──────────┐                          ┌─► on-device Whisper (free, default) ─┐
               ├─► 2-channel 16 kHz PCM ─┤                                       ├─► transcript ─► Supabase
 speakers ─────┘     (audio worklet)      └─► Deepgram (live, if you add a key) ──┘        │
 (loopback)                                                                                ▼
                               your rough notes + transcript ─► Claude (OpenRouter or Anthropic) ─► AI notes
```

- **Meeting detection.** Every few seconds the app checks which programs are using your microphone (Windows records this in the registry). When Zoom, Teams, Webex, Slack, WhatsApp, Discord or a browser starts using it, you get a notification offering to take notes.
- **Echo filter.** On speakers, your mic also picks up the other people. The app drops "You" lines that just repeat what came through the computer audio. Headphones still give the cleanest transcript.
- **Two ways to transcribe.** With no key, OpenAI's open-source Whisper model runs on your PC: free and private, and nothing leaves your computer. Lines appear a moment after each person finishes a sentence. Add a Deepgram key and you get word-by-word live text, better accuracy and speaker labels for the other side.
- **Built to survive bad Wi-Fi (Deepgram).** Modelled on how Granola's own client behaves (found by reverse-engineering it with REA): it reconnects automatically, keeps up to 2 minutes of audio while offline and sends it once it's back, notices a connection that has silently died, and lets you give it names and jargon to spell right (`DEEPGRAM_KEYTERMS`).
- **Keys stay safe.** All keys live only in the app's main process. The window never sees them.

## 1. What you need

- Windows 10 or 11
- Node.js 22 or newer (`node --version`)
- **For AI notes, one of:** an **OpenRouter** key (<https://openrouter.ai/settings/keys>) or an **Anthropic** key (<https://console.anthropic.com/settings/keys>). Either runs Claude; you pay per use, usually well under $0.50 for an hour-long meeting.
- **Optional:** a **Deepgram** key for faster live transcription (<https://console.deepgram.com>, *API Keys → Create a New API Key*). Without it, transcription runs free on your PC. Deepgram bills per minute of audio *per channel*, and this app sends two (you + them).
- **Docker Desktop**, for local Supabase (step 4). Optional to start: without it, meetings are saved to a file on your computer.

## 2. Install

Open a terminal (Windows Terminal or PowerShell from the Start menu) and run:

```bash
cd C:\Users\vepam\Projects\meeting-notes
npm install
```

## 3. Add your keys and run it

Copy the example settings file:

```bash
copy .env.example .env
```

Open `.env` in any editor and paste in your AI notes key:

```ini
OPENROUTER_API_KEY=your-openrouter-key
```

That's all you need. Every other setting in `.env` is optional and explained there.

Start the app:

```bash
npm start
```

The bottom-left corner shows what's connected. You can record and get AI notes straight away; meetings are saved to `data/meetings.json` in the project until you set up Supabase. The first recording downloads the speech model (about 80 MB) into `data/models`; after that it works offline.

## 4. Set up Supabase locally

Supabase runs on your computer inside Docker: a real Postgres database, plus a web dashboard called Studio.

**4a. Install Docker Desktop** (one time). Download it from <https://www.docker.com/products/docker-desktop/>, run the installer, and keep "Use WSL 2" ticked. Windows may ask to restart. Open Docker Desktop once and wait until it says *Engine running*.

**4b. Start Supabase** (the first run downloads a few GB of images, so give it a while):

```bash
npm run db:start
```

This starts Postgres and the Supabase services, and creates the `meetings` and `transcript_segments` tables from `supabase/migrations/`.

**4c. Connect the app to it.** This copies the local URL and secret key into `.env` for you:

```bash
npm run db:env
```

**4d. Restart the app** (`npm start`). The corner should now say **Supabase · 127.0.0.1:54321**.

**Look at your data.** Open Supabase Studio at <http://127.0.0.1:54323>. Under *Table Editor* you'll see `meetings` and `transcript_segments` filling up as you record. *SQL Editor* lets you run queries, for example:

```sql
select speaker, count(*), sum(end_sec - start_sec)::int as seconds
from transcript_segments
group by speaker;
```

**Day-to-day Supabase commands**

| Command | What it does |
| --- | --- |
| `npm run db:start` | Start local Supabase (Docker Desktop must be running) |
| `npm run db:stop` | Stop it. Your data is kept. |
| `npm run db:status` | Show URLs and keys |
| `npm run db:reset` | **Wipe the database** and rebuild it from `supabase/migrations/` |
| `npx supabase migration new <name>` | Create a new migration file for schema changes |

Meetings saved before you connected Supabase stay in the local file and aren't copied over.

**Prefer hosted Supabase?** Create a free project at <https://supabase.com>, paste `supabase/migrations/20261020000000_init.sql` into its SQL Editor and run it, then put the project URL and its **secret** key (*Project Settings → API Keys*) into `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env`.

## 5. Using the app

1. **Start a meeting.** Click **New meeting**, or join a call: when Zoom, Teams or similar grabs your mic you'll get a notification, and clicking it starts recording.
2. **Record.** Click **Start recording**. The *You* and *Them* meters show both audio sources are coming through; the transcript fills in live on the right.
3. **Jot notes.** Type rough notes in *My notes* while you talk. They save automatically.
4. **Stop**, then click **Write AI notes**. Claude uses your notes as the outline and the transcript for the detail, and adds action items.
5. **Search** from the sidebar across titles, notes and transcripts.

**Before you record anyone, tell them.** Recording laws differ by country and state, and many require everyone's consent.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the app |
| `npm test` | Unit tests (Deepgram reconnects and replay, speech segmenter, echo filter, meeting detection, storage, AI notes, Markdown) |
| `npm run smoke` | Opens the app hidden, captures 3 s of mic + computer audio, checks it, and exits. Nothing is saved or sent. |

## Project layout

```
src/main/main.js            window, loopback audio handler, recording, IPC
src/main/deepgram.js        Deepgram live transcription: reconnect, audio replay, stall detection, keyterms
src/main/localAsr.js        free on-device transcription (starts the worker below)
src/main/localAsrWorker.js  runs Whisper in its own process so the window never freezes
src/main/segmenter.js       cuts audio into sentences at pauses; filters Whisper's noise "words"
src/main/echo.js            drops your mic picking up the call from speakers
src/main/meetingDetector.js notices Zoom/Teams/etc. using the mic
src/main/notes.js           AI notes with Claude Opus 5.5, via Anthropic or OpenRouter (streamed)
src/main/db.js              Supabase store + local-file fallback
src/main/preload.js         the only functions the window can call
src/renderer/               the UI (plain HTML/CSS/JS, no build step)
src/renderer/pcm-worklet.js mixes mic + computer audio into 16-bit PCM
supabase/migrations/        database schema
scripts/sync-supabase-env.js copies local Supabase URL/key into .env
```

## Troubleshooting

- **"AI notes: no key set"**: check `.env` is in the project folder (not `.env.txt`), has `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`, and restart the app.
- **On-device transcription is slow or inaccurate**: it runs on your CPU. Close heavy apps, or add a Deepgram key. For better accuracy at some speed cost, set `LOCAL_WHISPER_MODEL=onnx-community/whisper-small.en`.
- **"Your OpenRouter account is out of credits (402)"**: top up at <https://openrouter.ai/settings/credits>.
- **Deepgram rejected the API key (401)**: copy the key again from the Deepgram console.
- **"Them" meter never moves**: play something (a YouTube video) to test. Loopback records your *default* playback device; if the call plays through a different device, make it the default in Windows sound settings.
- **"You" meter never moves**: Windows Settings → Privacy & security → Microphone → allow desktop apps to access your microphone.
- **Your lines show up twice or as "Them"**: wear headphones.
- **`npm run db:start` fails**: make sure Docker Desktop is open and says *Engine running*.
- **"Supabase error" in the corner**: Supabase isn't running (`npm run db:start`), or `.env` has old values (`npm run db:env`).
- **No meeting notification**: Windows notifications must be on for Electron, and detection only covers the apps listed in `src/main/meetingDetector.js`.
