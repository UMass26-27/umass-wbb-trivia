import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, getDocs, query, orderBy, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAILS } from "./firebase-config.js";
import { sha256, randomSalt, computeLeaderboard, fmtDate, gameLabel, normalizeWsWord, generateWordSearch } from "./shared.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const appEl = document.getElementById("app");
const whoEl = document.getElementById("whoami");

const QUIZ_BASE_URL = location.origin + location.pathname.replace(/admin\.html$/, "index.html");

let currentUser = null;
let games = [];
let activeGameId = null;
let activeTab = "questions"; // questions | qr | leaderboard | settings
let unsubLeaderboard = null;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Auth ----------

onAuthStateChanged(auth, async user => {
  currentUser = user;
  if (!user) {
    whoEl.textContent = "Not signed in";
    renderSignIn();
    return;
  }
  if (!ADMIN_EMAILS.includes(user.email)) {
    whoEl.textContent = user.email;
    renderNotAuthorized(user);
    return;
  }
  whoEl.textContent = user.email;
  await loadGamesAndRender();
});

function renderSignIn() {
  appEl.innerHTML = `
    <div class="card center">
      <h2>Coach Sign-In</h2>
      <p class="muted">Sign in with your UMass Google account to manage games and questions.</p>
      <button class="btn" id="signInBtn">Sign in with Google</button>
    </div>`;
  document.getElementById("signInBtn").addEventListener("click", () => {
    signInWithPopup(auth, new GoogleAuthProvider()).catch(e => alert(e.message));
  });
}

function renderNotAuthorized(user) {
  appEl.innerHTML = `
    <div class="card center">
      <h2>Not authorized</h2>
      <p class="muted">${escapeHtml(user.email)} isn't on the admin list for this app.</p>
      <button class="btn secondary" id="signOutBtn">Sign out</button>
    </div>`;
  document.getElementById("signOutBtn").addEventListener("click", () => signOut(auth));
}

// ---------- Games list ----------

async function loadGamesAndRender() {
  const snap = await getDocs(query(collection(db, "games"), orderBy("date", "desc")));
  games = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (activeGameId && !games.find(g => g.id === activeGameId)) activeGameId = null;
  renderShell();
}

function renderShell() {
  appEl.innerHTML = `
    <div class="card no-print">
      <h2>Season Leaderboard</h2>
      <p class="muted">Total points per athlete, summed across every away game.</p>
      <button class="btn secondary" id="openSeasonBtn">View Season Standings</button>
    </div>
    <div id="seasonPanel" class="no-print"></div>
    <div class="card no-print">
      <h2>Away Games</h2>
      <div id="gamesList"></div>
      <button class="btn secondary" id="newGameBtn">+ New Game</button>
    </div>
    <div id="newGameForm" class="no-print"></div>
    <div id="gameDetail"></div>
    <div class="card no-print">
      <h2>Nutrition Question Bank</h2>
      <p class="muted">Shared across every game — add once, reuse each trip.</p>
      <button class="btn secondary" id="openBankBtn">Manage Nutrition Bank</button>
    </div>
    <div id="bankPanel" class="no-print"></div>
    <div class="card no-print">
      <h2>Nutrition Word Bank</h2>
      <p class="muted">Single-word nutrition terms for word search rounds — shared across every game.</p>
      <button class="btn secondary" id="openWsBankBtn">Manage Nutrition Word Bank</button>
    </div>
    <div id="wsBankPanel" class="no-print"></div>
    <div class="card center no-print"><button class="btn secondary" id="signOutBtn2">Sign out</button></div>
  `;

  document.getElementById("gamesList").innerHTML = games.length
    ? games.map(g => `
        <div class="rank-row" data-game="${g.id}" style="cursor:pointer;">
          <div style="flex:1;">
            <div style="font-weight:700;">${escapeHtml(gameLabel(g))}</div>
            <div class="rank-meta">${fmtDate(g.date)}</div>
          </div>
          <span class="badge ${g.status}">${g.status}</span>
        </div>`).join("")
    : `<p class="muted">No games yet — add your first away game.</p>`;

  document.querySelectorAll("#gamesList [data-game]").forEach(el => {
    el.addEventListener("click", () => {
      activeGameId = el.getAttribute("data-game");
      activeTab = "questions";
      renderGameDetail();
    });
  });

  document.getElementById("newGameBtn").addEventListener("click", renderNewGameForm);
  document.getElementById("openBankBtn").addEventListener("click", renderBankPanel);
  document.getElementById("openWsBankBtn").addEventListener("click", renderWsBankPanel);
  document.getElementById("openSeasonBtn").addEventListener("click", renderSeasonPanel);
  document.getElementById("signOutBtn2").addEventListener("click", () => signOut(auth));

  if (activeGameId) renderGameDetail();
}

// ---------- Season leaderboard (cumulative across all games) ----------

