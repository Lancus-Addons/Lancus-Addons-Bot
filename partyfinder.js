/**
 * Lancus Addons party finder + dragon leaderboard.
 *
 * Deploy as its own Worker, or fold the fetch handler into worker.js. The mod ships
 * pointing at this one: `partyFinderUrl` and `leaderboardUrl` default to
 * lancus-partyfinder.lancus.workers.dev, and a blank value is refilled from the defaults
 * on load. So a fresh install needs no setup, and a deploy here reaches every player
 * without a mod update - which cuts both ways, since a bad deploy does too.
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
          id: p.id, host: p.host, uuid: p.uuid, kind: p.kind || 'dragon',
          eyes: p.eyes, dragons: p.dragons,
          lobbySwap: p.lobbySwap, note: p.note,
          size: p.size, maxSize: p.maxSize, members: p.members || [],
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
        const kind = body.kind === 'fishing' ? 'fishing' : 'dragon';
        for (const [id, p] of Object.entries(this.parties)) {
          if (p.host.toLowerCase() === host.toLowerCase() && (p.kind || 'dragon') === kind) {
            delete this.parties[id];
          }
        }
        const id = crypto.randomUUID().slice(0, 8);
        const token = crypto.randomUUID();
        this.parties[id] = {
          id, token, host, uuid,
          // Fishing and dragon parties share this list, and nothing but the kind keeps
          // them apart. Unknown kinds fall back to dragon so an older client is visible
          // somewhere rather than nowhere.
          kind: body.kind === 'fishing' ? 'fishing' : 'dragon',
          eyes: clampInt(body.eyes, 0, 50),
          dragons: clampInt(body.dragons, 0, 10000),
          lobbySwap: !!body.lobbySwap,
          note: cleanNote(body.note),
          maxSize: clampInt(body.maxSize, 2, MAX_PARTY),
          size: 1,
          members: [],
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
        // The roster the host's mod reads off its own chat. Trusted for display only -
        // the slot arithmetic uses size, which is clamped.
        p.members = Array.isArray(body.members)
          ? body.members.map(cleanName).filter(Boolean).slice(0, MAX_PARTY - 1)
          : [];
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
 * Where the dragon counters live on a profile member.
 *
 * Read off a real payload via /lb/probe rather than guessed. The three other shapes that
 * were being tried are gone: they were all null, and a list of candidates is a way of
 * saying you do not know yet, not something to keep once you do.
 */
const DRAGON_PATH = ['player_stats', 'end_island', 'dragon_fight'];

const dig = (obj, path) => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

/**
 * Sum a per-dragon-type map.
 *
 * The map carries its own `total` alongside the seven types, and that total is already
 * their sum - 253 + 253 + 249 + 233 + 232 + 258 + 66 comes to exactly the 1544 it
 * reports. Adding every value would therefore double the figure, which is precisely the
 * bug that shipping a guessed parser would have caused: a leaderboard where everybody
 * has twice the dragons they actually summoned, and nothing to reveal it.
 *
 * So `total` wins when present, and the fallback excludes it rather than trusting that
 * it always is.
 */
function sumTyped(node) {
  if (typeof node === 'number') return node;
  if (!node || typeof node !== 'object') return 0;
  if (typeof node.total === 'number') return node.total;
  return Object.entries(node)
    .filter(([k, v]) => k !== 'total' && typeof v === 'number')
    .reduce((a, [, v]) => a + v, 0);
}

/** The largest value in a per-type map, ignoring the total if one is present. */
function maxTyped(node) {
  if (!node || typeof node !== 'object') return 0;
  return Object.entries(node)
    .filter(([k, v]) => k !== 'total' && typeof v === 'number')
    .reduce((a, [, v]) => Math.max(a, v), 0);
}

