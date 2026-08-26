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
