require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const bcrypt       = require('bcryptjs');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const { Resend }   = require('resend');
const Database     = require('better-sqlite3');
const cron         = require('node-cron');
const sanitizeHtml = require('sanitize-html');

const app    = express();
const PORT   = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ── Strict SESSION_SECRET check ───────────────────────────────────────────────
if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is not set.');
  console.error('Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// ── Data directory (Railway Volume or local ./data) ───────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const LOGOS_DIR = path.join(DATA_DIR, 'logos');

// Auto-create backup directory
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

console.log('[MailBlast] DATA_DIR:', DATA_DIR);
console.log('[MailBlast] BACKUP_DIR:', BACKUP_DIR);


if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });

// ── SQLite setup ──────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'mailblast.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    phone     TEXT DEFAULT '',
    reply_to  TEXT DEFAULT '',
    login_url TEXT DEFAULT '',
    help_email TEXT DEFAULT '',
    note      TEXT DEFAULT '',
    address   TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS senders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    prefix     TEXT NOT NULL,
    domain     TEXT NOT NULL,
    total_sent INTEGER DEFAULT 0,
    last_used  TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(prefix, domain)
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    member_email TEXT NOT NULL,
    member_name  TEXT DEFAULT '',
    company_id   TEXT,
    stage        INTEGER DEFAULT 0,
    last_sent_at TEXT,
    is_completed INTEGER DEFAULT 0,
    deadline     TEXT,
    login_url    TEXT DEFAULT '',
    batch_name   TEXT DEFAULT '',
    do_not_send  INTEGER DEFAULT 0,
    project_name TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reminder_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    member_email  TEXT NOT NULL,
    subject       TEXT DEFAULT '',
    status        TEXT NOT NULL,
    error_message TEXT DEFAULT '',
    stage         INTEGER DEFAULT 0,
    sender_used   TEXT DEFAULT '',
    sent_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS custom_mail_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    subject         TEXT NOT NULL,
    sender_used     TEXT DEFAULT '',
    recipient_count INTEGER DEFAULT 0,
    body_preview    TEXT DEFAULT '',
    sent_at         TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaign_history (
    id           TEXT PRIMARY KEY,
    company_name TEXT DEFAULT '',
    total        INTEGER DEFAULT 0,
    sent         INTEGER DEFAULT 0,
    failed       INTEGER DEFAULT 0,
    duration     INTEGER DEFAULT 0,
    sender_used  TEXT DEFAULT '',
    timestamp    TEXT DEFAULT (datetime('now')),
    members_json TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS unsubscribers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_templates (
    id         INTEGER PRIMARY KEY,
    name       TEXT UNIQUE NOT NULL,
    subject    TEXT DEFAULT '',
    opening    TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Safe schema migrations (add columns if missing) ──────────────────────────
(function runMigrations() {
  const cols = db.prepare("PRAGMA table_info(reminders)").all().map(c => c.name);
  if (!cols.includes('batch_name'))    db.exec("ALTER TABLE reminders ADD COLUMN batch_name TEXT DEFAULT ''");
  if (!cols.includes('do_not_send'))   db.exec("ALTER TABLE reminders ADD COLUMN do_not_send INTEGER DEFAULT 0");
  if (!cols.includes('project_name'))  db.exec("ALTER TABLE reminders ADD COLUMN project_name TEXT DEFAULT ''");
  if (!cols.includes('next_stage'))    db.exec("ALTER TABLE reminders ADD COLUMN next_stage INTEGER DEFAULT 1");
  if (!cols.includes('next_send_at'))  db.exec("ALTER TABLE reminders ADD COLUMN next_send_at TEXT DEFAULT NULL");

  const cmCols = db.prepare("PRAGMA table_info(custom_mail_history)").all().map(c => c.name);
  if (!cmCols.includes('body_full'))  db.exec("ALTER TABLE custom_mail_history ADD COLUMN body_full TEXT DEFAULT ''");

  const coCols = db.prepare("PRAGMA table_info(companies)").all().map(c => c.name);
  if (!coCols.includes('logo_path'))  db.exec("ALTER TABLE companies ADD COLUMN logo_path TEXT DEFAULT ''");
})();

// ── Migrate legacy JSON → SQLite (one-time, if files exist) ──────────────────
(function migrateLegacy() {
  const companiesFile = path.join(DATA_DIR, 'companies.json');
  const historyFile   = path.join(DATA_DIR, 'history.json');

  if (fs.existsSync(companiesFile)) {
    try {
      const arr = JSON.parse(fs.readFileSync(companiesFile, 'utf8'));
      const ins = db.prepare(`INSERT OR IGNORE INTO companies
        (id, name, phone, reply_to, login_url, help_email, note, address)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const tx = db.transaction(() => {
        arr.forEach(c => ins.run(c.id || Date.now().toString(), c.name || '',
          c.phone || '', c.replyTo || '', c.loginUrl || '',
          c.helpEmail || '', c.note || '', c.address || ''));
      });
      tx();
      fs.renameSync(companiesFile, companiesFile + '.migrated');
      console.log(`Migrated ${arr.length} companies from JSON → SQLite`);
    } catch (e) { console.warn('Legacy companies migration failed:', e.message); }
  }

  if (fs.existsSync(historyFile)) {
    try {
      const arr = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      const ins = db.prepare(`INSERT OR IGNORE INTO campaign_history
        (id, company_name, total, sent, failed, duration, timestamp, members_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const tx = db.transaction(() => {
        arr.forEach(h => ins.run(h.id || Date.now().toString(), h.companyName || '',
          h.total || 0, h.sent || 0, h.failed || 0, h.duration || 0,
          h.timestamp || new Date().toISOString(),
          JSON.stringify(h.members || [])));
      });
      tx();
      fs.renameSync(historyFile, historyFile + '.migrated');
      console.log(`Migrated ${arr.length} history entries from JSON → SQLite`);
    } catch (e) { console.warn('Legacy history migration failed:', e.message); }
  }
})();

// ── Prepared statements ───────────────────────────────────────────────────────
const stmts = {
  // Companies
  allCompanies:  db.prepare('SELECT * FROM companies ORDER BY name'),
  getCompany:    db.prepare('SELECT * FROM companies WHERE id = ?'),
  insCompany:    db.prepare(`INSERT INTO companies (id,name,phone,reply_to,login_url,help_email,note,address)
                             VALUES (?,?,?,?,?,?,?,?)`),
  updCompany:    db.prepare(`UPDATE companies SET name=?,phone=?,reply_to=?,login_url=?,help_email=?,note=?,address=? WHERE id=?`),
  delCompany:    db.prepare('DELETE FROM companies WHERE id = ?'),

  // Senders
  allSenders:    db.prepare('SELECT * FROM senders ORDER BY created_at'),
  getSender:     db.prepare('SELECT * FROM senders WHERE id = ?'),
  insSender:     db.prepare('INSERT INTO senders (prefix,domain) VALUES (?,?)'),
  updSender:     db.prepare('UPDATE senders SET prefix=?,domain=? WHERE id=?'),
  delSender:     db.prepare('DELETE FROM senders WHERE id = ?'),
  delAllSenders: db.prepare('DELETE FROM senders'),
  // NOTE: Do NOT modify nextSender or bumpSender — round-robin must stay intact
  nextSender:    db.prepare('SELECT * FROM senders ORDER BY COALESCE(last_used,\'0\') ASC, total_sent ASC LIMIT 1'),
  bumpSender:    db.prepare('UPDATE senders SET total_sent=total_sent+1, last_used=datetime(\'now\') WHERE id=?'),
  countSenders:  db.prepare('SELECT COUNT(*) as cnt FROM senders'),

  // Reminders
  allReminders:  db.prepare(`SELECT r.*, c.name as company_name
                             FROM reminders r LEFT JOIN companies c ON r.company_id=c.id
                             ORDER BY r.batch_name ASC, r.created_at DESC`),
  getReminderByEmail: db.prepare('SELECT * FROM reminders WHERE member_email = ? LIMIT 1'),
  insReminder:   db.prepare(`INSERT INTO reminders
                             (member_email,member_name,company_id,stage,is_completed,deadline,login_url,batch_name,project_name,next_stage,next_send_at)
                             VALUES (?,?,?,0,0,?,?,?,?,?,?)`),
  updReminderStage: db.prepare('UPDATE reminders SET stage=?,last_sent_at=datetime(\'now\'),next_stage=?,next_send_at=? WHERE id=?'),
  setReminderComplete: db.prepare('UPDATE reminders SET is_completed=1,next_send_at=NULL WHERE id=?'),
  setReminderDoNotSend: db.prepare('UPDATE reminders SET do_not_send=1,next_send_at=NULL WHERE member_email=?'),
  delReminder:   db.prepare('DELETE FROM reminders WHERE id=?'),
  pendingReminders: db.prepare(`SELECT r.*, c.name as company_name, c.phone as company_phone,
                                c.help_email as company_help_email, c.note as company_note
                                FROM reminders r
                                LEFT JOIN companies c ON r.company_id=c.id
                                WHERE r.is_completed=0
                                AND r.do_not_send=0
                                AND r.next_send_at IS NOT NULL
                                AND datetime(r.next_send_at) <= datetime('now')
                                AND (
                                  r.deadline IS NULL OR r.deadline = ''
                                  OR datetime('now') < datetime(r.deadline || 'T00:00:00', '-5 hours', '-30 minutes')
                                )
                                AND r.member_email NOT IN (SELECT email FROM unsubscribers)
                                ORDER BY r.next_send_at ASC`),


  // Reminder logs
  insReminderLog:  db.prepare(`INSERT INTO reminder_logs (member_email,subject,status,error_message,stage,sender_used)
                               VALUES (?,?,?,?,?,?)`),
  allReminderLogs: db.prepare('SELECT * FROM reminder_logs ORDER BY sent_at DESC LIMIT 200'),
  pruneReminderLogs: db.prepare("DELETE FROM reminder_logs WHERE sent_at < datetime('now','-5 days')"),

  // Custom mail history
  insCustomHistory: db.prepare(`INSERT INTO custom_mail_history (subject,sender_used,recipient_count,body_preview,body_full)
                                VALUES (?,?,?,?,?)`),
  allCustomHistory: db.prepare('SELECT * FROM custom_mail_history ORDER BY sent_at DESC LIMIT 100'),

  // Campaign history
  insCampaign:   db.prepare(`INSERT INTO campaign_history (id,company_name,total,sent,failed,duration,sender_used,timestamp,members_json)
                             VALUES (?,?,?,?,?,?,?,?,?)`),
  allCampaigns:  db.prepare('SELECT * FROM campaign_history ORDER BY timestamp DESC LIMIT 100'),
  delCampaigns:  db.prepare('DELETE FROM campaign_history'),

  // Unsubscribers
  insUnsubscriber:  db.prepare('INSERT OR IGNORE INTO unsubscribers (email) VALUES (?)'),
  isUnsubscribed:   db.prepare('SELECT 1 FROM unsubscribers WHERE email=? LIMIT 1'),

  // Email templates
  allTemplates:     db.prepare('SELECT * FROM email_templates ORDER BY id'),
  getTemplate:      db.prepare('SELECT * FROM email_templates WHERE name=?'),
  upsertTemplate:   db.prepare(`INSERT INTO email_templates (id, name, subject, opening, updated_at)
                                VALUES (?, ?, ?, ?, datetime('now'))
                                ON CONFLICT(name) DO UPDATE SET subject=excluded.subject, opening=excluded.opening, updated_at=datetime('now')`),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(minMs, maxMs) { return Math.floor(Math.random() * (maxMs - minMs)) + minMs; }

// NOTE: getNextSender and round-robin logic must NOT be modified
function getNextSender() {
  const s = stmts.nextSender.get();
  if (!s) return null;
  stmts.bumpSender.run(s.id);
  return `${s.prefix}@${s.domain}`;
}

function sanitizeBody(html) {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'h1','h2','h3','img','span','div','table','thead','tbody','tr','th','td',
      'ul','ol','li','blockquote','pre','code','hr','br','strong','em','u','s',
      'a','p','figure','figcaption'
    ]),
    allowedAttributes: {
      '*':    ['style','class','id'],
      'a':    ['href','target','rel'],
      'img':  ['src','alt','width','height'],
      'table':['border','cellpadding','cellspacing','width'],
      'td':   ['colspan','rowspan','width'],
      'th':   ['colspan','rowspan','width']
    },
    allowedSchemes: ['http','https','mailto','data'],
  });
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDeadlineDate(dateStr) {
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m-1, d).toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
  } catch { return dateStr; }
}

