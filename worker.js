const TOKEN_KEY = "twitch_tokens";
const OAUTH_STATE_KEY = "oauth_state";

function randomInt(max) {
  const range = 0x100000000;
  const limit = Math.floor(range / max) * max;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % max;
}

function randomState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers }
  });
}

export class TwitchBot {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.appToken = null;
    this.botId = null;
    this.channels = new Map();
    this.chat = null;
    this.initialized = false;
  }

  configuration() {
    const clientId = this.env.TWITCH_CLIENT_ID || this.env.TWITCH_CLIENT;
    const channelNames = this.env.TWITCH_CHANNELS || this.env.TWITCH_CHANNEL;
    const values = {
      TWITCH_CLIENT_ID: clientId,
      TWITCH_CLIENT_SECRET: this.env.TWITCH_CLIENT_SECRET,
      TWITCH_BOT_USERNAME: this.env.TWITCH_BOT_USERNAME,
      TWITCH_CHANNELS: channelNames,
      OAUTH_REDIRECT_URI: this.env.OAUTH_REDIRECT_URI
    };

    for (const [name, value] of Object.entries(values)) {
      if (!value || /your[_-]/i.test(value)) {
        throw new Error(`Configure ${name} in the Wrangler environment.`);
      }
    }

    const botLogin = values.TWITCH_BOT_USERNAME.toLowerCase().replace(/^@/, "");
    const channelLogins = [...new Set(
      channelNames
        .split(",")
        .map((channel) => channel.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean)
    )];

    if (
      !/^[a-z0-9_]{1,25}$/.test(botLogin) ||
      channelLogins.length === 0 ||
      channelLogins.some((login) => !/^[a-z0-9_]{1,25}$/.test(login))
    ) {
      throw new Error(
        "Configure TWITCH_BOT_USERNAME and TWITCH_CHANNELS with valid Twitch usernames."
      );
    }

    return {
      clientId,
      clientSecret: values.TWITCH_CLIENT_SECRET,
      redirectUri: values.OAUTH_REDIRECT_URI,
      botLogin,
      channelLogins
    };
  }

  async fetch(request) {
    try {
      const config = this.configuration();
      await this.ensureBotStarted(config);

      const url = new URL(request.url);

      if (url.pathname === "/") {
        return textResponse("Twitch bot is running. Visit /login to authorize it.");
      }

      if (url.pathname === "/login") {
        const state = randomState();
        await this.state.storage.put(OAUTH_STATE_KEY, {
          value: state,
          expiresAt: Date.now() + 10 * 60 * 1000
        });

        const authorize = new URL("https://id.twitch.tv/oauth2/authorize");
        authorize.searchParams.set("client_id", config.clientId);
        authorize.searchParams.set("redirect_uri", config.redirectUri);
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set(
          "scope",
          "chat:read chat:edit moderator:manage:banned_users"
        );
        authorize.searchParams.set("state", state);

        return new Response(null, {
          status: 302,
          headers: { Location: authorize.toString() }
        });
      }

      if (url.pathname === "/auth/twitch/callback") {
        return await this.handleOAuthCallback(url, config);
      }

      return textResponse("Not found", 404);
    } catch (error) {
      console.error("Worker request failed:", error.message);
      return textResponse("The bot could not handle this request. Check Worker logs.", 500);
    }
  }

  async handleOAuthCallback(url, config) {
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const savedState = await this.state.storage.get(OAUTH_STATE_KEY);

    await this.state.storage.delete(OAUTH_STATE_KEY);

    if (
      !code ||
      !savedState ||
      savedState.expiresAt < Date.now() ||
      returnedState !== savedState.value
    ) {
      return textResponse("Invalid or expired OAuth state. Return to /login and try again.", 400);
    }

    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri
      })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("OAuth exchange failed:", data.message || response.status);
      return textResponse(
        "Authorization failed. Check the Twitch redirect URL and Worker logs.",
        502
      );
    }

    await this.state.storage.put(TOKEN_KEY, {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000
    });

    this.initialized = false;
    await this.initialise(config);
    this.connectChat(config);
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);

    return textResponse("Twitch authorization successful. The bot is connecting to chat.");
  }

  async ensureBotStarted(config) {
    const tokens = await this.state.storage.get(TOKEN_KEY);
    if (!tokens) return;

    if (!this.initialized) await this.initialise(config);
    this.connectChat(config);

    if (!(await this.state.storage.getAlarm())) {
      await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
  }

  async alarm() {
    try {
      const config = this.configuration();
      await this.ensureBotStarted(config);
      if (await this.state.storage.get(TOKEN_KEY)) {
        await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
      }
    } catch (error) {
      console.error("Bot alarm failed:", error.message);
      await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    }
  }

  async getAppToken(config) {
    if (this.appToken && this.appToken.expiresAt > Date.now() + 60_000) {
      return this.appToken.value;
    }

    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "client_credentials"
      })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error("Could not obtain Twitch app token.");
    }

    this.appToken = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000
    };
    return this.appToken.value;
  }

  async getUserToken(config) {
    const tokens = await this.state.storage.get(TOKEN_KEY);
    if (!tokens) throw new Error("Not authorized. Visit /login first.");
    if (tokens.expiresAt > Date.now() + 60_000) return tokens.access_token;

    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token
      })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      await this.state.storage.delete(TOKEN_KEY);
      throw new Error("Token refresh failed. Authorize again at /login.");
    }

    const refreshedTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000
    };
    await this.state.storage.put(TOKEN_KEY, refreshedTokens);
    return refreshedTokens.access_token;
  }

  async twitchApi(path, options = {}, useUserToken = false) {
    const config = this.configuration();
    const accessToken = useUserToken
      ? await this.getUserToken(config)
      : await this.getAppToken(config);
    const response = await fetch(`https://api.twitch.tv/helix/${path}`, {
      ...options,
      headers: {
        "Client-Id": config.clientId,
        Authorization: `Bearer ${accessToken}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        `Twitch API ${response.status}: ${data.message || "Request failed"}`
      );
    }

    return data;
  }

  async findUser(login) {
    const result = await this.twitchApi(
      `users?login=${encodeURIComponent(login.replace(/^@/, ""))}`
    );
    return result.data?.[0] || null;
  }

  async initialise(config) {
    const bot = await this.findUser(config.botLogin);
    if (!bot) throw new Error("Could not find the bot account.");

    const channelUsers = await Promise.all(
      config.channelLogins.map(async (login) => [login, await this.findUser(login)])
    );
    const missingChannel = channelUsers.find(([, user]) => !user);
    if (missingChannel) {
      throw new Error(`Could not find channel account "${missingChannel[0]}".`);
    }

    this.botId = bot.id;
    this.channels = new Map(
      channelUsers.map(([login, user]) => [
        login,
        { login: user.login, broadcasterId: user.id }
      ])
    );
    this.initialized = true;
    console.log(`Bot account: ${bot.login}`);
    console.log(`Target channels: ${[...this.channels.keys()].map((login) => `#${login}`).join(", ")}`);
  }

  sendChat(channelLogin, message) {
    if (!this.chat || this.chat.readyState !== WebSocket.OPEN) return;
    const safeMessage = String(message).replace(/[\r\n]/g, " ").slice(0, 450);
    this.chat.send(`PRIVMSG #${channelLogin} :${safeMessage}\r\n`);
  }

  async getStream(channel) {
    const result = await this.twitchApi(
      `streams?user_id=${encodeURIComponent(channel.broadcasterId)}`
    );
    return result.data?.[0] || null;
  }

  async getChannelInfo(channel) {
    const result = await this.twitchApi(
      `channels?broadcaster_id=${encodeURIComponent(channel.broadcasterId)}`
    );
    return result.data?.[0] || null;
  }

  async moderate(channel, login, duration, reason) {
    const target = await this.findUser(login);
    if (!target) throw new Error(`User "${login}" was not found.`);
    if (target.id === this.botId || target.id === channel.broadcasterId) {
      throw new Error("The bot and broadcaster cannot be targeted.");
    }

    const data = { user_id: target.id, reason: reason.slice(0, 400) };
    if (duration !== null) data.duration = duration;
    await this.twitchApi(
      `moderation/bans?broadcaster_id=${encodeURIComponent(channel.broadcasterId)}` +
        `&moderator_id=${encodeURIComponent(this.botId)}`,
      { method: "POST", body: JSON.stringify({ data }) },
      true
    );
    return target.login;
  }

  async unban(channel, login) {
    const target = await this.findUser(login);
    if (!target) throw new Error(`User "${login}" was not found.`);
    if (target.id === this.botId || target.id === channel.broadcasterId) {
      throw new Error("The bot and broadcaster cannot be targeted.");
    }

    await this.twitchApi(
      `moderation/bans?broadcaster_id=${encodeURIComponent(channel.broadcasterId)}` +
        `&moderator_id=${encodeURIComponent(this.botId)}` +
        `&user_id=${encodeURIComponent(target.id)}`,
      { method: "DELETE" },
      true
    );
    return target.login;
  }

  async handleCommand(channelLogin, channel, username, message, isMod) {
    const reply = (text) => this.sendChat(channelLogin, text);
    const parts = message.trim().split(/\s+/);
    const command = parts[0].toLowerCase();

    try {
      switch (command) {
        case "!hello":
          reply(`Hello, ${username}!`);
          break;
        case "!commands":
          reply(
            "Commands: !hello, !commands, !uptime, !viewers, !title, !game, " +
              "!dice [sides], !coinflip, !8ball <question>, !lurk, !back, " +
              "!so username, !timeout, !ban, !unban (mod commands)"
          );
          break;
        case "!uptime": {
          const stream = await this.getStream(channel);
          if (!stream) {
            reply("The channel is currently offline.");
            break;
          }
          const elapsed = Math.max(0, Date.now() - new Date(stream.started_at).getTime());
          const totalMinutes = Math.floor(elapsed / 60_000);
          reply(`Stream uptime: ${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m.`);
          break;
        }
        case "!viewers": {
          const stream = await this.getStream(channel);
          reply(
            stream
              ? `There are ${stream.viewer_count} viewers in the channel.`
              : "The channel is currently offline."
          );
          break;
        }
        case "!title": {
          const info = await this.getChannelInfo(channel);
          reply(info ? `Stream title: ${info.title}` : "Channel information unavailable.");
          break;
        }
        case "!game": {
          const info = await this.getChannelInfo(channel);
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
          reply(`${username} rolled ${randomInt(sides) + 1} (1-${sides}).`);
          break;
        }
        case "!coinflip":
          reply(`Coin flip: ${randomInt(2) === 0 ? "heads" : "tails"}.`);
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
          reply(answers[randomInt(answers.length)]);
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
          const user = await this.findUser(target);
          if (!user) {
            reply(`Could not find Twitch user "${target}".`);
            break;
          }
          reply(`Go check out ${user.display_name}: https://twitch.tv/${user.login}`);
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
            const name = await this.unban(channel, target);
            reply(`${name} has been unbanned.`);
          } else if (command === "!timeout") {
            const secondsText = parts[2] || "60";
            const seconds = Number(secondsText);
            if (!/^\d+$/.test(secondsText) || seconds < 1 || seconds > 1_209_600) {
              reply("Timeout duration must be between 1 and 1209600 seconds.");
              break;
            }
            const reason = parts.slice(3).join(" ") || "Moderator timeout";
            const name = await this.moderate(channel, target, seconds, reason);
            reply(`${name} timed out for ${seconds} seconds.`);
          } else {
            const reason = parts.slice(2).join(" ") || "Moderator ban";
            const name = await this.moderate(channel, target, null, reason);
            reply(`${name} has been banned.`);
          }
          break;
        }
      }
    } catch (error) {
      console.error(`Command ${command} failed:`, error.message);
      reply("Command failed. Check bot permissions and Worker logs.");
    }
  }

  connectChat(config) {
    if (
      this.chat &&
      (this.chat.readyState === WebSocket.CONNECTING ||
        this.chat.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    const chat = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.chat = chat;

    chat.addEventListener("open", async () => {
      try {
        const token = await this.getUserToken(config);
        if (this.chat !== chat) return;
        chat.send(`PASS oauth:${token}\r\n`);
        chat.send(`NICK ${config.botLogin}\r\n`);
        chat.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
        chat.send(`JOIN ${config.channelLogins.map((login) => `#${login}`).join(",")}\r\n`);
        console.log(`Connected to Twitch chat: ${config.channelLogins.map((login) => `#${login}`).join(", ")}`);
      } catch (error) {
        console.error("Chat authentication failed:", error.message);
        chat.close();
      }
    });

    chat.addEventListener("message", async (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      for (const line of raw.split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING ")) {
          if (chat.readyState === WebSocket.OPEN) {
            chat.send(line.replace("PING", "PONG") + "\r\n");
          }
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
        const channel = this.channels.get(channelLogin);
        if (!channel || username === config.botLogin || !message.startsWith("!")) continue;

        const badgesMatch = line.match(/(?:^| )badges=([^; ]*)/);
        const badges = badgesMatch ? badgesMatch[1] : "";
        const isMod =
          badges.split(",").includes("moderator/1") ||
          badges.split(",").includes("broadcaster/1");

        await this.handleCommand(channelLogin, channel, username, message, isMod);
      }
    });

    chat.addEventListener("close", () => {
      if (this.chat === chat) this.chat = null;
      console.log("Chat disconnected; the Durable Object alarm will reconnect it.");
    });

    chat.addEventListener("error", () => {
      console.error("Chat connection error.");
    });
  }
}

export default {
  async fetch(request, env) {
    const id = env.BOT.idFromName("twitch-bot");
    return env.BOT.get(id).fetch(request);
  }
};
