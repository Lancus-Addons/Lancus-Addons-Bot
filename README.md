# Lancus Addons backend

Two Cloudflare Workers, deployed separately from one repository. Between them they run
the Discord bot, the shared player list, the party finder, the dragon leaderboard and
every player lookup the mod makes.

| File | Worker | Config | What it serves |
| --- | --- | --- | --- |
| `worker.js` | `lancus-addons-bot` | `wrangler.toml` | Discord slash commands and the shared player list |
| `partyfinder.js` | `lancus-partyfinder` | `wrangler.partyfinder.toml` | Party finder, dragon leaderboard, player lookups |

They are separate because the party finder needs a Durable Object and its own migration,
and because a bad deploy of one should not take the other down with it. The Discord bot
answering slash commands and the party finder holding live party state have nothing in
common but an author.

The mod ships pointing at both, so **a deploy here reaches every player without a mod
update** - which is as true of a bad deploy as a good one.

Mod: <!-- Modrinth link goes here -->

Found a bug, or want something added? Message **mrlancus** on Discord.

---

# The Discord bot

Keeps a shared list of players worth avoiding. The mod reads the same list and warns you
in chat when one of them joins your party.

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

The username, reason and gamemode fields are free text. Reasons and gamemodes do not fit
a fixed set of choices, and a dropdown would go stale the moment anything new came along.

`/shitterlogchannel` needs **View Channel** and **Send Messages** in the channel you pick.
It posts a test message when you set it, so a missing permission shows up then rather than
silently swallowing every later entry. Changes made from inside the game are logged too,
so the channel is a complete record.

## Who can do what

Three levels. **Anyone** can look players up, because a list nobody can read is no use.
**Editors** can add and remove. The **owner** decides who the editors are.

The owner is set by `OWNER_ID`, defaulting to the id baked into `worker.js`. It is the one
identity that cannot be granted or revoked through the bot, so there is always somebody
able to repair the editor list - an editor list that can lock its own owner out is one bad
command away from needing the dashboard to fix it.

Editors are stored in KV and are global, not per server: the list is one shared thing, so
trusting somebody trusts them everywhere the bot is.

Rights are checked before the command is acknowledged rather than inside the handler. A
deferred reply is public and cannot be made private afterwards, so checking later would
announce every refusal to the channel. Owner commands and their replies are private;
adding and looking up stay public, so a shared list can be seen to be maintained.

## How entries are stored

Entries are keyed by **UUID**, never by name. A name is what people type and what gets
displayed, but it is also the one part of an account that can change, and keying on it
would drop someone off the list the day they renamed themselves.

`/shitteradd` resolves the name and stores the real capitalisation, so the list reads
properly and two spellings of one player cannot become two entries. Lookups try UUID first
and fall back to a name match, so the command still works while the name services are
unreachable.

Four name services are tried in turn: Mojang's two endpoints, then playerdb, then ashcon.
Mojang works fine from an ordinary machine and is unreliable from a Worker, because
Cloudflare's egress addresses are shared across the whole platform and get rate-limited
far harder than a home connection. The first definite answer wins, whether that is a
profile or a confirmed miss.

Each entry holds the UUID, name, reason, gamemode, who added it, and when. **The reporter
is never sent to the mod** - it is there so an entry can be traced back to whoever added
it.

## Routes

| Route | Returns |
| --- | --- |
| `GET /list` | every entry |
| `GET /check?names=a,b,c` | only the players asked about |
| `POST /register?secret=...` | push the command list to Discord |

`/check` exists so joining a full party is one request rather than one per person. Neither
route includes the reporter.

---

# The party finder, leaderboard and lookups

## Routes

