# Senju 千手

A prompt bar at the top of your screen. Type a goal, and a swarm of Claude agents splits it up and works on it in parallel through MCP servers. Each agent has a ghost cursor that parks on the window of the app it is working in. Your real mouse and keyboard stay yours.

## Run it

```bash
npm install
cp .env.example .env      # then paste your Anthropic API key into .env
npm start
```

Try `npm run demo` first. It uses scripted fake agents, needs no API key, and lets you check the overlay, cursors, idle state and dismiss.

## Using it

- Type a goal in the bar and press Enter. A lead agent plans, spawns workers, and their cursors fly out.
- Keep using your computer. The overlay passes clicks through everywhere except its own bar, chips and cards.
- **Windows are tiled.** Each browser worker opens its own Chrome window in its own slot below the bar.
- **When a worker needs you** (sign-in, 2FA, a decision, confirming something irreversible), your Mac beeps, its cursor pulses "needs you", and a card appears on top of that worker's window. Several workers can ask at once; each card sits on its own window. Click Done or an option, or type a reply in the card. Cards sit along the bottom of the window; drag one by its header or press Hide if it covers something you need.
- **Chat mid-job.** The bar talks to the lead by default: ask for progress or change the plan. Click a worker's chip to talk to that worker instead; click it again to go back to the lead. Replies show in a thread under the chips. A worker busy with a long step (Claude Code, a build, a slow page) answers right away in plain words while the step keeps running, and acts on what you said when the step ends. When a worker hands a task to Claude Code, its cursor opens a Terminal window, types `claude`, and types the task into Claude Code's prompt box. Claude Code then works in its own interface, where you can watch and step in, and follow-ups are typed into the same window. Its folder-trust questions are answered Yes for you; a permission question it asks goes back to the worker, which answers it or asks you. The keys go only to that window, so your own typing elsewhere is not disturbed. (Without Terminal access, Claude Code runs in the background and streams what it does instead.)
- When the job finishes, a summary appears, the cursors rest under the bar, and the bar waits for the next prompt.
- **Stop** cancels the current job.
- **Hide** or Esc hides the bar and cursors. A running job keeps going, and the overlay comes back by itself when an agent needs you or the job finishes. Set `"dismissCancels": true` in `swarm.config.json` if you want hiding to also stop the job.
- **`Cmd+Shift+Space` shows and hides it from anywhere.** Change it with `"hotkey"` in `swarm.config.json` (for example `"Alt+Space"`). If another app owns the key, the app picks a free one and tells you which. The key is shown in the bar's placeholder and in the ◎ menu, which also has Show, Hide, Stop and Quit.

## How it works

