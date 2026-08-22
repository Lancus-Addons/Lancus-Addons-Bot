/**
 * Does shims/prismarine-nbt.js still stand in for prismarine-nbt?
 *
 *   npm test        (or: node --test tests/)
 *
 * Two things are checked, and both are about a dependency bump rather than about this
 * repo's own code, which is why the test exists at all: the Worker cannot run the real
 * prismarine-nbt, so nothing on the deployed path would ever notice the two drifting
 * apart. Node can run both, so it compares them here.
 *
 *   1. Same values. Every tag type is written with prismarine's own builders, parsed
 *      back by both, and the results compared - so a long that came out as a BigInt
 *      instead of prismarine's [high, low] pair fails here rather than as a wrong
 *      networth for one player with one item.
 *
 *   2. Same shape of use. skyhelper-networth's helper/decode.js is loaded with the shim
 *      swapped in underneath it and run for real. The shim returns a promise from
 *      simplify(), which works only because decode.js returns that value straight out of
 *      an async function; a version of decode.js that did anything else with it would
 *      pass a promise on to the calculators and quietly value everything at zero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual as deepEqualLoose } from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const real = require('prismarine-nbt');
const shim = await import('../shims/prismarine-nbt.js');

/**
 * decode.js resolves `prismarine-nbt` to the same file this test just loaded, so seeding
 * the require cache with the shim is enough to put it underneath the real helper. The
 * bundler does the same job with `alias` in wrangler.partyfinder.toml; this is only how
 * a Node process gets there.
 */
const prismarinePath = require.resolve('prismarine-nbt');
require.cache[prismarinePath] = {
  id: prismarinePath,
  filename: prismarinePath,
  path: prismarinePath,
  loaded: true,
  children: [],
  paths: [],
  exports: shim,
};
const decode = require('skyhelper-networth/helper/decode');

/** One tag of every type, values chosen so a sign or a truncation would show. */
const sample = real.comp({
  i: real.comp({
    id: real.string('HYPERION'),
    Count: real.byte(1),
    Damage: real.short(3),
    tag: real.comp({
      ExtraAttributes: real.comp({
        id: real.string('HYPERION'),
        rarity_upgrades: real.int(1),
        timestamp: real.long([0x12345678, 0x9abcdef0 | 0]),
        modifier: real.string('heroic'),
        winning_bid: real.long([0, 1250000000]),
        negative: real.long([-1, -1]),
        price_paid: real.double(1.7976931348623157e100),
        wobble: real.float(0.1),
        low_byte: real.byte(-5),
        low_short: real.short(-300),
        big_int: real.int(-2147483648),
        gems: real.comp({ JASPER_0: real.string('PERFECT') }),
        enchantments: real.comp({ ultimate_wisdom: real.int(5) }),
      }),
      display: real.comp({
        Name: real.string('§6Hyperion §d✦'),
        Lore: real.list(real.string(['§7Damage: §c+260', ''])),
      }),
      bytes: real.byteArray([1, -2, 127, -128]),
      ints: real.intArray([1, -2, 70000]),
      longs: real.longArray([[0, 1], [-1, -1]]),
      empty: real.list(real.string([])),
      people: real.list(real.comp([{ x: real.int(1) }, { x: real.int(2) }])),
    }),
  }),
});

const encoded = gzipSync(real.writeUncompressed(sample, 'big')).toString('base64');

/** What the real library makes of a buffer, the way decode.js asks for it. */
const throughReal = (buffer) => real.simplify(real.protos.big.parsePacketBuffer('nbt', buffer, 0).data);

/** The same, through the shim. Its simplify() returns a promise; see the file header. */
const throughShim = (buffer) => shim.simplify(shim.protos.big.parsePacketBuffer('nbt', buffer, 0).data);

/**
 * Loose rather than strict, and only here: a long is an Array subclass on both sides but
 * not the *same* subclass, since the shim cannot import protodef's copy of it. Strict
 * equality compares prototypes and would fail on that alone. What the values are is
 * checked strictly by the tests below.
 */
