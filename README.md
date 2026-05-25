# MailBlast v4 — Bulk Email Platform

A self-hosted, single-admin bulk email platform built on Node.js + SQLite, powered by the **Resend** API. Designed for personalised registration confirmations, automated reminder sequences, and custom one-off blasts — all from a clean dark-themed dashboard.

---

## What's New in v4

All 12 upgrade notes have been implemented. See the full list below under **[Upgrade Notes](#upgrade-notes)**.

---

## Quick Start

### 1. Prerequisites

- **Node.js** ≥ 20
- A **Resend** account with at least one verified domain (https://resend.com)
- A **Railway** account (recommended) or any Node.js host with persistent storage

### 2. Clone & Install

```bash
git clone <your-repo> mailblast
cd mailblast
npm install
```

### 3. Configure Environment Variables

Copy the example and fill in your values:

```bash
cp .env.example .env
```

Required variables:

| Variable | Description |
|---|---|
| `RESEND_API_KEY` | Your Resend API key (`re_…`) |
| `SENDER_EMAIL` | Fallback sender if no senders are in the DB |
| `ADMIN_EMAIL` | Your admin login email |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of your password (see below) |
| `SESSION_SECRET` | Random 32+ char string for session signing |
| `APP_BASE_URL` | Your deployed app URL — used for unsubscribe links |

Optional:

| Variable | Description |
|---|---|
| `LOGO_URL` | Public URL of your company logo for email headers |
| `DATA_DIR` | SQLite DB path (default: `./data`) |
| `NODE_ENV` | Set to `production` on Railway |

#### Generating a password hash

```bash
node -e "const b=require('bcryptjs'); b.hash('YOUR_PASSWORD', 12).then(console.log)"
```

#### Generating a session secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Run

```bash
npm start
```

Open http://localhost:3000 in your browser.

---

## Deploying to Railway

1. Create a new Railway project → **Deploy from GitHub repo**
2. Add a **Volume** (for SQLite persistence) and mount it at `/data`
3. Set `DATA_DIR=/data` in environment variables
4. Set all required environment variables in the Railway dashboard
5. Railway auto-detects `nixpacks.toml` and runs `npm install` + `node server.js`

---

## Architecture

```
mailblast/
├── server.js              # Express server — all routes, email templates, cron jobs
├── package.json           # Dependencies
├── nixpacks.toml          # Railway build config
├── .env.example           # Environment variable template
└── public/
    ├── index.html         # Login page
    └── dashboard.html     # Admin dashboard (SPA)
```

### Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Web framework | Express 5 |
| Database | SQLite via `better-sqlite3` |
| Email API | Resend (`resend` npm package) |
| Scheduling | `node-cron` |
| Auth | `bcryptjs` + `express-session` |
| Rate limiting | `express-rate-limit` |
| HTML sanitization | `sanitize-html` |
| Rich text editor | Quill.js (CDN) |

### Database Schema

```
companies           — saved company profiles (name, phone, replyTo, loginUrl, etc.)
senders             — email sender pool (prefix@domain, total_sent, last_used)
reminders           — auto-reminder members (stage 0–3, batch_name, do_not_send)
reminder_logs       — audit log of all reminder sends (pruned after 5 days)
campaign_history    — bulk campaign results (sent, failed, duration, members JSON)
custom_mail_history — custom mail sends log
unsubscribers       — global unsubscribe list
```

---

## Upgrade Notes (v3 → v4)

### Note 7 — Dynamic Subject Variables
Reminder subject lines now support template variables:
- `{FirstName}` — member's first name
- `{ProjectName}` — project/company name (from batch config)
- `{DeadlineDate}` — formatted deadline date
- `{CompanyName}`, `{MemberName}`, `{Email}`, `{LoginUrl}`

### Note 8 — Sender Overhaul
- **Bulk add**: Sender modal now accepts up to 20 prefixes (one per line). Domain is **locked to `redalertsol.com`** and cannot be changed.
- **Success toast**: After bulk add, shows `X sender mails added successfully`.
- **Count badge**: Sender count moved to a colored badge in the Sender Emails tab header. Removed from sidebar nav.

### Note 9 — Dark Dropdown Fix
Added `color-scheme: dark` and explicit `background`/`color` on `<select>` elements and their `<option>` children. Dropdown options now correctly render dark on all major browsers.

### Note 10 — Updated "Need Help?" Email Block
The blue help section in registration emails has been redesigned with:
- Darker blue background (`#1a3fa8`) with white text
- Helpline hours: Mon–Sat 10:00 AM – 6:00 PM IST
- **Missed call warning** (red-tinted box): _"If your call is not answered, please send a missed call — we will call you back."_
- Reply-to email instructions in the same block

### Note 11 — Scaling Features
Four independent improvements:

1. **Auto-Pruning**: A cron job runs daily at 2:00 AM IST and deletes `reminder_logs` entries older than 5 days. Pruning also runs at every admin login.

2. **Admin Login Toast**: If logs were pruned at login, the dashboard shows a persistent info toast with the count and an **"I Understood"** button that reloads the page.

3. **Campaign Pause / Resume**: While a campaign is sending, two new buttons appear — **Pause** and **Resume**. Clicking Pause calls `POST /api/campaign/:id/pause` on the server. The send loop polls the campaign state and holds between emails. Resume calls `POST /api/campaign/:id/resume`.

4. **Unsubscribe**:
   - Every email (campaign + reminder) now includes an **Unsubscribe** link in the footer.
   - The link uses a base64url-encoded token of the email address.
   - Visiting `/unsubscribe?token=xxx` marks the email in the `unsubscribers` table and sets `do_not_send=1` on any active reminders. Future campaigns skip unsubscribed emails.
   - A clean confirmation/error page is returned (no login required).

5. **Placeholder Chips** (Custom Mail Editor): Clickable chips below the Quill editor insert template variables at the cursor: `{Name}`, `{Email}`, `{Phone}`, `{Company}`, `{LoginUrl}`, `{DeadlineDate}`, `{UnsubscribeLink}`.

### Note 12 — Batch Management
Full batch support from campaign to reminders:

- **SQLite schema**: `reminders` table gains `batch_name TEXT` and `project_name TEXT` columns (migrated safely with `ALTER TABLE … IF NOT EXISTS` checks).
- **Confirm Campaign modal**: New optional **Batch Name** field + **"Add these members to Reminders after sending"** toggle. If toggled on, shows Company, Deadline, and Project Name fields. After the campaign completes, members are bulk-imported to Reminders with the batch name attached.
- **Reminder accordion UI**: The Reminders tab now groups members by Batch Name using a collapsible accordion. Each batch shows:
  - Batch name header
  - `X/Y Completed` progress count + progress bar
  - **Mark All ✓** and **Delete All** batch actions
  - Expandable member table with per-row Stage badges, deadline, and status

---

## Cron Schedule (IST)

| Time | Action |
|---|---|
| 09:00 IST | Run reminder batch (Stages 1, 2, 3) |
| 21:00 IST | Run reminder batch (Stages 1, 2, 3) |
| 02:00 IST | Prune reminder logs older than 5 days |

> ⚠️ **Do not change the 09:00 and 21:00 cron timings.** These are production-critical.

---

## Reminder Logic

Each member in the Reminders tab progresses through stages:

| Stage | When triggered | Subject |
|---|---|---|
| 0 | On import / after campaign | (enrolled, no email sent yet) |
| 1 | Next cron run | `Reminder: Complete your registration with {ProjectName}` |
| 2 | Next cron run after stage 1 | `2nd Reminder: Action required — {ProjectName}` |
| 3 | Next cron run after stage 2 | `Final Notice: Deadline approaching — {ProjectName}` |

Members are skipped if:
- `is_completed = 1`
- `do_not_send = 1` (unsubscribed)
- Their email is in the `unsubscribers` table
- `deadline` is set and has already passed

---

## Sender Round-Robin

> **⚠️ Do NOT modify `getNextSender()`, `nextSender` or `bumpSender` prepared statements.**

The round-robin selects the sender with the oldest `last_used` timestamp (or `total_sent = 0` first), then increments their `total_sent` counter. This ensures even distribution across all senders and is the core of the system's deliverability strategy.

---

## Security Notes

- All session cookies are `httpOnly: true` + `sameSite: lax`; `secure: true` is set in production.
- Rate limiting is applied to `POST /api/login` (10 attempts per 15 minutes).
- Custom mail body is sanitized with `sanitize-html` before sending.
- `SESSION_SECRET` is required — the server will **refuse to start** without it.

---

## Environment Variables Reference

```env
# Required
RESEND_API_KEY=re_...
SENDER_EMAIL=hello@redalertsol.com
ADMIN_EMAIL=admin@yourcompany.com
ADMIN_PASSWORD_HASH=$2a$12$...
SESSION_SECRET=64charRandomHexString

# Recommended
APP_BASE_URL=https://your-app.up.railway.app

# Optional
LOGO_URL=https://cdn.yourcompany.com/logo.png
DATA_DIR=/data
NODE_ENV=production
```

---

## Changelog

### v4.0.0
- Notes 7–12 fully implemented (see above)
- `batch_name`, `do_not_send`, `project_name` added to reminders schema with safe migrations
- Unsubscribers table and `/unsubscribe` route
- Campaign pause/resume via server-side Map
- Bulk sender endpoint (`POST /api/senders/bulk`) locked to `redalertsol.com`
- Reminder accordion UI grouped by batch
- Auto log pruning at login and nightly cron
- Quill placeholder chips in Custom Mail editor

### v3.0.0
- Original release: SQLite migration from JSON, SSE streaming, multi-sender, Quill editor, dark UI
