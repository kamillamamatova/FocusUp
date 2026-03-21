# FocusUp

A focus timer you can use in the browser or embed directly in Notion.
Count up toward a daily goal, finish your day with one click, and keep your streak going.

---

## Using FocusUp

### What it does

- **Timer** - counts up from zero toward your daily goal (default: 2 hours)
- **Elapsed / Remaining / Overtime** - three live displays so you always know where you stand
- **Finish Day** - records your total focus time, updates your streak, and resets for tomorrow
- **Streaks** - tracks how many days in a row you've hit your goal
- **History** - a scrollable table of your last 30 days
- **Backup** - export your data as a file and import it on another device

### Controls

| Button | What it does |
|---|---|
| **Start** | Begin a focus session |
| **Pause** | Pause — your time is saved |
| **Continue** | Resume where you left off |
| **Reset** | Clear today's sessions (history stays) |
| **Finish Day** | Lock in today's total, update your streak, and start fresh tomorrow |
| **Goal** | Change your daily target in minutes |

### Your data

FocusUp stores your data in two places: a local browser cache (fast, always available) and the backend server (canonical, cross-device).

**Guest mode (no login required)**
On your first visit, FocusUp assigns you a private guest identity stored in this browser. Your history and goal are saved to the backend under that identity immediately — no account creation needed. The data is tied to this browser (the guest ID lives in localStorage), so clearing browser storage would lose the link. Use **Data Export / Import** to take a manual backup.

**Notion-connected mode**
When you connect Notion, FocusUp links your guest identity to your Notion workspace. Any history you collected as a guest is automatically merged into your Notion account. From that point on, your data is accessible from any browser or device where you connect the same Notion workspace — including the Notion embed.

- Use **Data Export / Import** at any time to take a manual backup or move data to a fresh browser

### How Notion sync works

When you connect Notion, FocusUp saves a record to your Notion database every time you click **Finish Day**. A Notion database is just a table — think of it as a spreadsheet inside Notion where your focus history is stored.

Here's what happens:

1. You click **Finish Day** — your data is saved locally first, so nothing is ever lost
2. FocusUp sends the day's summary to Notion in the background
3. A new row appears in your chosen database with the date, minutes focused, your goal, and whether you met it
4. If you click Finish Day again for the same day (e.g. to correct a mistake), the existing row is updated rather than duplicated

Notion sync is completely optional. The timer works just as well without it.

### Connecting Notion

1. Open the **Notion Sync** section at the bottom of the app
2. Click **Connect Notion** — you'll be taken to Notion to approve the connection
3. During sign-in, Notion will ask which pages FocusUp can access — select at least one database (a table in your workspace)
4. After approving, you'll be returned to FocusUp — your account is now connected
5. Optionally, click **Show my Notion databases** and choose which database your logs should go to

Your database needs four columns with these exact names (any order is fine):

| Column name | Type |
|---|---|
| Date | Date |
| Minutes | Number |
| Goal | Number |
| Met | Checkbox |

FocusUp fills these in automatically every time you finish a day — you never need to edit them by hand. If you don't have a database yet, create one in Notion by searching for "database" and adding a new full-page database.

### Embedding in Notion

1. Host the app at a public HTTPS URL (see the developer section below for options)
2. In a Notion page, type `/embed` and press Enter
3. Paste your hosted URL and click **Embed link**
4. Resize the block, 600 px tall is a good starting point

> **Tip:** The Notion embed is a first-class path. Connect Notion once and your history, goal, and streaks are shared between the embed and any browser tab — no separate setup needed.

---

## Developer setup

### Project structure

```
FocusUp/
├── index.html          frontend — static HTML, no build step required
├── backend/            Node.js + Express API server
│   ├── src/
│   │   ├── index.js            server entry point
│   │   ├── db.js               SQLite persistence layer
│   │   ├── middleware/
│   │   │   └── auth.js         session auth guard
│   │   └── routes/
│   │       ├── auth.js         Notion OAuth flow
│   │       ├── databases.js    list + save target database
│   │       └── sync.js         write daily logs to Notion
│   ├── .env.example    required environment variables
│   └── package.json
└── package.json        root-level convenience scripts
```

### Running locally

**Frontend only** (no Notion sync):

```bash
open index.html   # macOS
# or double-click index.html in your file manager
```

**Frontend + backend** (with Notion sync):

```bash
# 1. Install backend dependencies
npm run install:all

# 2. Create your environment file
cp backend/.env.example backend/.env

# 3. Fill in your values (see Environment variables below)
#    Open backend/.env and edit it

# 4. Start the backend
npm run backend:dev

# 5. Open the frontend
#    Use a local server (e.g. VS Code Live Server on port 5500)
#    or: python3 -m http.server 5500
open http://localhost:5500
```

Health check: `curl http://localhost:3001/api/health`

### Setting up Notion OAuth

1. Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
2. Click **New integration** → set the type to **Public**
3. Set the **Authorization URL** to your frontend URL (e.g. `http://localhost:5500` for local dev)
4. Set the **Redirect URI** to `http://localhost:3001/api/auth/notion/callback`
5. Save — copy the **Client ID** and **Client Secret** into `backend/.env`

### Environment variables

See `backend/.env.example` for the full reference. Required:

| Variable | Description |
|---|---|
| `SESSION_SECRET` | Random 32-byte hex string — generate with the command in `.env.example` |
| `NOTION_CLIENT_ID` | From your Notion integration settings |
| `NOTION_CLIENT_SECRET` | From your Notion integration settings |
| `NOTION_REDIRECT_URI` | Must match exactly what's registered in Notion |
| `FRONTEND_URL` | Origin your frontend is served from (used for CORS and OAuth redirects) |
| `NODE_ENV` | Set to `production` on your hosting platform |

### Hosting options

| Platform | Frontend | Backend |
|---|---|---|
| GitHub Pages + Railway | `index.html` → GitHub Pages | `backend/` → Railway (Node) |
| Netlify + Render | `index.html` → Netlify drop | `backend/` → Render web service |
| Vercel | `index.html` → Vercel static | `backend/` → Vercel serverless or separate |

When deploying:
- Set `NODE_ENV=production` on the backend platform
- Set all five required env vars in the platform's environment settings
- Update `NOTION_REDIRECT_URI` and `FRONTEND_URL` to your production URLs
- Update the Redirect URI in your Notion integration settings to match

### Embedding in Notion — important note

When FocusUp is embedded in a Notion page as an iframe, browsers apply cross-site cookie rules. This means the session cookie used for Notion sync may not be sent from inside the iframe on some browsers.

The **Connect Notion** flow opens a new browser tab (not an iframe) so it works correctly. But status checks and sync calls made from inside the embed may be blocked depending on the browser.

If sync stops working after embedding, open FocusUp directly in its own tab, everything will work there. See `backend/.env.example` for a full explanation and mitigation options.

---

## License

Created and maintained by **Kamilla Mamatova**.
Feel free to star the repo and share!