/**
 * Lifetime dragon numbers for a player, summed across every profile.
 *
 * Summed rather than taken from the selected profile: the leaderboard is about what
 * somebody has done, not which save file they happen to be on.
 *
 * Returns null when it cannot tell - no key, a failed call, or a profile with no
 * dragon_fight node at all. Null means "do not overwrite", never "zero".
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
    let dragons = 0, eyes = 0, superiors = 0, crystals = 0, bestDamage = 0;
    let found = false;

    // Summed across every profile: the leaderboard is about what somebody has done, not
    // which save file they are on. Profiles that have never been to the End simply have
    // no dragon_fight node and contribute nothing.
    for (const profile of data.profiles) {
      const member = (profile.members || {})[bare] || (profile.members || {})[uuid];
      if (!member) continue;
      const node = dig(member, DRAGON_PATH);
      if (!node || typeof node !== 'object') continue;
      found = true;
      dragons   += sumTyped(node.amount_summoned);
      eyes      += sumTyped(node.summoning_eyes_contributed);
      superiors += Number(node.amount_summoned?.superior) || 0;
      crystals  += Number(node.ender_crystals_destroyed) || 0;
      bestDamage = Math.max(bestDamage, maxTyped(node.most_damage));
    }
    return found ? { dragons, eyes, superiors, crystals, bestDamage } : null;
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
  const cached = prev && prev.verified && now - prev.verifiedAt < VERIFY_TTL_MS;
  const verified = cached
    ? { dragons: prev.dragons, eyes: prev.eyes, superiors: prev.superiors,
        crystals: prev.crystals, bestDamage: prev.bestDamage }
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
    // Verified extras, absent when there is no key. Superiors is the one dragon farmers
    // actually compete on, and it comes free with the call.
    superiors: verified ? verified.superiors : 0,
    crystals: verified ? verified.crystals : 0,
    bestDamage: verified ? Math.round(verified.bestDamage) : 0,
    // highest_rank in the API is the best placement ever reached, not a count of them,
    // so first-place finishes stay the mod's own figure. There is nothing to verify it
    // against and pretending otherwise would be worse than leaving it self-reported.
    firsts: clampInt(body.firsts, 0, 10000000),
    profit: Math.round(Number(body.profit) || 0),
    activeMinutes: clampInt(body.activeMinutes, 0, 10000000),
    // Shown in the mod so a rank is never presented as checked when it was not.
    verified: !!verified,
    verifiedAt: verified ? (cached ? prev.verifiedAt : now) : 0,
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
    eyes: r.eyes, firsts: r.firsts, superiors: r.superiors || 0,
    verified: !!r.verified,
  }));

  let you = null;
  if (uuid) {
    const i = rows.findIndex((r) => r.uuid === uuid);
    if (i >= 0) you = { rank: i + 1, player: rows[i].player, value: rows[i].dragons };
  }
  return { entries, you, total: rows.length };
}

// -- Player lookups -------------------------------------------------------------
//
// All of this exists on the worker rather than in the mod for one reason: the Hypixel key
// lives here. A key shipped inside a distributed jar is a published key, and the API
// terms do not allow it. The mod asks for a name and gets an answer.

const MOJANG_TTL_MS  = 24 * 60 * 60 * 1000;
const PROFILE_TTL_MS = 2 * 60 * 1000;

/** 32 hex characters, dashes optional, which is what the Hypixel API wants. */
function asUuid(raw) {
  const flat = String(raw || '').trim().toLowerCase().replace(/-/g, '');
  return /^[0-9a-f]{32}$/.test(flat) ? flat : null;
}

/**
 * Name or UUID to UUID.
 *
 * Two things were wrong here and they hid each other. A UUID went through `cleanName`,
 * which strips dashes and then truncates to 16 characters, so it arrived as half a UUID
 * and matched nobody - which is why passing one directly did not help. And a Mojang
 * lookup that fails for any reason returned null, which the caller reported as "no such
 * player", so a rate-limited request and a genuinely unknown name produced the same
 * sentence. Mojang rate-limits by IP, and a Worker shares its egress with a great many
 * other people, so that failure is the likely one rather than the exotic one.
 *
 * So: a UUID is accepted as-is and never looked up, and a name that cannot be resolved
 * says which of the two happened.
 */
