# How a kit plugs in

A kit is a command line tool with its own repository and npm package. makersmcp runs it with Node as a child process and knows it only through its JSON file in `kits/`. This is easybrandkit's, shortened:

```json
{
  "kit": "easybrandkit",
  "package": "easybrandkit",
  "field": "design",
  "about": "A website's brand kit: its real logo files, colors, fonts and first screen.",
  "repository": "https://github.com/EminBudak/easybrandkit",
  "needs": ["chrome"],
  "tools": [
    {
      "name": "make_brand_kit",
      "title": "Brand kit from a website",
      "description": "Reads a website in a headless browser ... Read BRAND.md before designing anything for that product.",
      "args": ["{url}"],
      "out": { "flag": "--out", "name": "easybrandkit-{host}" },
      "params": {
        "url": { "type": "url", "required": true, "description": "The website, like https://linear.app" },
        "facts": { "type": "boolean", "flag": "--facts", "description": "Also read what the site claims about itself." },
        "stores": { "type": "boolean", "flag": "--no-stores", "when": false, "description": "Set to false to skip app store listings." }
      },
      "docs": ["BRAND.md", "FACTS.md"]
    }
  ]
}
```

## The kit

- `kit`: its name, the one `--kits` and `--kit-path` take.
- `package`: its npm package. makersmcp runs the package's bin, or the one named in `bin` when there are several.
- `field`, `about`, `repository`: what `check_setup` shows.
- `needs`: what it needs on the machine, `chrome` or `ffmpeg`.

## A tool

- `name`, `title`, `description`: what the agent sees. Write the description for an agent: what the tool makes, which files, and which one to read first.
- `args`: the kit's positional arguments, like `["demo", "{url}"]`. `{param}` is that parameter's value.
- `params`: each one has a `type`, a `description`, and a place in `args` or a `flag`. A parameter in `args` must be `required`.
  - `url` is an http or https address. `path` is a file or folder; a relative one is read from the output folder, and it must exist. `url_or_path` is either.
  - `text_or_path` is text the kit takes as it is, or a file, like the cuts of a video as `3.2,7.5` or a JSON file. Its `pattern` is a regular expression for the text, matched in full; any other value is a file, read like a `path`. A parameter that takes a file in any form is never a plain `string`: on a hosted server only the file types are brought in as links, and a `string` would reach the kit as a path on the server.
  - `string`, `integer` and `number`; `min` and `max` bound the numbers. Every number needs both, set to what the kit itself accepts: `npm test` tries each bound with the kit.
  - `boolean` passes its flag when it is true, or with `"when": false` when it is false, for flags like `--no-music`.
  - `enum` takes one of its `values`. `list` takes several, joined with commas into one flag. `repeat` passes the flag once for each item.
- `out`: the folder the kit writes to, with the kit's `flag` for it and a `name` like `easybrandkit-{host}`. `{host}` is the address's host without www, `{dir:param}` is a file's folder and `{stem:param}` its name without the extension. Without a flag, the folder is only reported.
  - `otherwise`: where the kit saves when `name` cannot be filled, like `{dir:source}` when the tool was given a file instead of an address. The kit picks that folder itself and takes no flag for it, so an `out_dir` other than that folder is refused.
  - `replaces`: folders in the folder the kit is given that it deletes and makes again, each with the file that marks one a kit made, like `{ "brand": "brand.json" }`. makersmcp does not start the kit when such a folder holds anything else, or holds a file the call names. Mark the tool `destructive` too.
- `docs`: Markdown files in the folder to return with the result.
- `check`: the kit exits with 1 when a check fails. That is a normal result, not an error.
- `report`: for a check, what the kit writes once the check has run: `"stdout"` or a file in the folder, like `CHECK.md`. When the kit exits with 1 without writing it in this run, the check could not run, and the job failed. Every check needs one, since kits also exit with 1 on their own errors.
- `uses`: flags that take another kit's script, like `{ "--easybrandkit": "easybrandkit" }`, so a kit runs the copy makersmcp already has.
- `readOnly`: the tool writes nothing.
- `destructive`: the tool may delete or replace files already in its folder, so a client may ask before it runs.

makersmcp adds `out_dir` and `wait_seconds` to every tool. It starts the kit, sends each line the kit writes to stderr as progress, and returns the kit's stdout as the summary, with the folder, its files and the docs. A kit that takes longer than `wait_seconds` keeps running, and the tool returns a `job_id` for `wait_for_job`. When a kit fails, the agent gets what it said on stderr: for an argument error (exit code 2), the reason without the usage text after it.

Each kit runs in a process group of its own, with the browser and ffmpeg it starts, under a small supervisor (`dist/supervise.js`). `cancel_job` stops the group, and so does the supervisor once makersmcp is gone, however it ended.

## Adding one

1. Write its file in `kits/`.
2. Add its package to `dependencies` in `package.json`.
3. In `tests/kits.test.mjs`, say how the kit reads its arguments without a browser (its dry run) and one value it refuses.
4. Run `npm test`, which checks every file in `kits/` and tries each number's bounds with every kit that is installed.

To try a kit from its checkout before it is on npm, start makersmcp with `--kit-path <kit>=<folder>`. `MAKERSMCP_KIT_PATHS=<kit>=<folder> npm test` tries its bounds too.
