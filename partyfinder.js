/**
 * Lancus Addons party finder + dragon leaderboard.
 *
 * Deploy as its own Worker, or fold the fetch handler into worker.js. Nothing here is
 * live yet - the mod's `partyFinderUrl` is empty by default precisely so that an
 * undeployed backend reads as absent rather than broken.
 *
 * -- Why a Durable Object -------------------------------------------------------
 * The party list is small, shared and changes every few seconds. KV is eventually
 * consistent, so two players clicking Join at the same instant against KV can both be
 * told there is a slot. A single Durable Object serialises every write to the list, so
 * the last slot goes to exactly one of them. The leaderboard is the opposite shape -
 * write-rarely, read-often, no coordination needed - so it lives in KV.
 *
 * -- Bindings -------------------------------------------------------------------
 *   [[durable_objects.bindings]]  name = "PARTIES"  class_name = "PartyRoom"
 *   [[kv_namespaces]]             binding = "LEADERBOARD"  id = "<create one>"
 *   [[migrations]]                tag = "v1"  new_sqlite_classes = ["PartyRoom"]
 */

const PARTY_TTL_MS = 20000;    // three missed heartbeats and a listing is gone
const JOIN_TTL_MS  = 120000;   // a join request nobody acted on
const MAX_PARTIES  = 200;
const MAX_NOTE     = 64;
const MAX_PARTY    = 6;

// A total may not grow faster than this. Roughly one dragon a minute is already far
// beyond anything achievable, so it rejects fabrication without touching real play.
const MAX_DRAGONS_PER_MINUTE = 1;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const clampInt = (v, lo, hi) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
};

const cleanName = (s) =>
  typeof s === 'string' ? s.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) : '';

// Notes are shown verbatim in-game, so colour codes and control characters are stripped
// here rather than in the mod: the worker is the only place every client passes through.
const NOTE_STRIP = /[\u00a7\u0000-\u001f\u007f]/g;

const cleanNote = (s) =>
  typeof s === 'string'
    ? s.replace(NOTE_STRIP, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE)
    : '';

const cleanUuid = (s) =>
  typeof s === 'string' && /^[0-9a-fA-F-]{32,36}$/.test(s) ? s.toLowerCase() : '';

export class PartyRoom {
  constructor(state) {
    this.state = state;
    /** id -> party. Held in memory and mirrored to storage so an eviction is survivable. */
    this.parties = null;
  }

  async load() {
    if (this.parties) return;
    this.parties = (await this.state.storage.get('parties')) || {};
  }

  async save() {
    await this.state.storage.put('parties', this.parties);
  }