// ── Note 7: Variable substitution for reminder subjects/bodies ────────────────
function parseTemplateVars(text, vars) {
  return text
    .replace(/\{FirstName\}/gi,    vars.firstName    || vars.memberName || 'Member')
    .replace(/\{MemberName\}/gi,   vars.memberName   || 'Member')
    .replace(/\{ProjectName\}/gi,  vars.projectName  || '')
    .replace(/\{DeadlineDate\}/gi, vars.deadlineDate || '')
    .replace(/\{CompanyName\}/gi,  vars.companyName  || '')
    .replace(/\{Email\}/gi,        vars.email        || '')
    .replace(/\{LoginUrl\}/gi,     vars.loginUrl     || '');
}

// ── Unsubscribe token helpers ─────────────────────────────────────────────────
function emailToToken(email) {
  return Buffer.from(email.toLowerCase().trim()).toString('base64url');
}
function tokenToEmail(token) {
  try { return Buffer.from(token, 'base64url').toString('utf8'); } catch { return null; }
}
function getBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  if (req) {
    const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    const host  = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
    return `${proto}://${host}`;
  }
  return `http://localhost:${PORT}`;
}
function buildUnsubscribeLink(email, req) {
  return `${getBaseUrl(req)}/unsubscribe?token=${emailToToken(email)}`;
}

// ── Schedule-driven reminder helpers ─────────────────────────────────────────
//
// BUSINESS RULES:
//   submissionDate = the date stored in deadline field (e.g. "09-05-2026")
//   This means auto-submit happens at 09-05-2026 00:00:00 IST.
//   Real deadline = 08-05-2026 23:59:59 IST (night before).
//   User gets 3 working days:
//     Day1 = submissionDate - 3 days
//     Day2 = submissionDate - 2 days
//     Day3 = submissionDate - 1 day   ← last working day, must submit by 23:59
//
//   Fixed stage schedule (all times IST):
//     Stage 1 → Day1 21:00
//     Stage 2 → Day2 09:00
//     Stage 3 → Day2 21:00
//     Stage 4 → Day3 09:00
//     Stage 5 → Day3 21:00  ← final, no sends after this
//
//   stored deadline field = submissionDate string "YYYY-MM-DD"

// Returns IST date-only midnight for a YYYY-MM-DD string, as a JS Date in local time.
function parseISTDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  // We work fully in IST by using toLocaleString trick for "now", and plain Date
  // construction (which uses local time) is fine here since we only compare dates.
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

// Returns current IST time as a plain Date object (local fields = IST fields).
function nowIST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

// Build the full 5-stage schedule for a given submissionDate string.
// Returns array of { stage, sendAt } where sendAt is an ISO UTC string.
function buildStageSchedule(submissionDateStr) {
  if (!submissionDateStr) return [];
  const [y, m, d] = submissionDateStr.split('-').map(Number);

  // Helper: given a date offset from submission (negative = before) and hour/min in IST,
  // return a UTC ISO string.
  function istSlot(dayOffset, hour, min) {
    // Construct in IST by using a fixed offset: IST = UTC+5:30
    // We use Date.UTC with the IST date/time then subtract 5h30m
    const utcMs = Date.UTC(y, m - 1, d + dayOffset, hour, min, 0, 0) - (5 * 60 + 30) * 60 * 1000;
    return new Date(utcMs).toISOString();
  }

  return [
    { stage: 1, sendAt: istSlot(-3, 21, 0) },  // Day1 21:00 IST  (submissionDate - 3 days, 9PM)
    { stage: 2, sendAt: istSlot(-2, 9,  0) },  // Day2 09:00 IST  (submissionDate - 2 days, 9AM)
    { stage: 3, sendAt: istSlot(-2, 21, 0) },  // Day2 21:00 IST  (submissionDate - 2 days, 9PM)
    { stage: 4, sendAt: istSlot(-1, 9,  0) },  // Day3 09:00 IST  (submissionDate - 1 day,  9AM)
    { stage: 5, sendAt: istSlot(-1, 21, 0) },  // Day3 21:00 IST  (submissionDate - 1 day,  9PM) ← LAST
  ];
}

// calcNextSchedule — used when ADDING a new user.
// Strict: only picks slots that are strictly in the future (now < slotTime).
// If a slot's scheduled time has already passed, skip it — the cron ran without this user.
function calcNextSchedule(submissionDateStr) {
  if (!submissionDateStr) return null;
  const schedule = buildStageSchedule(submissionDateStr);
  const nowUtc = new Date();
  for (const slot of schedule) {
    const slotTime = new Date(slot.sendAt);
    if (nowUtc < slotTime) {
      return { nextStage: slot.stage, nextSendAt: slot.sendAt };
    }
  }
  return null; // All slots are in the past — expired
}


// Given a submissionDate and a stage that was just sent, find the NEXT stage after it.
// Returns { nextStage, nextSendAt } or null if stage 5 was just sent (all done).
// After sending a stage, advance to the next one.
// If the next slot's scheduled time is already in the past (downtime scenario),
// we keep its original sendAt — which means next_send_at <= now is immediately true,
// so the NEXT cron run will pick it up. We never send two stages in the same batch run;
// each cron run sends at most one stage per member, preserving order.
function calcNextScheduleAfterStage(submissionDateStr, justSentStage) {
  if (!submissionDateStr || justSentStage >= 5) return null;
  const schedule = buildStageSchedule(submissionDateStr);
  const remaining = schedule.filter(s => s.stage > justSentStage);
  if (!remaining.length) return null;
  // Always use the original scheduled sendAt — even if it's in the past.
  // This guarantees next_send_at <= now on the next cron run, so it fires immediately.
  return { nextStage: remaining[0].stage, nextSendAt: remaining[0].sendAt };
}

// Legacy alias used in a few places — now only used to check expired status.
// Returns -1 if expired (past all stage slots), 0 otherwise.
function calcStartingStage(submissionDateStr) {
  if (!submissionDateStr) return 0;
  const result = calcNextSchedule(submissionDateStr);
  return result ? 0 : -1;
}

