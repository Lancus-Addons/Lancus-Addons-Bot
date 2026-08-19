# Lancus Addons

Discord bot and list API behind the Lancus Addons mod.

The bot keeps a shared list of players worth avoiding. The mod reads the same list
and warns you in chat when one of them joins your party.

Mod: <!-- Modrinth link goes here -->

Found a bug, or want something added? Message **mrlancus** on Discord.

## Commands

| Command | Who can use it | What it does |
| --- | --- | --- |
| `/shitter <username>` | anyone | Look someone up |
| `/shittercount` | anyone | How many players are on the list |
| `/shitteradd <username> <reason> <gamemode>` | editors | Add a player, or update an existing entry |
| `/shitterremove <username>` | editors | Take a player off the list |
| `/shitterallow <user>` | owner | Let someone edit the list |
| `/shitterdeny <user>` | owner | Stop someone editing the list |
| `/shittereditors` | owner | Who can currently edit |
| `/shittertoken` | editors | Your token for editing from inside the game |
| `/shitterlogchannel [channel]` | owner | Post every change to a channel, or `off` |

The username, reason and gamemode fields are free text. Reasons and gamemodes do not
fit a fixed set of choices, and a dropdown would go stale the moment anything new came
along.

`/shitterlogchannel` needs **View Channel** and **Send Messages** in the channel you
pick. It posts a test message when you set it, so a missing permission shows up then
rather than silently swallowing every later entry. Changes made from inside the game
are logged too, so the channel is a complete record.

## Who can do what

Three levels. **Anyone** can look players up, because a list nobody can read is no
use. **Editors** can add and remove. The **owner** decides who the editors are.

The owner is set by `OWNER_ID`, defaulting to the id baked into `worker.js`. It is
the one identity that cannot be granted or revoked through the bot, so there is
always somebody able to repair the editor list – an editor list that can lock its own
owner out is one bad command away from needing the dashboard to fix it.

Editors are stored in KV and are global, not per server: the list is one shared thing,
so trusting somebody trusts them everywhere the bot is.

Rights are checked before the command is acknowledged rather than inside the handler.
A deferred reply is public and cannot be made private afterwards, so checking later
would announce every refusal to the channel. A refusal reads:

> You do not have permission to edit the shitter list.

Owner commands and their replies are private. Adding and looking up stay public, so a
shared list can be seen to be maintained.

## How entries are stored

Entries are keyed by **UUID**, never by name. A name is what people type and what
gets displayed, but it is also the one part of an account that can change, and
keying on it would drop someone off the list the day they renamed themselves.

`/shitteradd` resolves the name and stores the real capitalisation, so the list reads
properly and two spellings of one player cannot become two entries. Lookups try UUID
first and fall back to a name match, so the command still works while the name
services are unreachable.

Four name services are tried in turn: Mojang's two endpoints, then playerdb, then
ashcon. Mojang works fine from an ordinary machine and is unreliable from a Worker,
because Cloudflare's egress addresses are shared across the whole platform and get
rate-limited far harder than a home connection. The first definite answer wins,
whether that is a profile or a confirmed miss.

Each entry holds the UUID, name, reason, gamemode, who added it, and when. **The
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

`OWNER_ID` can be set here too, as a plain variable, to move ownership without
touching the code.

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