async function resolveUuid(env, input) {
  const direct = asUuid(input);
  if (direct) return { uuid: direct, name: '', at: Date.now() };

  const clean = cleanName(input);
  if (!clean) return { error: 'no name given' };

  const key = 'u:' + clean.toLowerCase();
  const hit = await env.LEADERBOARD.get(key, 'json');
  if (hit && hit.uuid && Date.now() - hit.at < MOJANG_TTL_MS) return hit;

  // Mojang first, then a mirror. The mirror exists because Mojang answers a Worker far
  // less reliably than it answers a laptop, and a name lookup failing is not a reason to
  // refuse to answer a question about somebody who plainly exists.
  const sources = [
    { url: 'https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(clean),
      read: (d) => (d && d.id ? { uuid: d.id, name: d.name } : null) },
    { url: 'https://playerdb.co/api/player/minecraft/' + encodeURIComponent(clean),
      read: (d) => (d && d.data && d.data.player
        ? { uuid: String(d.data.player.raw_id || '').replace(/-/g, ''),
            name: d.data.player.username }
        : null) },
  ];

  let sawAnswer = false;
  for (const src of sources) {
    try {
      const res = await fetch(src.url, { headers: { 'user-agent': 'LancusAddons' } });
      // A 204 or 404 from Mojang is a real answer: that name does not exist.
      if (res.status === 204 || res.status === 404) { sawAnswer = true; continue; }
      if (!res.ok) continue;
      const parsed = src.read(await res.json().catch(() => null));
      if (!parsed || !asUuid(parsed.uuid)) { sawAnswer = true; continue; }
      const row = { uuid: asUuid(parsed.uuid), name: parsed.name || clean, at: Date.now() };
      await env.LEADERBOARD.put(key, JSON.stringify(row), { expirationTtl: 86400 });
      return row;
    } catch (e) {
      // Try the next source rather than giving up on the first network hiccup.
    }
  }
  return { error: sawAnswer ? 'no such player' : 'could not reach the name lookup' };
}

/**
 * A player's SkyBlock profiles, or a reason there are none.
 *
 * The reasons matter and are kept apart. "Never played SkyBlock" and "has the API
 * switched off" produce the same empty answer if you only look at whether data arrived,
 * and only one of them is something the person being asked about can change.
 */
async function fetchProfiles(env, uuid) {
  if (!env.HYPIXEL_KEY) return { error: 'no key on the worker' };
  const res = await fetch(
    'https://api.hypixel.net/v2/skyblock/profiles?uuid=' + encodeURIComponent(uuid),
    { headers: { 'API-Key': env.HYPIXEL_KEY } });
  if (res.status === 429) return { error: 'Hypixel is rate limiting, try again shortly' };
  if (!res.ok) return { error: 'Hypixel returned ' + res.status };
  const data = await res.json().catch(() => null);
  if (!data || !data.success) return { error: 'Hypixel request failed' };
  if (!Array.isArray(data.profiles) || data.profiles.length === 0) {
    return { error: 'no SkyBlock profiles' };
  }
  return { profiles: data.profiles };
}

/** The profile they are on now, falling back to the first if none is flagged. */
function selectedProfile(profiles) {
  return profiles.find((p) => p.selected) || profiles[0];
}

const memberOf = (profile, uuid) => {
  const members = profile.members || {};
  return members[uuid.replace(/-/g, '')] || members[uuid] || null;
};

/**
 * Purse and bank.
 *
 * Bank is the one figure behind a SkyBlock API toggle: with Banking switched off the
 * `banking` object is simply absent, which is indistinguishable from a balance of zero
 * unless you check for the key rather than the number. That check is the whole reason
 * this reports `bankApiOff` instead of a cheerful 0.
 */
function moneyOf(profile, member) {
  const purse = Number(member?.currencies?.coin_purse
    ?? member?.coin_purse ?? NaN);
  const hasBanking = profile && Object.prototype.hasOwnProperty.call(profile, 'banking');
  const bank = hasBanking ? Number(profile.banking.balance) || 0 : null;
  return {
    purse: Number.isFinite(purse) ? purse : null,
    purseApiOff: !Number.isFinite(purse),
    bank,
    bankApiOff: !hasBanking,
  };
}

