# kiwimuncherbot

## Run

Install dependencies and start the bot with:

```sh
npm install
npm start
```

Configure these values in `.env` before starting:

- `TWITCH_CLIENT_ID` (or `TWITCH_CLIENT`) and `TWITCH_CLIENT_SECRET`
- `TWITCH_BOT_USERNAME` and `TWITCH_CHANNEL`
- `OAUTH_REDIRECT_URI`, set to the callback URL registered for the Twitch
  application, ending in `/auth/twitch/callback`

The server listens on port 3000. Open its URL followed by `/login` to authorize
the bot.