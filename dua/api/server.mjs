import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, promises as fs, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(here, '.env'));

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8787),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  dataFile: path.resolve(here, process.env.DATA_FILE || './data/nda-acknowledgments.json')
};

if (config.adminPassword.length < 16) {
  throw new Error('ADMIN_PASSWORD must be at least 16 characters. Set it in api/.env.');
}
if (config.sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be at least 32 characters. Set it in api/.env.');
}

let writeQueue = Promise.resolve();
const failedLogins = new Map();

await ensureDataFile();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const origin = req.headers.origin;

    if (origin && !config.allowedOrigins.includes(origin)) {
      return sendJson(res, 403, { error: 'This origin is not permitted to access the NDA service.' });
    }

    setSecurityHeaders(res, origin);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { status: 'ok', service: 'dua-nda-backend' });
    }

    if (req.method === 'POST' && url.pathname === '/api/nda-acknowledgments') {
      return handleAcknowledgment(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      return handleLogin(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
      return handleLogout(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/acknowledgments') {
      return handleAcknowledgmentList(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/acknowledgments.csv') {
      return handleCsvExport(req, res);
    }
    if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
      return sendFile(res, path.join(here, 'public', 'admin.html'), 'text/html; charset=utf-8');
    }

    return sendJson(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'Unexpected server error.' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`DUA NDA backend listening on http://${config.host}:${config.port}`);
});

async function handleAcknowledgment(req, res) {
  const body = await readJson(req);
  const name = text(body.name, 2, 120);
  const email = normalizeEmail(body.email);
  const role = text(body.role, 0, 160);
  const termsVersion = text(body.termsVersion, 1, 64);
  const proposalVersion = text(body.proposalVersion, 1, 64);

  if (!name || !email || body.accepted !== true || !termsVersion || !proposalVersion) {
    return sendJson(res, 422, { error: 'Please provide your name, email, acknowledgement, and the current terms version.' });
  }

  const acknowledgement = {
    id: randomUUID(),
    name,
    email,
    role,
    acknowledgedAt: new Date().toISOString(),
    termsVersion,
    proposalVersion,
    userAgent: text(req.headers['user-agent'], 0, 300),
    source: text(req.headers.referer, 0, 300)
  };

  await addAcknowledgment(acknowledgement);
  // EmailJS notification can be added here once its server-side credentials are configured.

  return sendJson(res, 201, {
    acknowledgement: {
      id: acknowledgement.id,
      acknowledgedAt: acknowledgement.acknowledgedAt
    }
  });
}

async function handleLogin(req, res) {
  const ip = requestIp(req);
  const attempt = failedLogins.get(ip);
  if (attempt && attempt.lockedUntil > Date.now()) {
    return sendJson(res, 429, { error: 'Too many login attempts. Please try again shortly.' });
  }

  const body = await readJson(req);
  if (!safeEqual(String(body.password || ''), config.adminPassword)) {
    const failures = (attempt?.failures || 0) + 1;
    failedLogins.set(ip, {
      failures,
      lockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0
    });
    return sendJson(res, 401, { error: 'Invalid password.' });
  }

  failedLogins.delete(ip);
  const token = createSessionToken();
  const secure = config.cookieSecure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `dua_nda_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`);
  return sendJson(res, 200, { ok: true });
}

async function handleLogout(req, res) {
  res.setHeader('Set-Cookie', 'dua_nda_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  return sendJson(res, 200, { ok: true });
}

async function handleAcknowledgmentList(req, res) {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Admin authentication required.' });
  const records = await readAcknowledgments();
  return sendJson(res, 200, { acknowledgments: records.sort((a, b) => b.acknowledgedAt.localeCompare(a.acknowledgedAt)) });
}

async function handleCsvExport(req, res) {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Admin authentication required.' });
  const records = await readAcknowledgments();
  const headers = ['Timestamp (UTC)', 'Name', 'Email', 'Role / Company', 'Terms version', 'Proposal version', 'Source', 'Record ID'];
  const rows = records
    .sort((a, b) => b.acknowledgedAt.localeCompare(a.acknowledgedAt))
    .map((record) => [record.acknowledgedAt, record.name, record.email, record.role, record.termsVersion, record.proposalVersion, record.source, record.id]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');

  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="dua-nda-acknowledgments.csv"',
    'Cache-Control': 'no-store'
  });
  res.end(csv);
}

function isAdmin(req) {
  const token = parseCookies(req.headers.cookie || '').dua_nda_admin;
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).expiresAt > Date.now();
  } catch {
    return false;
  }
}

function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({ expiresAt: Date.now() + 8 * 60 * 60 * 1000, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function sign(value) {
  return createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function ensureDataFile() {
  await fs.mkdir(path.dirname(config.dataFile), { recursive: true });
  if (!existsSync(config.dataFile)) await fs.writeFile(config.dataFile, '[]\n', { mode: 0o600 });
}

async function readAcknowledgments() {
  const raw = await fs.readFile(config.dataFile, 'utf8');
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    throw new Error('Acknowledgement data file is not valid JSON. Restore it from backup before continuing.');
  }
}

async function addAcknowledgment(record) {
  writeQueue = writeQueue.then(async () => {
    const records = await readAcknowledgments();
    records.push(record);
    const tempFile = `${config.dataFile}.${randomUUID()}.tmp`;
    await fs.writeFile(tempFile, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempFile, config.dataFile);
  });
  return writeQueue;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw new Error('Request body is too large.');
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : '';
}

function text(value, min, max) {
  const clean = String(value || '').trim().replace(/\s+/g, ' ');
  return clean.length >= min && clean.length <= max ? clean : '';
}

function parseCookies(header) {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    return index === -1 ? [] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter((entry) => entry.length));
}

function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function csvCell(value) {
  const safe = String(value ?? '').replace(/^([=+\-@])/, "'$1").replace(/"/g, '""');
  return `"${safe}"`;
}

function setSecurityHeaders(res, origin) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
  res.writeHead(200, { 'Content-Type': contentType });
  createReadStream(filePath).pipe(res);
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
