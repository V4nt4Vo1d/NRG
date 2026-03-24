import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

import { getLiveMap } from "./twitch.js";
import { getRecentReplays } from "./ballchasing.js";
import { fetchTrackerRoster } from "./tracker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.join(__dirname, "..");
const random5Root = path.join(appRoot, "..");

dotenv.config({ path: path.join(appRoot, ".env") });
dotenv.config({ path: path.join(random5Root, ".env"), override: false });

const app = express();
app.use(express.json({ limit: "1mb" }));

function createTimedCache(defaultTtlMs) {
  const store = new Map();

  return {
    get(key) {
      const now = Date.now();
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= now) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    set(key, value, ttlMs = defaultTtlMs) {
      const expiresAt = Date.now() + Math.max(0, Number(ttlMs) || defaultTtlMs);
      store.set(key, { value, expiresAt });
      return value;
    },
    clear() {
      store.clear();
    },
  };
}

const apiCaches = {
  team: createTimedCache(5_000),
  twitch: createTimedCache(30_000),
  ballchasing: createTimedCache(45_000),
  tracker: createTimedCache(120_000),
};

function normalizeIdentity(value) {
  return (value || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getTrackedIdentitiesFromTeam(team) {
  const players = Array.isArray(team?.players) ? team.players : [];
  const values = [];

  for (const p of players) {
    values.push(p?.name, p?.twitch, p?.tracker?.id);
  }

  return [...new Set(values.map(normalizeIdentity).filter(Boolean))];
}

function normalizeOriginValue(value) {
  return (value || "").toString().trim().toLowerCase().replace(/\/+$/, "");
}

function toHostname(value) {
  const input = normalizeOriginValue(value);
  if (!input) return "";
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return input.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
  }
}

const strictCors = process.env.STRICT_CORS === "true";
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => normalizeOriginValue(s))
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes("*")) return true;

  const normalizedOrigin = normalizeOriginValue(origin);
  const requestHost = toHostname(normalizedOrigin);

  return allowedOrigins.some((allowed) => {
    if (allowed === normalizedOrigin) return true;
    return toHostname(allowed) === requestHost;
  });
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!strictCors) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, TRN-Api-Key");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const publicDir = path.join(__dirname, "..", "public");
const teamPath = path.join(publicDir, "data", "team.json");

app.use(express.static(publicDir, {
  extensions: ["html"],
  maxAge: "1h",
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache");
      return;
    }

    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  },
}));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/team", (req, res) => {
  try {
    const cached = apiCaches.team.get("team");
    const raw = cached || fs.readFileSync(teamPath, "utf-8");
    if (!cached) apiCaches.team.set("team", raw);
    res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
    res.type("json").send(raw);
  } catch (e) {
    res.status(500).json({ ok: false, error: "Could not read team.json", details: String(e) });
  }
});

app.post("/api/team/snapshot", (req, res) => {
  try {
    const { playerIndex, ranks } = req.body || {};
    if (typeof playerIndex !== "number" || !ranks) {
      return res.status(400).json({ ok: false, error: "Invalid payload" });
    }

    const raw = fs.readFileSync(teamPath, "utf-8");
    const team = JSON.parse(raw);

    if (!Array.isArray(team.players) || !team.players[playerIndex]) {
      return res.status(404).json({ ok: false, error: "Player not found" });
    }

    const now = new Date().toISOString();
    const p = team.players[playerIndex];
    p.ranks = p.ranks || {};
    for (const key of Object.keys(ranks)) {
      const r = ranks[key];
      if (!r) continue;
      p.ranks[key] = {
        ...(p.ranks[key] || {}),
        ...(r.rank ? { rank: r.rank } : {}),
        ...(typeof r.mmr === "number" && !Number.isNaN(r.mmr) ? { mmr: r.mmr } : {}),
      };
    }

    team.snapshots = team.snapshots || [];
    team.snapshots.push({
      createdAt: now,
      player: p.name || `Player ${playerIndex}`,
      ranks: ranks,
    });

    fs.writeFileSync(teamPath, JSON.stringify(team, null, 2), "utf-8");
    apiCaches.team.clear();
    apiCaches.tracker.clear();
    apiCaches.ballchasing.clear();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Could not write snapshot", details: String(e) });
  }
});


app.get("/api/twitch/live", async (req, res) => {
  const logins = (req.query.logins || "").toString().split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!logins.length) return res.json({ ok: true, live: {}, channels: {} });

  try {
    const key = [...new Set(logins)].sort().join(",");
    let data = apiCaches.twitch.get(key);
    if (!data) {
      data = await getLiveMap(logins);
      apiCaches.twitch.set(key, data);
    }
    res.setHeader("Cache-Control", "public, max-age=20, stale-while-revalidate=60");
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(503).json({ ok: false, error: "Twitch not configured or request failed", details: String(e) });
  }
});

app.get("/api/ballchasing/recent", async (req, res) => {
  try {
    let groupId = process.env.BALLCHASING_GROUP_ID || "";
    let trackedIdentities = ["fahxey", "v4nt4vo1d"];

    if (!groupId) {
      try {
        const raw = fs.readFileSync(teamPath, "utf-8");
        const team = JSON.parse(raw);
        groupId = team?.ballchasing?.groupId || "";
        const rosterIdentities = getTrackedIdentitiesFromTeam(team);
        if (rosterIdentities.length) trackedIdentities = rosterIdentities;
      } catch {}
    } else {
      try {
        const raw = fs.readFileSync(teamPath, "utf-8");
        const team = JSON.parse(raw);
        const rosterIdentities = getTrackedIdentitiesFromTeam(team);
        if (rosterIdentities.length) trackedIdentities = rosterIdentities;
      } catch {}
    }

    const cacheKey = `${groupId || "latest"}|${trackedIdentities.join(",")}`;
    let payload = apiCaches.ballchasing.get(cacheKey);
    if (!payload) {
      payload = await getRecentReplays({
        groupId,
        count: 10,
        trackedIdentities,
      });
      apiCaches.ballchasing.set(cacheKey, payload);
    }

    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
    res.json(payload);
  } catch (e) {
    res.status(503).json({ ok: false, note: "Ballchasing not configured or request failed.", details: String(e) });
  }
});

app.get("/api/tracker/roster", async (req, res) => {
  try {
    let payload = apiCaches.tracker.get("roster");
    if (!payload) {
      const raw = fs.readFileSync(teamPath, "utf-8");
      const team = JSON.parse(raw);
      payload = await fetchTrackerRoster(team);
      apiCaches.tracker.set("roster", payload);
    }

    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=180");
    res.json(payload);
  } catch (e) {
    res.status(503).json({ ok: false, note: "Tracker not configured or request failed.", details: String(e) });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const port = process.env.PORT ? Number(process.env.PORT) : 5173;
app.listen(port, () => {
  console.log(`Rocket League Team Tracker running at http://localhost:${port}`);
});
