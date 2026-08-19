# Lancus Addons

Discord bot and list API behind the Lancus Addons mod.

The bot keeps a shared list of players worth avoiding. The mod reads the same list
and warns you in chat when one of them joins your party.

Mod: <!-- Modrinth link goes here -->

Found a bug, or want something added? Message **mrlancus** on Discord.

## Commands

| Command | What it does |
| --- | --- |
| `/shitteradd <username> <reason> <area>` | Add a player, or update an entry that already exists |
| `/shitter <username>` | Look someone up |
| `/shitterremove <username>` | Take a player off the list |
| `/shittercount` | How many players are on the list |

Every field is free text. Reasons and areas of the game do not fit a fixed list of
choices, and a dropdown would go stale the moment anything new came along.

## How entries are stored

Entries are keyed by **UUID**, never by name. A name is what people type and what
gets displayed, but it is also the one part of an account that can change, and
keying on it would drop someone off the list the day they renamed themselves.

`/shitteradd` resolves the name through Mojang and stores the capitalisation Mojang
holds, so the list reads properly and two spellings of one player cannot become two
entries. Lookups try UUID first and fall back to a name match, so the command still
works while Mojang is unreachable.

Each entry holds the UUID, name, reason, area, who added it, and when. **The
reporter is never sent to the mod** – it is there so an entry can be traced back to
whoever added it.

## API

| Route | Returns |
| --- | --- |
| `GET /list` | every entry |
| `GET /check?names=a,b,c` | only the players asked about |
| `POST /register?secret=...` | push the command list to Discord |

`/check` exists so joining a full party is one request rather than one per person.
Neither route includes the reporter.

## Setup

Nothing here needs Node, npm or wrangler installed. Everything is done in the
Cloudflare and Discord dashboards, plus one `curl` at the end.

### 1. Discord application

Create one at <https://discord.com/developers/applications>.

* **General Information** – note the **Application ID** and the **Public Key**.
* **Bot** – create the bot and copy its **token**.
* **Installation** – add the `applications.commands` scope so the slash commands can
  be installed to your server.

### 2. Push this folder to GitHub

Same as `ah-worker`: a repository with `worker.js` and `wrangler.toml` in the root.

### 3. Create the Worker on Cloudflare

Workers and Pages, **Create**, **Import a repository**, pick the repo. Cloudflare
reads `wrangler.toml` and redeploys on every push to `main` from then on.

### 4. Create the KV namespace

Storage and Databases, **KV**, **Create instance**, name it `SHITTER_LIST`. Copy the
namespace **ID** into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`, and
push. The Worker cannot start without it.

### 5. Add the secrets

Worker, **Settings**, **Variables and Secrets**. Add four, all as **Secret**:

| Name | Value |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | Public Key from step 1 |
| `DISCORD_APP_ID` | Application ID from step 1 |
| `DISCORD_BOT_TOKEN` | Bot token from step 1 |
| `ADMIN_SECRET` | Any long random string you make up |

### 6. Point Discord at the Worker

Back in the Discord application, set **Interactions Endpoint URL** to the Worker's
URL. Discord verifies it by sending a signed ping and refuses the URL if bad
signatures are not rejected, so this only saves once `DISCORD_PUBLIC_KEY` is right.

### 7. Register the commands

```sh
curl -X POST "https://<your-worker>.workers.dev/register?secret=<ADMIN_SECRET>&guild=<SERVER_ID>"
```

With `guild=` the commands appear in that server immediately, which is what you want
while setting up. Drop it to register globally, which takes a few minutes to roll
out. Run this again any time a command changes – Discord keeps its own copy and will
not pick up changes on its own.

To get the server ID: Discord settings, Advanced, turn on Developer Mode, then
right-click the server and Copy Server ID.

### 8. Point the mod at it

Set `shitterListUrl` in the mod's config to the Worker's base URL, with no path on
the end.

## Alternative: local wrangler

Only if you would rather work locally. Needs Node, which is not currently installed:

```sh
brew install node
npm install -g wrangler
cd lancus-bot
wrangler kv namespace create SHITTER_LIST
wrangler secret put DISCORD_PUBLIC_KEY     # and the other three
wrangler deploy
DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node register-commands.js
```