- `src/orchestrator.js` holds the swarm and all the agent prompts.
  - **Lead agent.** A long-running Claude loop with `spawn_agent`, `wait`, `message_agent`, `stop_agent` and `ask_user`. It spawns workers, waits for events (a worker finished or failed, a worker flagged something, you wrote to it), and replans: adds workers, redirects them, or stops them.
  - **Workers.** One Claude tool loop each, acting through MCP tools. They also have `handoff` and `ask_user` (bring you in), `wait_for` (block on another worker's result), `tell_lead` (flag something that changes the plan), and a shared board.
  - **Dependencies.** A worker that depends on others starts right away, does its own setup such as sign-in, then calls `wait_for` and receives their final reports. A wait that would deadlock is refused.
  - **Board.** `board_post` pushes a note to every other working agent on its next step, so partial results spread without going through the lead.
- `src/skills.js`: stores and loads the skills the lead writes after each job.
- `src/mcp.js`: connects to MCP servers and exposes their tools to Claude.
- `src/windows.js`: finds app windows so each ghost cursor and card can sit on the right one.
- `src/main.js` and `renderer/`: the transparent overlay.

## Building the download

`npm start` runs the app from this folder. To make an installable Mac app:

```bash
npm install
npm run release
```

This builds `dist/Senju-arm64.dmg` (Apple silicon) and `dist/Senju-x64.dmg` (Intel), then prints the command that publishes them as a GitHub Release on the website's repository. The download buttons on the site point at the latest release, so a new release needs no change to the site. `npm run dist` only builds. It must run on a Mac.

What changes in the installed app:

- **Nothing else to install.** The browser and files tool servers ship inside the app and run on its own runtime, so Node is not needed. Browser agents still need Google Chrome.
- **Settings live in the app's data folder**, not this project: `swarm.config.json`, traces and skills are under `~/Library/Application Support/Senju/`. The ◎ menu has "Open settings folder".
- **The API key is asked for in the bar** the first time you run a job, and stored encrypted with the Mac's keychain.

**Signing.** The build is ad-hoc signed, not notarized. On another person's Mac, the first launch is blocked until they choose Open Anyway under System Settings > Privacy & Security. To remove that step you need an Apple Developer ID: set `mac.identity` and notarization in the `build` section of `package.json`.

## Team mode

Several people can share one session across their computers: an agent can work on your Mac and a teammate's, its cursor shows on whichever screen it is called to, and everyone can talk to the lead. Each time the app opens it asks how you want to work: **On this Mac** (no account, your own API key) or **With my team** (sign in). You can switch from the menu bar icon whenever no job is running. To skip the question, set `"mode": "local"` or `"mode": "team"` in `swarm.config.json`. Team mode needs a small server and a Supabase project. See [MULTIPLAYER.md](MULTIPLAYER.md).

## Working together

**You and the agents**

- **Tasks for you, anywhere.** An agent can ask you to do something outside its own window with `user_task`: type something into another app, pick a file, plug in a device, anything physical. The card says what to do, where, and what to type back (for example a port name). It waits as long as you need, then checks the result itself when it can.
- **Take over a window.** Click a worker's chip, then **Pause**. The worker stops before its next action and its window is yours. **Resume** hands it back, and the worker re-reads the window before acting. **Stop** ends just that worker and tells the lead not to restart it.
- **Agents install the apps a task needs.** A worker that needs a Mac app you don't have (Claude, Slack, Zoom) installs it itself in a terminal: through Homebrew when you have it, otherwise from the vendor's own site. It checks the app's signature and notarization before copying it to Applications. It still asks you when an install needs your administrator password, costs money, or would replace an app you already have. Set `"autoInstallApps": false` in `swarm.config.json` to be asked every time.
- **Scrolling is shown too.** Browser workers scroll with `browser_scroll`: the ghost cursor moves onto the page or panel and the content scrolls smoothly under it. An element out of view is scrolled to the same way before it is clicked, and scripts that scroll the page unseen are refused.
- **Seeing and clicking by sight.** For what is drawn rather than built from page elements (a canvas game, a map, a chart, a drawing), browser workers have `browser_look`, a compact picture of the page or of one area enlarged, and `browser_click_at`, which clicks or drags at positions in that picture. The cursor goes to each position, several fit in one call, and the call returns the picture after the page has reacted, with rings where the clicks landed, so a move is one model step instead of a click and then a screenshot. Pictures are sized so the model reads them at full detail without the API shrinking them (which would shift every position), and screenshots go up as JPEGs (`"vision": false` turns the two tools off).
- **Ads get closed.** While a worker's browser is open, an ad that gets in the way is closed with its cursor as soon as it shows: a video ad's Skip button, a pop-up or full-page ad (also when its close button sits inside the ad's own frame), or an ad bar stuck to the page. Only boxes that are clearly ads count, so the page's own dialogs are left alone, and the worker is told when one was closed (`"skipAds": false` turns it off).
- **Reading is shown too.** When a worker reads a page or an app window (the Claude app included) and part of it is out of view, it scrolls under the resting cursor a screen at a time, pausing to read. Text below: it reads on down and stays. A chat at its newest message: it scrolls up to read the reply and back down to the input. Panels that scroll inside a page (claude.ai) are read in place, a page is read again when it grows, and when it reads one thing out of view (a match it searched for) the cursor scrolls to it. It happens while the model thinks; the worker's next action stops it rather than waiting (`"showReading": false` turns it off). App windows scroll through the desktop driver in the background, never while you are typing. The cursor moves on a quick curved path and lands before the click does, also on buttons inside embedded frames.
- **Agents wait while you type, if they would get in your way.** A desktop action that aims at the app you are in, has to run in the foreground, or affects the whole Mac (the real pointer, the clipboard, which app is in front) is held while you are typing or clicking. Background actions on other apps go ahead. A held action goes ahead about two seconds after you stop (`"typingPause"` seconds in `swarm.config.json`; it gives up waiting after `"typingWaitMax"`, default 120). Reading the screen never waits.

**Agents with each other**

- **Direct messages.** `tell_agent` sends a result, question or warning straight to another worker, and wakes it if it is waiting.
- **Claims.** A worker claims a shared thing (a window, a document, a file) before changing it, so two workers never edit it at once. Claims are released when the worker finishes.
- **Board, dependencies, lead.** Posts to the board reach everyone, `wait_for` blocks on another worker's result, and `tell_lead` asks for a change of plan.

## Desktop apps

Workers can drive your own Mac apps (Cursor, Claude, Word, Slack, Discord and others), already signed in as you, through the `desktop` server in `swarm.config.json`. It uses [Cua Driver](https://github.com/trycua/cua), an open-source (MIT) background computer-use driver: it reads a window's accessibility tree and screenshot and delivers clicks and keys to that one app without moving your pointer, where the app allows it.

**Set it up once** (this installs third-party software that gets Accessibility and Screen Recording rights, so read its page first):

```bash
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
open -n -g -a CuaDriver --args serve
cua-driver permissions grant
npm run doctor
```

`npm run doctor` starts every configured server, lists its tools, checks that windows can be seen and arranged, and writes `traces/doctor.json`. Until the driver is installed, the app says so once and works with the browser and files servers only.

**How it behaves**

- **One app per worker.** The lead gives each desktop worker its own app, and desktop calls run one at a time across workers, since they share one keyboard.
- **Windows are arranged.** The first time a worker uses an app, that app's window is moved into the worker's slot so nothing overlaps, and put back when the job ends (`"restoreWindows": false` to leave them). The desktop driver moves the windows, using the permission you already gave it. Without the driver, this falls back to System Events, which needs the app you start Senju from allowed under Privacy & Security > Accessibility.
- **One cursor.** Cua Driver draws its own agent cursor; Senju hides it so only Senju's ghost cursors show. Senju runs its calls in a driver session of its own, so other tools that use Cua Driver keep their cursor. Set `"driverCursor": true` on the `desktop` server to show it anyway.
- **Focus.** Workers act in the background where they can. For an app that ignores background input, a worker may bring it to the front for a single action, and never while you are typing.
- **Messaging and mail.** Workers may read and draft. Every send needs your click on a card that shows the exact text and recipient. Note that Discord's terms prohibit automating a user account.
- **Off limits unless you name them.** Terminal, System Settings, password managers, and banking apps.

These rules are instructions to the model, not enforcement. Cua Driver has its own permission modes if you want hard limits on which apps it may touch.

To use a different desktop server, change `command` and `args` under `desktop`. Keep `"kind": "desktop"` (adds the rules above), `"serial": true` and `"tile": "window"`.

## Skills (self-improvement)

After every finished job that used workers, the lead runs a short retrospective in the background and writes what the swarm learned into a skill: a markdown file in `skills/`.

- **What goes in.** Each worker ends its report with a "Lessons" section (the method that worked, dead ends, what it needed from you). The lead turns those into instructions for a future agent: the plan shape, the per-site method with exact tool usage, pitfalls, and when to ask you to sign in. It is told to record methods only, never passwords, codes, personal details, or the content of your work.
- **How it is used.** At the start of each job the lead sees the list of skills, reads the ones that fit, and attaches them to the workers that need them.
- **How it improves.** If a skill already covers the same ground, the lead reads it and saves a merged, corrected version. The old version is kept in `skills/.history/`.
- **You are in control.** Skills are plain files. Read them, edit them, or delete them. A toast tells you whenever one is created or improved. Set `"skills": false` in `swarm.config.json` to turn this off.

## Long-running jobs

Jobs can run for hours. These are set under `context`, `maxSteps` and `tokenBudget` in `swarm.config.json`:

- **Long context.** The default model has a 1M-token window, so agents keep a lot of history verbatim.
- **Tool-result clearing** (`clearToolResultsAt`, default 200k tokens). Past that size, the API drops old tool results such as page snapshots, keeping the newest `keepToolResults` (default 10).
- **Compaction** (`compactAt`, default 500k tokens, minimum 50k). Past that size, the API replaces the agent's history with a summary written to preserve its task, your instructions, results so far, the exact current state, and what remains. A toast tells you when it happens.
- **Prefix caching.** Each step re-reads the conversation so far from cache, which is what makes long contexts affordable.
- **Token budget** (`tokenBudget`, default 40M tokens processed per job; set `null` for no limit). At 100% the lead is told to wrap up. At 150% the job stops.
- **Steps.** A worker gets `maxSteps` model turns (default 300).
- **Keep-awake and notifications.** The Mac stays awake while a job runs, and you get a banner when an agent needs you or the job finishes.

If the model or account rejects the server-side features, the app says so once and falls back to trimming old tool results itself. Set `"context": { "enabled": false }` to force that fallback.

## Traces

Every job writes a folder under `traces/` (turn off with `"trace": false` in `swarm.config.json`):

- `timeline.log`: one readable line per event, all agents interleaved. Start here.
- `lead.jsonl` and one `<Worker>.jsonl` per worker: every model reply (stop reason, token counts, text, tool calls) and every tool result.
- Compactions and cleared tool results show up as `compaction` and `context` lines.

To see why a worker stopped, find its `END reason=` line: `reported` (it chose to stop), `step_limit`, `cut_off` (replies kept hitting the output limit), `error`, or `stopped`.

## Adding MCP servers

Edit `swarm.config.json`. Each server has:

- `command`, `args`, `env`: how to start it (same shape as other MCP clients). `${WORKSPACE}` expands to `~/Senju`.
- `app`: the macOS app name its ghost cursor should park on.
- `shared`: `true` to start one instance all agents share (stateless servers like files), `false` to give every agent its own instance (stateful servers like a browser).
- `tile`: `"playwright"` makes each agent's browser window open in its own slot on screen.

The defaults are a Playwright browser server (each agent gets its own Chrome window) and a filesystem server scoped to `~/Senju`.

## Known limits

- Ghost cursors show where an agent is working, not the exact element it is clicking.
- Each browser worker has its own fresh browser session, so two workers on the same site each need their own sign-in. The lead is told to keep one signed-in site with one worker where it can.
- Windows are placed when they open. A window is not moved again if the layout changes later.
- Agents can only do what the configured MCP servers allow.
- Desktop control depends on the app: games, canvas apps and some Electron apps ignore background input, and a write can appear to succeed without applying.
- The first job is slow to start while `npx` downloads the servers.

`npm test` runs the agent core against a fake model and a real MCP server.