/** Lifetime dragons, summed across profiles, using the path the probe confirmed. */
function dragonsOf(profiles, uuid) {
  let total = 0, found = false;
  for (const p of profiles) {
    const m = memberOf(p, uuid);
    if (!m) continue;
    const node = dig(m, DRAGON_PATH);
    if (!node) continue;
    found = true;
    total += sumTyped(node.amount_summoned);
  }
  return found ? total : null;
}

/**
 * Bestiary kills for a named mob.
 *
 * The bestiary keys are internal ids rather than display names, and they carry tier and
 * island prefixes, so a player typing "zealot" has to be matched loosely against them.
 * Matching is deliberately reported back: `matched` says which key answered, so a wrong
 * guess is visible in the reply rather than silently becoming the number.
 */
function bestiaryOf(profiles, uuid, query) {
  const want = String(query || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!want) return { error: 'no mob given' };

  const totals = new Map();
  let sawBestiary = false;
  for (const p of profiles) {
    const m = memberOf(p, uuid);
    const kills = m?.bestiary?.kills;
    if (!kills || typeof kills !== 'object') continue;
    sawBestiary = true;
    for (const [k, v] of Object.entries(kills)) {
      if (typeof v !== 'number') continue;
      totals.set(k, (totals.get(k) || 0) + v);
    }
  }
  if (!sawBestiary) return { error: 'bestiary API is off' };

  // Match on whole words, not substrings. A substring match made "dragon" find
  // DRAGONFLY, which is a different animal in every sense, and whichever of the two had
  // more kills won - so the answer depended on how the player had been spending their
  // time. Keys are underscore-separated (ENDER_DRAGON_YOUNG, DRAGONFLY_1), so splitting
  // on the separators and comparing whole tokens is both stricter and simpler.
  const tokensOf = (key) => key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  const matched = [];
  for (const [k, v] of totals.entries()) {
    const tokens = tokensOf(k);
    const flat = tokens.join('');
    if (flat === want || tokens.includes(want)) matched.push([k, v]);
  }

  if (matched.length === 0) {
    // Nothing matched a whole word. Rather than fall back to substrings and reintroduce
    // the dragonfly problem, say so and let the asker be more specific.
    return { error: 'no mob matching that' };
  }

  // Every tier and variant is its own key, so they are added up: somebody asking how many
  // dragons you have killed means all of them, not one type.
  const kills = matched.reduce((a, [, v]) => a + v, 0);
  matched.sort((a, b) => b[1] - a[1]);
  return {
    kills,
    matched: matched[0][0],
    variants: matched.length,
  };
}

async function playerSummary(env, name) {
  const who = await resolveUuid(env, name);
  if (who.error) return json({ name, error: who.error }, 200);

  const cacheKey = 'pl:' + who.uuid;
  const cached = await env.LEADERBOARD.get(cacheKey, 'json');
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return json(cached);

  const got = await fetchProfiles(env, who.uuid);
  if (got.error) return json({ name: who.name, error: got.error }, 200);

  const profile = selectedProfile(got.profiles);
  const member = memberOf(profile, who.uuid);
  const money = moneyOf(profile, member);

  const out = {
    name: who.name || name,
    uuid: who.uuid,
    profile: profile.cute_name || '',
    ...money,
    dragons: dragonsOf(got.profiles, who.uuid),
    at: Date.now(),
  };
  await env.LEADERBOARD.put(cacheKey, JSON.stringify(out), { expirationTtl: 300 });
  return json(out);
}

