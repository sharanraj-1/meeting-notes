// Storage. Supabase when SUPABASE_URL and SUPABASE_SECRET_KEY are set,
// otherwise a JSON file in the app's data folder so the app still works
// before you've set up Supabase. Both stores have the same methods.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class SupabaseStore {
  constructor(url, key) {
    const { createClient } = require('@supabase/supabase-js');
    this.kind = 'supabase';
    this.label = url;
    this.sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async check() {
    const { error } = await this.sb.from('meetings').select('id', { head: true, count: 'exact' });
    if (error) throw new Error(`Supabase: ${error.message}`);
  }

  async listMeetings() {
    const { data, error } = await this.sb
      .from('meetings')
      .select('id, title, source_app, started_at, ended_at')
      .order('started_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return data;
  }

  async searchMeetings(q) {
    const { data, error } = await this.sb.rpc('search_meetings', { q });
    if (error) throw error;
    return data.map(({ id, title, source_app, started_at, ended_at }) => ({ id, title, source_app, started_at, ended_at }));
  }

  async getMeeting(id) {
    const [{ data: meeting, error: e1 }, { data: segments, error: e2 }] = await Promise.all([
      this.sb.from('meetings').select('*').eq('id', id).single(),
      this.sb.from('transcript_segments').select('*').eq('meeting_id', id).order('start_sec'),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    return { ...meeting, segments };
  }

  async createMeeting({ title, source_app }) {
    const { data, error } = await this.sb.from('meetings').insert({ title, source_app }).select().single();
    if (error) throw error;
    return data;
  }

  async updateMeeting(id, patch) {
    const { data, error } = await this.sb.from('meetings').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async deleteMeeting(id) {
    const { error } = await this.sb.from('meetings').delete().eq('id', id);
    if (error) throw error;
  }

  async addSegment(meetingId, seg) {
    const { error } = await this.sb.from('transcript_segments').insert({
      meeting_id: meetingId,
      channel: seg.channel,
      speaker: seg.speaker,
      text: seg.text,
      start_sec: seg.start,
      end_sec: seg.end,
    });
    if (error) throw error;
  }
}

class LocalStore {
  constructor(file) {
    this.kind = 'local';
    this.label = file;
    this.file = file;
    this.data = { meetings: [], segments: [] };
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first run */
    }
    this.nextSegmentId = this.data.segments.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  async check() {}

  summary(m) {
    const { id, title, source_app, started_at, ended_at } = m;
    return { id, title, source_app, started_at, ended_at };
  }

  async listMeetings() {
    return [...this.data.meetings].sort((a, b) => b.started_at.localeCompare(a.started_at)).map((m) => this.summary(m));
  }

  async searchMeetings(q) {
    const needle = q.toLowerCase();
    const hits = new Set(
      this.data.segments.filter((s) => s.text.toLowerCase().includes(needle)).map((s) => s.meeting_id),
    );
    return (await this.listMeetings()).filter((m) => {
      const full = this.data.meetings.find((x) => x.id === m.id);
      const hay = `${full.title} ${full.user_notes} ${full.enhanced_notes ?? ''}`.toLowerCase();
      return hits.has(m.id) || hay.includes(needle);
    });
  }

  async getMeeting(id) {
    const meeting = this.data.meetings.find((m) => m.id === id);
    if (!meeting) throw new Error('Meeting not found');
    const segments = this.data.segments.filter((s) => s.meeting_id === id).sort((a, b) => a.start_sec - b.start_sec);
    return { ...meeting, segments };
  }

  async createMeeting({ title, source_app }) {
    const now = new Date().toISOString();
    const m = {
      id: crypto.randomUUID(),
      title: title || 'Untitled meeting',
      source_app: source_app ?? null,
      started_at: now,
      ended_at: null,
      user_notes: '',
      enhanced_notes: null,
      created_at: now,
      updated_at: now,
    };
    this.data.meetings.push(m);
    this.save();
    return m;
  }

  async updateMeeting(id, patch) {
    const m = this.data.meetings.find((x) => x.id === id);
    if (!m) throw new Error('Meeting not found');
    Object.assign(m, patch, { updated_at: new Date().toISOString() });
    this.save();
    return m;
  }

  async deleteMeeting(id) {
    this.data.meetings = this.data.meetings.filter((m) => m.id !== id);
    this.data.segments = this.data.segments.filter((s) => s.meeting_id !== id);
    this.save();
  }

  async addSegment(meetingId, seg) {
    this.data.segments.push({
      id: this.nextSegmentId++,
      meeting_id: meetingId,
      channel: seg.channel,
      speaker: seg.speaker,
      text: seg.text,
      start_sec: seg.start,
      end_sec: seg.end,
      created_at: new Date().toISOString(),
    });
    this.save();
  }
}

function openStore({ url, key, localFile }) {
  if (url && key) return new SupabaseStore(url, key);
  return new LocalStore(localFile);
}

module.exports = { openStore, SupabaseStore, LocalStore };
