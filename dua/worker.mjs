const encoder = new TextEncoder();
const CURRENT_TERMS_VERSION = 'DUA-NDA-2026-07-31-v2';
const PRIOR_FULL_NDA_VERSION = 'DUA-NDA-2026-07-31-v1';
const LEGACY_TERMS_VERSION = '2026-07-27';
let schemaPromise;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const headers = responseHeaders(origin, env);

    try {
      // The private admin page runs on this Worker origin; the public form runs only on the approved proposal origin.
      if (origin && origin !== url.origin && !allowedOrigins(env).includes(origin)) {
        return json({ error: 'This origin is not permitted to access the NDA service.' }, 403, headers);
      }

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers });
      }

      await ensureSchema(env);

      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ status: 'ok', service: 'dua-nda-backend' }, 200, headers);
      }
      if (request.method === 'POST' && url.pathname === '/api/nda-acknowledgments') {
        return createAcknowledgment(request, env, headers);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/login') {
        return login(request, env, headers);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
        headers.set('Set-Cookie', 'dua_nda_admin=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0');
        return json({ ok: true }, 200, headers);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/acknowledgments') {
        return listAcknowledgments(request, env, headers);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/acknowledgments.csv') {
        return exportCsv(request, env, headers);
      }
      if (request.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
        headers.set('Content-Type', 'text/html; charset=utf-8');
        return new Response(adminPage(), { status: 200, headers });
      }

      return json({ error: 'Not found.' }, 404, headers);
    } catch (error) {
      console.error(error);
      return json({ error: 'Unexpected server error.' }, 500, headers);
    }
  }
};

