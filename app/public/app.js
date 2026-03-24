function resolveApiBase() {
  const explicitBase = (window?.RLTT_CONFIG?.apiBase || "").toString().trim();
  if (explicitBase) return explicitBase.replace(/\/+$/, "");

  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (isLocal) return "";

  return "";
}

const API_BASE = resolveApiBase();

if (!API_BASE && window.location.hostname.includes("github.io")) {
  console.warn("RLTT API base is not configured. Set window.RLTT_CONFIG.apiBase in public/config.js");
}

function apiUrl(path) {
  return API_BASE ? `${API_BASE}${path}` : path;
}

const API = {
  team: "./data/team.json",
  twitchLive: (logins) => apiUrl(`/api/twitch/live?logins=${encodeURIComponent(logins.join(","))}`),
  matches: apiUrl("/api/ballchasing/recent"),
  trackerRoster: apiUrl("/api/tracker/roster"),
  saveSnapshot: apiUrl("/api/team/snapshot"),
};

const LOCAL_KEY = "rltt_team_overrides_v1";

function readOverrides() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeOverrides(obj) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(obj));
}

function applyOverrides(team) {
  const ov = readOverrides();
  if (!ov.players) return team;

  team.players = team.players || [];
  for (const [idxStr, patch] of Object.entries(ov.players)) {
    const idx = Number(idxStr);
    const p = team.players[idx];
    if (!p || !patch) continue;

    p.ranks = p.ranks || {};
    for (const mode of Object.keys(patch)) {
      p.ranks[mode] = { ...(p.ranks[mode] || {}), ...(patch[mode] || {}) };
    }
  }

  if (Array.isArray(ov.snapshots)) {
    team.snapshots = Array.isArray(team.snapshots) ? team.snapshots : [];
    team.snapshots = [...team.snapshots, ...ov.snapshots];
  }

  return team;
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


function qs(sel) { return document.querySelector(sel); }
function el(id) { return document.getElementById(id); }

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed ${res.status}: ${text || url}`);
  }
  return res.json();
}

function safeText(s) { return (s ?? "").toString(); }

function normalizeIdentity(value) {
  return safeText(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function buildTrackedIdentitySet(team) {
  const values = [];
  const players = Array.isArray(team?.players) ? team.players : [];

  for (const p of players) {
    values.push(p?.name, p?.twitch, p?.tracker?.id);
  }

  // Keep an explicit fallback so this logic works even if roster data is partial.
  values.push("fahxey", "v4nt4vo1d");

  return new Set(values.map(normalizeIdentity).filter(Boolean));
}

function countTrackedPlayers(players, trackedIdentitySet) {
  if (!Array.isArray(players) || !trackedIdentitySet || trackedIdentitySet.size === 0) return 0;

  let count = 0;
  for (const p of players) {
    const id = normalizeIdentity(p?.name);
    if (id && trackedIdentitySet.has(id)) count += 1;
  }
  return count;
}

function perspectiveResult(match, trackedIdentitySet) {
  const blueGoals = match?.blueGoals;
  const orangeGoals = match?.orangeGoals;
  if (typeof blueGoals !== "number" || typeof orangeGoals !== "number") {
    return match?.result || null;
  }

  const blueCount = countTrackedPlayers(match?.bluePlayers || [], trackedIdentitySet);
  const orangeCount = countTrackedPlayers(match?.orangePlayers || [], trackedIdentitySet);

  if (blueCount === orangeCount) {
    return match?.result || null;
  }

  const trackedOnBlue = blueCount > orangeCount;
  const trackedGoals = trackedOnBlue ? blueGoals : orangeGoals;
  const opponentGoals = trackedOnBlue ? orangeGoals : blueGoals;

  if (trackedGoals > opponentGoals) return "win";
  if (trackedGoals < opponentGoals) return "loss";
  return "draw";
}

function setApiStatus(kind, label, state = "") {
  const target = kind === "tracker" ? el("api-status-tracker") : el("api-status-ballchasing");
  if (!target) return;
  target.textContent = label;
  target.classList.remove("ok", "warn", "err");
  if (state) target.classList.add(state);
}

function computeAverages(players) {
  const mmr2s = [];
  const mmr3s = [];

  for (const p of players) {
    const m2 = p?.ranks?.["2v2"]?.mmr;
    const m3 = p?.ranks?.["3v3"]?.mmr;
    if (typeof m2 === "number") mmr2s.push(m2);
    if (typeof m3 === "number") mmr3s.push(m3);
  }

  const avg = (arr) => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : null;
  return { avg2: avg(mmr2s), avg3: avg(mmr3s) };
}

function renderRankRow(label, data, playerIdx, mode) {
  if (!data) return "";
  const rank = safeText(data.rank || "Unranked");
  const mmr = data.mmr ?? "–";
  const editBtnId = `edit-${playerIdx}-${mode}`;
  const infoBtnId = `info-${playerIdx}-${mode}`;
  return `
    <div class="rank-row" data-player-idx="${playerIdx}" data-mode="${mode}">
      <span class="label" title="Click to edit">${label}</span>
      <span class="value">${rank}</span>
      <span class="mmr">${mmr} MMR</span>
      <button class="rank-edit-btn" id="${editBtnId}" title="Quick edit">✎</button>
      <div class="rank-edit-inline" id="${infoBtnId}" style="display:none;">
        <input type="text" class="rank-edit-input rank-text" placeholder="e.g. Champ 2 Div 3" />
        <input type="number" class="rank-edit-input rank-mmr" placeholder="MMR" />
        <button class="rank-save-btn">✓</button>
        <button class="rank-cancel-btn">✕</button>
      </div>
    </div>
  `;
}

function bestRank(p) {
  return (
    p?.ranks?.["3v3"]?.rank ||
    p?.ranks?.["2v2"]?.rank ||
    p?.ranks?.["1v1"]?.rank ||
    "Unranked"
  );
}

function twitchParent() {
  return window.location.hostname || "vantaproject.space";
}

function canUseTwitchEmbed() {
  return typeof window.Twitch !== "undefined" && window.Twitch?.Embed;
}

function mountTwitchEmbedWhenVisible(embedId, login) {
  const target = document.getElementById(embedId);
  if (!target || target.dataset.twitchMounted === "1") return;

  const startEmbed = () => {
    if (!canUseTwitchEmbed()) return false;
    if (target.dataset.twitchMounted === "1") return true;

    target.dataset.twitchMounted = "1";
    new window.Twitch.Embed(embedId, {
      width: "100%",
      height: "100%",
      channel: login,
      parent: [twitchParent()],
      muted: true,
    });
    return true;
  };

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting) return;
      observer.disconnect();

      const tryStart = () => {
        if (startEmbed()) return true;
        return false;
      };

      if (!tryStart()) {
        const iv = setInterval(() => {
          if (tryStart()) clearInterval(iv);
        }, 250);
        setTimeout(() => clearInterval(iv), 8000);
      }
    }, { rootMargin: "220px" });

    observer.observe(target);
    return;
  }

  if (!startEmbed()) {
    const iv = setInterval(() => {
      if (startEmbed()) clearInterval(iv);
    }, 250);
    setTimeout(() => clearInterval(iv), 8000);
  }
}

function renderPlayers(team, liveMap) {
  const grid = el("players-grid");
  grid.innerHTML = "";

  let liveCount = 0;

  for (const p of team.players) {
    const card = document.createElement("article");
    card.className = "player-card";

    const login = p.twitch ? safeText(p.twitch).toLowerCase() : null;
    const live = login && liveMap ? !!liveMap[login] : false;
    if (live) liveCount++;

    const badges = [];
    badges.push(`<span class="badge">${safeText(bestRank(p))}</span>`);
    if (login) {
      badges.push(`<span class="badge ${live ? "live" : "offline"}">${live ? "LIVE" : "offline"}</span>`);
    }

    const trackerLink = p.trackerUrl
      ? `<a href="${p.trackerUrl}" target="_blank" rel="noopener noreferrer" class="profile-link">Tracker</a>`
      : `<span class="mmr">No tracker linked</span>`;

    const twitchLink = login
      ? `<a href="https://twitch.tv/${login}" target="_blank" rel="noopener noreferrer" class="profile-link">Twitch</a>`
      : `<span class="mmr">No Twitch</span>`;

    const embedId = login ? `twitch-${login}` : null;
    const embedShell = login
      ? `<div class="twitch-embed"><div class="embed-shell" id="${embedId}"></div></div>`
      : "";

    const trackerStats = p.trackerStats
      ? `
        <div class="tracker-stats">
          <span class="pill">W ${p.trackerStats.wins ?? "—"}</span>
          <span class="pill">G ${p.trackerStats.goals ?? "—"}</span>
          <span class="pill">A ${p.trackerStats.assists ?? "—"}</span>
          <span class="pill">Saves ${p.trackerStats.saves ?? "—"}</span>
          <span class="pill">Shots ${p.trackerStats.shots ?? "—"}</span>
        </div>
      `
      : "";


    card.innerHTML = `
      <div class="player-header">
        <div>
          <div class="player-name">${safeText(p.name)}</div>
          <div class="player-role">${safeText(p.role || "Player")}</div>
        </div>
        <div class="badges">${badges.join("")}</div>
      </div>

      <div class="player-platform">
        <span>Platform: ${safeText(p.platform || "Unknown")}</span>
        <span class="muted tiny">${login ? "@" + login : ""}</span>
      </div>

      <div class="ranks">
        ${renderRankRow("1v1", p.ranks?.["1v1"], "${team.players.indexOf(p)}", "1v1")}
        ${renderRankRow("2v2", p.ranks?.["2v2"], "${team.players.indexOf(p)}", "2v2")}
        ${renderRankRow("3v3", p.ranks?.["3v3"], "${team.players.indexOf(p)}", "3v3")}
      </div>

      ${trackerStats}

      ${embedShell}

      <div class="player-footer">
        <div class="controls">
          ${trackerLink}
          ${twitchLink}
        </div>
      </div>
    `;

    grid.appendChild(card);

    const playerIdx = team.players.indexOf(p);
    setupInlineRankEdits(playerIdx, p);

    if (login) {
      mountTwitchEmbedWhenVisible(embedId, login);
    }
  }

  el("live-count").textContent = liveCount.toString();
}

function setupInlineRankEdits(playerIdx, player) {
  const modes = ["1v1", "2v2", "3v3"];
  
  for (const mode of modes) {
    const editBtnId = `edit-${playerIdx}-${mode}`;
    const infoBtnId = `info-${playerIdx}-${mode}`;
    const editBtn = el(editBtnId);
    const infoDiv = el(infoBtnId);
    
    if (!editBtn || !infoDiv) continue;
    
    const rankData = player.ranks?.[mode];
    const rankTextInput = infoDiv.querySelector(".rank-text");
    const rankMmrInput = infoDiv.querySelector(".rank-mmr");
    const saveBtn = infoDiv.querySelector(".rank-save-btn");
    const cancelBtn = infoDiv.querySelector(".rank-cancel-btn");
    
    rankTextInput.value = rankData?.rank || "";
    rankMmrInput.value = rankData?.mmr ?? "";
    
    const showEdit = () => {
      editBtn.style.display = "none";
      infoDiv.style.display = "flex";
      rankTextInput.focus();
    };
    
    const hideEdit = () => {
      editBtn.style.display = "";
      infoDiv.style.display = "none";
    };
    
    const save = async () => {
      try {
        const newRank = rankTextInput.value.trim() || null;
        const newMmr = rankMmrInput.value.trim() ? Number(rankMmrInput.value.trim()) : null;
        
        const res = await fetch(API.saveSnapshot, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            playerIndex: playerIdx,
            ranks: {
              [mode]: {
                rank: newRank,
                mmr: newMmr,
              }
            }
          })
        });
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        await load();
        hideEdit();
      } catch (e) {
        alert(`Could not save: ${e.message}`);
      }
    };
    
    editBtn.addEventListener("click", showEdit);
    cancelBtn.addEventListener("click", hideEdit);
    saveBtn.addEventListener("click", save);
    rankTextInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") save();
    });
    rankMmrInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") save();
    });
  }
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function renderTeamPanel(name, goals, top, players = []) {
  const rows = players.length
    ? players.map((p) => `
      <div class="team-player-row">
        <span class="name">${p.name || "Unknown"}</span>
        <span class="stats">${p.score} • ${p.goals}G ${p.assists}A ${p.saves}S ${p.shots}Sh ${p.demos}D</span>
      </div>
    `).join("")
    : `<div class="muted tiny">No player stats available.</div>`;

  return `
    <div class="team-panel">
      <div class="team-panel-head">
        <span class="team-name">${name || "Team"}</span>
        <span class="pill">Goals ${typeof goals === "number" ? goals : "—"}</span>
      </div>
      <div class="kv">
        <span class="k">Top performer</span>
        <span class="v">${top || "—"}</span>
      </div>
      <div class="team-player-list">${rows}</div>
    </div>
  `;
}

function renderMatches(payload, trackedIdentitySet) {
  const grid = el("matches-grid");
  const empty = el("matches-empty");
  const source = el("matches-source");

  grid.innerHTML = "";

  if (!payload || payload.ok !== true || !Array.isArray(payload.items) || payload.items.length === 0) {
    empty.style.display = "block";
    source.textContent = payload?.note ? payload.note : "";
    return;
  }

  empty.style.display = "none";
  source.textContent = payload.note || "Source: ballchasing.com replays";

  for (const m of payload.items) {
    const card = document.createElement("article");
    card.className = "match-card";

    const title = `${m.playlist || "Unknown Playlist"} • ${m.map || "Unknown Arena"}`;
    const when = m.date ? fmtDate(m.date) : "—";

    const score = (typeof m.blueGoals === "number" && typeof m.orangeGoals === "number")
      ? `${m.blueGoals}-${m.orangeGoals}`
      : "—";

    const result = perspectiveResult(m, trackedIdentitySet);
    const resultPill = result
      ? `<span class="pill">${result.toUpperCase()}</span>`
      : "";

    const replayLink = m.url
      ? `<a class="small-link" href="${m.url}" target="_blank" rel="noopener noreferrer">Replay</a>`
      : "";

    const pills = [];
    if (m.playlist) pills.push(`<span class="pill">${m.playlist}</span>`);
    if (m.map) pills.push(`<span class="pill">${m.map}</span>`);
    if (m.duration) pills.push(`<span class="pill">${m.duration}</span>`);
    if (m.overtime) pills.push(`<span class="pill">OT</span>`);
    if (m.season) pills.push(`<span class="pill">${m.season}</span>`);
    if (m.teamSize) pills.push(`<span class="pill">${m.teamSize}v${m.teamSize}</span>`);

    const bluePanel = renderTeamPanel(m.blueTeamName, m.blueGoals, m.blueTopPerformer, m.bluePlayers);
    const orangePanel = renderTeamPanel(m.orangeTeamName, m.orangeGoals, m.orangeTopPerformer, m.orangePlayers);

    card.innerHTML = `
      <div class="match-head">
        <div>
          <div class="match-title">${title}</div>
          <div class="match-meta">Match date: ${when}</div>
        </div>
        <div class="pills">
          ${resultPill}
          <span class="pill">Score ${score}</span>
        </div>
      </div>

      <div class="pills">
        ${pills.join("")}
      </div>

      <div class="team-panels">
        ${bluePanel}
        ${orangePanel}
      </div>

      <div class="player-footer">
        ${replayLink}
      </div>
    `;

    grid.appendChild(card);
  }
}

async function getLiveMapNoBackend(logins) {
  const live = {};

  await Promise.all(
    logins.map(async (login) => {
      try {
        const url = `https://decapi.me/twitch/online/${encodeURIComponent(login)}`;
        const txt = await fetch(url, { cache: "no-store" }).then(r => r.text());
        live[login] = txt.trim().toLowerCase() === "true";
      } catch {
        live[login] = false;
      }
    })
  );

  return live;
}