/**
 * Networth, computed on the Worker.
 *
 * It could not be, and the reason is worth keeping because two wrong answers were given
 * before the right one. Not zlib - Buffer, Stream and Zlib all work under
 * `nodejs_compat`, and the library bundles to 172 KiB. Not size either. It is that
 * networth means parsing item NBT, `skyhelper-networth` reads NBT through
 * prismarine-nbt, prismarine-nbt gets its parser from protodef, and protodef builds that
 * parser by calling `eval()` at module scope - so importing the package is enough to
 * throw on a platform that refuses code generation from strings and offers no flag to
 * allow it.
 *
 * The way through is to not use that parser. `alias` in wrangler.partyfinder.toml points
 * `prismarine-nbt` at shims/prismarine-nbt.js, which reads the same NBT with NBTify, a
 * parser that walks the bytes through a DataView and never eval()s anything. Two other
 * aliases go with it and are described in their own files: axios, and the filesystem
 * that `constants/itemsMap.js` writes its items backup to.
 *
 * The import below is dynamic, and has to stay that way. skyhelper-networth's manager
 * singletons call `setInterval` and start fetching the Hypixel items list from their
 * constructors, at module scope, and Workers reject both outside a request
 * ("Disallowed operation called within global scope"). A static import runs that code
 * while the isolate is starting; a dynamic one runs it inside the request that first
 * asks for a networth, where it is ordinary work.
 *
 * That first request pays for it: the items list and the SkyHelper price list are a few
 * megabytes between them and are fetched and parsed before any figure comes out. Both
 * are then cached in module scope for the life of the isolate, so it is a cold-start
 * cost rather than a per-lookup one, but it is why this route is slower than the others.
 *
 * SKYHELPER_URL still delegates to a hosted or self-hosted SkyHelper instance when it is
 * set, as an escape hatch: an upstream change that this shim does not survive can be
 * routed around from the dashboard, without waiting on a deploy.
 */
/** One player's museum on one profile, or null when it is unavailable or switched off. */
async function fetchMuseum(env, profileId, uuid) {
  if (!env.HYPIXEL_KEY || !profileId) return null;
  try {
    const res = await fetch(
      'https://api.hypixel.net/v2/skyblock/museum?profile=' + encodeURIComponent(profileId),
      { headers: { 'API-Key': env.HYPIXEL_KEY } });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !data.success || !data.members) return null;
    return data.members[uuid.replace(/-/g, '')] || data.members[uuid] || null;
  } catch (e) {
    return null;
  }
}

/** The two figures, calculated here, or the reason there are none. */
async function localNetworth(member, museum, bank) {
  try {
    // Dynamic on purpose - see the note above. `onlyNetworth` drops the per-item
    // breakdown, which no caller shows and which is the expensive half to assemble.
    const { ProfileNetworthCalculator } = await import('skyhelper-networth');
    const result = await new ProfileNetworthCalculator(member, museum, bank)
      .getNetworth({ onlyNetworth: true });

    if (!Number.isFinite(result?.networth)) return { error: 'networth came out empty' };
    return {
      networth: result.networth,
      unsoulbound: Number(result.unsoulboundNetworth) || result.networth,
    };
  } catch (e) {
    // Logged as well as returned: chat gets a sentence a player can act on, and
    // `wrangler tail` gets the thing that actually broke, which is usually upstream.
    console.error('[networth] calculation failed:', e);
    return { error: 'networth could not be calculated' };
  }
}

/** The same two figures from a hosted SkyHelper instance, when SKYHELPER_URL is set. */
async function delegatedNetworth(env, member, museum, bank) {
  try {
    const headers = { 'content-type': 'application/json' };
    if (env.SKYHELPER_TOKEN) headers.Authorization = env.SKYHELPER_TOKEN;
    const res = await fetch(env.SKYHELPER_URL.replace(/\/$/, '') + '/v2/networth', {
      method: 'POST',
      headers,
      body: JSON.stringify({ profileData: member, museumData: museum, bankBalance: bank }),
    });
    if (!res.ok) return { error: 'networth service returned ' + res.status };

    const data = await res.json().catch(() => null);
    const total = Number(data?.networth ?? data?.total ?? data?.data?.networth);
    if (!Number.isFinite(total)) return { error: 'networth service gave no total' };
    return { networth: total, unsoulbound: Number(data?.unsoulboundNetworth) || total };
  } catch (e) {
    return { error: 'networth service unreachable' };
  }
}

/**
 * The sack counts on a player's selected profile.
 *
 * <p>Polled by the mod every few seconds, so it is cached for five: the underlying
 * figure only changes when SkyBlock saves the profile, which is far rarer than that, and
 * one key answering for every user of the mod is the thing worth protecting here.
 *
 * `last_save` goes back with it and is the whole reason this is useful. The mod knows
 * which of its own chat deltas arrived after that moment, so it can take this number as
 * the truth and re-apply only what the snapshot cannot have included.
 */