async function computeSeasonStandings() {
  const totals = {};
  for (const g of games) {
    const respSnap = await getDocs(collection(db, "games", g.id, "responses"));
    const responses = respSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!responses.length) continue;
    const ranked = computeLeaderboard(responses, g);
    ranked.forEach((r, i) => {
      if (!totals[r.athleteName]) totals[r.athleteName] = { athleteName: r.athleteName, total: 0, gamesPlayed: 0, wins: 0 };
      totals[r.athleteName].total += r.total;
      totals[r.athleteName].gamesPlayed += 1;
      if (i === 0) totals[r.athleteName].wins += 1;
    });
  }
  return Object.values(totals).sort((a, b) => b.total - a.total);
}

async function renderSeasonPanel() {
  const el = document.getElementById("seasonPanel");
  el.innerHTML = `<div class="card center"><div class="spinner"></div></div>`;
  const standings = await computeSeasonStandings();
  el.innerHTML = `
    <div class="card">
      <h2>Season Standings</h2>
      ${standings.length ? standings.map((s, i) => `
        <div class="rank-row">
          <div class="rank-num">${i + 1}</div>
          <div class="rank-name">${escapeHtml(s.athleteName)}</div>
          <div class="rank-meta">${s.gamesPlayed} game${s.gamesPlayed === 1 ? "" : "s"}${s.wins ? ` · ${s.wins} win${s.wins === 1 ? "" : "s"}` : ""}</div>
          <div class="rank-pts">${s.total} pts</div>
        </div>`).join("") : `<p class="muted">No submissions across any game yet.</p>`}
      <button class="btn small secondary no-print" id="refreshSeasonBtn" style="margin-top:10px;">Refresh</button>
    </div>
  `;
  document.getElementById("refreshSeasonBtn").addEventListener("click", renderSeasonPanel);
}

function renderNewGameForm() {
  document.getElementById("newGameForm").innerHTML = `
    <div class="card">
      <h2>New Away Game</h2>
      <label>Opponent</label>
      <input type="text" id="ngOpponent" placeholder="e.g. Richmond">
      <label>Location (city / school)</label>
      <input type="text" id="ngLocation" placeholder="e.g. Richmond, VA — University of Richmond">
      <label>Opponent logo URL (optional, for the printout)</label>
      <input type="text" id="ngLogo" placeholder="https://... link to their athletics logo">
      <label>Game date</label>
      <input type="date" id="ngDate">
      <label>Quiz format</label>
      <select id="ngFormat">
        <option value="mc">Multiple choice only</option>
        <option value="wordsearch">Word search only</option>
        <option value="both">Both (multiple choice, then word search)</option>
      </select>
      <label>Points per correct answer</label>
      <input type="number" id="ngPoints" value="10" min="1">
      <label>Perfect-score speed bonus tiers (comma-separated, 1st place first)</label>
      <input type="text" id="ngBonus" value="50,30,20,10,5">
      <div class="error hidden" id="ngErr"></div>
      <button class="btn" id="ngSave">Create Game</button>
    </div>`;
  document.getElementById("ngSave").addEventListener("click", async () => {
    const opponent = document.getElementById("ngOpponent").value.trim();
    const location_ = document.getElementById("ngLocation").value.trim();
    const opponentLogoUrl = document.getElementById("ngLogo").value.trim();
    const date = document.getElementById("ngDate").value;
    const quizFormat = document.getElementById("ngFormat").value;
    const points = parseInt(document.getElementById("ngPoints").value, 10) || 10;
    const bonusTiers = document.getElementById("ngBonus").value.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    const errEl = document.getElementById("ngErr");
    if (!opponent || !date) {
      errEl.textContent = "Opponent and date are required.";
      errEl.classList.remove("hidden");
      return;
    }
    const ref = await addDoc(collection(db, "games"), {
      opponent, location: location_, opponentLogoUrl, date, status: "draft", quizFormat,
      pointsPerCorrect: points, bonusTiers, createdAt: Date.now()
    });
    activeGameId = ref.id;
    activeTab = "questions";
    await loadGamesAndRender();
  });
}

// ---------- Game detail (tabs) ----------

