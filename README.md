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

## Chat commands

Everyone can use:

- `!hello`, `!commands`
- `!uptime`, `!viewers`, `!title`, `!game`
- `!dice [sides]` (2-1000 sides; defaults to 6), `!coinflip`, `!8ball <question>`
- `!lurk`, `!back`

Moderators can also use `!so username`, `!timeout username [seconds] [reason]`,
`!ban username [reason]`, and `!unban username`. The bot account needs the
appropriate moderator permissions in each channel for moderation actions.