  /** Drop anything that stopped heartbeating. Called before every read and write. */
  sweep() {
    const now = Date.now();
    for (const [id, p] of Object.entries(this.parties)) {
      if (now - p.updatedAt > PARTY_TTL_MS) {
        delete this.parties[id];
        continue;
      }
      p.joins = (p.joins || []).filter((j) => now - j.at < JOIN_TTL_MS);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.load();
    this.sweep();

    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    switch (url.pathname) {
      case '/pf/list': {
        const parties = Object.values(this.parties).map((p) => ({
          id: p.id, host: p.host, uuid: p.uuid,
          eyes: p.eyes, dragons: p.dragons, minEyes: p.minEyes,
          lobbySwap: p.lobbySwap, note: p.note,
          size: p.size, maxSize: p.maxSize,
          rank: p.rank || 0, dragonsDone: p.dragonsDone || 0,
          updatedAt: p.updatedAt,
        }));
        await this.save();
        return json({ parties });
      }

      case '/pf/create': {
        const host = cleanName(body.host);
        const uuid = cleanUuid(body.uuid);
        if (!host) return json({ error: 'bad host' }, 400);
        if (Object.keys(this.parties).length >= MAX_PARTIES) {
          return json({ error: 'party finder full' }, 503);
        }
        // One listing per host. Re-posting replaces rather than duplicates, so a
        // client that crashed and came back does not leave a ghost beside itself.
        for (const [id, p] of Object.entries(this.parties)) {
          if (p.host.toLowerCase() === host.toLowerCase()) delete this.parties[id];
        }
        const id = crypto.randomUUID().slice(0, 8);
        const token = crypto.randomUUID();
        this.parties[id] = {
          id, token, host, uuid,
          eyes: clampInt(body.eyes, 0, 8),
          minEyes: clampInt(body.minEyes, 0, 8),
          dragons: clampInt(body.dragons, 0, 10000),
          lobbySwap: !!body.lobbySwap,
          note: cleanNote(body.note),
          maxSize: clampInt(body.maxSize, 2, MAX_PARTY),
          size: 1,
          joins: [],
          rank: 0,
          dragonsDone: 0,
          updatedAt: Date.now(),
        };
        await this.save();
        return json({ id, token });
      }

      case '/pf/beat': {
        const p = this.parties[body.id];
        if (!p) return json({ error: 'gone' }, 404);
        if (p.token !== body.token) return json({ error: 'not yours' }, 403);
        p.size = clampInt(body.size, 1, MAX_PARTY);
        p.updatedAt = Date.now();

        // Hand back everyone waiting who has not been told about yet, and mark them
        // told in the same tick. The host's mod turns each into a /party invite.
        const invite = [];
        for (const j of p.joins) {
          if (j.state === 'WAITING') {
            j.state = 'INVITED';
            invite.push(j.player);
          }
        }
        // A full party takes itself off the list, which is the behaviour that stops a
        // finder filling up with parties that cannot be joined.
        const closed = p.size >= p.maxSize;
        if (closed) delete this.parties[p.id];
        await this.save();
        return json({ invite, size: p.size, closed });
      }

      case '/pf/close': {
        const p = this.parties[body.id];
        if (p && p.token === body.token) delete this.parties[body.id];
        await this.save();
        return json({ ok: true });
      }

      case '/pf/join': {
        const p = this.parties[body.id];
        if (!p) return json({ error: 'gone' }, 404);
        const player = cleanName(body.player);
        if (!player) return json({ error: 'bad name' }, 400);
        // Pending joins count against the slots, or six people race into the last one
        // and five of them get an invite to a party with no room.
        const pending = p.joins.filter((j) => j.state !== 'GONE').length;
        if (p.size + pending >= p.maxSize) return json({ error: 'full' }, 409);
        if (clampInt(body.eyes, 0, 8) < p.minEyes) {
          return json({ error: 'not enough eyes' }, 403);
        }
        if (!p.joins.some((j) => j.player.toLowerCase() === player.toLowerCase())) {
          p.joins.push({ player, uuid: cleanUuid(body.uuid), state: 'WAITING', at: Date.now() });
        }
        await this.save();
        return json({ ok: true });
      }

      case '/pf/self': {
        const p = this.parties[url.searchParams.get('id')];
        if (!p) return json({ state: 'GONE' });
        const player = cleanName(url.searchParams.get('player'));
        const j = p.joins.find((x) => x.player.toLowerCase() === player.toLowerCase());
        return json({ state: j ? j.state : 'NONE' });
      }

      // Internal: the leaderboard side stamps a placement onto this host's listing so
      // a party row can show a rank without every row costing a leaderboard read. Not
      // reachable from outside - the top-level fetch refuses to forward this path.
      case '/pf/decorate': {
        for (const p of Object.values(this.parties)) {
          if (p.uuid && p.uuid === cleanUuid(body.uuid)) {
            p.rank = clampInt(body.rank, 0, 1000000);
            p.dragonsDone = clampInt(body.dragons, 0, 10000000);
          }
        }
        await this.save();
        return json({ ok: true });
      }

      default:
        return json({ error: 'no such route' }, 404);
    }
  }

}

// -- Leaderboard ---------------------------------------------------------------
//
// Self-reported, and guarded rather than trusted: one row per UUID, totals may only go
// up, and they may not go up faster than anyone could actually play. That raises the
// effort of faking a placement without pretending to make it impossible. Verifying it
// properly needs a Hypixel API key here so the profile counters can be read
// server-side; the stored shape already has room for that.

// -- Verification against Hypixel ----------------------------------------------
//
// The submission list IS the player set: Hypixel gives no way to enumerate players, but
// it does not need to, because everybody who wants ranking announces themselves by
// submitting. So the API's job here is not to find anyone, it is to check the numbers of
// the people who turn up. That is what turns a self-reported board into a verified one
// without the mod changing at all.
//
// Without HYPIXEL_KEY set, every function below no-ops and the worker trusts what it was
// sent, exactly as it does today. Adding the secret is the whole switch.

const VERIFY_TTL_MS = 10 * 60 * 1000;   // one call per player per ten minutes

/**
 * Candidate paths to the dragon counters on a profile member.
 *
 * Written as a list, and every one of them tried, because the exact path has not been
 * read off a real payload yet - see /lb/probe. Guessing a single path and shipping it is
 * how you get a leaderboard that silently ranks everyone at zero. When the probe says
 * which one is real, delete the rest.
 */
const DRAGON_PATHS = [
  ['player_stats', 'end_island', 'dragon_fight'],
  ['player_stats', 'dragon_fight'],
  ['stats', 'end_island', 'dragon_fight'],
  ['dragon_fight'],
];

const dig = (obj, path) => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

/** Sum a leaf that may be a number or a map of per-dragon-type numbers. */
function total(node) {
  if (typeof node === 'number') return node;
  if (node && typeof node === 'object') {
    return Object.values(node).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
  }
  return 0;
}

/**
 * Lifetime dragon numbers for a player, summed across every profile.
 *
 * Summed rather than taken from the selected profile: the leaderboard is about what
 * somebody has done, not which save file they happen to be on.
 *
 * Returns null when it cannot tell - no key, a failed call, or a payload whose shape
 * none of DRAGON_PATHS matched. Null means "do not overwrite", never "zero".
 */
async function verify(env, uuid) {
  if (!env.HYPIXEL_KEY) return null;
  try {
    const res = await fetch(
      'https://api.hypixel.net/v2/skyblock/profiles?uuid=' + encodeURIComponent(uuid),
      { headers: { 'API-Key': env.HYPIXEL_KEY } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.success || !Array.isArray(data.profiles)) return null;

    const bare = uuid.replace(/-/g, '');
    let summoned = 0, eyes = 0, found = false;

    for (const profile of data.profiles) {
      const member = (profile.members || {})[bare] || (profile.members || {})[uuid];
      if (!member) continue;
      for (const path of DRAGON_PATHS) {
        const node = dig(member, path);
        if (!node || typeof node !== 'object') continue;
        found = true;
        summoned += total(node.amount_summoned);
        eyes += total(node.summoning_eyes_contributed);
        break;
      }
    }
    return found ? { dragons: summoned, eyes } : null;
  } catch (e) {
    return null;
  }
}

async function submit(env, body) {
  const uuid = cleanUuid(body.uuid);
  const player = cleanName(body.player);
  if (!uuid || !player) return json({ error: 'bad identity' }, 400);

  let dragons = clampInt(body.dragons, 0, 10000000);
  let eyes = clampInt(body.eyes, 0, 100000000);
  const now = Date.now();
  const prev = await env.LEADERBOARD.get('p:' + uuid, 'json');

  // Verified numbers replace the submitted ones outright. They are lifetime figures and
  // the mod's are only since install, so they are not comparable and averaging them
  // would produce a number that is neither.
  let verified = prev && prev.verified && now - prev.verifiedAt < VERIFY_TTL_MS
    ? { dragons: prev.dragons, eyes: prev.eyes }
    : await verify(env, uuid);

  if (verified) {
    dragons = verified.dragons;
    eyes = verified.eyes;
  }

  // The growth guards only apply to numbers we are trusting. A verified figure needs no
  // guarding, and a lifetime total arriving for the first time will always look like an
  // implausible jump next to a since-install one.
  if (prev && !verified) {
    if (dragons < prev.dragons) return json({ error: 'totals only go up' }, 409);
    const minutes = Math.max(1, (now - prev.at) / 60000);
    if (dragons - prev.dragons > minutes * MAX_DRAGONS_PER_MINUTE) {
      return json({ error: 'implausible jump' }, 409);
    }
  }

  const row = {
    uuid, player, dragons, eyes,
    firsts: clampInt(body.firsts, 0, 10000000),
    profit: Math.round(Number(body.profit) || 0),
    activeMinutes: clampInt(body.activeMinutes, 0, 10000000),
    // Shown in the mod so a rank is never presented as checked when it was not.
    verified: !!verified,
    verifiedAt: verified ? (prev && prev.verified && now - prev.verifiedAt < VERIFY_TTL_MS
      ? prev.verifiedAt : now) : 0,
    at: now,
  };
  await env.LEADERBOARD.put('p:' + uuid, JSON.stringify(row));
  return json({ ok: true });
}

/**
 * The ranked list.
 *
 * KV list+get is fine at this size and would not be at ten thousand players; move to D1
 * before that rather than after.
 */
async function top(env, limit, uuid) {
  const listed = await env.LEADERBOARD.list({ prefix: 'p:', limit: 1000 });
  const rows = [];
  for (const k of listed.keys) {
    const r = await env.LEADERBOARD.get(k.name, 'json');
    if (r) rows.push(r);
  }
  rows.sort((a, b) => b.dragons - a.dragons);

  const entries = rows.slice(0, limit).map((r, i) => ({
    rank: i + 1, player: r.player, value: r.dragons,
    eyes: r.eyes, firsts: r.firsts, verified: !!r.verified,
  }));

  let you = null;
  if (uuid) {
    const i = rows.findIndex((r) => r.uuid === uuid);
    if (i >= 0) you = { rank: i + 1, player: rows[i].player, value: rows[i].dragons };
  }
  return { entries, you, total: rows.length };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /pf/decorate is internal, so it is never forwarded from the outside world.
    if (url.pathname.startsWith('/pf/') && url.pathname !== '/pf/decorate') {
      // One room, so every party sees every other. Sharding by region would break the
      // one guarantee the object exists to give.
      const id = env.PARTIES.idFromName('global');
      return env.PARTIES.get(id).fetch(request);
    }

    if (url.pathname === '/lb/submit' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const res = await submit(env, body);

      // Push the fresh placement onto any listing this player is hosting, so the party
      // finder shows a rank without every row costing a leaderboard read.
      if (res.status === 200) {
        const board = await top(env, 0, cleanUuid(body.uuid));
        if (board.you) {
          // Through fetch rather than as an RPC method: RPC on a stub needs the class
          // to extend DurableObject from cloudflare:workers, and this one does not.
          const id = env.PARTIES.idFromName('global');
          await env.PARTIES.get(id).fetch(new Request(url.origin + '/pf/decorate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              uuid: cleanUuid(body.uuid),
              rank: board.you.rank,
              dragons: clampInt(body.dragons, 0, 10000000),
            }),
          }));
        }
      }
      return res;
    }

    // Dumps the shape of one profile so the dragon field paths can be read off a real
    // payload instead of guessed. The same trick as the mod's `/la lb` probe: when a
    // format is unknown, ship a way to look at it rather than a guess about it.
    //
    //   curl "https://<worker>/lb/probe?uuid=<uuid>&secret=<ADMIN_SECRET>"
    if (url.pathname === '/lb/probe') {
      if (!env.ADMIN_SECRET || url.searchParams.get('secret') !== env.ADMIN_SECRET) {
        return json({ error: 'nope' }, 403);
      }
      if (!env.HYPIXEL_KEY) return json({ error: 'HYPIXEL_KEY not set' }, 503);
      const uuid = cleanUuid(url.searchParams.get('uuid') || '');
      if (!uuid) return json({ error: 'bad uuid' }, 400);

      const res = await fetch(
        'https://api.hypixel.net/v2/skyblock/profiles?uuid=' + encodeURIComponent(uuid),
        { headers: { 'API-Key': env.HYPIXEL_KEY } });
      const data = await res.json().catch(() => null);
      if (!data || !Array.isArray(data.profiles)) {
        return json({ status: res.status, data }, 200);
      }

      const bare = uuid.replace(/-/g, '');
      const out = data.profiles.map((p) => {
        const m = (p.members || {})[bare] || (p.members || {})[uuid] || {};
        return {
          profile: p.cute_name,
          selected: !!p.selected,
          memberKeys: Object.keys(m),
          playerStatsKeys: m.player_stats ? Object.keys(m.player_stats) : null,
          // Whichever of these is not null is the answer.
          candidates: DRAGON_PATHS.map((path) => ({
            path: path.join('.'), value: dig(m, path) ?? null,
          })),
        };
      });
      return json({ profiles: out });
    }

    if (url.pathname === '/lb/top') {
      const limit = clampInt(url.searchParams.get('limit') || '10', 1, 100);
      const board = await top(env, limit, cleanUuid(url.searchParams.get('uuid') || ''));
      return json(board);
    }

    return json({ error: 'no such route' }, 404);
  },
};
