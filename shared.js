// Shared helpers used by both index.html (athlete quiz) and admin.html (coach panel).

export async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function randomSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, "0")).join("");
}

// answerHash = sha256(correctOptionText + "|" + salt), computed when a question is authored.
// Grading re-hashes the selected option the same way and compares. This is light
// obfuscation (keeps the answer out of plain view in the network tab / page source)
// not real security — a determined athlete could still hash each visible option
// client-side and compare. Fine for a casual team trivia game.
export async function isCorrect(question, selectedOptionText) {
  const h = await sha256(selectedOptionText + "|" + question.salt);
  return h === question.answerHash;
}

function toMillis(ts) {
  if (!ts) return Date.now();
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts.seconds != null) return ts.seconds * 1000;
  return Date.now();
}

// Scoring: every correct answer earns pointsPerCorrect. Athletes who answer
// every question correctly also split a speed bonus (bonusTiers), awarded in
// order of server-recorded submit time — first perfect submission gets the
// biggest bonus, and it steps down from there. This rewards partial correctness
// for everyone while still making "first with a perfect score" worth the most.
export function computeLeaderboard(responses, game) {
  const pointsPerCorrect = game?.pointsPerCorrect ?? 10;
  const bonusTiers = game?.bonusTiers ?? [50, 30, 20, 10, 5];

  const withMs = responses.map(r => ({ ...r, _ms: toMillis(r.submittedAt) }));
  const byTime = [...withMs].sort((a, b) => a._ms - b._ms);

  let bonusIdx = 0;
  const scored = byTime.map(r => {
    let bonus = 0;
    if (r.perfect) {
      bonus = bonusTiers[bonusIdx] ?? bonusTiers[bonusTiers.length - 1] ?? 0;
      bonusIdx++;
    }
    const basePoints = (r.correctCount || 0) * pointsPerCorrect;
    return { ...r, basePoints, bonus, total: basePoints + bonus };
  });

  return scored.sort((a, b) => b.total - a.total || a._ms - b._ms);
}

export function fmtDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function gameLabel(game) {
  return `${game.opponent}${game.location ? " — " + game.location : ""}`;
}

// ---------- Word search ----------

const WS_DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export function normalizeWsWord(word) {
  return String(word || "").toUpperCase().replace(/[^A-Z]/g, "");
}

// Places every word into a square letter grid (random position + one of 8
// directions per word, longest words first so they have the most room),
// then fills empty cells with random letters. Throws if a word can't be
// placed after many attempts — the caller should shorten words or drop one.
export function generateWordSearch(words, size) {
  const clean = words.map(normalizeWsWord).filter(Boolean);
  const gridSize = size || Math.max(12, Math.min(16, Math.max(...clean.map(w => w.length)) + 3));
  const grid = Array.from({ length: gridSize }, () => Array(gridSize).fill(null));
  const placements = [];

  const sorted = [...clean].sort((a, b) => b.length - a.length);
  for (const word of sorted) {
    let placed = false;
    for (let attempt = 0; attempt < 300 && !placed; attempt++) {
      const dir = WS_DIRS[Math.floor(Math.random() * WS_DIRS.length)];
      const r0 = Math.floor(Math.random() * gridSize);
      const c0 = Math.floor(Math.random() * gridSize);
      const cells = [];
      let ok = true;
      for (let i = 0; i < word.length; i++) {
        const r = r0 + dir[0] * i;
        const c = c0 + dir[1] * i;
        if (r < 0 || r >= gridSize || c < 0 || c >= gridSize) { ok = false; break; }
        const existing = grid[r][c];
        if (existing && existing !== word[i]) { ok = false; break; }
        cells.push([r, c]);
      }
      if (ok) {
        cells.forEach(([r, c], i) => { grid[r][c] = word[i]; });
        placements.push({ word, cells });
        placed = true;
      }
    }
    if (!placed) throw new Error(`Couldn't fit "${word}" in the grid — try shorter words or fewer of them.`);
  }

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (!grid[r][c]) grid[r][c] = String.fromCharCode(65 + Math.floor(Math.random() * 26));
    }
  }

  return { grid, gridSize, placements };
}

// Returns the straight-line path of [row,col] cells between two points
// (inclusive), or null if the two points don't form a horizontal, vertical,
// or diagonal line.
export function wsLinePath(r1, c1, r2, c2) {
  const dr = Math.sign(r2 - r1);
  const dc = Math.sign(c2 - c1);
  if (r1 !== r2 && c1 !== c2 && Math.abs(r2 - r1) !== Math.abs(c2 - c1)) return null;
  const len = Math.max(Math.abs(r2 - r1), Math.abs(c2 - c1)) + 1;
  const path = [];
  for (let i = 0; i < len; i++) path.push([r1 + dr * i, c1 + dc * i]);
  return path;
}

// Checks a selected cell path against the placed words, in either direction.
// Returns the matched word string, or null.
export function wsMatchWord(path, placements, alreadyFound) {
  if (!path) return null;
  for (const p of placements) {
    if (alreadyFound && alreadyFound.has(p.word)) continue;
    if (p.cells.length !== path.length) continue;
    const forward = p.cells.every((c, i) => c[0] === path[i][0] && c[1] === path[i][1]);
    const backward = p.cells.every((c, i) => c[0] === path[path.length - 1 - i][0] && c[1] === path[path.length - 1 - i][1]);
    if (forward || backward) return p.word;
  }
  return null;
}
