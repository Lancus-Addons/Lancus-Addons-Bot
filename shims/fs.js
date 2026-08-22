/**
 * A filesystem that is always empty, for the one place `skyhelper-networth` uses files.
 *
 * `constants/itemsMap.js` keeps a copy of the Hypixel items list in `.itemsBackup.json`
 * next to the package, so a process that starts while the API is down still has item
 * data. On a Worker there is nowhere to write and nothing that survives the isolate
 * anyway, so `existsSync` says no, `writeFileSync` does nothing, and the package falls
 * back to the behaviour it has on any machine that has not fetched the items yet.
 *
 * The read-side functions throw rather than return empty data: `loadItems` only calls
 * them after `existsSync` says the file is there, so reaching one means this shim has
 * been wired somewhere it was not meant to be.
 */

const missing = (name) => () => {
  throw new Error('fs.' + name + ' is not available on Workers');
};

export const existsSync = () => false;
export const writeFileSync = () => {};
export const readFileSync = missing('readFileSync');
export const readFile = missing('readFile');
export const writeFile = missing('writeFile');

export default { existsSync, writeFileSync, readFileSync, readFile, writeFile };
