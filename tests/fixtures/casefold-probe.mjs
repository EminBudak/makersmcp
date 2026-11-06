// What a disk that ignores letter case takes for the same name, for a test in
// server.test.mjs. In an empty folder on such a disk it makes card.png and a file for each
// string of one or two of the characters kit file names use, then prints one JSON line:
// `left`, each code point the disk leaves out of a name (car<c>d.png opens card.png), and
// `taken`, each code point it takes for one of those strings (q<c>q opens q<s>q), as
// [code point, string]. Planes 0, 1 and 14 hold every code point a disk leaves out or
// folds to those characters; the other planes hold ideographs, private use and code
// points Unicode has not assigned.
// Usage: node casefold-probe.mjs <empty folder on a disk that ignores letter case>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const base = path.resolve(process.argv[2]);
const left = path.join(base, 'left');
const taken = path.join(base, 'taken');
mkdirSync(left);
mkdirSync(taken);
writeFileSync(path.join(left, 'card.png'), '');
const characters = 'abcdefghijklmnopqrstuvwxyz0123456789._-';
for (const a of characters) {
  writeFileSync(path.join(taken, `q${a}q`), a);
  for (const b of characters) writeFileSync(path.join(taken, `q${a}${b}q`), a + b);
}

const found = { left: [], taken: [] };
for (const plane of [0, 1, 14]) {
  for (let point = plane * 0x10000; point < (plane + 1) * 0x10000; point++) {
    // Not a code point a name can hold, or one that is a string already.
    if (point === 0 || point === 0x2f || (point >= 0xd800 && point <= 0xdfff)) continue;
    const character = String.fromCodePoint(point);
    if (characters.includes(character)) continue;
    if (existsSync(path.join(left, `car${character}d.png`))) found.left.push(point);
    try {
      found.taken.push([point, readFileSync(path.join(taken, `q${character}q`), 'utf8')]);
    } catch {
      // A name of its own on this disk.
    }
  }
}
process.stdout.write(`${JSON.stringify(found)}\n`);
