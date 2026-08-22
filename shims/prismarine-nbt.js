/**
 * prismarine-nbt, reimplemented on NBTify, so that networth can be computed on the
 * Worker instead of being sent somewhere else to be computed.
 *
 * `skyhelper-networth` reads item NBT through prismarine-nbt, prismarine-nbt gets its
 * parser from protodef, and protodef builds that parser by calling `eval()` at module
 * scope - so merely importing the package throws on Workers, which refuse code
 * generation from strings and offer no flag to allow it. NBTify is a parser that reads
 * the bytes directly with a DataView, so aliasing `prismarine-nbt` to this file (see
 * `alias` in wrangler.partyfinder.toml) is the whole of the fix.
 *
 * Only what `skyhelper-networth/helper/decode.js` calls is implemented: reading a
 * gunzipped Java-edition tag, and flattening it. Nothing writes NBT here, and the rest
 * of prismarine's surface - the builders, `parse`, `writeUncompressed`, the little
 * endian protos - is deliberately absent so that a use this file does not cover fails
 * loudly at the call rather than quietly returning something plausible.
 *
 * -- The one seam: simplify() returns a promise --------------------------------------
 * NBTify's `read()` is async and prismarine's `parsePacketBuffer()` is not, and there
 * is no synchronous entry point to NBTify to bridge that with. The single caller is:
 *
 *     const parsed = nbt.protos.big.parsePacketBuffer('nbt', unzippedData, 0);
 *     return nbt.simplify(parsed.data);
 *
 * and it sits inside an `async function`, so a promise returned from `simplify()` is
 * awaited on the way out and every consumer downstream sees exactly the value
 * prismarine-nbt would have handed back. So `parsePacketBuffer()` starts the parse and
 * hands back a token, and `simplify()` returns its result.
 *
 * That holds precisely as long as `decode.js` keeps that shape: a version that assigned
 * the simplified tag to a variable and read a field off it would get a promise and go
 * quietly wrong. Which is why `skyhelper-networth` is pinned to an exact version in
 * package.json, and why tests/nbt-shim.test.js runs the real `decode.js` through this
 * file and compares against real prismarine-nbt. Bump the version, run the test.
 *
 * -- Failure is `{}`, not a throw ----------------------------------------------------
 * prismarine throws on bytes that are not NBT and `decode.js` catches that and returns
 * `{}`. A rejected promise would escape that catch - the `return` is awaited after the
 * try block has already been left - so bad bytes resolve to `{}` here instead. Same
 * value, same place, without depending on a catch that would no longer fire.
 *
 * -- Matching prismarine's value shapes ----------------------------------------------
 * prismarine's `simplify` leaves the *values* alone and only unwraps the tag envelope,
 * so a long arrives as a `[high, low]` pair of signed 32-bit numbers and a byteArray as
 * a plain Array. NBTify hands back `Int8`/`Int16`/`Int32`/`Float32` wrappers, BigInt and
 * typed arrays instead. Everything is converted back below, because skyhelper reads
 * these values straight out of `ExtraAttributes` and a Number object where it expects a
 * number is the kind of difference that survives every comparison and breaks one.
 */

import { read, getTagType, TAG } from 'nbtify';

/** Marks the token `parsePacketBuffer` returns, so `simplify` cannot be handed anything else. */
const PARSE = Symbol('lancus.nbt.parse');

/**
 * A long the way prismarine reports one: the two signed 32-bit halves, high first, in an
 * Array subclass that knows what it adds up to. Copied in shape from protodef's own
 * class rather than reduced to a plain `[high, low]`, because the difference is visible -
 * `valueOf()` is what makes `Number(tag)` and `tag > 0` give the number a caller expects
 * instead of NaN, and `String(tag)` the digits instead of "305419896,-1698898192".
 */
class SignedBigInt extends Array {
  valueOf() {
    return BigInt.asIntN(64, BigInt(this[0]) << 32n) | BigInt.asUintN(32, BigInt(this[1]));
  }

  toString() {
    return this.valueOf().toString();
  }
}

const longPair = (value) =>
  new SignedBigInt(
    Number(BigInt.asIntN(32, value >> 32n)),
    Number(BigInt.asIntN(32, BigInt.asUintN(32, value))),
  );

/** One NBTify tag as the plain JS value prismarine's `simplify` would have produced. */
function plain(value) {
  switch (getTagType(value)) {
    // Int8/Int16/Int32/Float32 are Number subclasses; `.valueOf()` is the number itself.
    case TAG.BYTE:
      return typeof value === 'boolean' ? Number(value) : value.valueOf();
    case TAG.SHORT:
    case TAG.INT:
    case TAG.FLOAT:
      return value.valueOf();
    case TAG.DOUBLE:
    case TAG.STRING:
      return value;
    case TAG.LONG:
      return longPair(value);
    case TAG.BYTE_ARRAY:
    case TAG.INT_ARRAY:
      return Array.from(value);
    case TAG.LONG_ARRAY:
      return Array.from(value, longPair);
    case TAG.LIST:
      return value.map(plain);
    case TAG.COMPOUND:
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
    default:
      // getTagType returns null for anything that is not a tag, which after a successful
      // read means NBTify grew a type this switch has not been taught yet.
      throw new TypeError('unsupported NBT value: ' + Object.prototype.toString.call(value));
  }
}

/**
 * The format is fixed rather than sniffed: Hypixel stores Java-edition NBT, big endian,
 * with a named root, and `decode.js` has already gunzipped it. Left to guess, NBTify
 * retries the whole parse against every combination, which turns one bad item into a
 * dozen wasted passes. `strict: false` tolerates trailing bytes, as prismarine does.
 */
async function parse(bytes) {
  try {
    const nbt = await read(bytes, {
      rootName: true,
      endian: 'big',
      compression: null,
      strict: false,
    });
    return plain(nbt.data);
  } catch {
    return {};
  }
}

/**
 * `metadata`, `buffer` and `fullBuffer` are not returned. The byte count is not known
 * until the parse finishes, and inventing one would be worse than its absence: the only
 * caller reads `.data` and nothing else, so a reader of the others gets a TypeError
 * rather than a wrong number.
 */
function parsePacketBuffer(type, buffer, offset = 0) {
  if (type !== 'nbt') {
    throw new Error('this prismarine-nbt shim only parses the "nbt" type, not "' + type + '"');
  }
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return { data: { [PARSE]: parse(offset ? bytes.subarray(offset) : bytes) } };
}

/** Big endian, Java edition. The Bedrock protos are not implemented; see the header. */
export const protos = { big: { parsePacketBuffer } };

/** Returns a promise - read the seam note at the top of this file before using it. */
export function simplify(data) {
  const parsed = data && data[PARSE];
  if (!parsed) {
    throw new TypeError('simplify() takes the `data` from this shim\'s parsePacketBuffer');
  }
  return parsed;
}

export default { protos, simplify };
