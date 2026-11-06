#!/usr/bin/env node
// easybrandkit for the tests, without a browser or the network: it readies its folder
// with the real easybrandkit's prepareDir, which replaces an earlier kit's own files,
// keeps the rest and refuses a folder that holds no kit, then writes a small kit there.
const fs = require("fs");
const path = require("path");
const { prepareDir } = require("easybrandkit");

const args = process.argv.slice(2);
const url = args[0];
const out = args[args.indexOf("--out") + 1];
try {
  prepareDir(out);
} catch (error) {
  process.stderr.write(`easybrandkit: ${error.message}\n`);
  process.exit(1);
}
const kit = {
  version: 1,
  url,
  name: "Acme",
  colors: [{ hex: "#112233", role: "primary" }, { hex: "#ffcc00", role: "button" }],
  logos: [],
  screenshots: [],
};
fs.writeFileSync(path.join(out, "brand.json"), JSON.stringify(kit, null, 2) + "\n");
fs.writeFileSync(path.join(out, "BRAND.md"), "# Acme\n");
process.stdout.write(`Saved the brand kit of ${url} in ${out}\n`);
