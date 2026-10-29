
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
  TWITCH_CHANNELS: configuredChannels,
  TWITCH_CHANNEL,
  OAUTH_REDIRECT_URI
} = process.env;

const TWITCH_CLIENT_ID = configuredClientId || TWITCH_CLIENT;
const configuredChannelNames = configuredChannels || TWITCH_CHANNEL;
const PORT = 3000;
const TOKEN_FILE = "./tokens.json";

for (const [name, value] of Object.entries({
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_BOT_USERNAME,
  TWITCH_CHANNELS: configuredChannelNames,
  OAUTH_REDIRECT_URI
})) {
  if (!value || value.startsWith("YOUR_") ||
      value.includes("YOUR-CODESPACE")) {
    console.error(`Configure ${name} in .env first.`);
    process.exit(1);
  }
}

const botLogin = TWITCH_BOT_USERNAME.toLowerCase().replace(/^@/, "");
const channelLogins = [...new Set(
  configuredChannelNames
    .split(",")
    .map((channel) => channel.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean)
)];

if (
  channelLogins.length === 0 ||
  channelLogins.some((login) => !/^[a-z0-9_]{1,25}$/.test(login))
) {
  console.error("Configure TWITCH_CHANNELS as comma-separated Twitch usernames.");
  process.exit(1);
}

let tokens = loadTokens();
let appToken = null;
let botId = null;
let channels = new Map();
let chat = null;
let oauthState = null;
let reconnectTimer = null;

const FUN_FACTS = [
  "Octopuses have three hearts: two pump blood to the gills and one pumps it to the rest of the body.",
  "Honey never spoils. Archaeologists have found edible honey in ancient tombs.",
  "Bananas are berries, but strawberries are not.",
  "A day on Venus is longer than a year on Venus.",
  "Wombat poop is cube-shaped.",
  "The Eiffel Tower can grow by up to 15 cm in the summer due to heat expansion.",
  "There are more possible iterations of a game of chess than there are atoms in the observable universe.",
  "A group of flamingos is called a flamboyance.",
  "Sharks are older than trees.",
  "The shortest war in history lasted 38 to 45 minutes.",
  "Dolphins have unique names for each other.",
  "A cloud can weigh more than 1 million pounds.",
  "The human brain uses around 20% of the body's total energy.",
  "Some turtles can breathe through their butts."
];

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

  if (!bot) {
    throw new Error("Could not find the bot account.");
  }

  const channelUsers = await Promise.all(
    channelLogins.map(async (login) => [login, await findUser(login)])
  );
  const missingChannel = channelUsers.find(([, user]) => !user);

  if (missingChannel) {
    throw new Error(`Could not find channel account "${missingChannel[0]}".`);
  }

  botId = bot.id;
  channels = new Map(
    channelUsers.map(([login, user]) => [
      login,
      { login: user.login, broadcasterId: user.id }
    ])
  );

  console.log(`Bot account: ${bot.login}`);
  console.log(`Target channels: ${[...channels.keys()].map((login) => `#${login}`).join(", ")}`);
}

function sendChat(channelLogin, message) {
  if (!chat || chat.readyState !== WebSocket.OPEN) return;

  const safeMessage = String(message)
    .replace(/[\r\n]/g, " ")
    .slice(0, 450);

  chat.send(
    `PRIVMSG #${channelLogin} :${safeMessage}\r\n`
  );
}

async function getStream(channel) {
  const result = await twitchApi(
    `streams?user_id=${encodeURIComponent(channel.broadcasterId)}`
  );

  return result.data?.[0] || null;
}

async function getChannelInfo(channel) {
  const result = await twitchApi(
    `channels?broadcaster_id=${encodeURIComponent(channel.broadcasterId)}`
  );

  return result.data?.[0] || null;
}

async function moderate(channel, login, duration, reason) {
  const target = await findUser(login);

  if (!target) {
    throw new Error(`User "${login}" was not found.`);
  }

  if (target.id === botId || target.id === channel.broadcasterId) {
    throw new Error("The bot and broadcaster cannot be targeted.");
  }

  const data = {
    user_id: target.id,
    reason: reason.slice(0, 400)
  };

  if (duration !== null) data.duration = duration;

  await twitchApi(
    `moderation/bans?broadcaster_id=${encodeURIComponent(channel.broadcasterId)}` +
    `&moderator_id=${encodeURIComponent(botId)}`,
    {
      method: "POST",
      body: JSON.stringify({ data })
    },
    true
  );

  return target.login;
}

