
require("dotenv").config();

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const WebSocket = require("ws");

const {
  TWITCH_CLIENT_ID: configuredClientId,
  TWITCH_CLIENT,
  TWITCH_CLIENT_SECRET,
  TWITCH_BOT_USERNAME,
  TWITCH_CHANNEL,
  OAUTH_REDIRECT_URI
} = process.env;

const TWITCH_CLIENT_ID = configuredClientId || TWITCH_CLIENT;
const PORT = 3000;
const TOKEN_FILE = "./tokens.json";

for (const [name, value] of Object.entries({
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_BOT_USERNAME,
  TWITCH_CHANNEL,
  OAUTH_REDIRECT_URI
})) {
  if (!value || value.startsWith("YOUR_") ||
      value.includes("YOUR-CODESPACE")) {
    console.error(`Configure ${name} in .env first.`);
    process.exit(1);
  }
}

const botLogin = TWITCH_BOT_USERNAME.toLowerCase().replace(/^@/, "");
const channelLogin = TWITCH_CHANNEL.toLowerCase().replace(/^@/, "");

let tokens = loadTokens();
let appToken = null;
let botId = null;
let broadcasterId = null;
let chat = null;
let oauthState = null;
let reconnectTimer = null;

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveTokens(value) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(value, null, 2), {
    mode: 0o600
  });
}

function form(values) {
  return new URLSearchParams(values).toString();
}

async function getAppToken() {
  if (appToken && appToken.expiresAt > Date.now() + 60000) {
    return appToken.value;
  }

  const response = await fetch(
    "https://id.twitch.tv/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        grant_type: "client_credentials"
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error("Could not obtain Twitch app token.");
  }

  appToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000
  };

  return appToken.value;
}

async function getUserToken() {
  if (!tokens) {
    throw new Error("Not authorized. Visit /login first.");
  }

  if (tokens.expiresAt > Date.now() + 60000) {
    return tokens.access_token;
  }

  const response = await fetch(
    "https://id.twitch.tv/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    tokens = null;
    throw new Error("Token refresh failed. Authorize again at /login.");
  }

  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000
  };

  saveTokens(tokens);
  return tokens.access_token;
}