async function createAcknowledgment(request, env, headers) {
  const body = await readBody(request);
  if (body.error) return json({ error: body.error }, 400, headers);

  const name = cleanText(body.value.name, 2, 120);
  const email = normalizeEmail(body.value.email);
  const company = cleanText(body.value.company, 0, 160);
  const role = cleanText(body.value.role, 0, 160);
  const country = cleanText(body.value.country, 0, 120);
  const termsVersion = cleanText(body.value.termsVersion, 1, 64);
  const proposalVersion = cleanText(body.value.proposalVersion, 1, 64);
  const isSignedNda = termsVersion === CURRENT_TERMS_VERSION;
  const isPriorSignedNda = termsVersion === PRIOR_FULL_NDA_VERSION;
  const isFullNda = isSignedNda || isPriorSignedNda;
  const isLegacyAcknowledgment = termsVersion === LEGACY_TERMS_VERSION;

  if (!name || !email || body.value.accepted !== true || !proposalVersion || (!isFullNda && !isLegacyAcknowledgment)) {
    return json({ error: 'Please provide the required signer information and accept the current agreement.' }, 422, headers);
  }
  if (isFullNda && (!company || !role || !country || body.value.authorityAccepted !== true || body.value.electronicSignature !== true || body.value.termsScrolled !== true)) {
    return json({ error: 'Please complete every signer field, review the agreement to the end, and accept both electronic-signature confirmations.' }, 422, headers);
  }

  const record = {
    id: crypto.randomUUID(),
    name,
    email,
    company,
    role,
    country,
    acknowledgedAt: new Date().toISOString(),
    termsVersion,
    proposalVersion,
    authorityAccepted: isFullNda ? 1 : 0,
    electronicSignature: isFullNda ? 1 : 0,
    termsScrolled: isFullNda ? 1 : 0,
    agreementType: isSignedNda ? 'signed_nda' : (isPriorSignedNda ? 'signed_nda_prior' : 'legacy_acknowledgment'),
    ipAddress: cleanText(request.headers.get('CF-Connecting-IP'), 0, 64),
    userAgent: cleanText(request.headers.get('User-Agent'), 0, 300),
    source: cleanText(request.headers.get('Referer'), 0, 300)
  };

  await env.DB.prepare(`
    INSERT INTO acknowledgments (
      id, name, email, company, role, country, acknowledged_at, terms_version, proposal_version,
      authority_accepted, electronic_signature, terms_scrolled, agreement_type, ip_address, user_agent, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    record.id,
    record.name,
    record.email,
    record.company,
    record.role,
    record.country,
    record.acknowledgedAt,
    record.termsVersion,
    record.proposalVersion,
    record.authorityAccepted,
    record.electronicSignature,
    record.termsScrolled,
    record.agreementType,
    record.ipAddress,
    record.userAgent,
    record.source
  ).run();

  return json({ acknowledgement: { id: record.id, acknowledgedAt: record.acknowledgedAt } }, 201, headers);
}

async function login(request, env, headers) {
  const body = await readBody(request);
  if (body.error) return json({ error: body.error }, 400, headers);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const attempt = await env.DB.prepare(
    'SELECT failures, locked_until FROM login_attempts WHERE ip = ?'
  ).bind(ip).first();
  const now = Date.now();

  if (attempt && Number(attempt.locked_until) > now) {
    return json({ error: 'Too many login attempts. Please try again shortly.' }, 429, headers);
  }

  if (!(await passwordsMatch(String(body.value.password || ''), env))) {
    const failures = Number(attempt?.failures || 0) + 1;
    const lockedUntil = failures >= 5 ? now + 15 * 60 * 1000 : 0;
    await env.DB.prepare(`
      INSERT INTO login_attempts (ip, failures, locked_until) VALUES (?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until
    `).bind(ip, failures, lockedUntil).run();
    return json({ error: 'Invalid password.' }, 401, headers);
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  const token = await createSessionToken(env);
  headers.set('Set-Cookie', `dua_nda_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=28800`);
  return json({ ok: true }, 200, headers);
}

async function listAcknowledgments(request, env, headers) {
  if (!(await isAdmin(request, env))) {
    return json({ error: 'Admin authentication required.' }, 401, headers);
  }

  const result = await env.DB.prepare(`
    SELECT id, name, email, company, role, country, acknowledged_at, terms_version, proposal_version,
      authority_accepted, electronic_signature, terms_scrolled, agreement_type, ip_address, user_agent, source
    FROM acknowledgments ORDER BY acknowledged_at DESC
  `).all();

  const acknowledgments = (result.results || []).map((record) => ({
    id: record.id,
    name: record.name,
    email: record.email,
    company: record.company,
    role: record.role,
    country: record.country,
    acknowledgedAt: record.acknowledged_at,
    termsVersion: record.terms_version,
    proposalVersion: record.proposal_version,
    authorityAccepted: Boolean(record.authority_accepted),
    electronicSignature: Boolean(record.electronic_signature),
    termsScrolled: Boolean(record.terms_scrolled),
    agreementType: record.agreement_type,
    ipAddress: record.ip_address,
    userAgent: record.user_agent,
    source: record.source
  }));
  return json({ acknowledgments }, 200, headers);
}

async function exportCsv(request, env, headers) {
  if (!(await isAdmin(request, env))) {
    return json({ error: 'Admin authentication required.' }, 401, headers);
  }

  const result = await env.DB.prepare(`
    SELECT id, name, email, company, role, country, acknowledged_at, terms_version, proposal_version,
      authority_accepted, electronic_signature, terms_scrolled, agreement_type, ip_address, user_agent, source
    FROM acknowledgments ORDER BY acknowledged_at DESC
  `).all();
  const rows = (result.results || []).map((record) => [
    record.acknowledged_at,
    record.name,
    record.email,
    record.company,
    record.role,
    record.country,
    record.agreement_type,
    record.authority_accepted ? 'Yes' : 'No',
    record.electronic_signature ? 'Yes' : 'No',
    record.terms_scrolled ? 'Yes' : 'No',
    record.terms_version,
    record.proposal_version,
    record.ip_address,
    record.user_agent,
    record.source,
    record.id
  ]);
  const csv = [
    ['Timestamp (UTC)', 'Name', 'Email', 'Company / organization', 'Title / role', 'Country', 'Agreement type', 'Authority accepted', 'Electronic signature', 'Terms scrolled to end', 'Terms version', 'Proposal version', 'IP address', 'User agent', 'Source', 'Record ID'],
    ...rows
  ].map((row) => row.map(csvCell).join(',')).join('\n');

  headers.set('Content-Type', 'text/csv; charset=utf-8');
  headers.set('Content-Disposition', 'attachment; filename="dua-nda-acknowledgments.csv"');
  return new Response(csv, { status: 200, headers });
}

async function ensureSchema(env) {
  if (!env.DB) throw new Error('The D1 database binding named DB has not been configured.');
  if (!schemaPromise) {
    schemaPromise = initializeSchema(env).catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  return schemaPromise;
}

async function initializeSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS acknowledgments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        company TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        country TEXT NOT NULL DEFAULT '',
        acknowledged_at TEXT NOT NULL,
        terms_version TEXT NOT NULL,
        proposal_version TEXT NOT NULL,
        authority_accepted INTEGER NOT NULL DEFAULT 0,
        electronic_signature INTEGER NOT NULL DEFAULT 0,
        terms_scrolled INTEGER NOT NULL DEFAULT 0,
        agreement_type TEXT NOT NULL DEFAULT 'legacy_acknowledgment',
        ip_address TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL,
        source TEXT NOT NULL
      )
    `),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS acknowledgments_acknowledged_at ON acknowledgments(acknowledged_at DESC)'),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        ip TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        locked_until INTEGER NOT NULL
      )
    `)
  ]);

  const existing = await env.DB.prepare('PRAGMA table_info(acknowledgments)').all();
  const columns = new Set((existing.results || []).map((column) => column.name));
  const additions = [
    ['company', "ALTER TABLE acknowledgments ADD COLUMN company TEXT NOT NULL DEFAULT ''"],
    ['country', "ALTER TABLE acknowledgments ADD COLUMN country TEXT NOT NULL DEFAULT ''"],
    ['authority_accepted', 'ALTER TABLE acknowledgments ADD COLUMN authority_accepted INTEGER NOT NULL DEFAULT 0'],
    ['electronic_signature', 'ALTER TABLE acknowledgments ADD COLUMN electronic_signature INTEGER NOT NULL DEFAULT 0'],
    ['terms_scrolled', 'ALTER TABLE acknowledgments ADD COLUMN terms_scrolled INTEGER NOT NULL DEFAULT 0'],
    ['agreement_type', "ALTER TABLE acknowledgments ADD COLUMN agreement_type TEXT NOT NULL DEFAULT 'legacy_acknowledgment'"],
    ['ip_address', "ALTER TABLE acknowledgments ADD COLUMN ip_address TEXT NOT NULL DEFAULT ''"]
  ].filter(([name]) => !columns.has(name));

  if (additions.length) {
    await env.DB.batch(additions.map(([, sql]) => env.DB.prepare(sql)));
  }
}

function responseHeaders(origin, env) {
  const headers = new Headers({
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  });
  if (origin && allowedOrigins(env).includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || 'https://mikek.ai')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function json(data, status, headers) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

async function readBody(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 20_000) return { error: 'Request body is too large.' };
  try {
    const raw = await request.text();
    if (raw.length > 20_000) return { error: 'Request body is too large.' };
    return { value: JSON.parse(raw || '{}') };
  } catch {
    return { error: 'Request body must be valid JSON.' };
  }
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : '';
}

function cleanText(value, min, max) {
  const clean = String(value || '').trim().replace(/\s+/g, ' ');
  return clean.length >= min && clean.length <= max ? clean : '';
}

async function passwordsMatch(password, env) {
  if (String(env.ADMIN_PASSWORD || '').length < 16 || String(env.SESSION_SECRET || '').length < 32) {
    throw new Error('ADMIN_PASSWORD or SESSION_SECRET has not been securely configured.');
  }
  const [expected, received] = await Promise.all([
    hmacBytes(env.ADMIN_PASSWORD, env.SESSION_SECRET),
    hmacBytes(password, env.SESSION_SECRET)
  ]);
  return constantTimeEqual(expected, received);
}

async function isAdmin(request, env) {
  const token = parseCookies(request.headers.get('Cookie') || '').dua_nda_admin;
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  try {
    const valid = await verifySignature(payload, signature, env.SESSION_SECRET);
    if (!valid) return false;
    const details = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    return Number(details.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

async function createSessionToken(env) {
  const payload = base64UrlEncode(JSON.stringify({
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    nonce: crypto.randomUUID()
  }));
  return `${payload}.${await sign(payload, env.SESSION_SECRET)}`;
}

async function sign(value, secret) {
  return base64UrlEncode(await hmacBytes(value, secret));
}

async function verifySignature(value, signature, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify('HMAC', key, base64UrlDecode(signature), encoder.encode(value));
}

async function hmacBytes(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function base64UrlEncode(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function parseCookies(header) {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    return index === -1 ? [] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter((entry) => entry.length));
}

function csvCell(value) {
  const safe = String(value ?? '').replace(/^([=+\-@])/, "'$1").replace(/"/g, '""');
  return `"${safe}"`;
}

function adminPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>DUA NDA Signer Log</title><style>
:root{--ink:#0f2028;--paper:#f4f1ea;--surface:#fffdf8;--muted:#65747a;--line:#d9d5ca;--danger:#a63d36;--signed:#456400}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,sans-serif}main{width:min(1280px,calc(100% - 40px));margin:0 auto;padding:56px 0}.eyebrow{font:700 11px/1.2 ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em;text-transform:uppercase;color:#667b16}h1{margin:10px 0 8px;font:400 clamp(34px,5vw,58px)/1.05 Georgia,serif;letter-spacing:-.045em}.sub{margin:0;color:var(--muted);max-width:720px;line-height:1.55}.card{margin-top:34px;background:var(--surface);border:1px solid var(--line);box-shadow:0 20px 50px rgba(15,32,40,.06)}#login{width:min(420px,100%);padding:32px}label{display:block;margin:20px 0 8px;font-size:13px;font-weight:700}input{width:100%;padding:13px 14px;border:1px solid #b7beb9;border-radius:2px;background:#fff;font:inherit}button,.download{border:0;border-radius:2px;padding:12px 16px;background:var(--ink);color:#fff;font:700 13px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}button:hover,.download:hover{background:#243b45}button.secondary{color:var(--ink);background:#e8e6df}button.danger{color:var(--danger);background:transparent;border:1px solid #c99792}.error{min-height:20px;margin-top:14px;color:var(--danger);font-size:13px}#dashboard{display:none}.toolbar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:22px 24px;border-bottom:1px solid var(--line)}.count{font:700 14px ui-monospace,SFMono-Regular,monospace}.actions{display:flex;gap:10px;flex-wrap:wrap}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1050px}th,td{padding:16px 20px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{background:#f0eee7;color:var(--muted);font:700 10px/1.2 ui-monospace,SFMono-Regular,monospace;letter-spacing:.09em;text-transform:uppercase}td{font-size:14px}td strong{display:block;font-size:14px}td span{display:block;color:var(--muted);font-size:12px;line-height:1.45;margin-top:3px}.status{display:inline-flex;border:1px solid #bac99c;background:#f3f7e9;color:var(--signed);padding:5px 7px;font:700 10px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.06em;text-transform:uppercase}.status.legacy{border-color:var(--line);background:#f0eee7;color:var(--muted)}.empty{padding:56px 24px;color:var(--muted);text-align:center}@media(max-width:640px){main{width:min(100% - 28px,1280px);padding:32px 0}.toolbar{padding:18px}}
</style></head><body><main><div class="eyebrow">Confidential · DUA Hotel</div><h1>NDA signature log</h1><p class="sub">Review signed NDA evidence and earlier legacy acknowledgments. This private dashboard is not indexed by search engines.</p><section class="card" id="login"><form id="login-form"><label for="password">Admin password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit" style="margin-top:18px">Sign in</button><div class="error" id="login-error" role="alert"></div></form></section><section class="card" id="dashboard"><div class="toolbar"><div class="count" id="count">0 records</div><div class="actions"><button class="secondary" id="refresh" type="button">Refresh</button><a class="download" href="/api/admin/acknowledgments.csv">Export full evidence CSV</a><button class="danger" id="logout" type="button">Sign out</button></div></div><div class="table-wrap"><table><thead><tr><th>Recorded (UTC)</th><th>Signer</th><th>Organization</th><th>Acceptance</th><th>Evidence</th></tr></thead><tbody id="records"></tbody></table></div></section></main><script>
const login=document.getElementById('login'),dashboard=document.getElementById('dashboard'),error=document.getElementById('login-error'),records=document.getElementById('records'),count=document.getElementById('count');document.getElementById('login-form').addEventListener('submit',async event=>{event.preventDefault();error.textContent='';const response=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});if(!response.ok){error.textContent=(await response.json()).error||'Unable to sign in.';return}login.style.display='none';dashboard.style.display='block';loadRecords()});document.getElementById('refresh').addEventListener('click',loadRecords);document.getElementById('logout').addEventListener('click',async()=>{await fetch('/api/admin/logout',{method:'POST'});location.reload()});async function loadRecords(){const response=await fetch('/api/admin/acknowledgments');if(response.status===401){login.style.display='block';dashboard.style.display='none';return}const data=await response.json(),entries=data.acknowledgments||[];count.textContent=entries.length+' '+(entries.length===1?'record':'records');records.innerHTML=entries.length?entries.map(row).join(''):'<tr><td class="empty" colspan="5">No NDA signatures have been recorded yet.</td></tr>'}function row(entry){const signed=String(entry.agreementType||'').startsWith('signed_nda');return '<tr><td>'+escapeHtml(new Date(entry.acknowledgedAt).toISOString().replace('T',' ').replace('.000Z',' UTC'))+'</td><td><strong>'+escapeHtml(entry.name)+'</strong><span>'+escapeHtml(entry.email)+'</span><span>'+escapeHtml(entry.country||'Country not recorded')+'</span></td><td><strong>'+escapeHtml(entry.company||'Not recorded')+'</strong><span>'+escapeHtml(entry.role||'Role not recorded')+'</span></td><td><span class="status'+(signed?'':' legacy')+'">'+(signed?'Signed NDA':'Legacy acknowledgment')+'</span><span>'+escapeHtml(entry.termsVersion)+'</span><span>Authority: '+(entry.authorityAccepted?'Yes':'Not recorded')+' · E-sign: '+(entry.electronicSignature?'Yes':'Not recorded')+' · Read-through: '+(entry.termsScrolled?'Yes':'Not recorded')+'</span></td><td><strong>'+escapeHtml(entry.id)+'</strong><span>IP: '+escapeHtml(entry.ipAddress||'Not recorded')+'</span><span>'+escapeHtml(entry.source||'Source not recorded')+'</span></td></tr>'}function escapeHtml(value){return String(value||'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}loadRecords();
</script></body></html>`;
}
