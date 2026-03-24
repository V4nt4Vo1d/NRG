

const TWITCH_OAUTH_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_API_BASE = "https://api.twitch.tv/helix";

let cached = { token: null, expiresAt: 0 };

async function getAppToken() {
  const now = Date.now();
  if (cached.token && cached.expiresAt > now + 10_000) return cached.token;

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET");
  }

  const url = new URL(TWITCH_OAUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("grant_type", "client_credentials");

  const res = await fetch(url.toString(), { method: "POST" });
  if (!res.ok) throw new Error(`Twitch token request failed: ${res.status}`);
  const json = await res.json();

  cached.token = json.access_token;
  cached.expiresAt = now + (json.expires_in * 1000);
  return cached.token;
}

export async function getLiveMap(logins) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const token = await getAppToken();

  const url = new URL(`${TWITCH_API_BASE}/streams`);
  for (const login of logins) url.searchParams.append("user_login", login);

  const res = await fetch(url.toString(), {
    headers: {
      "Client-ID": clientId,
      "Authorization": `Bearer ${token}`,
    }
  });

  if (!res.ok) throw new Error(`Twitch streams request failed: ${res.status}`);
  const json = await res.json();

  const live = {};
  const channels = {};
  for (const login of logins) live[login] = false;

  for (const s of (json.data || [])) {
    const login = (s.user_login || "").toLowerCase();
    live[login] = true;
    channels[login] = {
      title: s.title,
      game: s.game_name,
      started_at: s.started_at,
      viewer_count: s.viewer_count,
    };
  }

  return { live, channels };
}