async function getLiveMapPreferred(logins) {
  if (!logins.length) return {};

  try {
    const res = await fetchJson(API.twitchLive(logins));
    return res?.live || {};
  } catch {
    return getLiveMapNoBackend(logins);
  }
}


async function load() {
  let team = await fetchJson(API.team);

  setApiStatus("ballchasing", "Ballchasing: checking…");
  setApiStatus("tracker", "Tracker: checking…");
  team = applyOverrides(team);


  el("team-name").textContent = team.teamName || "Your Team";
  el("team-name-footer").textContent = team.teamName || "Your Team";
  el("team-region").textContent = team.region || "";
  el("year").textContent = new Date().getFullYear();

  const logoEl = el("team-logo");
  if (team.logo) {
    logoEl.src = team.logo;
    logoEl.style.display = "";
  } else {
    logoEl.style.display = "none";
  }

  const { avg2 } = computeAverages(team.players || []);
  el("avg-2v2-mmr").textContent = avg2 ?? "–";

  const logins = (team.players || [])
    .map(p => (p.twitch ? safeText(p.twitch).toLowerCase() : null))
    .filter(Boolean);

  const [trackerResult, liveMapResult, matchesResult] = await Promise.allSettled([
    fetchJson(API.trackerRoster),
    getLiveMapPreferred(logins),
    fetchJson(API.matches),
  ]);

  if (trackerResult.status === "fulfilled") {
    const tracker = trackerResult.value;
    if (tracker?.ok && Array.isArray(tracker.players)) {
      let syncedCount = 0;
      for (const entry of tracker.players) {
        if (!entry?.ok) continue;
        syncedCount++;
        const p = team?.players?.[entry.index];
        if (!p) continue;
        p.ranks = { ...(p.ranks || {}), ...(entry.ranks || {}) };
        p.trackerStats = entry.trackerStats || p.trackerStats || null;
        p.trackerUpdatedAt = entry.trackerUpdatedAt || p.trackerUpdatedAt || null;
      }

      if (syncedCount > 0) {
        setApiStatus("tracker", `Tracker: live (${syncedCount})`, "ok");
      } else {
        const firstErr = tracker.players.find((x) => x && x.ok === false)?.reason || "fallback";
        const isAuth = typeof firstErr === "string" && /401|invalid authentication/i.test(firstErr);
        setApiStatus("tracker", isAuth ? "Tracker: unauthorized" : "Tracker: fallback", "warn");
      }
    } else {
      setApiStatus("tracker", "Tracker: unavailable", "warn");
    }
  } else {
    console.warn("Tracker roster fetch failed:", trackerResult.reason);
    setApiStatus("tracker", "Tracker: error", "err");
  }

  const liveMap = liveMapResult.status === "fulfilled" ? liveMapResult.value : {};
  renderPlayers(team, liveMap);

  if (matchesResult.status === "fulfilled") {
    const matches = matchesResult.value;
    const trackedIdentitySet = buildTrackedIdentitySet(team);
    renderMatches(matches, trackedIdentitySet);
    const hasItems = matches?.ok === true && Array.isArray(matches.items) && matches.items.length > 0;
    setApiStatus("ballchasing", hasItems ? `Ballchasing: live (${matches.items.length})` : "Ballchasing: no matches", hasItems ? "ok" : "warn");
  } else {
    renderMatches({ ok: false, note: "Match endpoint unavailable." }, buildTrackedIdentitySet(team));
    setApiStatus("ballchasing", "Ballchasing: error", "err");
  }

  setupAdmin(team);
}