function renderGameDetail() {
  const game = games.find(g => g.id === activeGameId);
  const container = document.getElementById("gameDetail");
  if (!game) { container.innerHTML = ""; return; }

  container.innerHTML = `
    <div class="card no-print">
      <h2>${escapeHtml(gameLabel(game))} <span class="badge ${game.status}">${game.status}</span></h2>
      <p class="muted">${fmtDate(game.date)}</p>
      <div class="row-actions" style="margin-bottom:10px;">
        ${game.status !== "live" ? `<button class="btn small" id="setLiveBtn">Set Live</button>` : ""}
        ${game.status !== "closed" ? `<button class="btn small secondary" id="closeBtn">Close Quiz</button>` : ""}
        ${game.status !== "draft" ? `<button class="btn small secondary" id="reopenBtn">Back to Draft</button>` : ""}
        <button class="btn small secondary" id="editGameBtn">Edit</button>
      </div>
      <div id="editGameForm"></div>
      <nav class="tabs no-print">
        <button data-tab="questions" class="${activeTab === "questions" ? "active" : ""}">Questions</button>
        <button data-tab="wordsearch" class="${activeTab === "wordsearch" ? "active" : ""}">Word Search</button>
        <button data-tab="qr" class="${activeTab === "qr" ? "active" : ""}">QR Code</button>
        <button data-tab="leaderboard" class="${activeTab === "leaderboard" ? "active" : ""}">Leaderboard</button>
      </nav>
    </div>
    <div id="tabContent"></div>
  `;

  document.getElementById("setLiveBtn")?.addEventListener("click", async () => {
    await updateDoc(doc(db, "games", game.id), { status: "live" });
    await loadGamesAndRender();
  });
  document.getElementById("closeBtn")?.addEventListener("click", async () => {
    await updateDoc(doc(db, "games", game.id), { status: "closed" });
    await loadGamesAndRender();
  });
  document.getElementById("reopenBtn")?.addEventListener("click", async () => {
    await updateDoc(doc(db, "games", game.id), { status: "draft" });
    await loadGamesAndRender();
  });
  document.getElementById("editGameBtn").addEventListener("click", () => {
    document.getElementById("editGameForm").innerHTML = `
      <div class="card" style="text-align:left;">
        <label>Opponent</label>
        <input type="text" id="egOpponent" value="${escapeHtml(game.opponent)}">
        <label>Location (city / school)</label>
        <input type="text" id="egLocation" value="${escapeHtml(game.location || "")}">
        <label>Game date</label>
        <input type="date" id="egDate" value="${escapeHtml(game.date || "")}">
        <label>Quiz format</label>
        <select id="egFormat">
          <option value="mc" ${(!game.quizFormat || game.quizFormat === "mc") ? "selected" : ""}>Multiple choice only</option>
          <option value="wordsearch" ${game.quizFormat === "wordsearch" ? "selected" : ""}>Word search only</option>
          <option value="both" ${game.quizFormat === "both" ? "selected" : ""}>Both (multiple choice, then word search)</option>
        </select>
        <div class="error hidden" id="egErr"></div>
        <button class="btn small" id="egSave">Save Changes</button>
        <button class="btn small secondary" id="egCancel">Cancel</button>
      </div>
    `;
    document.getElementById("egCancel").addEventListener("click", () => {
      document.getElementById("editGameForm").innerHTML = "";
    });
    document.getElementById("egSave").addEventListener("click", async () => {
      const opponent = document.getElementById("egOpponent").value.trim();
      const location_ = document.getElementById("egLocation").value.trim();
      const date = document.getElementById("egDate").value;
      const quizFormat = document.getElementById("egFormat").value;
      const errEl = document.getElementById("egErr");
      if (!opponent || !date) {
        errEl.textContent = "Opponent and date are required.";
        errEl.classList.remove("hidden");
        return;
      }
      await updateDoc(doc(db, "games", game.id), { opponent, location: location_, date, quizFormat });
      await loadGamesAndRender();
    });
  });

  container.querySelectorAll(".tabs button").forEach(btn => {
    btn.addEventListener("click", () => {
      activeTab = btn.getAttribute("data-tab");
      renderGameDetail();
    });
  });

  if (unsubLeaderboard) { unsubLeaderboard(); unsubLeaderboard = null; }

  if (activeTab === "questions") renderQuestionsTab(game);
  else if (activeTab === "wordsearch") renderWordSearchTab(game);
  else if (activeTab === "qr") renderQrTab(game);
  else if (activeTab === "leaderboard") renderLeaderboardTab(game);
}

// ---------- Questions tab ----------