// ── Seed default email templates if missing ───────────────────────────────────
(function seedTemplates() {
  const defaults = [
    { id: 1, name: 'registration', subject: 'You have been registered successfully with {CompanyName}',
      opening: 'You have been successfully registered with {CompanyName}. We\'re glad to have you on board!' },
    { id: 2, name: 'stage1', subject: '🔔 Reminder: You have been registered with {CompanyName}',
      opening: 'This is a reminder that you have been registered with {CompanyName}. Please log in and complete your pending project work at your earliest convenience.' },
    { id: 3, name: 'stage2', subject: '⏰ 2nd Reminder: Please complete your pending work — {CompanyName}',
      opening: 'This is a friendly reminder that you have pending project work with {CompanyName}. Please complete your submission at your earliest convenience.' },
    { id: 4, name: 'stage3', subject: '📢 3rd Reminder: Your submission is still pending — {CompanyName}',
      opening: 'We noticed your project is still pending. This is your 2nd reminder — please complete your work on time and with required accuracy.' },
    { id: 5, name: 'stage4', subject: '⚠️ 4th Reminder: Urgent — Action required — {CompanyName}',
      opening: 'Your submission is still pending with {CompanyName}. This is your 3rd reminder — please log in and complete your work immediately.' },
    { id: 6, name: 'stage5', subject: '🚨 Final Reminder: Deadline approaching — {CompanyName}',
      opening: 'We have not received your submission yet. This is an urgent 4th reminder — please complete your project without any further delay.' },
  ];
  const tx = db.transaction(() => {
    for (const t of defaults) {
      const existing = db.prepare('SELECT id FROM email_templates WHERE name=?').get(t.name);
      if (!existing) {
        db.prepare(`INSERT INTO email_templates (id, name, subject, opening) VALUES (?, ?, ?, ?)`).run(t.id, t.name, t.subject, t.opening);
      }
    }
  });
  tx();
})();
const campaignPaused = new Map();

// ── Express setup ─────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' }
});

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { maxAge: 24*60*60*1000, httpOnly: true, secure: isProd, sameSite: 'lax' }
}));

app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
    const adminHash  = process.env.ADMIN_PASSWORD_HASH || '';
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (email.toLowerCase().trim() !== adminEmail.toLowerCase().trim())
      return res.status(401).json({ error: 'Invalid credentials' });
    if (!adminHash) return res.status(500).json({ error: 'Server not configured: ADMIN_PASSWORD_HASH missing.' });
    const match = await bcrypt.compare(password, adminHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    // Note 11: Run log pruning on login and report count
    let prunedCount = 0;
    try {
      const info = stmts.pruneReminderLogs.run();
      prunedCount = info.changes || 0;
    } catch (e) { console.warn('[Prune] Error:', e.message); }

    req.session.authenticated = true;
    req.session.email = email;
    req.session.loginTime = Date.now();
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session error' });
      res.json({ ok: true, email, prunedCount });
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ ok: true }); });
});

app.get('/api/me', (req, res) => {
  if (req.session?.authenticated) return res.json({ authenticated: true, email: req.session.email });
  res.json({ authenticated: false });
});

// ── Resend test ───────────────────────────────────────────────────────────────
app.get('/api/test-resend', requireAuth, async (req, res) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.json({ ok: false, message: 'RESEND_API_KEY not set.' });
  try {
    const r = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (r.status === 200) {
      const data = await r.json();
      return res.json({ ok: true, message: `Connected ✓  ${data.data?.length ?? 0} domain(s) verified` });
    }
    return res.json({ ok: false, message: `Resend returned status ${r.status}` });
  } catch (e) { return res.json({ ok: false, message: 'Connection failed: ' + e.message }); }
});

// ── Companies API ─────────────────────────────────────────────────────────────
app.get('/api/companies', requireAuth, (req, res) => {
  const rows = stmts.allCompanies.all();
  res.json(rows.map(r => ({
    id: r.id, name: r.name, phone: r.phone, replyTo: r.reply_to,
    loginUrl: r.login_url, helpEmail: r.help_email, note: r.note, address: r.address,
    hasLogo: !!(r.logo_path)
  })));
});

app.post('/api/companies', requireAuth, (req, res) => {
  const { name, phone='', replyTo='', loginUrl='', helpEmail='', note='', address='' } = req.body;
  if (!name) return res.status(400).json({ error: 'Company name required' });
  const id = crypto.randomUUID();
  stmts.insCompany.run(id, name, phone, replyTo, loginUrl, helpEmail, note, address);
  res.json({ ok: true, company: { id, name, phone, replyTo, loginUrl, helpEmail, note, address } });
});