test('every tag type parses to the value prismarine-nbt produces', async () => {
  const buffer = real.writeUncompressed(sample, 'big');
  deepEqualLoose(await throughShim(buffer), throughReal(buffer));
});

test('longs stay [high, low] pairs of signed 32-bit numbers', async () => {
  const buffer = real.writeUncompressed(sample, 'big');
  const attributes = (await throughShim(buffer)).i.tag.ExtraAttributes;

  assert.deepEqual([...attributes.timestamp], [305419896, -1698898192]);
  assert.deepEqual([...attributes.winning_bid], [0, 1250000000]);
  assert.deepEqual([...attributes.negative], [-1, -1]);
});

test('a long behaves like protodef\'s: valueOf() is the number, toString() the digits', async () => {
  const buffer = real.writeUncompressed(sample, 'big');
  const mine = (await throughShim(buffer)).i.tag.ExtraAttributes;
  const theirs = throughReal(buffer).i.tag.ExtraAttributes;

  for (const key of ['timestamp', 'winning_bid', 'negative']) {
    assert.equal(mine[key].valueOf(), theirs[key].valueOf(), key + ' valueOf');
    assert.equal(String(mine[key]), String(theirs[key]), key + ' toString');
    assert.equal(Number(mine[key]), Number(theirs[key]), key + ' Number()');
    assert.ok(Array.isArray(mine[key]), key + ' should still be an Array');
  }
});

test('numbers come out as numbers, not Number objects', async () => {
  const buffer = real.writeUncompressed(sample, 'big');
  const attributes = (await throughShim(buffer)).i.tag.ExtraAttributes;

  for (const key of ['rarity_upgrades', 'price_paid', 'wobble', 'low_byte', 'low_short', 'big_int']) {
    assert.equal(typeof attributes[key], 'number', key + ' should be a primitive number');
  }
  assert.ok(Array.isArray((await throughShim(buffer)).i.tag.bytes), 'byteArray should be a plain Array');
});

test('bytes that are not NBT come back as {}, the way decode.js reports them', async () => {
  assert.deepEqual(await throughShim(Buffer.from('not nbt at all')), {});
  assert.deepEqual(await throughShim(Buffer.alloc(0)), {});
});

test('simplify refuses anything but its own parsePacketBuffer output', () => {
  assert.throws(() => shim.simplify({ type: 'compound', value: {} }), TypeError);
});

test("skyhelper-networth's own decode.js runs unchanged on the shim", async () => {
  deepEqualLoose(await decode.decodeNbtData(encoded), throughReal(real.writeUncompressed(sample, 'big')));
  assert.equal((await decode.decodeItem(encoded)).id, 'HYPERION');
  deepEqualLoose(await decode.decodeItems([encoded]), [await decode.decodeItem(encoded)]);
  deepEqualLoose(await decode.decodeItemsObject({ inventory: encoded }), {
    inventory: await decode.decodeItem(encoded),
  });
});

test('decode.js still returns {} for junk rather than throwing through the shim', async () => {
  assert.deepEqual(await decode.decodeNbtData('invalid-base64'), {});
  assert.deepEqual(await decode.decodeNbtData(''), {});
  assert.deepEqual(await decode.decodeItem(null), {});
  deepEqualLoose(await decode.decodeItems([encoded, 'invalid-base64']), [
    await decode.decodeItem(encoded),
    [],
  ]);
});

/**
 * The coupling the shim is built on, asserted directly so that a bump which rewrites
 * decode.js fails with a sentence about why rather than with a wrong number somewhere
 * downstream. If this one fails, read the seam note in shims/prismarine-nbt.js.
 */
test('decode.js still returns simplify() straight out of an async function', () => {
  const source = readFileSync(require.resolve('skyhelper-networth/helper/decode'), 'utf8');
  assert.match(
    source,
    /return nbt\.simplify\(parsed\.data\);/,
    'decode.js no longer hands simplify() output straight back - the shim returns a promise there',
  );
});
