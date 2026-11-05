# MakersMCP

Free kits for makers, one MCP. https://makersmcp.com

Open source kits for people who make things, from creators to product teams: image, video, sound, design and more. MakersMCP serves every kit to your agent through one MCP server, and they all run on your own machine, with no account or key.

## The kits

Each kit lives in its own repository and works on its own too, as a CLI and an agent skill.

| Field | Kit | Tools |
| --- | --- | --- |
| Design | [easybrandkit](https://github.com/EminBudak/easybrandkit): a website's logo files, colors, fonts and first screen | `make_brand_kit` |
| Design | [easyfontkit](https://github.com/EminBudak/easyfontkit): a site's fonts with their licenses and free look-alikes | `make_font_kit` |
| Image | [easyscreenshot](https://github.com/EminBudak/easyscreenshot): clean screenshots and a short demo video of a website | `take_screenshots`, `record_demo_video`, `check_pwa_screenshots` |
| Video | [launch-film](https://github.com/EminBudak/launch-film): a launch film with music, the launch pictures, and a check for any video | `make_launch_film`, `plan_launch_film`, `render_launch_film`, `make_launch_stills`, `check_video`, `launch_film_guide` |
| Sound | musicfit (soon): a music track cut to fit your video | `fit_music`, `analyze_music` |

More kits are on the way.

## Use it

The first release on npm is on its way, so until it is out the commands below will not find the package. Star the repo to hear when it ships.

You need Node 22 or newer and the Chrome, Chromium, Edge or Brave you already have. The video and sound kits also need ffmpeg.

In Claude Code:

```bash
claude mcp add makersmcp -- npx -y makersmcp
```

In Codex:

```bash
codex mcp add makersmcp -- npx -y makersmcp
```

Claude Desktop, Cursor and other MCP clients take the same command in their MCP settings:

```json
{
  "mcpServers": {
    "makersmcp": {
      "command": "npx",
      "args": ["-y", "makersmcp"]
    }
  }
}
```

Then ask your agent for what you need, like "make a launch film for linear.app" or "get the brand kit and the fonts of stripe.com". To see what makersmcp found on your machine, run `npx -y makersmcp --check`.

## Where the files go

Every tool saves its files in a folder and returns the folder, the files in it and the kit's own notes, like BRAND.md. The folders go where makersmcp starts, which is your project for a coding agent, or `~/makersmcp` when it can't write there. Choose another place with `--out <dir>` or `MAKERSMCP_OUT`, or give a tool its own `out_dir`.

A long job, like rendering a film, keeps going after the tool returns. The tool then gives back a `job_id`, and your agent calls `wait_for_job` with it until the job ends. `list_jobs` and `cancel_job` do what they say, and `check_setup` tells what is missing when a kit fails to start.

## Pick your kits

Every kit that is installed is on. To give your agent fewer tools, turn on only the kits you use:

```bash
npx -y makersmcp --kits easybrandkit,launch-film
```

## Add a kit

makersmcp has no code for any kit. Each kit is a JSON file in [kits/](kits) that names its npm package, its tools, and how each tool's parameters become the kit's arguments. A new kit is a new file there and its package in `package.json`; removing a kit is the reverse. [docs/kits.md](docs/kits.md) describes the file.

## Develop

```bash
npm install
npm test
node dist/index.js --check
```

To try a kit from its checkout before it is on npm, start makersmcp with `--kit-path <kit>=<folder>`, like `--kit-path musicfit=../musicfit`. The package also exports `createMcpServer`, to serve the kits over another transport.

[MIT](LICENSE)
