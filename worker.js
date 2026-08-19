/**
 * Lancus Addons – Discord bot and list API.
 *
 * Two jobs in one Worker:
 *
 *   POST /            Discord interactions endpoint (the slash commands)
 *   GET  /list        the whole list, for the mod
 *   GET  /check?names=a,b,c   just the players asked about, for a party join
 *
 * Entries are keyed by UUID rather than by name. A name is what people type and
 * what gets displayed, but it is also the one part of a Minecraft account that can
 * change; keying on it would quietly drop someone off the list the day they renamed
 * themselves, which is the exact case where a list like this matters most.
 *
 * The reporter is stored on every entry but never leaves through the mod-facing
 * routes. It exists so an entry can be traced back to whoever added it.
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
};

// ── Discord plumbing ────────────────────────────────────────────────────────

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 };
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
};

const hex2bin = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

/**
 * Check the Ed25519 signature Discord puts on every interaction.
 *
 * Discord rejects an endpoint that does not reject bad signatures, so this is not
 * optional even during setup. Workers name the curve "Ed25519"; older runtimes call
 * it "NODE-ED25519", so both are tried.
 */
async function verifyDiscordRequest(request, body, publicKey) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return false;

  const data = new TextEncoder().encode(timestamp + body);
  const sig = hex2bin(signature);
  const raw = hex2bin(publicKey);

  for (const algorithm of ['Ed25519', 'NODE-ED25519']) {
    try {
      const key = await crypto.subtle.importKey('raw', raw, { name: algorithm, namedCurve: algorithm }, false, ['verify']);
      return await crypto.subtle.verify(algorithm, key, sig, data);
    } catch (e) {
      // Try the other spelling before giving up.
    }
  }
  return false;
}

const ephemeral = (content) => ({
  type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
  data: { content, flags: 64 },
});

/**
 * Replace the "thinking" placeholder with the real answer.
 *
 * Commands here call Mojang, which can easily take longer than the three seconds
 * Discord allows for a reply, so every command defers first and edits afterwards.
 */
async function followUp(env, token, payload) {
  const url = `https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.log('follow-up failed', res.status, await res.text());
}

// ── Mojang ──────────────────────────────────────────────────────────────────

/**
 * Resolve a typed name to a real account.
 *
 * Returns the capitalisation Mojang holds rather than whatever was typed, so the
 * list reads properly and two spellings of one player cannot become two entries.
 */
async function resolveName(name) {
  const endpoints = [
    `https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(name)}`,
    `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;      // a real answer: no such player
      if (!res.ok) continue;                     // rate limited or down: try the next
      const body = await res.json();
      if (body && body.id && body.name) return { uuid: body.id.replace(/-/g, ''), name: body.name };
    } catch (e) {
      // Fall through to the next endpoint.
    }
  }
  return undefined;                              // could not tell, as against "not found"
}

/** The name a UUID currently answers to, or null when it cannot be checked. */
async function currentName(uuid) {
  try {
    const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.name ? body.name : null;
  } catch (e) {
    return null;
  }
}

// ── Storage ─────────────────────────────────────────────────────────────────

const key = (uuid) => `player:${uuid}`;

async function putEntry(env, entry) {
  await env.SHITTER_LIST.put(key(entry.uuid), JSON.stringify(entry));
}

async function getEntry(env, uuid) {
  const raw = await env.SHITTER_LIST.get(key(uuid));
  return raw ? JSON.parse(raw) : null;
}

