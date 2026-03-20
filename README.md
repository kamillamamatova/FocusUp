# FocusUp

A lightweight, embeddable focus timer for the browser and Notion.
Count up toward a daily goal, log sessions, and keep your streak alive.

---

## Features

- **Count-up timer** toward a configurable daily goal (default 2 hours)
- **Elapsed / Remaining / Overtime** displays update every second
- **Finish Day** — logs your total minutes, updates streaks, clears sessions for tomorrow
- **Daily streaks** — current and best consecutive days where you met your goal
- **History** — last 30 days in a scrollable table
- **Export / Import** — back up and restore all data as JSON
- **Notion sync** (optional) — "Finish Day" can write a row to a Notion database via a client-side integration token (personal use only)
- **No backend, no build step** — single static HTML file, all data in browser localStorage

---

## Hosting (required to embed in Notion)

Notion's `/embed` block only accepts **public HTTPS URLs**.
A local `file://` path will not work as an embed.

### GitHub Pages

1. Push the repo to GitHub.
2. Go to **Settings → Pages → Source** and select the branch and folder containing `index.html`.
3. Your URL will be `https://<username>.github.io/<repo>/` (adjust path if `index.html` is in a subfolder).

### Netlify

1. Go to [netlify.com](https://netlify.com).
2. Drag the folder containing `index.html` onto the Netlify deploy dropzone, or connect your GitHub repo.
3. Netlify assigns a URL like `https://your-site.netlify.app`.

### Vercel

1. Install the CLI: `npm i -g vercel`
2. Run `vercel` from the folder containing `index.html` and follow the prompts.
3. Vercel assigns a URL like `https://your-project.vercel.app`.

> **Framing note:** Notion embeds require the host to allow iframes.
> GitHub Pages and Netlify allow framing by default.
> If the embed shows a blank frame, your host may be sending an
> `X-Frame-Options: DENY` or a restrictive `Content-Security-Policy: frame-ancestors` header.

---

## Embedding in Notion

1. Host the app at a public HTTPS URL (see above).
2. In a Notion page, type `/embed` and press Enter.
3. Paste your hosted URL into the embed dialog and click **Embed link**.
4. Resize the embed block — 600 px height is a good starting point.

> Data is stored in the **browser's localStorage inside the Notion client**, not in Notion itself.
> Each browser or device has independent storage.

---

## Local use (no hosting needed)

```bash
git clone https://github.com/yourusername/focusup.git
cd focusup/FocusUp
open index.html        # macOS
# or double-click index.html in your file manager (Windows / Linux)
```

No install or build step required.

---

## Usage

| Control | What it does |
|---|---|
| **Start / Pause** | Begin or pause a focus session |
| **Reset** | Clear today's sessions (history is preserved) |
| **Finish Day** | Log today's total, update streaks, clear sessions for tomorrow |
| **Goal (mins)** | Set your daily focus target |
| **Export** | Copy all app data to the textarea as JSON |
| **Import** | Paste exported JSON and restore it |

---

## Data & Storage

- All data lives in `localStorage` under the key `focusTimer.v1`.
- Data is per-device and per-browser — switching browsers starts fresh.
- Use **Data → Export** to copy your data as JSON, and **Import** to restore it on another device or after clearing localStorage.

---

## Notion Sync (optional)

Finish Day can optionally write a row into a Notion database.

1. Open the **Notion Sync** panel at the bottom of the app.
2. Set mode to **Notion (client-side, personal use)**.
3. Paste your integration token (`secret_...`) from [notion.so/my-integrations](https://notion.so/my-integrations).
4. Paste your database ID (32-character ID from the database URL).
5. In Notion, share the database with your integration.
6. Click **Save Settings**.

Your database must have these property names with exact spelling and types:

| Property | Type |
|---|---|
| `Date` | date |
| `Minutes` | number |
| `Goal` | number |
| `Met` | checkbox |

> **Security:** your token is stored in plain text in this browser's localStorage.
> Only configure this on a personal, private device.
> Local data is always saved first — a failed sync never loses your data.

---

## License

Created and maintained by **Kamilla Mamatova**.
Feel free to star the repo and share!
