# AgentLink

AgentLink is an engineering workspace for Firefox in which **Gemini coordinates** a project and **Arena Agent Mode carries out the work**, without you in the loop.

You state an objective once. From then on AgentLink runs by itself: Gemini plans the work and writes a task, AgentLink types it into your Arena tab, waits until Arena has finished, reads the report, and hands it to Gemini, which checks it against the task's acceptance criteria and writes the next task. This repeats until Gemini has evidence that the objective is met.

```
You ──► objective
          │
          ▼
   ┌─► Gemini plans and writes a task ──► AgentLink sends it to Arena
   │                                              │
   │                                              ▼
   └── Gemini reviews the report ◄── AgentLink reads Arena's report
          │
          ▼
   objective complete  (or one clear question for you)
```

There is no approval step and no button to press between tasks. AgentLink stops and asks for you only when it cannot go on: Gemini needs a decision that is yours to make, the Gemini API keeps failing, Arena cannot be reached or does not answer, or the task limit is reached. It then says what it needs, in one place at the top of the workspace.

## How it is put together

| Part | Where it runs | What it does |
| --- | --- | --- |
| **Companion** (`src/companion`) | A small Node.js program on your computer, loopback only | Holds the Gemini API key, calls Gemini, keeps project memory on disk, and drives the loop: after every Gemini turn and every Arena report it decides what happens next |
| **Extension relay** (`src/extension/background`, `content`) | Firefox, in the background | Every few seconds asks the companion what is outstanding, types queued tasks into your Arena tab, follows them until Arena has finished, and brings the reports back. It runs whether or not the workspace is open |
| **Workspace** (`src/extension/ui`) | Firefox, tab or sidebar | Shows the plan, the conversation with Gemini, each task with Arena's report and Gemini's review, and the session controls |

The Gemini API key is entered on the companion's own settings page. It is never stored in the extension, never sent to it, and never appears in logs or API responses.

## Requirements

- Node.js 20.11 or newer
- Firefox 140 or newer
- A Gemini API key from Google AI Studio
- An Arena account, signed in, with an Agent Mode conversation open

## Setup

```bash
npm install
npm run build
npm start
```

`npm start` prints two things you need:

```
1. Open the settings page to enter or test your Gemini API key:
     http://127.0.0.1:47821/settings#token=…
2. Pair the browser extension: … paste this pairing token: …
```

1. **Add your Gemini key.** Open the printed settings link, paste the key, and select **Save and test**. The page shows whether the key works and lets you choose the model.
2. **Load the extension.** In Firefox open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and select `dist/manifest.json`.
3. **Pair it.** Click the AgentLink toolbar button. Paste the settings link (or the address and token) into the connection form.
4. **Open Arena.** Sign in and open an Agent Mode conversation in a tab. With one Arena tab open there is nothing to choose; with several, pick one under **Settings → Arena**. **Test Arena connection** checks the page without typing anything.
5. **Create a project.** Give it a name and the objective, and select **Start**. That is the last thing you have to do.

AgentLink also opens as a sidebar: **View → Sidebar → AgentLink**.

## What happens after you press Start

1. Gemini reads the objective, records a plan, and sends the first task. Each task carries its instructions, the context Arena needs, acceptance criteria, your project constraints, and a reference code such as `AL-T-1-3f9c2a1b`.
2. The relay types the task into the Arena tab and confirms that Arena took it. It asks Arena to end its report with `AGENTLINK-DONE` and the reference code.
3. The relay watches the page. The report is complete when that closing line is there and the page has gone quiet, or, if Arena leaves the line out, when the page has stopped changing for the configured quiet time.
4. Gemini reviews the report. To mark a task complete it must quote the report word for word; a verdict whose quotes are not in the report is refused.
5. Gemini sends the next task, and so on, until it declares the objective complete. That needs at least one task verified from an Arena report.

You can watch all of it in the workspace. You can also write to Gemini at any time to redirect the work; that is optional.

### Session controls

- **Pause** stops new tasks from being sent. A task Arena already has is still followed and its report is saved; Gemini reviews it when you **Resume**.
- **Stop** ends the session and cancels the open task. **Continue the work** starts it again from the recorded state.
- **Cancel task** abandons one task; Gemini then decides what to do instead.

### When it needs you

A strip at the top of the workspace shows the one thing that holds the work up, with the way to resolve it:

| What it says | What to do |
| --- | --- |
| A question from Gemini | Choose one of the offered answers or type your own. The work continues with your answer. |
| Gemini cannot be reached, or the key or model is refused | Fix it under **Gemini settings**, then **Continue**. Temporary failures are retried automatically first (after 5, 20, 60 and 180 seconds). |
| The task is waiting on the Arena tab | Open Arena Agent Mode, choose between several tabs, clear a draft left in the message box, or switch the tab to Agent Mode. The relay continues by itself as soon as it can. |
| Arena did not answer several tasks in a row, or a task could not be delivered in five attempts | Check the Arena tab, then **Continue**. |
| The task limit was reached | Raise the limit on the companion's settings page, or **Continue** for another round. |

### What it does not do

- It never types a task twice. Before sending, and whenever a delivery is in doubt, it looks for the task in the page first.
- It never reports a result Arena did not write. A task Arena does not answer is closed as "No reply from Arena" and Gemini decides what to do next.
- It never overwrites text you left in Arena's message box, and never guesses between several Arena tabs.

### After an interruption

All state is on disk in the companion, and the relay keeps none in the page. If the browser, the extension or the companion restarts, or the computer sleeps, the work resumes where it was:

- A running session keeps running after the companion restarts.
- A report that Arena finished in the meantime is picked up from the Arena conversation as soon as a tab shows it, in whichever tab that is. Gemini reviews it and sends the next task.
- A task that was being typed when the browser closed is looked for in the page. If it is there, it is treated as sent; if it is not, it is sent again.

If the conversation a task was sent in is not open in any tab, AgentLink says so and continues by itself when you reopen it.

### If a report cannot be read

These are for recovery only and are never needed in normal use. On a task that is waiting for Arena:

- **Take the reply as it is now** hands Gemini what Arena has written so far.
- **Paste the reply by hand…** lets you supply the report yourself.

## Configuration

Settings can be given as environment variables or in a `.env` file in this folder (copy `.env.example`). `.env` is git-ignored.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | none | Used only if no key was saved on the settings page |
| `GEMINI_MODEL` | `gemini-4-hydrogen` | Used only if no model was chosen on the settings page |
| `AGENTLINK_PORT` | `47821` | Port for the companion, on `127.0.0.1` |
| `AGENTLINK_HOME` | `~/.agentlink` | Projects, settings, pairing token and the saved key |
| `AGENTLINK_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

The companion's settings page also has the limits of a session: the number of tasks one session may send to Arena (default 100), the number of tool rounds per Gemini turn, and how much of a long Arena report is given to Gemini. **Settings → Arena → Page adapter settings** in the extension has the quiet time (default 12 seconds) and the longest silence tolerated while Arena shows that it is working (default 20 minutes).

The data directory is created with owner-only permissions. A key saved on the settings page is kept in `credentials.json` there, readable by your user account only.

## If Arena's page changes

The adapter finds Arena's message box, send button and replies by their role on the page, not by fixed class names. If **Test Arena connection** starts failing after an Arena update, open **Settings → Arena → Page adapter settings** and give CSS selectors for the parts it can no longer find. No rebuild is needed.

## Development

```bash
npm run typecheck   # companion, extension and tests
npm test            # unit and end-to-end tests
npm run build       # dist/ (extension) and dist-companion/
npm run lint:ext    # Mozilla's add-on linter on the built extension
npm run check       # all of the above
npm run package     # zipped extension in web-ext-artifacts/
```

The tests run the real companion over HTTP against a stand-in for Gemini's API, the real Arena adapter against a stand-in Arena page, and the real bundled UI in a DOM. They need no API key and no network.

```
src/shared/       types and messages used by both sides
src/companion/    credentials, Gemini client, project memory, coordinator, HTTP API, settings page
src/extension/    background relay, Arena content adapter, workspace UI
src/styles/       design tokens and base styles shared by the UI and the settings page
tests/            companion and extension suites, with their stand-ins
```

## Known limits

- The Arena adapter has been tested against a stand-in page, not against the live Arena site. Run **Test Arena connection** on first use and adjust the page adapter settings if a check fails.
- The relay works in one Arena conversation at a time, and one task is open at a time.
- Firefox must be running with the extension loaded for tasks to move. The companion notices when the relay has been silent for 45 seconds and says so in the workspace.
- A project saved by version 1.0.0, which waited for your approval, is converted when the companion starts: a task that was proposed or approved is queued for Arena, a task Arena already has is followed to its report, and a rejected task is recorded as cancelled. A session that you had paused yourself stays paused until you select **Resume**.
- Calls to the real Gemini API have not been exercised by the test suite; **Save and test** on the settings page is the live check.
- The extension is loaded as a temporary add-on and has to be loaded again after Firefox restarts, until it is signed.
- Arena is the only worker. There is no ChatGPT adapter.
