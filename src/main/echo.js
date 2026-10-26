// Echo filter.
//
// If you're on speakers rather than headphones, your microphone also hears the
// other people, so their words show up twice: once on the computer-audio
// channel ("Them") and again on your mic channel ("You"). Windows gives us no
// echo reference for other apps' audio, so we drop a mic segment when most of
// its words were just said on the computer-audio channel around the same time.

const WINDOW_SEC = 4;
const OVERLAP_THRESHOLD = 0.6;

function words(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function overlap(a, b) {
  const wa = words(a);
  if (wa.length === 0) return 0;
  const sb = new Set(words(b));
  let hit = 0;
  for (const w of wa) if (sb.has(w)) hit++;
  return hit / wa.length;
}

class EchoFilter {
  constructor() {
    this.recentSystem = [];
  }

  // Returns true if `seg` should be kept.
  accept(seg) {
    if (seg.channel === 1) {
      this.recentSystem.push(seg);
      this.recentSystem = this.recentSystem.filter((s) => seg.end - s.end <= WINDOW_SEC * 3);
      return true;
    }
    const nearby = this.recentSystem.filter(
      (s) => s.end >= seg.start - WINDOW_SEC && s.start <= seg.end + WINDOW_SEC,
    );
    if (nearby.length === 0) return true;
    const heard = nearby.map((s) => s.text).join(' ');
    return overlap(seg.text, heard) < OVERLAP_THRESHOLD;
  }
}

module.exports = { EchoFilter, overlap };