async function renderQuestionsTab(game) {
  const tc = document.getElementById("tabContent");
  tc.innerHTML = `<div class="card center"><div class="spinner"></div></div>`;
  const qSnap = await getDocs(query(collection(db, "games", game.id, "questions"), orderBy("order")));
  const questions = qSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  tc.innerHTML = `
    <div class="card">
      <h2>Questions (${questions.length})</h2>
      ${questions.length ? `<table class="qlist"><tbody>
        ${questions.map((q, i) => `
          <tr>
            <td style="width:22px;">${i + 1}</td>
            <td>
              <span class="badge ${q.category}">${q.category === "nutrition" ? "Nutrition" : "Location"}</span><br>
              <strong>${escapeHtml(q.text)}</strong><br>
              <span class="muted">Options: ${q.options.map(escapeHtml).join(" · ")}</span>
            </td>
            <td class="row-actions">
              <button class="btn small danger" data-del="${q.id}">Delete</button>
            </td>
          </tr>`).join("")}
      </tbody></table>` : `<p class="muted">No questions yet.</p>`}
    </div>
    <div class="card">
      <h2>Bulk Add (paste from Claude)</h2>
      <p class="muted">Paste the JSON block of questions Claude drafted for this game.</p>
      <textarea id="bulkJson" placeholder='[{"category":"location","text":"...","options":["A","B","C","D"],"correctIdx":0}, ...]' style="min-height:100px;"></textarea>
      <div class="error hidden" id="bulkErr"></div>
      <button class="btn secondary" id="bulkAddBtn">Add All from Paste</button>
    </div>
    <div class="card">
      <h2>Add Question</h2>
      <label>Category</label>
      <select id="qCategory">
        <option value="location">Location / School</option>
        <option value="nutrition">Sports Nutrition</option>
      </select>
      <label>Question text</label>
      <textarea id="qText" placeholder="e.g. What is the mascot of the University of Richmond?"></textarea>
      <label>Answer options (mark the correct one)</label>
      ${[0, 1, 2, 3].map(i => `
        <div class="option">
          <input type="radio" name="correctOpt" value="${i}" ${i === 0 ? "checked" : ""}>
          <input type="text" id="opt${i}" placeholder="Option ${i + 1}" style="border:none; padding:6px;">
        </div>`).join("")}
      <div class="error hidden" id="qErr"></div>
      <button class="btn" id="addQBtn">Add Question</button>
    </div>
    <div class="card">
      <h2>Add from Nutrition Bank</h2>
      <div id="bankPicker" class="muted">Loading bank…</div>
    </div>
  `;

  tc.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this question?")) return;
      await deleteDoc(doc(db, "games", game.id, "questions", btn.getAttribute("data-del")));
      renderQuestionsTab(game);
    });
  });

  document.getElementById("bulkAddBtn").addEventListener("click", async () => {
    const raw = document.getElementById("bulkJson").value.trim();
    const errEl = document.getElementById("bulkErr");
    let items;
    try {
      items = JSON.parse(raw);
      if (!Array.isArray(items)) throw new Error("Expected a JSON array");
    } catch (e) {
      errEl.textContent = "Couldn't parse that JSON: " + e.message;
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    let order = questions.length;
    for (const item of items) {
      await addQuestionToGame(game.id, item, order++);
    }
    renderQuestionsTab(game);
  });

  document.getElementById("addQBtn").addEventListener("click", async () => {
    const category = document.getElementById("qCategory").value;
    const text = document.getElementById("qText").value.trim();
    const options = [0, 1, 2, 3].map(i => document.getElementById(`opt${i}`).value.trim());
    const correctIdx = parseInt(document.querySelector('input[name="correctOpt"]:checked').value, 10);
    const errEl = document.getElementById("qErr");
    if (!text || options.some(o => !o)) {
      errEl.textContent = "Fill in the question and all four options.";
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    await addQuestionToGame(game.id, { category, text, options, correctIdx }, questions.length);
    renderQuestionsTab(game);
  });

  renderBankPicker(game, questions.length);
}

async function addQuestionToGame(gameId, { category, text, options, correctIdx }, order) {
  const salt = randomSalt();
  const answerHash = await sha256(options[correctIdx] + "|" + salt);
  await addDoc(collection(db, "games", gameId, "questions"), { category, text, options, salt, answerHash, order });
}

async function renderBankPicker(game, currentOrder) {
  const el = document.getElementById("bankPicker");
  if (!el) return;
  const snap = await getDocs(collection(db, "nutritionBank"));
  const bank = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!bank.length) {
    el.innerHTML = `<p class="muted">Bank is empty. Seed it from the "Manage Nutrition Bank" panel below the games list.</p>`;
    return;
  }
  el.innerHTML = `
    ${bank.map(q => `
      <label class="option">
        <input type="checkbox" value="${q.id}" class="bankCheck">
        <span>${escapeHtml(q.text)}</span>
      </label>`).join("")}
    <button class="btn small secondary" id="addBankSelected" style="margin-top:8px;">Add Selected to Game</button>
  `;
  document.getElementById("addBankSelected").addEventListener("click", async () => {
    const checked = Array.from(el.querySelectorAll(".bankCheck:checked")).map(c => c.value);
    let order = currentOrder;
    for (const id of checked) {
      const q = bank.find(b => b.id === id);
      await addDoc(collection(db, "games", game.id, "questions"), {
        category: "nutrition", text: q.text, options: q.options, salt: q.salt, answerHash: q.answerHash, order: order++
      });
    }
    renderQuestionsTab(game);
  });
}

// ---------- Word search tab ----------