| Route | What it does |
| --- | --- |
| `GET /pf/list` | every live party |
| `POST /pf/create` | post a listing |
| `POST /pf/beat` | heartbeat; three missed and the listing is gone |
| `POST /pf/close` | unlist |
| `POST /pf/join` | ask to join, holding a slot |
| `GET /pf/self` | where a join request has got to |
| `GET /lb/top?limit=&uuid=` | the leaderboard, and your own row |
| `POST /lb/submit` | send your own totals |
| `GET /lb/probe?uuid=&secret=` | dump a profile's shape, for reading field paths off a real payload |
| `GET /player/summary?name=` | purse, bank and dragons |
| `GET /player/bestiary?name=&mob=` | bestiary kills |
| `GET /player/networth?name=` | networth, museum included |
| `GET /player/sacks?name=` | sack contents and `last_save` |

## Why the party list is a Durable Object

It is small, shared, and changes every few seconds. KV is eventually consistent, so two
players clicking Join at the same instant against KV can both be told there is a slot. A
single Durable Object serialises every write, so the last slot goes to exactly one of them,
and pending joins count against the slots for the same reason.

The leaderboard is the opposite shape - write rarely, read often, no coordination needed -
so it lives in KV.

## The leaderboard ranks mod users, not SkyBlock

Hypixel offers no way to list players; you can only look up a UUID you already have. So
the population is exactly whoever runs the mod with sharing switched on, and it is labelled
that way everywhere it appears.

Without `HYPIXEL_KEY` the figures are self-reported and the worker guards what it is given:
one row per UUID, totals only go up, and no faster than one dragon a minute. With the key
set, the API figure replaces the submitted one outright rather than being blended - one is
lifetime and one is since-install, so an average of them is neither.

## Networth runs on the Worker

`!nw` is calculated here rather than fetched from somewhere else. That takes three swaps,
set up in `wrangler.partyfinder.toml`, all needed because `skyhelper-networth` was written
for Node:

| Swapped | For | Because |
| --- | --- | --- |
| `prismarine-nbt` | `shims/prismarine-nbt.js` | it builds its NBT parser with `eval()`, which Workers forbid. The shim reads the same NBT with NBTify |
| `axios` | `shims/axios.js` | it picks its transport by sniffing for Node, and a Worker under `nodejs_compat` is an ambiguous case. The shim is the two GETs the package makes, on `fetch` |
| `fs` | `shims/fs.js` | the package caches the Hypixel items list to a file next to itself. There is nowhere to write, so the shim says the file is not there |

Each shim explains itself at the top of its own file, and the NBT one is worth reading
before changing anything near it: NBTify parses asynchronously and prismarine-nbt does not,
which the shim bridges in a way that depends on the exact shape of
`skyhelper-networth/helper/decode.js`. Both packages are pinned to exact versions, and
`npm test` is what tells you whether a bump still fits - it parses every tag type through
both parsers and compares.

```sh
npm install
npm test
```

The first lookup after a Worker starts spends about a second fetching the Hypixel items
list and the SkyHelper price list; both are then cached for the life of the isolate and
later lookups take under 200 ms.

`SKYHELPER_URL` is the escape hatch. Set it to a hosted or self-hosted SkyHelper instance
and every lookup is forwarded there instead, which is a dashboard change rather than a
deploy if an upstream release ever outgrows the shims.

## Sacks

`/player/sacks` returns `sacks_counts` from the player's own profile along with
`last_save`, cached for five seconds. The mod uses it to correct a total it maintains from
Hypixel's `[Sacks]` chat messages, which are live but lossy - they collapse long lists into
"and N other items", and the player can switch them off entirely.

`last_save` is why the pair works: the mod knows which of its own chat deltas arrived after
that moment, so it can take the snapshot as the truth and re-apply only what the snapshot
cannot have included.

**Mind the API policy here.** Hypixel's policy forbids "continuous polling of player data
for detection of stats earned in-game", and the only cadence it blesses is once per player
per hour. Whatever the mod does, the cache in front of this route is doing the real
protecting - keep it, and do not shorten it to make a HUD feel snappier.

---