app.put('/api/companies/:id', requireAuth, (req, res) => {
  const { name, phone='', replyTo='', loginUrl='', helpEmail='', note='', address='' } = req.body;
  if (!name) return res.status(400).json({ error: 'Company name required' });
  const info = stmts.updCompany.run(name, phone, replyTo, loginUrl, helpEmail, note, address, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.delete('/api/companies/:id', requireAuth, (req, res) => {
  const info = stmts.delCompany.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Company logo API ──────────────────────────────────────────────────────────
app.get('/api/companies/:id/logo', (req, res) => {
  const co = stmts.getCompany.get(req.params.id);
  if (!co || !co.logo_path) return res.status(404).send('No logo');
  const logoPath = path.join(LOGOS_DIR, co.logo_path);
  if (!fs.existsSync(logoPath)) return res.status(404).send('Logo file not found');
  const ext = path.extname(co.logo_path).toLowerCase();
  const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  res.set('Content-Type', mimeMap[ext] || 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(logoPath);
});

app.post('/api/companies/:id/logo', requireAuth, (req, res) => {
  const { data, mimeType } = req.body;
  if (!data || !mimeType) return res.status(400).json({ error: 'data and mimeType required' });
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(mimeType)) return res.status(400).json({ error: 'Only PNG, JPG, WEBP allowed' });
  const co = stmts.getCompany.get(req.params.id);
  if (!co) return res.status(404).json({ error: 'Company not found' });
  const buf = Buffer.from(data, 'base64');
  if (buf.length > 512 * 1024) return res.status(400).json({ error: 'Logo too large (max 500 KB)' });
  const ext = mimeType === 'image/webp' ? '.webp' : mimeType === 'image/jpeg' ? '.jpg' : '.png';
  const filename = `${req.params.id}${ext}`;
  if (co.logo_path && co.logo_path !== filename) {
    const oldPath = path.join(LOGOS_DIR, co.logo_path);
    if (fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch {}
  }
  fs.writeFileSync(path.join(LOGOS_DIR, filename), buf);
  db.prepare('UPDATE companies SET logo_path=? WHERE id=?').run(filename, req.params.id);
  res.json({ ok: true, filename });
});

app.delete('/api/companies/:id/logo', requireAuth, (req, res) => {
  const co = stmts.getCompany.get(req.params.id);
  if (!co) return res.status(404).json({ error: 'Company not found' });
  if (co.logo_path) {
    const logoPath = path.join(LOGOS_DIR, co.logo_path);
    if (fs.existsSync(logoPath)) try { fs.unlinkSync(logoPath); } catch {}
    db.prepare("UPDATE companies SET logo_path='' WHERE id=?").run(req.params.id);
  }
  res.json({ ok: true });
});

// ── Senders API ───────────────────────────────────────────────────────────────
app.get('/api/senders', requireAuth, (req, res) => {
  res.json(stmts.allSenders.all());
});

app.post('/api/senders', requireAuth, (req, res) => {
  const { prefix, domain } = req.body;
  if (!prefix || !domain) return res.status(400).json({ error: 'Prefix and domain required' });
  try {
    const info = stmts.insSender.run(prefix.trim().toLowerCase(), domain.trim().toLowerCase());
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Sender already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Note 8: Bulk sender add endpoint (domain locked to redalertsol.com)
app.post('/api/senders/bulk', requireAuth, (req, res) => {
  const { prefixes } = req.body;
  if (!Array.isArray(prefixes) || !prefixes.length)
    return res.status(400).json({ error: 'prefixes array required' });

  const domain = 'redalertsol.com';
  const limited = prefixes.slice(0, 500);
  let added = 0, skipped = 0;

  const tx = db.transaction(() => {
    for (const raw of limited) {
      const prefix = (raw || '').trim().toLowerCase();
      if (!prefix) { skipped++; continue; }
      try {
        stmts.insSender.run(prefix, domain);
        added++;
      } catch (e) {
        if (e.message.includes('UNIQUE')) skipped++;
        else throw e;
      }
    }
  });
  tx();
  res.json({ ok: true, added, skipped });
});

app.put('/api/senders/:id', requireAuth, (req, res) => {
  const { prefix, domain } = req.body;
  if (!prefix || !domain) return res.status(400).json({ error: 'Prefix and domain required' });
  try {
    const info = stmts.updSender.run(prefix.trim().toLowerCase(), domain.trim().toLowerCase(), req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Sender already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Note 3: Delete all senders — must be registered BEFORE /:id to avoid route conflict
app.delete('/api/senders/all', requireAuth, (req, res) => {
  stmts.delAllSenders.run();
  res.json({ ok: true });
});

app.delete('/api/senders/:id', requireAuth, (req, res) => {
  const info = stmts.delSender.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Per-sender test send
app.post('/api/senders/:id/test', requireAuth, async (req, res) => {
  const { toEmail } = req.body;
  if (!toEmail) return res.json({ ok: false, message: 'Recipient email required' });
  const sender = stmts.getSender.get(req.params.id);
  if (!sender) return res.status(404).json({ error: 'Sender not found' });
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.json({ ok: false, message: 'RESEND_API_KEY not set' });
  const fromEmail = `${sender.prefix}@${sender.domain}`;
  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: [toEmail],
      reply_to: sender.reply_to || undefined,
      subject: `✅ Test Email — ${fromEmail}`,
      html: `<div style="font-family:sans-serif;padding:24px;">
        <h2 style="color:#1a3fa8;">MailBlast Sender Test</h2>
        <p>This test email was sent from <strong>${escHtml(fromEmail)}</strong>.</p>
        <p style="color:#666;">If you received this, the sender is working correctly.</p>
      </div>`
    });
    if (error) return res.json({ ok: false, message: error.message });
    stmts.bumpSender.run(sender.id);
    res.json({ ok: true, message: `Test sent from ${fromEmail} to ${toEmail}` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ── Campaign History API ──────────────────────────────────────────────────────
app.get('/api/history', requireAuth, (req, res) => {
  const rows = stmts.allCampaigns.all();
  res.json(rows.map(r => ({
    id: r.id, companyName: r.company_name, total: r.total, sent: r.sent,
    failed: r.failed, duration: r.duration, senderUsed: r.sender_used,
    timestamp: r.timestamp, members: JSON.parse(r.members_json || '[]')
  })));
});

app.delete('/api/history', requireAuth, (req, res) => {
  stmts.delCampaigns.run();
  res.json({ ok: true });
});

// ── Note 11: Pause / Resume campaign ─────────────────────────────────────────
app.post('/api/campaign/:id/pause', requireAuth, (req, res) => {
  campaignPaused.set(req.params.id, true);
  res.json({ ok: true, status: 'paused' });
});

app.post('/api/campaign/:id/resume', requireAuth, (req, res) => {
  campaignPaused.set(req.params.id, false);
  res.json({ ok: true, status: 'running' });
});

// ── Note 11: Unsubscribe route ────────────────────────────────────────────────
app.get('/unsubscribe', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send(unsubscribePage('Invalid Link', 'No unsubscribe token provided.', false));
  }
  const email = tokenToEmail(token);
  if (!email || !email.includes('@')) {
    return res.status(400).send(unsubscribePage('Invalid Link', 'This unsubscribe link is invalid or expired.', false));
  }
  try {
    stmts.insUnsubscriber.run(email);
    stmts.setReminderDoNotSend.run(email);
    return res.send(unsubscribePage(
      'Successfully Unsubscribed',
      `The email address <strong>${escHtml(email)}</strong> has been unsubscribed.<br>You will no longer receive automated emails from this platform.`,
      true
    ));
  } catch (e) {
    console.error('[Unsubscribe] Error:', e.message);
    return res.status(500).send(unsubscribePage('Error', 'Something went wrong. Please try again later.', false));
  }
});

function unsubscribePage(title, message, success) {
  const color = success ? '#34d399' : '#f87171';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} — MailBlast</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{background:#080810;color:#eeeeff;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;}
.card{background:#0e0e1a;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px 36px;max-width:480px;width:100%;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.6);}
.icon{width:60px;height:60px;border-radius:50%;background:${success?'rgba(52,211,153,0.12)':'rgba(248,113,113,0.12)'};display:flex;align-items:center;justify-content:center;margin:0 auto 24px;border:1px solid ${color}33;}
h1{font-size:22px;font-weight:800;color:${color};margin-bottom:12px;}
p{font-size:14px;color:#8888a8;line-height:1.7;}
.back{display:inline-block;margin-top:28px;padding:10px 24px;background:rgba(79,102,247,0.12);color:#818cf8;border:1px solid rgba(79,102,247,0.2);border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;}
</style></head><body>
<div class="card">
  <div class="icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${success?'<polyline points="20 6 9 17 4 12"/>':'<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'}</svg></div>
  <h1>${escHtml(title)}</h1>
  <p>${message}</p>
</div></body></html>`;
}

// ── Send emails (SSE stream) ──────────────────────────────────────────────────
app.post('/api/send', requireAuth, async (req, res) => {
  const {
    members, senderName, replyTo, fromEmail,
    deadline, deadlineTime, company,
    campaignId
  } = req.body;

  if (!members?.length) return res.status(400).json({ error: 'No members provided' });

  const apiKey  = process.env.RESEND_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not set.' });

  if (!company?.id) return res.status(400).json({ error: 'No company selected. Please select a company before sending.' });
  const coRow = stmts.getCompany.get(company.id);
  if (!coRow) return res.status(400).json({ error: 'Selected company not found. Please select a valid company.' });

  let logoUrl = process.env.LOGO_URL || null;
  if (!logoUrl && coRow?.logo_path) logoUrl = `${getBaseUrl(req)}/api/companies/${company.id}/logo`;

  const companyHelpPhone  = coRow.phone      || '';
  const companyHelpEmail  = coRow.help_email || '';
  const companyLoginUrl   = coRow.login_url  || '';
  const companyNote       = coRow.note       || '';

  let fromAddr = fromEmail;
  if (!fromAddr) fromAddr = getNextSender();
  if (!fromAddr && process.env.SENDER_EMAIL) fromAddr = process.env.SENDER_EMAIL;
  const senderSource = fromAddr || null;
  if (!fromAddr) return res.status(400).json({ error: 'No sender configured. Add senders in the Senders tab.' });

  const resend      = new Resend(apiKey);
  const co          = company || { name: senderName || 'Our Company', phone: helpPhone || '', address: '' };
  const initials    = (co.name || 'C').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const displayFrom = senderName ? `${senderName} <${fromAddr}>` : fromAddr;

  const cid = campaignId || Date.now().toString();
  campaignPaused.set(cid, false);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let sent = 0, failed = 0;
  const results = [];
  const startTime = Date.now();
  const controller = new AbortController();

  req.on('close', () => { controller.abort(); campaignPaused.delete(cid); });
  emit({ type: 'start', total: members.length, sender: fromAddr, campaignId: cid });

  try {
  for (let i = 0; i < members.length; i++) {
    if (controller.signal.aborted) break;

    // Note 11: Pause/Resume — hold in loop while paused
    while (campaignPaused.get(cid) === true && !controller.signal.aborted) {
      emit({ type: 'paused', index: i, sent, failed });
      await sleep(1500);
    }
    if (controller.signal.aborted) break;

    const member  = members[i];

    // Note 11: Skip unsubscribed
    if (stmts.isUnsubscribed.get(member.email)) {
      emit({ type: 'progress', index: i+1, total: members.length, sent, failed,
             email: member.email, name: member.name, status: 'skipped', error: 'Unsubscribed' });
      results.push({ name: member.name, email: member.email, status: 'failed', error: 'Unsubscribed' });
      failed++;
      continue;
    }

    const regTpl = stmts.getTemplate.get('registration');
    const rawSubject = regTpl?.subject || `You have been registered successfully with {CompanyName}`;
    const subject = parseTemplateVars(rawSubject, {
      firstName: (member.name || 'Member').split(' ')[0],
      memberName: member.name || 'Member',
      companyName: co.name || '',
      email: member.email || '',
      loginUrl: companyLoginUrl || '',
      deadlineDate: deadline ? formatDeadlineDate(deadline) : '',
      projectName: ''
    });
    const unsubLink = buildUnsubscribeLink(member.email, req);

    try {
      const sendPromise = resend.emails.send({
        from: displayFrom,
        to: [member.email],
        subject,
        html: buildPosterEmail({
          member, co, initials, deadline, deadlineTime,
          loginUrl: companyLoginUrl,
          helpPhone: companyHelpPhone,
          helpEmail: companyHelpEmail,
          messageNote: companyNote,
          logoUrl, unsubscribeLink: unsubLink
        }),
        ...(replyTo ? { reply_to: replyTo } : {})
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Send timeout after 30s')), 30000)
      );
      const { error } = await Promise.race([sendPromise, timeoutPromise]);
      if (error) throw new Error(error.message || JSON.stringify(error));
      sent++;
      results.push({ name: member.name, email: member.email, status: 'sent' });
      emit({ type: 'progress', index: i+1, total: members.length, sent, failed, email: member.email, name: member.name, status: 'ok' });
    } catch (e) {
      failed++;
      results.push({ name: member.name, email: member.email, status: 'failed', error: e.message });
      emit({ type: 'progress', index: i+1, total: members.length, sent, failed, email: member.email, name: member.name, status: 'error', error: e.message });
    }

    if (!controller.signal.aborted && i < members.length - 1) {
      await sleep(jitter(1800, 2500));
    }
  }
  } finally {
    campaignPaused.delete(cid);
  }
  const duration = Math.round((Date.now() - startTime) / 1000);

  if (!controller.signal.aborted) {
    const id = Date.now().toString();
    stmts.insCampaign.run(id, co.name, members.length, sent, failed, duration,
      senderSource || '', new Date().toISOString(), JSON.stringify(results));
  }

  emit({ type: 'done', sent, failed, duration, sender: fromAddr });
  res.end();
});
// ── Test send ─────────────────────────────────────────────────────────────────
app.post('/api/test-send', requireAuth, async (req, res) => {
  const { toEmail, senderName, fromEmail, template } = req.body;
  const apiKey  = process.env.RESEND_API_KEY;
  let logoUrl = process.env.LOGO_URL || null;

  let from = fromEmail;
  if (!from) from = getNextSender();
  if (!from) from = process.env.SENDER_EMAIL;
  if (!apiKey || !from) return res.json({ ok: false, message: 'Missing RESEND_API_KEY or no senders configured.' });
  if (!toEmail) return res.json({ ok: false, message: 'No recipient email provided' });

  const co = { name: senderName || '[Company Name]', phone: '+91 98765 43210', address: '' };
  const testMember = { name: 'Test User', email: toEmail };
  const testDeadline = new Date(Date.now() + 7*86400000).toISOString().split('T')[0];
  const testLoginUrl = 'https://example.com/login';
  const unsubLink = buildUnsubscribeLink(toEmail, req);
  const initials = 'MB';

  let subject, html;

  if (template === 'registration') {
    const regTpl = stmts.getTemplate.get('registration');
    subject = regTpl?.subject ? regTpl.subject.replace('{CompanyName}', co.name) : `You have been registered successfully with ${co.name}`;
    html = buildPosterEmail({
      member: testMember, co, initials,
      deadline: testDeadline, deadlineTime: '23:59',
      loginUrl: testLoginUrl, helpPhone: '+91 98765 43210',
      helpEmail: from, messageNote: regTpl?.opening || 'This is a test email to preview your registration confirmation template.',
      logoUrl, unsubscribeLink: unsubLink
    });
} else if (template === 'reminder1') {
    subject = buildReminderSubject(1, co.name);
    html = buildReminderEmail({
      member: testMember, co, stage: 1,
      deadline: testDeadline, loginUrl: testLoginUrl,
      helpPhone: '+91 98765 43210', helpEmail: from,
      noteText: 'This is a sample note from company settings.',
      logoUrl, projectName: '', unsubscribeLink: unsubLink
    });
  } else if (template === 'reminder2') {
    subject = buildReminderSubject(2, co.name);
    html = buildReminderEmail({
      member: testMember, co, stage: 2,
      deadline: testDeadline, loginUrl: testLoginUrl,
      helpPhone: '+91 98765 43210', helpEmail: from,
      noteText: 'This is a sample note from company settings.',
      logoUrl, projectName: '', unsubscribeLink: unsubLink
    });
  } else if (template === 'reminder3') {
    subject = buildReminderSubject(3, co.name);
    html = buildReminderEmail({
      member: testMember, co, stage: 3,
      deadline: testDeadline, loginUrl: testLoginUrl,
      helpPhone: '+91 98765 43210', helpEmail: from, logoUrl, projectName: '',
      unsubscribeLink: unsubLink
    });
  } else if (template === 'reminder4') {
    subject = buildReminderSubject(4, co.name);
    html = buildReminderEmail({
      member: testMember, co, stage: 4,
      deadline: testDeadline, loginUrl: testLoginUrl,
      helpPhone: '+91 98765 43210', helpEmail: from, logoUrl, projectName: '',
      unsubscribeLink: unsubLink
    });
  } else if (template === 'reminder5') {
    subject = buildReminderSubject(5, co.name);
    html = buildReminderEmail({
      member: testMember, co, stage: 5,
      deadline: testDeadline, loginUrl: testLoginUrl,
      helpPhone: '+91 98765 43210', helpEmail: from, logoUrl, projectName: '',
      unsubscribeLink: unsubLink
    });
  } else {
    subject = `✅ Test Email from MailBlast`;
    html = buildPosterEmail({
      member: testMember, co, initials,
      deadline: testDeadline, deadlineTime: '23:59',
      loginUrl: testLoginUrl, helpPhone: '+91 98765 43210',
      helpEmail: from, messageNote: 'This is a basic test email.',
      logoUrl, unsubscribeLink: unsubLink
    });
  }

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: `${co.name} <${from}>`,
      to: [toEmail],
      reply_to: from,
      subject,
      html
    });
    if (error) return res.json({ ok: false, message: error.message });
    res.json({ ok: true, message: `Test email sent from ${from} to ${toEmail}` });
  } catch (e) { res.json({ ok: false, message: e.message }); }
});
// ── Reminders API ─────────────────────────────────────────────────────────────
app.get('/api/reminders', requireAuth, (req, res) => {
  res.json(stmts.allReminders.all());
});

// Note 12: reminders endpoint now accepts batch_name and project_name
app.post('/api/reminders', requireAuth, (req, res) => {
  const {
    memberEmail, memberName='', companyId='', deadline='',
    loginUrl='', batchName='', projectName=''
  } = req.body;
  if (!memberEmail) return res.status(400).json({ error: 'Member email required' });
  const existing = stmts.getReminderByEmail.get(memberEmail);
  if (existing) return res.status(409).json({ error: 'Reminder already exists for this email' });
  const sched = deadline ? calcNextSchedule(deadline) : null;
  if (deadline && !sched) return res.status(400).json({ error: 'Submission date has passed — all reminder slots are expired.' });
  const info = stmts.insReminder.run(
    memberEmail, memberName, companyId || null,
    deadline || null, loginUrl, batchName, projectName,
    sched ? sched.nextStage : null,
    sched ? sched.nextSendAt : null
  );
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/reminders/:id/complete', requireAuth, (req, res) => {
  stmts.setReminderComplete.run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/reminders/:id', requireAuth, (req, res) => {
  const info = stmts.delReminder.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// Note 12: bulk import now accepts batch_name and project_name
app.post('/api/reminders/bulk', requireAuth, (req, res) => {
  const {
    members, companyId='', deadline='', loginUrl='',
    batchName='', projectName=''
  } = req.body;
  if (!members?.length) return res.status(400).json({ error: 'No members provided' });

  // Batch-check which emails already exist to avoid N+1 queries
  const incomingEmails = members.map(m => m.email).filter(Boolean);
  const placeholders = incomingEmails.map(() => '?').join(',');
  const existingSet = new Set(
    incomingEmails.length
      ? db.prepare(`SELECT member_email FROM reminders WHERE member_email IN (${placeholders})`).all(...incomingEmails).map(r => r.member_email)
      : []
  );

  let added = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const m of members) {
      if (!m.email) { skipped++; continue; }
      if (existingSet.has(m.email)) { skipped++; continue; }
      const sched = deadline ? calcNextSchedule(deadline) : null;
      if (deadline && !sched) { skipped++; continue; } // all slots expired
      stmts.insReminder.run(
        m.email, m.name || '', companyId || null,
        deadline || null, loginUrl, batchName, projectName,
        sched ? sched.nextStage : null,
        sched ? sched.nextSendAt : null
      );
      added++;
    }
  });
  tx();
  res.json({ ok: true, added, skipped });
});

// Reminder logs
app.get('/api/reminder-logs', requireAuth, (req, res) => {
  res.json(stmts.allReminderLogs.all());
});

// -- Email Templates API
app.get('/api/templates', requireAuth, (req, res) => {
  res.json(stmts.allTemplates.all());
});

app.put('/api/templates/:name', requireAuth, (req, res) => {
  const { subject, opening } = req.body;
  const name = req.params.name;
  const valid = ['registration','stage1','stage2','stage3','stage4','stage5'];
  if (!valid.includes(name)) return res.status(400).json({ error: 'Invalid template name' });
  const idMap = { registration:1, stage1:2, stage2:3, stage3:4, stage4:5, stage5:6 };
  stmts.upsertTemplate.run(idMap[name], name, subject || '', opening || '');
  res.json({ ok: true });
});

// -- Crosscheck Reminder Mail
app.post('/api/reminders/crosscheck', requireAuth, async (req, res) => {
  const { reminderIds } = req.body;
  if (!reminderIds?.length) return res.status(400).json({ error: 'No reminder IDs provided' });
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not set' });
  const results = [];
  for (const rid of reminderIds) {
    const reminder = db.prepare().get(rid);
    if (!reminder) { results.push({ id: rid, status: 'not_found' }); continue; }
    if (reminder.is_completed || reminder.do_not_send) { results.push({ id: rid, email: reminder.member_email, status: 'skipped' }); continue; }
    const nextStage = reminder.stage + 1;
    if (nextStage > 5) { results.push({ id: rid, email: reminder.member_email, status: 'already_complete' }); continue; }
    const senderEmail = getNextSender() || process.env.SENDER_EMAIL;
    if (!senderEmail) { results.push({ id: rid, email: reminder.member_email, status: 'no_sender' }); continue; }
    const co = { name: reminder.company_name || 'Our Company', phone: reminder.company_phone || '', address: '' };
    let logoUrl = process.env.LOGO_URL || null;
    if (!logoUrl && reminder.company_id) {
      const coRow = stmts.getCompany.get(reminder.company_id);
      if (coRow?.logo_path) logoUrl = APP_BASE_URL + '/api/companies/' + reminder.company_id + '/logo';
    }
    const subject = buildReminderSubject(nextStage, co.name);
    const unsubLink = APP_BASE_URL + '/unsubscribe?token=' + emailToToken(reminder.member_email);
    try {
      const resend = new Resend(apiKey);
      const replyToAddr = reminder.company_help_email || process.env.REPLY_TO_EMAIL || senderEmail;
      const sendPromise = resend.emails.send({
        from: co.name + ' <' + senderEmail + '>',
        to: [reminder.member_email],
        reply_to: replyToAddr,
        subject: '[CROSSCHECK] ' + subject,
        html: buildReminderEmail({
          member: { name: reminder.member_name || 'Member', email: reminder.member_email },
          co, stage: nextStage,
          deadline: reminder.deadline,
          loginUrl: reminder.login_url || '',
          helpPhone: reminder.company_phone || '',
          helpEmail: reminder.company_help_email || '',
          noteText: reminder.company_note || '',
          logoUrl,
          projectName: reminder.project_name || '',
          unsubscribeLink: unsubLink,
          openingOverride: stageOpening
        })
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Reminder send timeout after 30s')), 30000)
      );
      const { error } = await Promise.race([sendPromise, timeoutPromise]);
      if (error) throw new Error(error.message);
      results.push({ id: rid, email: reminder.member_email, stage: nextStage, subject, status: 'sent' });
    } catch (e) {
      results.push({ id: rid, email: reminder.member_email, stage: nextStage, status: 'error', error: e.message });
    }
  }
  res.json({ ok: true, results });
});

// Next cron run info
app.get('/api/reminders/next-run', requireAuth, (req, res) => {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h = ist.getHours(), m = ist.getMinutes();
  let next;
  if (h < 9 || (h === 9 && m === 0)) {
    next = new Date(ist); next.setHours(9,0,0,0);
  } else if (h < 21 || (h === 21 && m === 0)) {
    next = new Date(ist); next.setHours(21,0,0,0);
  } else {
    next = new Date(ist); next.setDate(next.getDate() + 1); next.setHours(9,0,0,0);
  }
  const diffMs = next - ist;
  const diffSec = Math.floor(diffMs / 1000);
  const hrs  = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  res.json({
    currentIst: ist.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
    nextRun: next.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }),
    countdownHours: hrs, countdownMins: mins, countdownSecs: secs,
    pending: stmts.pendingReminders.all().length
  });
});

// ── Custom Mail API ───────────────────────────────────────────────────────────
app.post('/api/custom-mail/send', requireAuth, async (req, res) => {
  const { subject, body, recipients, fromEmail, senderName, replyTo } = req.body;

  if (!subject) return res.status(400).json({ error: 'Subject required' });
  if (!body)    return res.status(400).json({ error: 'Email body required' });
  if (!recipients?.length) return res.status(400).json({ error: 'No recipients provided' });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not set.' });

  let from = fromEmail;
  if (!from) from = getNextSender();
  if (!from) from = process.env.SENDER_EMAIL;
  if (!from) return res.status(400).json({ error: 'No sender configured.' });

  const cleanHtml = sanitizeBody(body);
  const displayFrom = senderName ? `${senderName} <${from}>` : from;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let sent = 0, failed = 0;
  emit({ type: 'start', total: recipients.length, sender: from });

  for (let i = 0; i < recipients.length; i++) {
    if (controller.signal.aborted) break;
    const to = recipients[i].trim();
    if (!to) continue;

    // Skip unsubscribed
    if (stmts.isUnsubscribed.get(to)) {
      failed++;
      emit({ type: 'progress', index: i+1, total: recipients.length, sent, failed, email: to, status: 'error', error: 'Unsubscribed' });
      continue;
    }

    try {
      const resend = new Resend(apiKey);
      const sendPromise = resend.emails.send({
        from: displayFrom, to: [to], subject,
        html: cleanHtml,
        ...(replyTo ? { reply_to: replyTo } : {})
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Send timeout after 30s')), 30000)
      );
      const { error } = await Promise.race([sendPromise, timeoutPromise]);
      if (error) throw new Error(error.message);
      sent++;
      emit({ type: 'progress', index: i+1, total: recipients.length, sent, failed, email: to, status: 'ok' });
    } catch (e) {
      failed++;
      emit({ type: 'progress', index: i+1, total: recipients.length, sent, failed, email: to, status: 'error', error: e.message });
    }
    if (!controller.signal.aborted && i < recipients.length - 1) {
      await sleep(jitter(1500, 2500));
    }
  }

  if (!controller.signal.aborted) {
    const preview = cleanHtml.replace(/<[^>]+>/g, '').substring(0, 200);
    stmts.insCustomHistory.run(subject, from, sent, preview, cleanHtml);
  }

  emit({ type: 'done', sent, failed, sender: from });
  res.end();
});

app.get('/api/custom-mail/history', requireAuth, (req, res) => {
  res.json(stmts.allCustomHistory.all());
});

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// ── Note 11: Auto Reminder Cron — daily prune of logs older than 5 days ───────
cron.schedule('0 2 * * *', () => {
  try {
    const info = stmts.pruneReminderLogs.run();
    if (info.changes > 0) console.log(`[Prune] Deleted ${info.changes} reminder log(s) older than 5 days.`);
  } catch (e) { console.error('[Prune] Error:', e.message); }
}, { timezone: 'Asia/Kolkata' });

// ── Auto Reminder Cron (Asia/Kolkata — 09:00 and 21:00 IST) ──────────────────
// NOTE: Cron timing must NOT be changed
// Processing is now schedule-driven: pendingReminders filters by next_send_at <= now
async function runReminderBatch() {
  const pending = stmts.pendingReminders.all();
  if (!pending.length) {
    console.log('[Reminder] No pending reminders to process.');
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[Reminder] RESEND_API_KEY not set — skipping batch.');
    return;
  }

  console.log(`[Reminder] Processing ${pending.length} reminders...`);

  for (const reminder of pending) {
    const delay = jitter(3000, 12000);
    await sleep(delay);

    // Use next_stage from the schedule (set at insert / after each send)
    const stageToSend = reminder.next_stage;
    if (!stageToSend || stageToSend < 1 || stageToSend > 5) {
      console.warn(`[Reminder] Invalid next_stage (${stageToSend}) for ${reminder.member_email} — skipping`);
      continue;
    }

    // Hard guard: never send a reminder on or after the submission date (deadline field).
    // Submission happens at deadline 00:00:00 IST. No reminder is meaningful after that point.
    if (reminder.deadline) {
      const [dy, dm, dd] = reminder.deadline.split('-').map(Number);
      const submissionUtc = new Date(Date.UTC(dy, dm - 1, dd, 0, 0, 0) - (5 * 60 + 30) * 60 * 1000);
      if (new Date() >= submissionUtc) {
        console.log(`[Reminder] Skipping stage ${stageToSend} for ${reminder.member_email} — submission date ${reminder.deadline} has passed.`);
        stmts.setReminderComplete.run(reminder.id);
        continue;
      }
    }

    const senderEmail = getNextSender() || process.env.SENDER_EMAIL;
    if (!senderEmail) {
      console.warn(`[Reminder] No sender for ${reminder.member_email} — skipping`);
      continue;
    }

    const co = {
      name:    reminder.company_name || 'Our Company',
      phone:   reminder.company_phone || '',
      address: ''
    };
    let logoUrl = process.env.LOGO_URL || null;
    if (!logoUrl && reminder.company_id) {
      const coRow = stmts.getCompany.get(reminder.company_id);
      if (coRow?.logo_path) logoUrl = `${APP_BASE_URL}/api/companies/${reminder.company_id}/logo`;
    }

    const stageTplNames = ['', 'stage1', 'stage2', 'stage3', 'stage4', 'stage5'];
    const stageTpl = stmts.getTemplate.get(stageTplNames[stageToSend]);
    const subject = stageTpl?.subject
      ? parseTemplateVars(stageTpl.subject, {
          companyName:  co.name,
          memberName:   reminder.member_name || 'Member',
          firstName:    (reminder.member_name || 'Member').split(' ')[0],
          email:        reminder.member_email,
          deadlineDate: reminder.deadline || '',
          loginUrl:     reminder.login_url || '',
          projectName:  reminder.project_name || ''
        })
      : buildReminderSubject(stageToSend, co.name);
    const stageOpening = stageTpl?.opening || null;
    const unsubLink = `${APP_BASE_URL}/unsubscribe?token=${emailToToken(reminder.member_email)}`;

    try {
      const resend = new Resend(apiKey);
      const replyToAddr = reminder.company_help_email || process.env.REPLY_TO_EMAIL || senderEmail;
      const sendPromise = resend.emails.send({
        from: `${co.name} <${senderEmail}>`,
        to: [reminder.member_email],
        reply_to: replyToAddr,
        subject,
        html: buildReminderEmail({
          member: { name: reminder.member_name || 'Member', email: reminder.member_email },
          co, stage: stageToSend,
          deadline: reminder.deadline,
          loginUrl: reminder.login_url || '',
          helpPhone: reminder.company_phone || '',
          helpEmail: reminder.company_help_email || '',
          noteText: reminder.company_note || '',
          logoUrl,
          projectName: reminder.project_name || '',
          unsubscribeLink: unsubLink,
          openingOverride: stageOpening
        })
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Reminder send timeout after 30s')), 30000)
      );
      const { error } = await Promise.race([sendPromise, timeoutPromise]);
      if (error) throw new Error(error.message);

      // Advance to next scheduled slot
      // Use lenient cron version for advancing so downtime-recovered sends still schedule next slot
      const afterNext = calcNextScheduleAfterStage(reminder.deadline, stageToSend);
      stmts.updReminderStage.run(stageToSend, afterNext ? afterNext.nextStage : null, afterNext ? afterNext.nextSendAt : null, reminder.id);
      if (stageToSend === 5 || !afterNext) stmts.setReminderComplete.run(reminder.id);
      stmts.insReminderLog.run(reminder.member_email, subject, 'success', '', stageToSend, senderEmail);
      console.log(`[Reminder] Sent stage ${stageToSend} to ${reminder.member_email}`);
    } catch (e) {
      stmts.insReminderLog.run(reminder.member_email, subject, 'failed', e.message, stageToSend, senderEmail);
      console.error(`[Reminder] Failed for ${reminder.member_email}: ${e.message}`);
    }
  }
  console.log('[Reminder] Batch complete.');
}

// NOTE: 09:00 IST — do NOT change timing
cron.schedule('0 9 * * *', () => {
  console.log('[Cron] 09:00 IST reminder batch triggered');
  runReminderBatch().catch(e => console.error('[Cron] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// NOTE: 21:00 IST — do NOT change timing
cron.schedule('0 21 * * *', () => {
  console.log('[Cron] 21:00 IST reminder batch triggered');
  runReminderBatch().catch(e => console.error('[Cron] Error:', e.message));
}, { timezone: 'Asia/Kolkata' });

// ── Email templates ───────────────────────────────────────────────────────────

// Note 10: Updated buildPosterEmail — new "Need Help?" design
function buildPosterEmail({ member, co, initials, deadline, deadlineTime, loginUrl, helpPhone, helpEmail, messageNote, logoUrl, unsubscribeLink }) {
  const deadlineDisplay = deadline ? formatDeadlineDate(deadline) : null;
  const timeDisplay     = deadlineTime || '23:59';

  let deadlineWarning = 'Please complete your submission by the previous night';
  if (deadline) {
    const today = new Date();
    const [y, m, d] = deadline.split('-').map(Number);
    if (today.getFullYear() === y && today.getMonth()+1 === m && today.getDate() === d) {
      deadlineWarning = 'Please complete your submission by tonight';
    }
  }

  const logoBlock = logoUrl
    ? `<td style="padding-right:14px;"><img src="${escHtml(logoUrl)}" alt="${escHtml(co.name)}" width="48" height="48"
         style="width:48px;height:48px;border-radius:10px;object-fit:contain;display:block;border:1.5px solid rgba(255,255,255,0.25);"></td>`
    : `<td style="width:48px;height:48px;background:rgba(255,255,255,0.15);border-radius:10px;text-align:center;vertical-align:middle;border:1.5px solid rgba(255,255,255,0.25);">
         <span style="color:white;font-family:Arial,sans-serif;font-weight:900;font-size:15px;letter-spacing:1px;">${initials}</span></td>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Registration Confirmation</title></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:24px 8px;"><tr><td align="center">
<table cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);max-width:600px;width:100%;">
  <tr><td style="background:#1a3fa8;padding:22px 24px;">
    <table cellpadding="0" cellspacing="0" width="100%"><tr>
      ${logoBlock}
      <td style="padding-left:14px;">
        <div style="color:white;font-size:19px;font-weight:700;letter-spacing:-0.3px;">${escHtml(co.name)}</div>
        <div style="color:rgba(255,255,255,0.6);font-size:10px;margin-top:3px;letter-spacing:1.5px;text-transform:uppercase;">Registration Confirmation</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px 24px 0;">
    <p style="margin:0 0 16px;font-size:15px;color:#1a1a2e;font-weight:500;">Dear ${escHtml(member.name || 'Member')},</p>
    <div style="background:#dcfce7;color:#166534;padding:9px 18px;border-radius:6px;font-size:13px;font-weight:700;margin-bottom:18px;border:1px solid #bbf7d0;display:inline-block;">&#10003; Registered successfully</div>
    <p style="margin:0 0 20px;font-size:14px;color:#374151;line-height:1.75;">You have been successfully registered with <strong style="color:#1a3fa8;">${escHtml(co.name)}</strong>.<br>We're glad to have you on board!</p>
    ${messageNote ? `<div style="background:#f0f7ff;border-left:3px solid #2563eb;padding:13px 16px;border-radius:0 8px 8px 0;margin-bottom:20px;">
      <div style="font-size:12px;font-weight:700;color:#1e40af;margin-bottom:6px;letter-spacing:0.3px;">NOTE</div>
      <div style="font-size:13px;color:#374151;line-height:1.7;">${escHtml(messageNote).replace(/\n/g,'<br>')}</div></div>` : ''}
    ${loginUrl ? `<div style="background:#f8fafc;border-radius:8px;padding:16px 20px;margin-bottom:20px;border:1px solid #e5e7eb;">
      <div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#94a3b8;font-weight:700;margin-bottom:12px;">Your Login Credentials</div>
      <table cellpadding="0" cellspacing="0">
        <tr><td style="padding-bottom:9px;font-size:13px;color:#374151;">&#128279; Login: &nbsp;<a href="${loginUrl}" style="color:#2563eb;font-weight:600;text-decoration:none;">Click here to login</a></td></tr>
        <tr><td style="padding-bottom:9px;font-size:13px;color:#374151;">&#128231; Username: &nbsp;<strong>${escHtml(member.email)}</strong></td></tr>
        <tr><td style="font-size:13px;color:#374151;">&#128273; Password: &nbsp;<strong>Your Phone Number</strong></td></tr>
      </table></div>` : ''}
    ${deadlineDisplay ? `<div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
      <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#b45309;font-weight:700;margin-bottom:8px;">&#128197; Submission Deadline</div>
      <div style="font-size:28px;font-weight:900;color:#78350f;margin-bottom:8px;line-height:1.2;">&#127942; ${escHtml(deadlineDisplay)}</div>
<div style="font-size:12.5px;color:#92400e;margin-bottom:4px;font-weight:600;">&#9888;&#65039; ${deadlineWarning}</div>
<div style="font-size:11.5px;color:#b45309;">The deadline day is for verification, not submission.</div></div>` : ''}
    ${loginUrl ? `<div style="text-align:center;margin-bottom:28px;">
      <a href="${loginUrl}" style="display:inline-block;background:#1a3fa8;color:white;padding:13px 40px;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none;">&#128279; Go to Login Page</a></div>` : ''}
  </td></tr>
  ${(helpPhone || helpEmail) ? `<tr><td style="padding:0 24px 24px;">
    <div style="background:#1a3fa8;border-radius:10px;padding:18px 20px;">
      <div style="font-size:14px;font-weight:800;color:#ffffff;margin-bottom:12px;">&#127775; Need Help?</div>
      ${helpPhone ? `
      <div style="font-size:13px;color:#e0e7ff;margin-bottom:6px;">&#128222; Helpline: <strong style="color:#ffffff;">${escHtml(helpPhone)}</strong></div>
      <div style="font-size:12px;color:#93c5fd;margin-bottom:8px;">&#128336; Available: Mon–Sat, 10:00 AM – 6:00 PM IST</div>
      <div style="background:rgba(255,255,255,0.1);border:1px solid rgba(248,113,113,0.5);border-radius:7px;padding:9px 13px;margin-bottom:10px;display:inline-block;">
        <span style="font-size:12px;color:#fca5a5;">&#128308; If your call is not answered, please send a missed call — we will call you back.</span>
      </div>` : ''}
      ${helpEmail ? `
      <div style="font-size:13px;color:#e0e7ff;margin-bottom:4px;">&#9993;&#65039; Or reply to this email for support</div>
      <div style="font-size:12px;color:#93c5fd;">You can also email us at: <a href="mailto:${escHtml(helpEmail)}" style="color:#bfdbfe;text-decoration:underline;">${escHtml(helpEmail)}</a></div>` : ''}
    </div>
  </td></tr>` : ''}
  <tr><td style="background:#f8f9fa;padding:14px 24px;border-top:1px solid #e5e7eb;text-align:center;">
    <p style="margin:0 0 6px;font-size:12.5px;color:#6b7280;">Warm regards,<br><strong style="color:#374151;">${escHtml(co.name)} Team</strong></p>
    ${unsubscribeLink ? `<p style="margin:0;font-size:10.5px;color:#9ca3af;">
      <a href="${escHtml(unsubscribeLink)}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe from future emails</a>
    </p>` : ''}
  </td></tr>
</table></td></tr></table></body></html>`;
}

// Note 7: buildReminderSubject uses company name
function buildReminderSubject(stage, companyName) {
  const stages = [
    '',
    `🔔 Reminder: You have been registered with ${companyName}`,
    `⏰ 2nd Reminder: Please complete your pending work — ${companyName}`,
    `📢 3rd Reminder: Your submission is still pending — ${companyName}`,
    `⚠️ 4th Reminder: Urgent — Action required — ${companyName}`,
    `🚨 Final Reminder: Deadline approaching — ${companyName}`
  ];
  return stages[stage] || `Reminder from ${companyName}`;
}

function buildReminderEmail({ member, co, stage, deadline, loginUrl, helpPhone, helpEmail, noteText, logoUrl, projectName, unsubscribeLink, openingOverride }) {
  const deadlineDisplay = deadline ? formatDeadlineDate(deadline) : null;
  const initials = (co.name || 'C').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

  // Apply variable substitution to dynamic text fields
  const templateVars = {
    firstName:    (member.name || 'Member').split(' ')[0],
    memberName:   member.name || 'Member',
    projectName:  projectName || '',
    deadlineDate: deadlineDisplay || '',
    companyName:  co.name || '',
    email:        member.email || '',
    loginUrl:     loginUrl || ''
  };
  const resolvedNote        = noteText    ? parseTemplateVars(noteText, templateVars)    : '';
  const resolvedProjectName = projectName ? parseTemplateVars(projectName, templateVars) : '';

  const stageMessages = [
    '',
    `This is a reminder that you have been registered with <strong style="color:#166534;">${escHtml(co.name)}</strong>. Please log in and complete your pending project work at your earliest convenience.`,
    `This is a friendly reminder that you have pending project work with <strong style="color:#166534;">${escHtml(co.name)}</strong>. Please complete your submission at your earliest convenience.`,
    `We noticed your project is still pending. This is your <strong>2nd reminder</strong> — please complete your work on time and with required accuracy.`,
    `Your submission is still pending with <strong style="color:#6b21a8;">${escHtml(co.name)}</strong>. This is your <strong>3rd reminder</strong> — please log in and complete your work immediately.`,
    `We have not received your submission yet. This is an <strong>urgent 4th reminder</strong> — please complete your project without any further delay.`,
    `<strong style="color:#dc2626;">This is your Final Reminder.</strong> The deadline for your submission with <strong>${escHtml(co.name)}</strong> is today. Please act immediately — no further reminders will be sent after this.`
  ];

  const stageBadgeColor  = stage === 5 ? '#fecaca' : stage === 4 ? '#fde68a' : stage === 3 ? '#ede9fe' : stage === 2 ? '#ccfbf1' : '#dcfce7';
  const stageBadgeText   = stage === 5 ? '#991b1b' : stage === 4 ? '#92400e' : stage === 3 ? '#6b21a8' : stage === 2 ? '#0f766e' : '#166534';
  const stageBadgeBorder = stage === 5 ? '#fca5a5' : stage === 4 ? '#fcd34d' : stage === 3 ? '#ddd6fe' : stage === 2 ? '#99f6e4' : '#bbf7d0';
  const stageBadgeLabel  = stage === 5 ? '🚨 Final Reminder' : stage === 4 ? '⚠️ 4th Reminder' : stage === 3 ? '📢 3rd Reminder' : stage === 2 ? '⏰ 2nd Reminder' : '🔔 Reminder';
  const stageLabels      = ['', 'Reminder', '2nd Reminder', '3rd Reminder', '4th Reminder', 'Final Reminder'];
  const headerBg         = stage === 5 ? '#7f1d1d' : stage === 4 ? '#92400e' : stage === 3 ? '#4c1d95' : stage === 2 ? '#0f766e' : '#166534';

  const deadlineWarning = stage === 5
    ? 'Finish your project by today midnight — 11:59'
    : 'Please complete your submission by the previous night — 23:59';

  const logoBlock = logoUrl
    ? `<td style="padding-right:14px;"><img src="${escHtml(logoUrl)}" alt="${escHtml(co.name)}" width="48" height="48" style="width:48px;height:48px;border-radius:10px;object-fit:contain;display:block;border:1.5px solid rgba(255,255,255,0.25);"></td>`
    : `<td style="width:48px;height:48px;background:rgba(255,255,255,0.15);border-radius:10px;text-align:center;vertical-align:middle;border:1.5px solid rgba(255,255,255,0.25);">
         <span style="color:white;font-family:Arial,sans-serif;font-weight:900;font-size:15px;">${initials}</span></td>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(stageLabels[stage])}</title></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',Arial,Helvetica,sans-serif;font-size:16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:24px 8px;"><tr><td align="center">
<table cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);max-width:600px;width:100%;">
  <tr><td style="background:${headerBg};padding:22px 24px;">
    <table cellpadding="0" cellspacing="0" width="100%"><tr>
      ${logoBlock}
      <td style="padding-left:14px;">
        <div style="color:white;font-size:19px;font-weight:700;letter-spacing:-0.3px;">${escHtml(co.name)}</div>
        <div style="color:rgba(255,255,255,0.6);font-size:10px;margin-top:3px;letter-spacing:1.5px;text-transform:uppercase;">${escHtml(stageLabels[stage])}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px 24px 0;">
    <p style="margin:0 0 16px;font-size:15px;color:#1a1a2e;font-weight:500;">Dear ${escHtml(member.name || 'Member')},</p>
    <div style="background:${stageBadgeColor};color:${stageBadgeText};padding:9px 18px;border-radius:6px;font-size:13px;font-weight:700;margin-bottom:18px;border:1px solid ${stageBadgeBorder};display:inline-block;">${stageBadgeLabel}</div>
    <p style="margin:0 0 20px;font-size:14px;color:#374151;line-height:1.75;">${openingOverride ? escHtml(parseTemplateVars(openingOverride, templateVars)) : stageMessages[stage]}</p>
    ${resolvedProjectName ? `<div style="background:#f0f7ff;border-left:3px solid #1a3fa8;padding:10px 16px;border-radius:0 8px 8px 0;margin-bottom:16px;">
      <div style="font-size:12px;font-weight:700;color:#1e40af;margin-bottom:4px;letter-spacing:0.3px;">PROJECT</div>
      <div style="font-size:13px;color:#374151;font-weight:600;">${escHtml(resolvedProjectName)}</div></div>` : ''}
    ${resolvedNote ? `<div style="background:#f0f7ff;border-left:3px solid #2563eb;padding:13px 16px;border-radius:0 8px 8px 0;margin-bottom:20px;">
      <div style="font-size:12px;font-weight:700;color:#1e40af;margin-bottom:6px;letter-spacing:0.3px;">NOTE</div>
      <div style="font-size:13px;color:#374151;line-height:1.7;">${escHtml(resolvedNote).replace(/\n/g,'<br>')}</div></div>` : ''}
    ${loginUrl ? `<div style="background:#f8fafc;border-radius:8px;padding:16px 20px;margin-bottom:20px;border:1px solid #e5e7eb;">
      <div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#94a3b8;font-weight:700;margin-bottom:12px;">Your Login Credentials</div>
      <table cellpadding="0" cellspacing="0">
        <tr><td style="padding-bottom:9px;font-size:13px;color:#374151;">&#128279; Login: &nbsp;<a href="${loginUrl}" style="color:#2563eb;font-weight:600;text-decoration:none;">Click here to login</a></td></tr>
        <tr><td style="padding-bottom:9px;font-size:13px;color:#374151;">&#128231; Username: &nbsp;<strong>${escHtml(member.email)}</strong></td></tr>
        <tr><td style="font-size:13px;color:#374151;">&#128273; Password: &nbsp;<strong>Your Phone Number</strong></td></tr>
      </table></div>` : ''}
    ${deadlineDisplay ? `<div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:10px;padding:20px 24px;margin-bottom:24px;">
      <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#b45309;font-weight:700;margin-bottom:8px;">&#128197; Submission Deadline</div>
      <div style="font-size:28px;font-weight:900;color:#78350f;margin-bottom:8px;line-height:1.2;">&#127942; ${escHtml(deadlineDisplay)}</div>
<div style="font-size:12.5px;color:#92400e;margin-bottom:4px;font-weight:600;">&#9888;&#65039; ${deadlineWarning}</div>
      <div style="font-size:11.5px;color:#b45309;">The deadline day is for verification, not submission.</div>
      </div>` : ''}
    ${loginUrl ? `<div style="text-align:center;margin-bottom:28px;">
      <a href="${loginUrl}" style="display:inline-block;background:#1a3fa8;color:white;padding:13px 40px;border-radius:8px;font-size:14px;font-weight:700;text-decoration:none;">&#128279; Go to Login Page</a></div>` : ''}
  </td></tr>
  ${(helpPhone || helpEmail) ? `<tr><td style="padding:0 24px 24px;">
        <div style="background:#1a3fa8;border-radius:10px;padding:18px 20px;">
      <div style="font-size:14px;font-weight:800;color:#ffffff;margin-bottom:12px;">&#127775; Need Help?</div>
      ${helpPhone ? `
      <div style="font-size:13px;color:#e0e7ff;margin-bottom:6px;">&#128222; Helpline: <strong style="color:#ffffff;">${escHtml(helpPhone)}</strong></div>
      <div style="font-size:12px;color:#93c5fd;margin-bottom:8px;">&#128336; Available: Mon–Sat, 10:00 AM – 6:00 PM IST</div>
      <div style="background:rgba(255,255,255,0.1);border:1px solid rgba(248,113,113,0.5);border-radius:7px;padding:9px 13px;margin-bottom:10px;display:inline-block;">
        <span style="font-size:12px;color:#fca5a5;">&#128308; If your call is not answered, please send a missed call — we will call you back.</span>
      </div>` : ''}
      ${helpEmail ? `
      <div style="font-size:13px;color:#e0e7ff;margin-bottom:4px;">&#9993;&#65039; Or reply to this email for support</div>
      <div style="font-size:12px;color:#93c5fd;">You can also email us at: <a href="mailto:${escHtml(helpEmail)}" style="color:#bfdbfe;text-decoration:underline;">${escHtml(helpEmail)}</a></div>` : ''}
    </div>
  </td></tr>` : ''}
  <tr><td style="background:#f8f9fa;padding:14px 24px;border-top:1px solid #e5e7eb;text-align:center;">
    <p style="margin:0 0 6px;font-size:12.5px;color:#6b7280;">Warm regards,<br><strong style="color:#374151;">${escHtml(co.name)} Team</strong></p>
    ${unsubscribeLink ? `<p style="margin:0;font-size:10.5px;color:#9ca3af;">
      <a href="${escHtml(unsubscribeLink)}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe from future emails</a>
    </p>` : ''}
  </td></tr>
</table></td></tr></table></body></html>`;
}
// ── Start ─────────────────────────────────────────────────────────────────────
console.log('=== MailBlast v4.0 Starting ===');
console.log('PORT:', PORT);
console.log('NODE_ENV:', process.env.NODE_ENV || 'development');
console.log('DATA_DIR:', DATA_DIR);
console.log('ADMIN_EMAIL:', process.env.ADMIN_EMAIL || '(not set)');
console.log('RESEND_API_KEY:', process.env.RESEND_API_KEY ? 'SET ✓' : 'NOT SET ✗');
console.log('APP_BASE_URL:', APP_BASE_URL);
console.log('SESSION_SECRET: SET ✓');

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MailBlast v4 ready → http://0.0.0.0:${PORT}`);
});