async function renderWordSearchTab(game) {
  const tc = document.getElementById("tabContent");
  tc.innerHTML = `<div class="card center"><div class="spinner"></div></div>`;
  const wsSnap = await getDocs(collection(db, "games", game.id, "wordsearch"));
  const words = wsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  tc.innerHTML = `
    <div class="card">
      <h2>Word Search Words (${words.length})</h2>
      <p class="muted">Only used if this game's quiz format includes a word search. Words should be single tokens (letters only — no spaces or punctuation).</p>
      ${words.length ? `<table class="qlist"><tbody>
        ${words.map(w => `
          <tr>
            <td>
              <span class="badge ${w.category === "nutrition" ? "nutrition" : "location"}">${w.category === "nutrition" ? "Nutrition" : "Location"}</span><br>
              <strong>${escapeHtml(w.word)}</strong><br><span class="muted">${escapeHtml(w.clue)}</span>
            </td>
            <td class="row-actions"><button class="btn small danger" data-delws="${w.id}">Delete</button></td>
          </tr>`).join("")}
      </tbody></table>` : `<p class="muted">No words yet.</p>`}
    </div>
    <div class="card">
      <h2>Bulk Add (paste from Claude)</h2>
      <textarea id="wsBulkJson" placeholder='[{"word":"FRIARS","clue":"Providence College mascot nickname","category":"location"}, ...]' style="min-height:100px;"></textarea>
      <div class="error hidden" id="wsBulkErr"></div>
      <button class="btn secondary" id="wsBulkAddBtn">Add All from Paste</button>
    </div>
    <div class="card">
      <h2>Add One Word</h2>
      <label>Category</label>
      <select id="wsCategory">
        <option value="location">Location / School</option>
        <option value="nutrition">Sports Nutrition</option>
      </select>
      <label>Word (letters only)</label>
      <input type="text" id="wsWord" placeholder="e.g. FRIARS">
      <label>Clue</label>
      <input type="text" id="wsClue" placeholder="e.g. Providence College's mascot nickname">
      <div class="error hidden" id="wsAddErr"></div>
      <button class="btn small secondary" id="wsAddBtn">Add Word</button>
    </div>
    <div class="card">
      <h2>Add from Nutrition Word Bank</h2>
      <div id="wsBankPicker" class="muted">Loading bank…</div>
    </div>
    <div class="card">
      <h2>Preview Grid</h2>
      <p class="muted">Generates a sample grid with the current word list, so you can check everything fits before game day. Each athlete gets their own freshly generated grid — this is just a preview.</p>
      <button class="btn small secondary" id="wsPreviewBtn">Generate Preview</button>
      <div id="wsPreviewOut" style="margin-top:10px;"></div>
    </div>
  `;

  tc.querySelectorAll("[data-delws]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this word?")) return;
      await deleteDoc(doc(db, "games", game.id, "wordsearch", btn.getAttribute("data-delws")));
      renderWordSearchTab(game);
    });
  });

  document.getElementById("wsBulkAddBtn").addEventListener("click", async () => {
    const raw = document.getElementById("wsBulkJson").value.trim();
    const errEl = document.getElementById("wsBulkErr");
    let items;
    try {
      items = JSON.parse(raw);
      if (!Array.isArray(items)) throw new Error("Expected a JSON array");
    } catch (e) {
      errEl.textContent = "Couldn't parse that JSON: " + e.message;
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    for (const item of items) {
      const word = normalizeWsWord(item.word);
      if (!word) continue;
      await addDoc(collection(db, "games", game.id, "wordsearch"), { word, clue: item.clue || "", category: item.category === "nutrition" ? "nutrition" : "location" });
    }
    renderWordSearchTab(game);
  });

  document.getElementById("wsAddBtn").addEventListener("click", async () => {
    const word = normalizeWsWord(document.getElementById("wsWord").value);
    const clue = document.getElementById("wsClue").value.trim();
    const category = document.getElementById("wsCategory").value;
    const errEl = document.getElementById("wsAddErr");
    if (!word || !clue) {
      errEl.textContent = "Both a word and a clue are required.";
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    await addDoc(collection(db, "games", game.id, "wordsearch"), { word, clue, category });
    renderWordSearchTab(game);
  });

  renderWsBankPicker(game, words);

  document.getElementById("wsPreviewBtn").addEventListener("click", () => {
    const out = document.getElementById("wsPreviewOut");
    if (!words.length) { out.innerHTML = `<p class="muted">Add some words first.</p>`; return; }
    try {
      const { grid, gridSize } = generateWordSearch(words.map(w => w.word));
      out.innerHTML = `
        <div class="ws-grid" style="grid-template-columns:repeat(${gridSize}, 1fr); max-width:${gridSize * 26}px;">
          ${grid.map(row => row.map(ch => `<div class="ws-cell">${ch}</div>`).join("")).join("")}
        </div>
      `;
    } catch (e) {
      out.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
    }
  });
}

async function renderWsBankPicker(game, existingWords) {
  const el = document.getElementById("wsBankPicker");
  if (!el) return;
  const snap = await getDocs(collection(db, "nutritionWordBank"));
  const bank = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (!bank.length) {
    el.innerHTML = `<p class="muted">Bank is empty. Seed it from the "Nutrition Word Bank" panel below the games list.</p>`;
    return;
  }
  const existingSet = new Set(existingWords.map(w => w.word));
  el.innerHTML = `
    ${bank.map(w => `
      <label class="option">
        <input type="checkbox" value="${w.id}" class="wsBankCheck" ${existingSet.has(w.word) ? "disabled checked" : ""}>
        <span>${escapeHtml(w.word)} — ${escapeHtml(w.clue)}</span>
      </label>`).join("")}
    <button class="btn small secondary" id="wsAddBankSelected" style="margin-top:8px;">Add Selected to Game</button>
  `;
  document.getElementById("wsAddBankSelected").addEventListener("click", async () => {
    const checked = Array.from(el.querySelectorAll(".wsBankCheck:checked:not(:disabled)")).map(c => c.value);
    for (const id of checked) {
      const w = bank.find(b => b.id === id);
      await addDoc(collection(db, "games", game.id, "wordsearch"), { word: w.word, clue: w.clue, category: "nutrition" });
    }
    renderWordSearchTab(game);
  });
}

// ---------- QR tab ----------

const COURT_STRIP_SVG = `
<svg class="court-strip" viewBox="0 0 800 90" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
  <rect x="0" y="0" width="800" height="90" fill="#5C0000"/>
  <g stroke="#e8b923" stroke-width="2.5" fill="none" opacity="0.55">
    <line x1="400" y1="6" x2="400" y2="84" />
    <circle cx="400" cy="45" r="24" />
    <path d="M6,16 A34,34 0 0,1 6,74" />
    <path d="M794,16 A34,34 0 0,0 794,74" />
    <rect x="6" y="6" width="788" height="78" rx="4" />
  </g>
</svg>`;

function posterInnerHtml(game, qrImg) {
  const opponentLogo = game.opponentLogoUrl
    ? `<img class="poster-logo" src="${escapeHtml(game.opponentLogoUrl)}" alt="${escapeHtml(game.opponent)} logo">`
    : `<div class="poster-logo placeholder">🏀</div>`;
  return `
    ${COURT_STRIP_SVG}
    <div class="poster-header">
      <img class="poster-logo" src="assets/umass-logo.png" alt="UMass logo">
      <div class="poster-vs">VS</div>
      ${opponentLogo}
    </div>
    <div class="poster-teams">UMass Women's Basketball<span class="sep">vs</span>${escapeHtml(game.opponent)}</div>
    <div class="poster-location">${escapeHtml(game.location || "")}${game.location ? " · " : ""}${fmtDate(game.date)}</div>
    <h2 class="poster-cta">Scan to Play Trivia!</h2>
    <div class="poster-qr-box"><img src="${qrImg}" alt="QR code"></div>
    <div class="poster-sub">First perfect score wins big — every correct answer earns points.</div>
    ${COURT_STRIP_SVG}
  `;
}

function renderQrTab(game) {
  const tc = document.getElementById("tabContent");
  const link = `${QUIZ_BASE_URL}?g=${game.id}`;
  const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(link)}`;
  const inner = posterInnerHtml(game, qrImg);

  tc.innerHTML = `
    <div class="card center no-print">
      <h2>${escapeHtml(gameLabel(game))} — Printable QR</h2>
      ${game.status !== "live" ? `<p class="muted" style="margin-bottom:10px;">Quiz status is <strong>${game.status}</strong> — set it Live before athletes scan, or they'll see a "not open yet" screen.</p>` : ""}
      <div class="link-box">${escapeHtml(link)}</div>
      <button class="btn" id="printBtn">Print (2-up, half-sheet)</button>
      <p class="muted" style="margin-top:8px;">Prints two copies stacked on one page — cut along the dashed line to get two half-sheet posters, sized to tuck into snack bags.</p>

      <div class="card" style="margin-top:16px; text-align:left;">
        <label>Opponent logo URL</label>
        <input type="text" id="logoUrlInput" value="${escapeHtml(game.opponentLogoUrl || "")}" placeholder="https://... link to their athletics logo">
        <button class="btn small secondary" id="saveLogoBtn" style="margin-top:8px;">Save Logo URL</button>
      </div>
    </div>

    <div class="center">
      <div class="poster" id="posterEl">${inner}</div>
    </div>
    <div class="poster print-duplicate">${inner}</div>
  `;
  document.getElementById("printBtn").addEventListener("click", () => window.print());
  document.getElementById("saveLogoBtn").addEventListener("click", async () => {
    const url = document.getElementById("logoUrlInput").value.trim();
    await updateDoc(doc(db, "games", game.id), { opponentLogoUrl: url });
    game.opponentLogoUrl = url;
    renderQrTab(game);
  });
}

// ---------- Leaderboard tab ----------

function renderLeaderboardTab(game) {
  const tc = document.getElementById("tabContent");
  tc.innerHTML = `<div class="card"><h2>Live Leaderboard</h2><div id="lbAdmin"><div class="muted center">Loading…</div></div></div>`;
  unsubLeaderboard = onSnapshot(collection(db, "games", game.id, "responses"), snap => {
    const responses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const el = document.getElementById("lbAdmin");
    if (!el) return;
    if (!responses.length) { el.innerHTML = `<p class="muted center">No submissions yet.</p>`; return; }
    const ranked = computeLeaderboard(responses, game);
    el.innerHTML = ranked.map((r, i) => `
      <div class="rank-row">
        <div class="rank-num">${i + 1}</div>
        <div class="rank-name">${escapeHtml(r.athleteName)}</div>
        <div class="rank-meta">${r.correctCount}/${r.totalQuestions}${r.perfect ? " ⭐ perfect" : ""} · base ${r.basePoints} + bonus ${r.bonus}</div>
        <div class="rank-pts">${r.total} pts</div>
        <button class="btn small danger no-print" data-delresp="${r.id}" style="margin-left:8px;">×</button>
      </div>`).join("");
    el.querySelectorAll("[data-delresp]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this submission from the leaderboard?")) return;
        await deleteDoc(doc(db, "games", game.id, "responses", btn.getAttribute("data-delresp")));
      });
    });
  });
}

// ---------- Nutrition bank panel ----------

const STARTER_BANK = [
  { text: "What's the primary role of carbohydrates for an athlete?", options: ["Building muscle", "Fueling high-intensity exercise", "Preventing dehydration", "Absorbing vitamins"], correctIdx: 1 },
  { text: "About how soon after a hard practice should you start refueling with carbs + protein for best recovery?", options: ["Within 30-60 minutes", "Within 6 hours", "The next morning", "It doesn't matter"], correctIdx: 0 },
  { text: "Which is the best sign that you're well-hydrated before a game?", options: ["Feeling thirsty", "Pale yellow urine", "Dark yellow urine", "A headache"], correctIdx: 1 },
  { text: "Which nutrient is most important for repairing and building muscle after training?", options: ["Protein", "Fiber", "Sugar", "Saturated fat"], correctIdx: 0 },
  { text: "About how many grams of protein should you aim for in a recovery meal to support muscle repair?", options: ["5-10g", "20-30g", "60-70g", "100g+"], correctIdx: 1 },
  { text: "What's a good source of quick, easily digestible carbs before a game?", options: ["A bagel with jam", "A large fatty steak", "A bowl of raw broccoli", "A protein shake with no carbs"], correctIdx: 0 },
  { text: "Which mineral, lost through sweat, is especially important to replace during long or hot workouts to help prevent cramping?", options: ["Sodium", "Iron", "Calcium", "Zinc"], correctIdx: 0 },
  { text: "What does \"carb loading\" mainly help with?", options: ["Weight loss", "Increasing muscle glycogen stores for endurance", "Building bone density", "Reducing soreness"], correctIdx: 1 },
  { text: "Which is a better pre-game snack 60-90 minutes before tip-off?", options: ["A banana with peanut butter", "A large cheeseburger", "An energy drink only", "Nothing — play on an empty stomach"], correctIdx: 0 },
  { text: "What's the main reason athletes are told to avoid trying new foods on game day?", options: ["New foods are always unhealthy", "Risk of GI upset during play", "New foods cost more", "It's just a superstition"], correctIdx: 1 },
  { text: "Which of these best supports bone health, especially important for female athletes?", options: ["Calcium and Vitamin D", "Extra caffeine", "High-sugar snacks", "Skipping breakfast"], correctIdx: 0 },
  { text: "About what percent of body weight lost as fluid can start to noticeably hurt performance?", options: ["0.5%", "2%", "10%", "20%"], correctIdx: 1 },
  { text: "What's a key benefit of chocolate milk as a recovery drink?", options: ["It has zero nutrients", "A solid carb-to-protein ratio for recovery", "It replaces the need for water", "It's mainly for pre-game energy"], correctIdx: 1 },
  { text: "Which is a warning sign of under-fueling (not eating enough for training demands)?", options: ["Consistent energy all practice", "Frequent fatigue, illness, or missed periods", "Faster recovery", "Improved sleep"], correctIdx: 1 },
  { text: "Which snack combo is best for sustained energy on a long travel day?", options: ["Candy alone", "Trail mix with nuts, dried fruit, and whole grains", "Soda and chips", "Skipping snacks to save calories"], correctIdx: 1 },
  { text: "What's the main purpose of eating protein AND carbs together after a workout?", options: ["Carbs replenish glycogen while protein repairs muscle", "Protein replaces water loss", "Carbs build muscle alone", "It has no added benefit vs. either alone"], correctIdx: 0 },
  { text: "Which drink is most useful specifically during long, intense, or hot workouts (over about 60 minutes)?", options: ["Water only", "A sports drink with electrolytes and carbs", "Black coffee", "Diet soda"], correctIdx: 1 },
  { text: "About how many hours before a game is it generally best to eat your last full meal?", options: ["3-4 hours", "15 minutes", "Right before tip-off", "Only applies to night games"], correctIdx: 0 }
];

function renderBankPanel() {
  const el = document.getElementById("bankPanel");
  el.innerHTML = `<div class="card center"><div class="spinner"></div></div>`;
  loadBank(el);
}

async function loadBank(el) {
  const snap = await getDocs(collection(db, "nutritionBank"));
  const bank = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  el.innerHTML = `
    <div class="card">
      <h2>Nutrition Bank (${bank.length})</h2>
      ${bank.length ? bank.map(q => `
        <div class="rank-row">
          <div style="flex:1;">${escapeHtml(q.text)}</div>
          <button class="btn small danger" data-delbank="${q.id}">Delete</button>
        </div>`).join("") : `<p class="muted">Empty.</p>`}
      ${!bank.length ? `<button class="btn secondary" id="seedBtn">Seed 18 Starter Questions</button>` : ""}
    </div>
    <div class="card">
      <h2>Bulk Add (paste from Claude)</h2>
      <p class="muted">Paste a JSON block of nutrition questions to add to the shared bank.</p>
      <textarea id="bankBulkJson" placeholder='[{"text":"...","options":["A","B","C","D"],"correctIdx":0}, ...]' style="min-height:100px;"></textarea>
      <div class="error hidden" id="bankBulkErr"></div>
      <button class="btn secondary" id="bankBulkAddBtn">Add All from Paste</button>
    </div>
  `;
  el.querySelectorAll("[data-delbank]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this bank question?")) return;
      await deleteDoc(doc(db, "nutritionBank", btn.getAttribute("data-delbank")));
      loadBank(el);
    });
  });
  document.getElementById("bankBulkAddBtn").addEventListener("click", async () => {
    const raw = document.getElementById("bankBulkJson").value.trim();
    const errEl = document.getElementById("bankBulkErr");
    let items;
    try {
      items = JSON.parse(raw);
      if (!Array.isArray(items)) throw new Error("Expected a JSON array");
    } catch (e) {
      errEl.textContent = "Couldn't parse that JSON: " + e.message;
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    for (const q of items) {
      const salt = randomSalt();
      const answerHash = await sha256(q.options[q.correctIdx] + "|" + salt);
      await addDoc(collection(db, "nutritionBank"), { text: q.text, options: q.options, salt, answerHash, category: "nutrition" });
    }
    loadBank(el);
  });
  document.getElementById("seedBtn")?.addEventListener("click", async () => {
    for (const q of STARTER_BANK) {
      const salt = randomSalt();
      const answerHash = await sha256(q.options[q.correctIdx] + "|" + salt);
      await addDoc(collection(db, "nutritionBank"), { text: q.text, options: q.options, salt, answerHash, category: "nutrition" });
    }
    loadBank(el);
  });
}

// ---------- Nutrition word bank (for word search rounds) ----------

const STARTER_WS_BANK = [
  { word: "PROTEIN", clue: "Nutrient essential for repairing and building muscle" },
  { word: "HYDRATION", clue: "Staying adequately fueled with fluids" },
  { word: "ELECTROLYTES", clue: "Minerals like sodium and potassium lost through sweat" },
  { word: "CARBOHYDRATES", clue: "The body's main fuel source for high-intensity exercise" },
  { word: "RECOVERY", clue: "The post-workout window when the body restocks energy and repairs muscle" },
  { word: "IRON", clue: "Mineral commonly low in female athletes, aids oxygen transport in blood" },
  { word: "CALCIUM", clue: "Mineral crucial for bone health" },
  { word: "GLYCOGEN", clue: "Stored form of carbohydrate energy in muscles" },
  { word: "SODIUM", clue: "Electrolyte lost through sweat, important to replace during long workouts" },
  { word: "FUELING", clue: "Eating enough to support training and competition demands" }
];

function renderWsBankPanel() {
  const el = document.getElementById("wsBankPanel");
  el.innerHTML = `<div class="card center"><div class="spinner"></div></div>`;
  loadWsBank(el);
}

async function loadWsBank(el) {
  const snap = await getDocs(collection(db, "nutritionWordBank"));
  const bank = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  el.innerHTML = `
    <div class="card">
      <h2>Nutrition Word Bank (${bank.length})</h2>
      ${bank.length ? bank.map(w => `
        <div class="rank-row">
          <div style="flex:1;"><strong>${escapeHtml(w.word)}</strong> — ${escapeHtml(w.clue)}</div>
          <button class="btn small danger" data-delwsbank="${w.id}">Delete</button>
        </div>`).join("") : `<p class="muted">Empty.</p>`}
      ${!bank.length ? `<button class="btn secondary" id="wsSeedBtn">Seed 10 Starter Words</button>` : ""}
    </div>
    <div class="card">
      <h2>Bulk Add (paste from Claude)</h2>
      <textarea id="wsBankBulkJson" placeholder='[{"word":"PROTEIN","clue":"..."}, ...]' style="min-height:100px;"></textarea>
      <div class="error hidden" id="wsBankBulkErr"></div>
      <button class="btn secondary" id="wsBankBulkAddBtn">Add All from Paste</button>
    </div>
  `;
  el.querySelectorAll("[data-delwsbank]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this word?")) return;
      await deleteDoc(doc(db, "nutritionWordBank", btn.getAttribute("data-delwsbank")));
      loadWsBank(el);
    });
  });
  document.getElementById("wsBankBulkAddBtn").addEventListener("click", async () => {
    const raw = document.getElementById("wsBankBulkJson").value.trim();
    const errEl = document.getElementById("wsBankBulkErr");
    let items;
    try {
      items = JSON.parse(raw);
      if (!Array.isArray(items)) throw new Error("Expected a JSON array");
    } catch (e) {
      errEl.textContent = "Couldn't parse that JSON: " + e.message;
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    for (const w of items) {
      const word = normalizeWsWord(w.word);
      if (!word) continue;
      await addDoc(collection(db, "nutritionWordBank"), { word, clue: w.clue || "" });
    }
    loadWsBank(el);
  });
  document.getElementById("wsSeedBtn")?.addEventListener("click", async () => {
    for (const w of STARTER_WS_BANK) {
      await addDoc(collection(db, "nutritionWordBank"), { word: w.word, clue: w.clue });
    }
    loadWsBank(el);
  });
}