# Setup

Nothing here needs Node, npm or wrangler installed. Everything is done in the Cloudflare
and Discord dashboards, plus one `curl` at the end. The Discord bot has no dependencies at
all; the party finder's are installed by Cloudflare's build from `package-lock.json`, so
Node is only needed locally to run `npm test`.

### 1. Discord application

Create one at <https://discord.com/developers/applications>.

* **General Information** - note the **Application ID** and the **Public Key**.
* **Bot** - create the bot and copy its **token**.
* **Installation** - add the `applications.commands` scope so the slash commands can be
  installed to your server.

### 2. Push this folder to GitHub

A repository with `worker.js` and `wrangler.toml` in the root.

### 3. Create the Workers on Cloudflare

Workers and Pages, **Create**, **Import a repository**, pick the repo. Cloudflare reads
`wrangler.toml` and redeploys on every push to `main` from then on.

The party finder is a second Worker from the same repository, deployed with its own
config:

```sh
wrangler deploy -c wrangler.partyfinder.toml
```

### 4. Create the KV namespaces

Storage and Databases, **KV**, **Create instance**. The bot needs one called
`SHITTER_LIST`; the party finder needs one called `LEADERBOARD`. Copy each namespace
**ID** into the matching `wrangler` config, replacing the placeholder, and push. Neither
Worker can start without its own.

### 5. Add the secrets

Worker, **Settings**, **Variables and Secrets**, all as **Secret**.

The Discord bot:

| Name | Value |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | Public Key from step 1 |
| `DISCORD_APP_ID` | Application ID from step 1 |
| `DISCORD_BOT_TOKEN` | Bot token from step 1 |
| `ADMIN_SECRET` | Any long random string you make up |

`OWNER_ID` can be set here too, as a plain variable, to move ownership without touching
the code.

The party finder:

| Name | Value |
| --- | --- |
| `HYPIXEL_KEY` | Turns the leaderboard from self-reported into verified, and is what every `/player/*` route needs. **Never ship this inside the mod** - a key in a distributed jar is a published key, and the API terms do not allow it |
| `ADMIN_SECRET` | Guards `/lb/probe` |
| `SKYHELPER_URL` | Optional. Set it only to forward networth elsewhere |

### 6. Point Discord at the Worker

Back in the Discord application, set **Interactions Endpoint URL** to the bot Worker's
URL. Discord verifies it by sending a signed ping and refuses the URL if bad signatures
are not rejected, so this only saves once `DISCORD_PUBLIC_KEY` is right.

### 7. Register the commands

```sh
curl -X POST "https://<your-worker>.workers.dev/register?secret=<ADMIN_SECRET>&guild=<SERVER_ID>"
```

With `guild=` the commands appear in that server immediately, which is what you want while
setting up. Drop it to register globally, which takes a few minutes to roll out. Run this
again any time a command changes - Discord keeps its own copy and will not pick up changes
on its own.

To get the server ID: Discord settings, Advanced, turn on Developer Mode, then right-click
the server and Copy Server ID.

### 8. The mod

Both addresses are already baked into the mod's defaults, so a player installing it needs
no setup. If you deploy your own copies, change `shitterListUrl`, `partyFinderUrl` and
`leaderboardUrl` in `LancusConfig`.

## Alternative: local wrangler

Only if you would rather work locally:

```sh
npm install -g wrangler
cd lancus-bot
wrangler kv namespace create SHITTER_LIST
wrangler secret put DISCORD_PUBLIC_KEY     # and the others
wrangler deploy                            # the Discord bot
wrangler deploy -c wrangler.partyfinder.toml
DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node register-commands.js
```

`wrangler dev --local` is worth knowing about: it evaluates global scope in workerd, which
`wrangler deploy --dry-run` does not, and it is the only real check this repo has for the
party finder short of deploying it.

---

Lancus Addons is not affiliated with or endorsed by Hypixel.