function setupAdmin(team) {
  const modal = el("modal-backdrop");
  const btn = el("admin-btn");
  const close = el("modal-close");
  const cancel = el("cancel-update");
  const save = el("save-update");
  const playerSel = el("modal-player");

  const open = () => { modal.style.display = "flex"; };
  const hide = () => { modal.style.display = "none"; };

  btn.addEventListener("click", open);
  close.addEventListener("click", hide);
  cancel.addEventListener("click", hide);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) hide();
  });

  playerSel.innerHTML = "";
  (team.players || []).forEach((p, idx) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = p.name || `Player ${idx+1}`;
    playerSel.appendChild(opt);
  });

  const fillFromSelected = () => {
    const idx = Number(playerSel.value);
    const p = team.players[idx];
    el("rank-2v2").value = p?.ranks?.["2v2"]?.rank || "";
    el("mmr-2v2").value = (p?.ranks?.["2v2"]?.mmr ?? "").toString();
    el("rank-3v3").value = p?.ranks?.["3v3"]?.rank || "";
    el("mmr-3v3").value = (p?.ranks?.["3v3"]?.mmr ?? "").toString();
  };

  playerSel.addEventListener("change", fillFromSelected);
  fillFromSelected();

  save.addEventListener("click", async () => {
    const idx = Number(playerSel.value);
    const payload = {
      playerIndex: idx,
      ranks: {
        "2v2": {
          rank: el("rank-2v2").value.trim() || null,
          mmr: el("mmr-2v2").value.trim() ? Number(el("mmr-2v2").value.trim()) : null,
        },
        "3v3": {
          rank: el("rank-3v3").value.trim() || null,
          mmr: el("mmr-3v3").value.trim() ? Number(el("mmr-3v3").value.trim()) : null,
        }
      }
    };

    try {
      const res = await fetch(API.saveSnapshot, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      save.textContent = "✓ Saved";
      setTimeout(() => {
        save.textContent = "Save snapshot";
        hide();
        load().catch(console.error);
      }, 1500);
    } catch (e) {
      alert("Could not save: " + e.message);
    }
  });
}

el("refresh-btn").addEventListener("click", () => load().catch(console.error));

load().catch((err) => {
  console.error("Failed to load app", err);
  el("matches-empty").style.display = "block";
});