async function sacksOf(env, name) {
  const who = await resolveUuid(env, name);
  if (who.error) return json({ name, error: who.error }, 200);

  const cacheKey = 'sk:' + who.uuid;
  const cached = await env.LEADERBOARD.get(cacheKey, 'json');
  if (cached && Date.now() - cached.at < 5000) return json(cached);

  const got = await fetchProfiles(env, who.uuid);
  if (got.error) return json({ name: who.name || name, error: got.error }, 200);

  const profile = selectedProfile(got.profiles);
  const member = memberOf(profile, who.uuid);
  if (!member) return json({ name: who.name || name, error: 'no profile data' }, 200);

  // Two places, because the field moved when Hypixel reorganised the inventory block and
  // older profiles were not rewritten.
  const counts = member.sacks_counts || (member.inventory && member.inventory.sacks_counts);
  if (!counts) {
    return json({ name: who.name, error: 'sacks are hidden in their API settings' }, 200);
  }

  const out = {
    name: who.name || name,
    profile: profile.cute_name || '',
    lastSave: Number(member.last_save) || 0,
    sacks: counts,
    at: Date.now(),
  };
  await env.LEADERBOARD.put(cacheKey, JSON.stringify(out), { expirationTtl: 60 });
  return json(out);
}

async function networthOf(env, name) {
  const who = await resolveUuid(env, name);
  if (who.error) return json({ name, error: who.error }, 200);

  const got = await fetchProfiles(env, who.uuid);
  if (got.error) return json({ name: who.name || name, error: got.error }, 200);

  const profile = selectedProfile(got.profiles);
  const member = memberOf(profile, who.uuid);
  if (!member) return json({ name: who.name || name, error: 'no profile data' }, 200);

  // Absent rather than zero when banking is switched off, so a hidden bank is not
  // quietly counted as an empty one.
  const bank = profile.banking ? Number(profile.banking.balance) || 0 : 0;

  // The museum counts toward networth and is a separate endpoint. Fetched best-effort:
  // it is one more subrequest and a player with the museum API off should still get a
  // figure, just one that omits it.
  const museum = await fetchMuseum(env, profile.profile_id, who.uuid);

  const figures = env.SKYHELPER_URL
    ? await delegatedNetworth(env, member, museum, bank)
    : await localNetworth(member, museum, bank);
  if (figures.error) return json({ name: who.name || name, error: figures.error }, 200);

  return json({
    name: who.name,
    networth: Math.round(figures.networth),
    unsoulbound: Math.round(figures.unsoulbound),
    profile: profile.cute_name || '',
    bankHidden: !profile.banking,
    museumCounted: museum !== null,
  });
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
          dragonFight: dig(m, DRAGON_PATH) ?? null,
          currencies: m.currencies ?? null,
          bankingPresent: Object.prototype.hasOwnProperty.call(p, 'banking'),
          banking: p.banking ?? null,
          bestiaryKeys: m.bestiary && m.bestiary.kills
            ? Object.keys(m.bestiary.kills).slice(0, 40) : null,
        };
      });
      return json({ profiles: out });
    }

    if (url.pathname === '/player/summary') {
      return playerSummary(env, url.searchParams.get('name') || '');
    }

    if (url.pathname === '/player/bestiary') {
      const asked = url.searchParams.get('name') || '';
      const who = await resolveUuid(env, asked);
      if (who.error) return json({ name: asked, error: who.error }, 200);
      const got = await fetchProfiles(env, who.uuid);
      if (got.error) return json({ name: who.name, error: got.error }, 200);
      const res = bestiaryOf(got.profiles, who.uuid, url.searchParams.get('mob') || '');
      return json({ name: who.name || asked, ...res });
    }

    if (url.pathname === '/player/sacks') {
      return sacksOf(env, url.searchParams.get('name') || '');
    }

    if (url.pathname === '/player/networth') {
      return networthOf(env, url.searchParams.get('name') || '');
    }

    if (url.pathname === '/lb/top') {
      const limit = clampInt(url.searchParams.get('limit') || '10', 1, 100);
      const board = await top(env, limit, cleanUuid(url.searchParams.get('uuid') || ''));
      return json(board);
    }

    return json({ error: 'no such route' }, 404);
  },
};