/** Every entry. The list is small enough that paging through it is fine. */
async function allEntries(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.SHITTER_LIST.list({ prefix: 'player:', cursor });
    for (const k of page.keys) {
      const raw = await env.SHITTER_LIST.get(k.name);
      if (raw) out.push(JSON.parse(raw));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** What the mod is allowed to see. The reporter is deliberately not in here. */
const publicView = (e) => ({ uuid: e.uuid, name: e.name, reason: e.reason, area: e.area, addedAt: e.addedAt });

// ── Permissions ─────────────────────────────────────────────────────────────

/**
 * Who may change the list.
 *
 * <p>Three levels: the owner, the editors the owner has named, and everyone else.
 * Everyone else can still look people up – a list nobody can read is no use – but
 * only editors can put someone on it or take them off.</p>
 *
 * The owner is the one identity that cannot be granted or revoked through the bot,
 * so there is always someone able to repair the editor list. It is baked in rather
 * than stored, because an editor list that can lock its own owner out is one bad
 * command away from needing the dashboard to fix.
 */
const ownerId = (env) => String(env.OWNER_ID || '728271613195190294').trim();

const EDITORS_KEY = 'editors';

async function editorIds(env) {
  const raw = await env.SHITTER_LIST.get(EDITORS_KEY);
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function setEditorIds(env, ids) {
  await env.SHITTER_LIST.put(EDITORS_KEY, JSON.stringify([...new Set(ids)]));
}

/** Whoever ran the command. Guild commands nest the user; DMs do not. */
const actorId = (interaction) =>
  interaction.member?.user?.id || interaction.user?.id || null;

const isOwner = (env, interaction) => actorId(interaction) === ownerId(env);

async function canEdit(env, interaction) {
  const id = actorId(interaction);
  if (!id) return false;
  if (id === ownerId(env)) return true;
  return (await editorIds(env)).includes(id);
}

/**
 * A Discord user id out of whatever was typed.
 *
 * Accepts a raw id or a mention. A mention is what you get from autocomplete, and a
 * raw id is the only way to name somebody who is not in the server you are typing
 * in, so both have to work.
 */
function parseUserId(raw) {
  const id = String(raw || '').replace(/[<@!>\s]/g, '');
  return /^\d{15,25}$/.test(id) ? id : null;
}

/** Commands that change the list, and so need edit rights. */
const EDIT_COMMANDS  = new Set(['shitteradd', 'shitterremove']);
/** Commands that change who may edit, and so are the owner's alone. */
const OWNER_COMMANDS = new Set(['shitterallow', 'shitterdeny', 'shittereditors']);

// ── Commands ────────────────────────────────────────────────────────────────

const optionValue = (data, name) => {
  const found = (data.options || []).find((o) => o.name === name);
  return found ? String(found.value).trim() : '';
};

async function handleAdd(env, interaction) {
  const data = interaction.data;
  const typed  = optionValue(data, 'username');
  const reason = optionValue(data, 'reason');
  const area   = optionValue(data, 'area');
  const by     = interaction.member?.user || interaction.user || {};
  const addedBy = by.username ? `${by.username} (${by.id})` : String(by.id || 'unknown');

  if (!typed || !reason || !area) {
    return { content: 'Username, reason and area are all required.' };
  }

  const profile = await resolveName(typed);
  if (profile === null) {
    return { content: `**${typed}** is not a Minecraft account. Check the spelling.` };
  }
  if (profile === undefined) {
    return { content: 'Could not reach Mojang to check that name. Try again in a moment.' };
  }

  const existing = await getEntry(env, profile.uuid);
  const entry = {
    uuid: profile.uuid,
    name: profile.name,               // Mojang's capitalisation, not what was typed
    reason,
    area,
    addedBy,
    addedAt: existing?.addedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await putEntry(env, entry);

  const verb = existing ? 'Updated' : 'Added';
  return {
    embeds: [{
      title: `${verb}: ${entry.name}`,
      color: 0xff4d4d,
      fields: [
        { name: 'Reason', value: reason },
        { name: 'Area',   value: area },
      ],
      footer: { text: `${verb.toLowerCase()} by ${by.username || 'unknown'}` },
    }],
  };
}

async function handleLookup(env, interaction) {
  const typed = optionValue(interaction.data, 'username');
  if (!typed) return { content: 'Give me a username to look up.' };

  const profile = await resolveName(typed);

  // Look up by UUID when Mojang answered, so a renamed player is still found. Fall
  // back to a name match so the command still works while Mojang is unreachable.
  let entry = null;
  if (profile && profile.uuid) entry = await getEntry(env, profile.uuid);
  if (!entry) {
    const wanted = typed.toLowerCase();
    entry = (await allEntries(env)).find((e) => e.name.toLowerCase() === wanted) || null;
  }

  if (!entry) {
    return { content: `**${profile?.name || typed}** is not on the list.` };
  }

  // The stored name is whatever they were called when they were added; show the
  // current one too when it has changed, so the entry is recognisable either way.
  const now = await currentName(entry.uuid);
  const heading = now && now.toLowerCase() !== entry.name.toLowerCase()
    ? `${now}  (listed as ${entry.name})`
    : entry.name;

  return {
    embeds: [{
      title: heading,
      color: 0xff4d4d,
      fields: [
        { name: 'Reason', value: entry.reason },
        { name: 'Area',   value: entry.area },
      ],
      footer: { text: `On the list since ${entry.addedAt.slice(0, 10)}` },
    }],
  };
}

async function handleRemove(env, interaction) {
  const typed = optionValue(interaction.data, 'username');
  const profile = await resolveName(typed);
  let uuid = profile?.uuid;
  if (!uuid) {
    const wanted = typed.toLowerCase();
    uuid = (await allEntries(env)).find((e) => e.name.toLowerCase() === wanted)?.uuid;
  }
  if (!uuid) return { content: `**${typed}** is not on the list.` };
  await env.SHITTER_LIST.delete(key(uuid));
  return { content: `Removed **${profile?.name || typed}** from the list.` };
}

async function handleAllow(env, interaction) {
  const id = parseUserId(optionValue(interaction.data, 'user'));
  if (!id) return { content: 'That is not a Discord user id. Paste the id, or @mention them.' };
  if (id === ownerId(env)) return { content: 'You already own the list.' };

  const ids = await editorIds(env);
  if (ids.includes(id)) return { content: `<@${id}> can already edit the list.` };
  ids.push(id);
  await setEditorIds(env, ids);
  return { content: `<@${id}> can now edit the list.`, allowed_mentions: { parse: [] } };
}

async function handleDeny(env, interaction) {
  const id = parseUserId(optionValue(interaction.data, 'user'));
  if (!id) return { content: 'That is not a Discord user id. Paste the id, or @mention them.' };

  const ids = await editorIds(env);
  if (!ids.includes(id)) return { content: `<@${id}> was not an editor.`, allowed_mentions: { parse: [] } };
  await setEditorIds(env, ids.filter((e) => e !== id));
  return { content: `<@${id}> can no longer edit the list.`, allowed_mentions: { parse: [] } };
}

async function handleEditors(env) {
  const ids = await editorIds(env);
  const lines = ids.map((id) => `<@${id}>  (${id})`);
  return {
    content: lines.length
      ? `Owner: <@${ownerId(env)}>\nEditors:\n${lines.join('\n')}`
      : `Owner: <@${ownerId(env)}>\nNo other editors yet.`,
    allowed_mentions: { parse: [] },
  };
}

async function handleCount(env) {
  const entries = await allEntries(env);
  return { content: `${entries.length} player${entries.length === 1 ? '' : 's'} on the list.` };
}

async function dispatch(env, interaction) {
  switch (interaction.data.name) {
    case 'shitteradd':    return handleAdd(env, interaction);
    case 'shitter':       return handleLookup(env, interaction);
    case 'shitterremove': return handleRemove(env, interaction);
    case 'shittercount':  return handleCount(env);
    case 'shitterallow':  return handleAllow(env, interaction);
    case 'shitterdeny':   return handleDeny(env, interaction);
    case 'shittereditors': return handleEditors(env);
    default:              return { content: 'Unknown command.' };
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * The slash commands, and their registration.
 *
 * Discord keeps its own copy of the command list and will not notice edits here on
 * its own, so this has to be pushed to it whenever a command or an option changes.
 *
 * It lives in the Worker, behind a secret, rather than only in a script you run
 * locally: registering is otherwise the one step in the whole setup that needs Node
 * installed, and there is no reason to need a toolchain to send one HTTP request.
 */
const COMMAND_DEFINITIONS = (() => {
  // Free text everywhere on purpose: a reason or an area of the game cannot be
  // pinned to a fixed list without the list going stale, so none of these are
  // choices.
  const text = (name, description, required = true) => ({ type: 3, name, description, required });
  return [
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
    {
      name: 'shitterallow',
      description: 'Let someone edit the list (owner only)',
      options: [text('user', 'Their Discord user id, or an @mention')],
    },
    {
      name: 'shitterdeny',
      description: 'Stop someone editing the list (owner only)',
      options: [text('user', 'Their Discord user id, or an @mention')],
    },
    { name: 'shittereditors', description: 'Who can edit the list (owner only)' },
  ];
})();

async function registerCommands(env, guildId) {
  const url = guildId
    ? `https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/commands`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body: JSON.stringify(COMMAND_DEFINITIONS),
  });
  const body = await res.text();
  return new Response(
    res.ok ? `Registered ${COMMAND_DEFINITIONS.length} commands${guildId ? ` to guild ${guildId}` : ' globally'}.\n`
           : `Discord said ${res.status}: ${body}\n`,
    { status: res.ok ? 200 : 502, headers: { 'content-type': 'text/plain' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Registration. Guarded by a secret because it can rewrite the bot's command
    // list, and a URL anyone could hit is not a place to leave that.
    if (url.pathname === '/register') {
      // Two different failures, said apart. Which one it is gives nothing away – that
      // the secret is unset is not a secret – and one flat "no" during setup leaves
      // you guessing between a missing binding and a typo.
      if (!env.ADMIN_SECRET) {
        return new Response(
          'ADMIN_SECRET is not set on this Worker. Add it under Settings, Variables and Secrets.\n',
          { status: 401, headers: { 'content-type': 'text/plain' } });
      }
      // Trimmed on both sides: pasting into the dashboard picks up a trailing newline
      // often enough that an invisible character is the likeliest reason a secret that
      // looks identical does not match.
      const given = (url.searchParams.get('secret') || request.headers.get('x-admin-secret') || '').trim();
      if (given !== env.ADMIN_SECRET.trim()) {
        return new Response(
          given ? 'That secret does not match the one set on this Worker.\n'
                : 'No secret given. Add ?secret=... to the URL.\n',
          { status: 401, headers: { 'content-type': 'text/plain' } });
      }
      return registerCommands(env, url.searchParams.get('guild'));
    }

    if (request.method === 'GET' && url.pathname === '/list') {
      const entries = (await allEntries(env)).map(publicView);
      return new Response(JSON.stringify({ success: true, count: entries.length, entries }), { headers: JSON_HEADERS });
    }

    // One request per party rather than one per player, so joining a full party is
    // a single round trip.
    if (request.method === 'GET' && url.pathname === '/check') {
      const wanted = (url.searchParams.get('names') || '')
        .split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
      const entries = (await allEntries(env))
        .filter((e) => wanted.includes(e.name.toLowerCase()))
        .map(publicView);
      return new Response(JSON.stringify({ success: true, entries }), { headers: JSON_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Lancus Addons', { headers: { 'content-type': 'text/plain' } });
    }

    const body = await request.text();
    if (!await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY)) {
      return new Response('bad signature', { status: 401 });
    }

    const interaction = JSON.parse(body);
    if (interaction.type === InteractionType.PING) {
      return new Response(JSON.stringify({ type: InteractionResponseType.PONG }), { headers: JSON_HEADERS });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const name = interaction.data?.name;

      // Rights are checked before deferring, not inside the handler. A deferred reply
      // is public and cannot be made private afterwards, so checking later would
      // announce every refusal to the channel. This costs one KV read, which is far
      // inside Discord's three second window.
      if (OWNER_COMMANDS.has(name) && !isOwner(env, interaction)) {
        return new Response(JSON.stringify(
          ephemeral('Only the list owner can change who may edit the shitter list.')),
          { headers: JSON_HEADERS });
      }
      if (EDIT_COMMANDS.has(name) && !(await canEdit(env, interaction))) {
        return new Response(JSON.stringify(
          ephemeral('You do not have permission to edit the shitter list.')),
          { headers: JSON_HEADERS });
      }

      // Defer, then edit. Mojang can take longer than Discord's three second limit,
      // and a timed-out interaction cannot be answered at all afterwards.
      ctx.waitUntil((async () => {
        try {
          await followUp(env, interaction.token, await dispatch(env, interaction));
        } catch (e) {
          await followUp(env, interaction.token, { content: `Something went wrong: ${e.message}` });
        }
      })());
      return new Response(JSON.stringify({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        // Who may edit is between the owner and the bot; adding and looking up stay
        // public, so a shared list can be seen to be maintained.
        data: OWNER_COMMANDS.has(name) ? { flags: 64 } : {},
      }), { headers: JSON_HEADERS });
    }

    return new Response(JSON.stringify(ephemeral('Unsupported interaction.')), { headers: JSON_HEADERS });
  },
};
