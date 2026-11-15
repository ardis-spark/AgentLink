# AgentLink

AgentLink is an engineering workspace for Firefox in which **Gemini coordinates** a project and **Arena Agent Mode carries out the work**.

You describe an objective. Gemini plans it, proposes one task at a time, and waits. Nothing is sent to Arena until you approve. AgentLink types the approved task into your Arena tab, waits for the reply, and hands it back to Gemini, which checks it against the task's acceptance criteria before proposing the next step.

```
You ──► Gemini (plans, proposes a task) ──► You (approve / edit / reject)
                    ▲                                   │
                    │                                   ▼
          Gemini reviews the reply ◄── Arena Agent Mode does the work
```

## How it is put together

| Part | Where it runs | What it does |
| --- | --- | --- |
| **Companion** (`src/companion`) | A small Node.js program on your computer, loopback only | Holds the Gemini API key, calls Gemini, keeps project memory on disk, enforces the task lifecycle |
| **Extension** (`src/extension`) | Firefox | The workspace UI, and the adapter that types into and reads from your Arena tab |

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
4. **Choose your Arena tab.** Open **Settings → Arena**, select the tab, and run **Test Arena connection**. The test only reads the page.
5. **Create a project** and tell the coordinator what you want.

AgentLink also opens as a sidebar: **View → Sidebar → AgentLink**.

## Working with it

- **Approve and send to Arena** sends the task exactly as shown under *Exact text that will be sent to Arena*. You can edit a task first, or reject it with a reason for Gemini.
- **Copy and send by hand** records the task as sent and copies it, for when you would rather paste it yourself.
- If AgentLink cannot read Arena's reply, use **Capture reply now** once Arena has finished, or **Paste reply…**.
- If delivery cannot be confirmed, AgentLink says so and does not send again by itself. Check the Arena tab, then either capture the reply or choose **It was not sent**.
- **Pause**, **Resume** and **Stop** control the session. After a restart of the companion, a session that was running comes back paused, with its history intact.
- Gemini must quote Arena's reply to mark a task complete. A verdict without a matching quote is refused.

## Configuration

Settings can be given as environment variables or in a `.env` file in this folder (copy `.env.example`). `.env` is git-ignored.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | none | Used only if no key was saved on the settings page |
| `GEMINI_MODEL` | `gemini-4-hydrogen` | Used only if no model was chosen on the settings page |
| `AGENTLINK_PORT` | `47821` | Port for the companion, on `127.0.0.1` |
| `AGENTLINK_HOME` | `~/.agentlink` | Projects, settings, pairing token and the saved key |
| `AGENTLINK_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

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
src/extension/    background dispatcher, Arena content adapter, workspace UI
src/styles/       design tokens and base styles shared by the UI and the settings page
tests/            companion and extension suites, with their stand-ins
```

## Known limits

- The Arena adapter has been tested against a stand-in page, not against the live Arena site. Run **Test Arena connection** on first use and adjust the page adapter settings if a check fails.
- Calls to the real Gemini API have not been exercised by the test suite; **Save and test** on the settings page is the live check.
- The extension is loaded as a temporary add-on and has to be loaded again after Firefox restarts, until it is signed.
- Arena is the only worker. There is no ChatGPT adapter.