async function twitchApi(path, options = {}, useUserToken = false) {
  const accessToken = useUserToken
    ? await getUserToken()
    : await getAppToken();

  const response = await fetch(
    `https://api.twitch.tv/helix/${path}`,
    {
      ...options,
      headers: {
        "Client-Id": TWITCH_CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
        ...(options.body
          ? { "Content-Type": "application/json" }
          : {}),
        ...options.headers
      }
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Twitch API ${response.status}: ${
        data.message || "Request failed"
      }`
    );
  }

  return data;
}

async function findUser(login) {
  const result = await twitchApi(
    `users?login=${encodeURIComponent(login.replace(/^@/, ""))}`
  );

  return result.data?.[0] || null;
}

async function initialise() {
  const bot = await findUser(botLogin);
  const broadcaster = await findUser(channelLogin);

  if (!bot || !broadcaster) {
    throw new Error("Could not find the bot or channel account.");
  }

  botId = bot.id;
  broadcasterId = broadcaster.id;

  console.log(`Bot account: ${bot.login}`);
  console.log(`Target channel: ${broadcaster.login}`);
}

function sendChat(message) {
  if (!chat || chat.readyState !== WebSocket.OPEN) return;

  const safeMessage = String(message)
    .replace(/[\r\n]/g, " ")
    .slice(0, 450);

  chat.send(
    `PRIVMSG #${channelLogin} :${safeMessage}\r\n`
  );
}

async function getStream() {
  const result = await twitchApi(
    `streams?user_id=${encodeURIComponent(broadcasterId)}`
  );

  return result.data?.[0] || null;
}

async function getChannelInfo() {
  const result = await twitchApi(
    `channels?broadcaster_id=${encodeURIComponent(broadcasterId)}`
  );

  return result.data?.[0] || null;
}

async function moderate(login, duration, reason) {
  const target = await findUser(login);

  if (!target) {
    throw new Error(`User "${login}" was not found.`);
  }

  if (target.id === botId || target.id === broadcasterId) {
    throw new Error("The bot and broadcaster cannot be targeted.");
  }

  const data = {
    user_id: target.id,
    reason: reason.slice(0, 400)
  };

  if (duration !== null) data.duration = duration;

  await twitchApi(
    `moderation/bans?broadcaster_id=${encodeURIComponent(broadcasterId)}` +
    `&moderator_id=${encodeURIComponent(botId)}`,
    {
      method: "POST",
      body: JSON.stringify({ data })
    },
    true
  );

  return target.login;
}

async function handleCommand(username, message, isMod) {
  const parts = message.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  try {
    switch (command) {
      case "!hello":
        sendChat(`Hello, ${username}!`);
        break;

      case "!commands":
        sendChat(
          "Commands: !hello, !commands, !uptime, !title, !game, !timeout, !ban"
        );
        break;

      case "!uptime": {
        const stream = await getStream();

        if (!stream) {
          sendChat("The channel is currently offline.");
          break;
        }

        const elapsed = Math.max(
          0,
          Date.now() - new Date(stream.started_at).getTime()
        );

        const totalMinutes = Math.floor(elapsed / 60000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        sendChat(`Stream uptime: ${hours}h ${minutes}m.`);
        break;
      }

      case "!title": {
        const info = await getChannelInfo();
        sendChat(info ? `Stream title: ${info.title}` : "Channel information unavailable.");
        break;
      }

      case "!game": {
        const info = await getChannelInfo();
        sendChat(
          info
            ? `Current category: ${info.game_name || "None set"}`
            : "Channel information unavailable."
        );
        break;
      }

      case "!timeout":
      case "!ban": {
        if (!isMod) {
          sendChat(`${username}, that command is for moderators only.`);
          break;
        }

        const target = (parts[1] || "").replace(/^@/, "");

        if (!/^[a-zA-Z0-9_]{1,25}$/.test(target)) {
          sendChat("Usage: !timeout username [seconds] [reason] or !ban username [reason]");
          break;
        }

        if (command === "!timeout") {
          const secondsText = parts[2] || "60";
          const seconds = Number(secondsText);

          if (
            !/^\d+$/.test(secondsText) ||
            seconds < 1 ||
            seconds > 1209600
          ) {
            sendChat("Timeout duration must be between 1 and 1209600 seconds.");
            break;
          }

          const reason = parts.slice(3).join(" ") || "Moderator timeout";
          const name = await moderate(target, seconds, reason);

          sendChat(`${name} timed out for ${seconds} seconds.`);
        } else {
          const reason = parts.slice(2).join(" ") || "Moderator ban";
          const name = await moderate(target, null, reason);

          sendChat(`${name} has been banned.`);
        }

        break;
      }
    }
  } catch (error) {
    console.error(`Command ${command} failed:`, error.message);
    sendChat("Command failed. Check bot permissions and terminal logs.");
  }
}

function connectChat() {
  if (chat) {
    chat.removeAllListeners();
    chat.close();
  }

  chat = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

  chat.on("open", async () => {
    try {
      const token = await getUserToken();

      chat.send(`PASS oauth:${token}\r\n`);
      chat.send(`NICK ${botLogin}\r\n`);
      chat.send(
        "CAP REQ :twitch.tv/tags twitch.tv/commands\r\n"
      );
      chat.send(`JOIN #${channelLogin}\r\n`);

      console.log(`Connected to Twitch chat: #${channelLogin}`);
    } catch (error) {
      console.error("Chat authentication failed:", error.message);
      chat.close();
    }
  });

  chat.on("message", async (buffer) => {
    const raw = buffer.toString();

    for (const line of raw.split("\r\n")) {
      if (!line) continue;

      if (line.startsWith("PING ")) {
        chat.send(line.replace("PING", "PONG") + "\r\n");
        continue;
      }

      if (/Login authentication failed|Improperly formatted auth/i.test(line)) {
        console.error("Twitch rejected the chat token. Reauthorize at /login.");
        continue;
      }

      const userMatch = line.match(/ :([^!]+)!/);
      const messageMatch = line.match(/PRIVMSG #\S+ :(.*)$/);

      if (!userMatch || !messageMatch) continue;

      const username = userMatch[1].toLowerCase();
      const message = messageMatch[1];

      if (username === botLogin || !message.startsWith("!")) continue;

      const badgesMatch = line.match(/(?:^| )badges=([^; ]*)/);
      const badges = badgesMatch ? badgesMatch[1] : "";

      const isMod =
        badges.split(",").includes("moderator/1") ||
        badges.split(",").includes("broadcaster/1");

      await handleCommand(username, message, isMod);
    }
  });

  chat.on("close", () => {
    console.log("Chat disconnected.");

    if (reconnectTimer) clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(() => {
      connectChat();
    }, 10000);
  });

  chat.on("error", (error) => {
    console.error("Chat connection error:", error.message);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3000");

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Twitch bot is running. Visit /login to authorize it.");
    return;
  }

  if (url.pathname === "/login") {
    oauthState = crypto.randomBytes(32).toString("hex");

    const authorize = new URL("https://id.twitch.tv/oauth2/authorize");
    authorize.searchParams.set("client_id", TWITCH_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set(
      "scope",
      "chat:read chat:edit moderator:manage:banned_users"
    );
    authorize.searchParams.set("state", oauthState);

    res.writeHead(302, { Location: authorize.toString() });
    res.end();
    return;
  }

  if (url.pathname === "/auth/twitch/callback") {
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");

    if (!code || !oauthState || returnedState !== oauthState) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid OAuth state. Return to /login and try again.");
      return;
    }

    oauthState = null;

    try {
      const response = await fetch(
        "https://id.twitch.tv/oauth2/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: form({
            client_id: TWITCH_CLIENT_ID,
            client_secret: TWITCH_CLIENT_SECRET,
            code,
            grant_type: "authorization_code",
            redirect_uri: OAUTH_REDIRECT_URI
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error("OAuth exchange failed. Check your redirect URL and credentials.");
      }

      tokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000
      };

      saveTokens(tokens);

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Twitch authorization successful. Return to your Codespaces terminal.");

      await initialise();
      connectChat();
    } catch (error) {
      console.error("OAuth setup failed:", error.message);

      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Authorization failed. Check the terminal logs.");
      }
    }

    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OAuth server listening on port ${PORT}.`);
  console.log("Open your Codespaces port 3000 URL followed by /login.");
});

process.on("SIGINT", () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (chat) chat.close();

  server.close(() => process.exit(0));
});
