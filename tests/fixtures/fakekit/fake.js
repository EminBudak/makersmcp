#!/usr/bin/env node
// A kit for the tests: it writes a folder like the real kits do, says what it is
// doing on stderr and its summary on stdout. The address picks what happens:
// fail exits 3, slow takes 3 seconds, bad fails a check, and tree starts a
// process of its own, like a browser, and runs until it is stopped.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const isCheck = args[0] === "check";
const target = isCheck ? args[1] : args[0];
const out = flag("--out");

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
  if (out) {
    fs.mkdirSync(path.join(out, "parts"), { recursive: true });
    fs.writeFileSync(path.join(out, "REPORT.md"), `# Report\n\nMade from ${target}.\n`);
    fs.writeFileSync(path.join(out, "parts", "data.json"), "{}\n");
  }
  process.stdout.write(`Saved the fake kit to ${out}\nargs: ${JSON.stringify(args)}\n`);
};

if (/tree/.test(target)) {
  // A browser stand-in: its own process, with no pipes back, the way kits start Chrome.
  const browser = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "pids.json"), JSON.stringify({ kit: process.pid, browser: browser.pid }));
  let step = 0;
  setInterval(() => process.stderr.write(`Working ${++step}...\n`), 200);
} else if (/slow/.test(target)) {
  let step = 0;
  const timer = setInterval(() => process.stderr.write(`Working ${++step}...\n`), 200);
  setTimeout(() => {
    clearInterval(timer);
    finish();
  }, 3000);
} else {
  finish();
}
