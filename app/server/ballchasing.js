const BC_BASE = "https://ballchasing.com/api";
const DETAIL_TTL_MS = 10 * 60 * 1000;
const replayDetailCache = new Map();

function normalizeIdentity(value) {
  return (value || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getPlayerIdentityCandidates(player) {
  const names = [];
  if (player?.name) names.push(player.name);

  const idObj = player?.id;
  if (idObj && typeof idObj === "object") {
    if (idObj.id) names.push(idObj.id);
    if (idObj.platform && idObj.id) names.push(`${idObj.platform}:${idObj.id}`);
  }

  if (player?.remote_id) names.push(player.remote_id);
  if (player?.platform_id) names.push(player.platform_id);

  return names
    .map(normalizeIdentity)
    .filter(Boolean);
}

function countTrackedPlayers(rawPlayers, trackedIdentitySet) {
  if (!Array.isArray(rawPlayers) || trackedIdentitySet.size === 0) return 0;

  let count = 0;
  for (const player of rawPlayers) {
    const candidates = getPlayerIdentityCandidates(player);
    if (candidates.some((candidate) => trackedIdentitySet.has(candidate))) {
      count += 1;
    }
  }

  return count;
}

function computePerspectiveResult({ blueGoals, orangeGoals, blueTrackedCount, orangeTrackedCount }) {
  if (typeof blueGoals !== "number" || typeof orangeGoals !== "number") return null;

  if (blueTrackedCount === orangeTrackedCount) return null;

  const trackedSide = blueTrackedCount > orangeTrackedCount ? "blue" : "orange";
  const trackedGoals = trackedSide === "blue" ? blueGoals : orangeGoals;
  const opponentGoals = trackedSide === "blue" ? orangeGoals : blueGoals;

  if (trackedGoals > opponentGoals) return "win";
  if (trackedGoals < opponentGoals) return "loss";
  return "draw";
}

function resolveKey() {
  const key = (
    process.env.BALLCHASING_API_KEY ||
    process.env.BALLCHASING_TOKEN ||
    process.env.BC_API_KEY ||
    ""
  ).trim();

  if (!key) {
    throw new Error("Missing Ballchasing API key. Set BALLCHASING_API_KEY (or BALLCHASING_TOKEN).");
  }

  return key.replace(/^Bearer\s+/i, "");
}

async function requestJson(url, token) {
  const res = await fetch(url, {
    headers: { "Authorization": token }
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`Ballchasing request failed: ${res.status} ${text}`);
  }

  if (!text) return {};
  return JSON.parse(text);
}

async function fetchReplayDetailsById(id, token) {
  if (!id) return null;

  const cached = replayDetailCache.get(id);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const value = await requestJson(`${BC_BASE}/replays/${encodeURIComponent(id)}`, token);
    replayDetailCache.set(id, { value, expiresAt: now + DETAIL_TTL_MS });
    return value;
  } catch {
    return null;
  }
}

function hasDetailedStats(replay) {
  const bluePlayers = replay?.blue?.players;
  const orangePlayers = replay?.orange?.players;

  if (!Array.isArray(bluePlayers) || !Array.isArray(orangePlayers)) return false;
  if (!bluePlayers.length && !orangePlayers.length) return false;

  const allPlayers = [...bluePlayers, ...orangePlayers];
  return allPlayers.some((p) => p?.stats?.core);
}

function fmtDuration(seconds) {
  if (typeof seconds !== "number") return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function mapPlayer(p) {
  return {
    name: p.name,
    score: p?.stats?.core?.score ?? 0,
    goals: p?.stats?.core?.goals ?? 0,
    assists: p?.stats?.core?.assists ?? 0,
    saves: p?.stats?.core?.saves ?? 0,
    shots: p?.stats?.core?.shots ?? 0,
    demos: p?.stats?.demo?.inflicted ?? 0,
  };
}

function sortPlayers(players) {
  return [...players].sort((a, b) => {
    return (b.score - a.score) || (b.goals - a.goals) || (b.assists - a.assists) || (b.saves - a.saves);
  });
}

export async function getRecentReplays({ groupId, count = 10, trackedIdentities = [] }) {
  const key = resolveKey();
  const trackedIdentitySet = new Set(
    (Array.isArray(trackedIdentities) ? trackedIdentities : [])
      .map(normalizeIdentity)
      .filter(Boolean)
  );

  const safeCount = Number.isFinite(count) ? Math.min(Math.max(Number(count), 1), 200) : 10;

  const primary = new URL(`${BC_BASE}/replays`);
  if (groupId) primary.searchParams.set("group", groupId);
  primary.searchParams.set("count", String(safeCount));

  let json;
  try {
    json = await requestJson(primary.toString(), key);
  } catch (primaryErr) {
    if (!groupId) throw primaryErr;

    const fallback = new URL(`${BC_BASE}/groups/${encodeURIComponent(groupId)}/replays`);
    fallback.searchParams.set("count", String(safeCount));

    try {
      json = await requestJson(fallback.toString(), key);
    } catch (fallbackErr) {
      throw new Error(`${primaryErr.message} | Fallback failed: ${fallbackErr.message}`);
    }
  }
  const list = json?.list || [];

  const detailList = await Promise.all(
    list.map(async (r) => {
      if (hasDetailedStats(r)) return r;
      const detailed = await fetchReplayDetailsById(r?.id, key);
      return detailed || r;
    })
  );

  const items = detailList.map(r => {
    const blue = r.blue || {};
    const orange = r.orange || {};
    const date = r.date || null;

    const blueRawPlayers = Array.isArray(blue.players) ? blue.players : [];
    const orangeRawPlayers = Array.isArray(orange.players) ? orange.players : [];

    const bluePlayers = sortPlayers(blueRawPlayers.map(mapPlayer));
    const orangePlayers = sortPlayers(orangeRawPlayers.map(mapPlayer));

    const derivedBlueGoals = bluePlayers.reduce((sum, p) => sum + (Number.isFinite(p.goals) ? p.goals : 0), 0);
    const derivedOrangeGoals = orangePlayers.reduce((sum, p) => sum + (Number.isFinite(p.goals) ? p.goals : 0), 0);

    const blueGoals = typeof blue.goals === "number" ? blue.goals : derivedBlueGoals;
    const orangeGoals = typeof orange.goals === "number" ? orange.goals : derivedOrangeGoals;

    const blueTrackedCount = countTrackedPlayers(blueRawPlayers, trackedIdentitySet);
    const orangeTrackedCount = countTrackedPlayers(orangeRawPlayers, trackedIdentitySet);
    const result = computePerspectiveResult({
      blueGoals,
      orangeGoals,
      blueTrackedCount,
      orangeTrackedCount,
    });

    return {
      id: r.id,
      url: r.id ? `https://ballchasing.com/replay/${r.id}` : (r.link || null),
      date,
      blueTeamName: blue.name || "Blue",
      orangeTeamName: orange.name || "Orange",
      bluePlayers,
      orangePlayers,
      blueTopPerformer: bluePlayers[0]?.name || null,
      orangeTopPerformer: orangePlayers[0]?.name || null,
      map: r.map_name || r.map || null,
      playlist: r.playlist_name || r.playlist || null,
      teamSize: r.team_size || null,
      season: r.season ? `Season ${r.season}` : null,
      overtime: !!r.overtime,
      duration: fmtDuration(r.duration),
      blueGoals,
      orangeGoals,
      result,
      trackedSide: blueTrackedCount === orangeTrackedCount ? null : (blueTrackedCount > orangeTrackedCount ? "blue" : "orange"),
    };
  });

  return {
    ok: true,
    note: groupId ? "Source: ballchasing.com (group filtered)" : "Source: ballchasing.com (latest uploads)",
    items
  };
}
