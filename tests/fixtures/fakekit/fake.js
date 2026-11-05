#!/usr/bin/env node
// A kit for the tests: it writes a folder like the real kits do, says what it is
// doing on stderr and its summary on stdout. The address picks what happens:
// fail exits 3, slow takes 3 seconds, bad fails a check.
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const isCheck = args[0] === "check";
const target = isCheck ? args[1] : args[0];

process.stderr.write(`Opening ${target}...\n`);
if (/fail/.test(target)) {
  process.stderr.write("Something broke\n");
  process.exit(3);
}

const finish = () => {
  if (isCheck) {
    const pass = !/bad/.test(target);
    process.stdout.write(`${pass ? "PASS" : "FAIL"} ${target}\n`);
    process.exit(pass ? 0 : 1);
  }
  const out = flag("--out");
  if (out) {
    fs.mkdirSync(path.join(out, "parts"), { recursive: true });
    fs.writeFileSync(path.join(out, "REPORT.md"), `# Report\n\nMade from ${target}.\n`);
    fs.writeFileSync(path.join(out, "parts", "data.json"), "{}\n");
  }
  process.stdout.write(`Saved the fake kit to ${out}\nargs: ${JSON.stringify(args)}\n`);
};

if (/slow/.test(target)) {
  let step = 0;
  const timer = setInterval(() => process.stderr.write(`Working ${++step}...\n`), 200);
  setTimeout(() => {
    clearInterval(timer);
    finish();
  }, 3000);
} else {
  finish();
}
