/**
 * Register the slash commands with Discord. Run once, and again whenever a command
 * or its options change – Discord keeps its own copy and will not notice edits here
 * on its own.
 *
 *   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node register-commands.js
 *
 * Commands are registered globally, which can take a few minutes to appear. Set
 * DISCORD_GUILD_ID as well to register them to one server instead, which is instant
 * and is what you want while testing.
 */

// Every field is free text on purpose: a reason or an area of the game cannot be
// pinned to a fixed list without the list going stale, so none of these are choices.
const text = (name, description, required = true) => ({ type: 3, name, description, required });

const commands = [
  {
    name: 'shitteradd',
    description: 'Add a player to the list',
    options: [
      text('username', 'Their Minecraft name. Capitalisation is corrected automatically'),
      text('reason',   'What they did'),
      text('area',     'Which part of the game it happened in'),
    ],
  },
  {
    name: 'shitter',
    description: 'Look someone up on the list',
    options: [text('username', 'Their Minecraft name')],
  },
  {
    name: 'shitterremove',
    description: 'Take a player off the list',
    options: [text('username', 'Their Minecraft name')],
  },
  { name: 'shittercount', description: 'How many players are on the list' },
];

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guild = process.env.DISCORD_GUILD_ID;

if (!appId || !token) {
  console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN first.');
  process.exit(1);
}

const url = guild
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guild}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

// Wrapped rather than using top-level await, so this runs as a plain script and does
// not need package.json to declare the file a module.
(async () => {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bot ${token}` },
    body: JSON.stringify(commands),
  });

  if (res.ok) {
    console.log(`Registered ${commands.length} commands ${guild ? `to guild ${guild}` : 'globally'}.`);
  } else {
    console.error(res.status, await res.text());
    process.exit(1);
  }
})();
