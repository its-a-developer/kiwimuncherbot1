# kiwimuncherbot

## Run

Install dependencies and start the bot with:

```sh
npm install
npm start
```

Configure these values in `.env` before starting:

- `TWITCH_CLIENT_ID` (or `TWITCH_CLIENT`) and `TWITCH_CLIENT_SECRET`
- `TWITCH_BOT_USERNAME` and `TWITCH_CHANNELS`, a comma-separated list of
  Twitch channel usernames (for example, `channel_one,channel_two`). The
  legacy `TWITCH_CHANNEL` setting is still supported for one channel.
- `OAUTH_REDIRECT_URI`, set to the callback URL registered for the Twitch
  application, ending in `/auth/twitch/callback`

The server listens on port 3000. Open its URL followed by `/login` to authorize
the bot.

## Deploy to Cloudflare Workers

The Cloudflare entry point uses a Durable Object to keep the Twitch chat
connection alive and store OAuth tokens. Set `TWITCH_BOT_USERNAME`,
`TWITCH_CHANNELS`, and `OAUTH_REDIRECT_URI` in `wrangler.toml`. Set the
redirect URI to your Worker URL ending in
`/auth/twitch/callback`, and register that exact URL in the Twitch application.
The client ID is public; store the client secret as a Worker secret:

```sh
npx wrangler secret put TWITCH_CLIENT_SECRET
npm run deploy
```

Authorize the bot by visiting your deployed Worker URL followed by `/login`.
For local development, use `npm run dev` and register the local callback URL
with your Twitch application. These commands explicitly use `wrangler.toml`,
which points Wrangler at the module Worker in `worker.js`. Do not use
`index.js` as the Cloudflare Worker entry point; it is the separate Node.js
server for local use.

## Chat commands

Everyone can use:

- `!hello`, `!commands`
- `!fact` / `!funfact` for a random fun fact
- `!member` to show your Twitch account age and creation date
- `!uptime`, `!viewers`, `!title`, `!game`
- `!dice [sides]` (2-1000 sides; defaults to 6), `!coinflip`, `!8ball <question>`
- `!lurk`, `!back`

Moderators can also use `!so username`, `!timeout username [seconds] [reason]`,
`!ban username [reason]`, and `!unban username`. The broadcaster can use
`!mod username` to make a user a moderator. The bot account needs to be a
moderator in each channel for moderation actions.