async function unban(channel, login) {
  const target = await findUser(login);

  if (!target) {
    throw new Error(`User "${login}" was not found.`);
  }

  if (target.id === botId || target.id === channel.broadcasterId) {
    throw new Error("The bot and broadcaster cannot be targeted.");
  }

  await twitchApi(
    `moderation/bans?broadcaster_id=${encodeURIComponent(channel.broadcasterId)}` +
    `&moderator_id=${encodeURIComponent(botId)}` +
    `&user_id=${encodeURIComponent(target.id)}`,
    { method: "DELETE" },
    true
  );

  return target.login;
}

async function handleCommand(
  channelLogin,
  channel,
  username,
  message,
  isMod,
  isBroadcaster
) {
  const reply = (message) => sendChat(channelLogin, message);
  const parts = message.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  try {
    switch (command) {
      case "!hello":
        reply(`Hello, ${username}!`);
        break;

      case "!commands":
        reply(
          "Commands: !hello, !commands, !fact, !funfact, !member, !uptime, !viewers, !title, !game, " +
          "!dice [sides], !coinflip, !8ball <question>, !lurk, !back; " +
          "mods: !so username, !timeout, !ban, !unban; broadcaster: !mod username"
        );
        break;

      case "!member": {
        const user = await findUser(username);

        if (!user) {
          reply(`Could not find Twitch account "${username}".`);
          break;
        }

        const createdAt = Date.parse(user.created_at);

        if (!Number.isFinite(createdAt)) {
          throw new Error("Twitch returned an invalid account creation date.");
        }

        const ageDays = Math.max(
          0,
          Math.floor((Date.now() - createdAt) / 86400000)
        );
        const age = ageDays === 0
          ? "less than a day"
          : `${ageDays} ${ageDays === 1 ? "day" : "days"}`;
        const joined = new Intl.DateTimeFormat("en-US", {
          dateStyle: "medium",
          timeZone: "UTC"
        }).format(createdAt);

        reply(`${user.display_name}'s Twitch account is ${age} old (created ${joined}).`);
        break;
      }

      case "!fact":
      case "!funfact":
        reply(`Fun fact: ${FUN_FACTS[crypto.randomInt(0, FUN_FACTS.length)]}`);
        break;

      case "!uptime": {
        const stream = await getStream(channel);

        if (!stream) {
          reply("The channel is currently offline.");
          break;
        }

        const elapsed = Math.max(
          0,
          Date.now() - new Date(stream.started_at).getTime()
        );

        const totalMinutes = Math.floor(elapsed / 60000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        reply(`Stream uptime: ${hours}h ${minutes}m.`);
        break;
      }

      case "!viewers": {
        const stream = await getStream(channel);
        reply(
          stream
            ? `There are ${stream.viewer_count} viewers in the channel.`
            : "The channel is currently offline."
        );
        break;
      }

      case "!title": {
        const info = await getChannelInfo(channel);
        reply(info ? `Stream title: ${info.title}` : "Channel information unavailable.");
        break;
      }

      case "!game": {
        const info = await getChannelInfo(channel);
        reply(
          info
            ? `Current category: ${info.game_name || "None set"}`
            : "Channel information unavailable."
        );
        break;
      }

      case "!dice": {
        const sidesText = parts[1] || "6";
        const sides = Number(sidesText);

        if (!/^\d+$/.test(sidesText) || sides < 2 || sides > 1000) {
          reply("Usage: !dice [sides] (choose between 2 and 1000).");
          break;
        }

        reply(`${username} rolled ${crypto.randomInt(1, sides + 1)} (1-${sides}).`);
        break;
      }

      case "!coinflip":
        reply(`Coin flip: ${crypto.randomInt(0, 2) === 0 ? "heads" : "tails"}.`);
        break;

      case "!8ball": {
        if (parts.length < 2) {
          reply("Ask a question after !8ball.");
          break;
        }

        const answers = [
          "It is certain.",
          "Without a doubt.",
          "You may rely on it.",
          "Ask again later.",
          "Cannot predict now.",
          "Don't count on it.",
          "My reply is no.",
          "Outlook is good."
        ];

        reply(answers[crypto.randomInt(0, answers.length)]);
        break;
      }

      case "!lurk":
        reply(`${username} is lurking. Thanks for hanging out!`);
        break;

      case "!back":
        reply(`Welcome back, ${username}!`);
        break;

      case "!so": {
        if (!isMod) {
          reply(`${username}, that command is for moderators only.`);
          break;
        }

        const target = (parts[1] || "").replace(/^@/, "");

        if (!/^[a-zA-Z0-9_]{1,25}$/.test(target)) {
          reply("Usage: !so username");
          break;
        }

        const user = await findUser(target);

        if (!user) {
          reply(`Could not find Twitch user "${target}".`);
          break;
        }

        reply(`Go check out ${user.display_name}: https://twitch.tv/${user.login}`);
        break;
      }

      case "!mod": {
        if (!isBroadcaster) {
          reply(`${username}, that command is for the broadcaster only.`);
          break;
        }

        const target = (parts[1] || "").replace(/^@/, "");

        if (!/^[a-zA-Z0-9_]{1,25}$/.test(target)) {
          reply("Usage: !mod username");
          break;
        }

        const user = await findUser(target);

        if (!user) {
          reply(`Could not find Twitch user "${target}".`);
          break;
        }

        sendChat(channelLogin, `/mod ${user.login}`);
        break;
      }

      case "!timeout":
      case "!ban":
      case "!unban": {
        if (!isMod) {
          reply(`${username}, that command is for moderators only.`);
          break;
        }

        const target = (parts[1] || "").replace(/^@/, "");

        if (!/^[a-zA-Z0-9_]{1,25}$/.test(target)) {
          reply(
            "Usage: !timeout username [seconds] [reason], !ban username [reason], or !unban username"
          );
          break;
        }

        if (command === "!unban") {
          const name = await unban(channel, target);
          reply(`${name} has been unbanned.`);
        } else if (command === "!timeout") {
          const secondsText = parts[2] || "60";
          const seconds = Number(secondsText);

          if (
            !/^\d+$/.test(secondsText) ||
            seconds < 1 ||
            seconds > 1209600
          ) {
            reply("Timeout duration must be between 1 and 1209600 seconds.");
            break;
          }

          const reason = parts.slice(3).join(" ") || "Moderator timeout";
          const name = await moderate(channel, target, seconds, reason);

          reply(`${name} timed out for ${seconds} seconds.`);
        } else {
          const reason = parts.slice(2).join(" ") || "Moderator ban";
          const name = await moderate(channel, target, null, reason);

          reply(`${name} has been banned.`);
        }

        break;
      }
    }
  } catch (error) {
    console.error(`Command ${command} failed:`, error.message);
    reply("Command failed. Check bot permissions and terminal logs.");
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
      chat.send(`JOIN ${channelLogins.map((login) => `#${login}`).join(",")}\r\n`);

      console.log(`Connected to Twitch chat: ${channelLogins.map((login) => `#${login}`).join(", ")}`);
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
      const messageMatch = line.match(/PRIVMSG #(\S+) :(.*)$/);

      if (!userMatch || !messageMatch) continue;

      const username = userMatch[1].toLowerCase();
      const channelLogin = messageMatch[1].toLowerCase();
      const message = messageMatch[2];
      const channel = channels.get(channelLogin);

      if (!channel || username === botLogin || !message.startsWith("!")) continue;

      const badgesMatch = line.match(/(?:^| )badges=([^; ]*)/);
      const badges = badgesMatch ? badgesMatch[1] : "";

      const isMod =
        badges.split(",").includes("moderator/1") ||
        badges.split(",").includes("broadcaster/1");
      const isBroadcaster = badges.split(",").includes("broadcaster/1");

      await handleCommand(
        channelLogin,
        channel,
        username,
        message,
        isMod,
        isBroadcaster
      );
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
