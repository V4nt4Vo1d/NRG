const TRN_BASE = "https://public-api.tracker.gg/v2/rocket-league/standard/profile";

function getApiKey() {
  const key = (process.env.TRACKER_API_KEY || process.env.TRN_API_KEY || "").trim();
  if (!key) {
    throw new Error("Missing TRACKER_API_KEY (or TRN_API_KEY)");
  }
  return key;
}

function normalizePlatform(platform) {
  const raw = (platform || "").toString().trim().toLowerCase();
  if (raw === "epic" || raw === "epicgames") return "epic";
  if (raw === "steam") return "steam";
  if (raw === "xbl" || raw === "xbox") return "xbl";
  if (raw === "psn" || raw === "playstation") return "psn";
  return raw;
}

function getNumberStat(segment, key) {
  const value = segment?.stats?.[key]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rankFromPlaylistSegment(segment) {
  const tierName = segment?.stats?.tier?.metadata?.name || null;
  const divisionName = segment?.stats?.division?.metadata?.name || null;

  const rank = [tierName, divisionName].filter(Boolean).join(" ") || null;
  const mmr = getNumberStat(segment, "rating");

  return {
    ...(rank ? { rank } : {}),
    ...(typeof mmr === "number" ? { mmr: Math.round(mmr) } : {}),
  };
}

function parseProfileToRosterData(json) {
  const segments = Array.isArray(json?.data?.segments) ? json.data.segments : [];

  const byName = (fragment) =>
    segments.find((s) => {
      const name = (s?.metadata?.name || "").toString().toLowerCase();
      return name.includes(fragment);
    });

  const one = byName("ranked duel");
  const two = byName("ranked doubles");
  const three = byName("ranked standard");

  const ranks = {};
  const oneData = rankFromPlaylistSegment(one);
  const twoData = rankFromPlaylistSegment(two);
  const threeData = rankFromPlaylistSegment(three);

  if (Object.keys(oneData).length) ranks["1v1"] = oneData;
  if (Object.keys(twoData).length) ranks["2v2"] = twoData;
  if (Object.keys(threeData).length) ranks["3v3"] = threeData;

  const overview = segments.find((s) => s?.type === "overview") || null;

  const stats = {
    wins: getNumberStat(overview, "wins"),
    goals: getNumberStat(overview, "goals"),
    assists: getNumberStat(overview, "assists"),
    saves: getNumberStat(overview, "saves"),
    shots: getNumberStat(overview, "shots"),
  };

  return {
    ranks,
    trackerStats: stats,
    trackerUpdatedAt: new Date().toISOString(),
  };
}

export async function fetchTrackerPlayer({ platform, playerId }) {
  const key = getApiKey();
  const normalizedPlatform = normalizePlatform(platform);
  const safePlayerId = encodeURIComponent((playerId || "").toString());

  if (!normalizedPlatform || !safePlayerId) {
    throw new Error("Missing tracker platform or player ID");
  }

  const url = `${TRN_BASE}/${normalizedPlatform}/${safePlayerId}`;

  const res = await fetch(url, {
    headers: {
      "TRN-Api-Key": key,
      "Accept": "application/json",
    },
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Tracker request failed: ${res.status} ${text}`);
  }

  const json = text ? JSON.parse(text) : {};
  return parseProfileToRosterData(json);
}

export async function fetchTrackerRoster(team) {
  const players = Array.isArray(team?.players) ? team.players : [];

  const results = await Promise.all(
    players.map(async (player, index) => {
      const platform = player?.tracker?.platform || player?.platform || "";
      const playerId = player?.tracker?.id || "";

      if (!platform || !playerId) {
        return {
          index,
          ok: false,
          reason: "Missing tracker platform/id",
        };
      }

      try {
        const payload = await fetchTrackerPlayer({ platform, playerId });
        return {
          index,
          ok: true,
          ...payload,
        };
      } catch (e) {
        return {
          index,
          ok: false,
          reason: String(e),
        };
      }
    })
  );

  return {
    ok: true,
    source: "tracker.gg",
    players: results,
  };
}
