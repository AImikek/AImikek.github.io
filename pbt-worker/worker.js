// PB Tourney ✨ Assistant — Cloudflare Worker
// ───────────────────────────────────────────────────────────────────────────────────────────────
// What this does: the app sends the conversation; this worker (1) checks the caller is a signed-in
// PB Tourney user, (2) asks Claude what to do, giving it the app's actions as tools, and (3) returns
// Claude's reply. The APP runs the actions itself with the user's own Firebase login, so the normal
// database rules still apply — this worker never touches the database and holds no Firebase secret.
//
// SETUP (one time, ~5 minutes):
//   1. dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker → Deploy, then "Edit code".
//   2. Replace everything with this file. Save and deploy.
//   3. Worker → Settings → Variables and Secrets:
//        ANTHROPIC_API_KEY  (secret)  = your key from console.anthropic.com
//        ALLOWED_UIDS       (text)    = 4VIYfWzAOsWwp6e2j7f0U2vUurh2        ← Mike only, for now
//                                       (set to  all  to open it to everyone)
//        MODEL              (text)    = claude-sonnet-5-5                    ← optional
//   4. Copy the worker URL (https://something.workers.dev) and paste it into the app:
//        Chat → ✨ Assistant → "Assistant endpoint" box (admin only) → Save.
//
// PAYMENTS (Stripe) — same worker, extra secrets (Settings → Variables and Secrets):
//        STRIPE_SECRET_KEY         (secret) = sk_live_… from dashboard.stripe.com → Developers → API keys
//        STRIPE_WEBHOOK_SECRET     (secret) = whsec_… from Developers → Webhooks → Add endpoint:
//                                             URL = <this worker URL>/pay/webhook, event = checkout.session.completed
//                                             (optional but recommended; the app also confirms payments itself)
//        FIREBASE_SERVICE_ACCOUNT  (secret) = the WHOLE JSON of a service account key:
//                                             Firebase console → ⚙ Project settings → Service accounts → Generate new private key
//        FIREBASE_DB_URL           (text)   = https://pickle-tourney-default-rtdb.firebaseio.com
//   Only the worker can write payment records (it signs in as the service account); the app's rules make
//   a paid roster spot impossible without one. Card numbers never touch the app or Firebase.
// ───────────────────────────────────────────────────────────────────────────────────────────────

const FIREBASE_API_KEY = 'AIzaSyBtq_zSwn1KgALGhxoiEJQeiSaNEuH6yeo'; // public web key of pickle-tourney (it's in the app too)
const ALLOWED_ORIGINS = ['https://mikek.ai', 'https://www.mikek.ai', 'http://localhost', 'http://127.0.0.1'];

const TOOLS = [
  { name: 'list_upcoming_sessions', description: 'List upcoming sessions (games people can join): id, title, date, time, location, level, open spots, who is signed up. Call this before referring to "the game tomorrow", "my session", etc.', input_schema: { type: 'object', properties: {} } },
  { name: 'list_past_sessions', description: 'List PAST sessions (already happened), newest first: id, title, date, time, location, level, spots, who played, whether it has a Full Details page (hasFullDetails + detailSections like Format / Finals / What to Bring / Address & Parking / House Rules), price if it was a paid game. Use this whenever the user says "like last time", "same as Saturday", "run it back", "duplicate", "copy that event", or asks about a game that already happened. Optional query filters by title/location/date text.', input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'duplicate_session', description: 'Copy a past (or upcoming) session into a NEW one: title (date bumped), location, times, spots, level, note, visibility, the whole Full Details page (every section, verbatim) and any price settings. The user becomes organizer and player #1; the roster is NOT copied. Defaults: same weekday one week after the source. Pass a date/startTime to move it. ALWAYS prefer this over create_session when the user wants a repeat of an earlier game, because it carries the full details that take the longest to write.', input_schema: { type: 'object', properties: { sid: { type: 'string', description: 'source session id from list_past_sessions / list_upcoming_sessions' }, date: { type: 'string', description: 'YYYY-MM-DD; default source date + 7' }, startTime: { type: 'string', description: 'HH:MM 24h; default same as source' }, endTime: { type: 'string' }, title: { type: 'string' }, location: { type: 'string' }, spots: { type: 'integer' } }, required: ['sid'] } },
  { name: 'create_session', description: 'Create a new game session (a sign-up sheet). The organizer is added as player #1 automatically. Ask the user only for details you cannot infer; sensible defaults: doubles, 8 spots, public, 2.5 hours long. Dates must be YYYY-MM-DD, times 24h HH:MM.', input_schema: { type: 'object', properties: {
    date: { type: 'string', description: 'YYYY-MM-DD' }, startTime: { type: 'string', description: 'HH:MM 24h' }, endTime: { type: 'string', description: 'HH:MM 24h' },
    location: { type: 'string' }, title: { type: 'string' }, level: { type: 'string', description: 'e.g. "4.0+"' }, spots: { type: 'integer' },
    visibility: { type: 'string', enum: ['public', 'private'] }, note: { type: 'string' } }, required: ['date', 'startTime', 'location'] } },
  { name: 'invite_to_session', description: 'Send in-app invites (notifications) for a session. Choose WHO with exactly one selector: minDpr (everyone at that DPR and up), group (g45|g40|g35), names (specific people), or following=true (people the user follows). Returns who was invited and who could not be (no account).', input_schema: { type: 'object', properties: {
    sid: { type: 'string' }, minDpr: { type: 'number' }, group: { type: 'string', enum: ['g00', 'g50', 'g45', 'g40', 'g35'] }, names: { type: 'array', items: { type: 'string' } }, following: { type: 'boolean' }, message: { type: 'string', description: 'optional personal note' } }, required: ['sid'] } },
  { name: 'post_to_group', description: 'Post a message in a level group chat (g00 = Community/everyone, g50 = 5.0+, g45 = 4.5+, g40 = 4.0+, g35 = 3.5+). Optionally attach a session as a tappable Join card.', input_schema: { type: 'object', properties: { group: { type: 'string', enum: ['g00', 'g50', 'g45', 'g40', 'g35'] }, text: { type: 'string' }, sid: { type: 'string' } }, required: ['group'] } },
  { name: 'send_direct_message', description: 'Send a private message to one player by name (they must have an app account). Optionally attach a session.', input_schema: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' }, sid: { type: 'string' } }, required: ['name', 'text'] } },
  { name: 'find_players', description: 'Search players: by name fragment, by minimum DPR, or list a group\'s members. Returns name, DPR, games, whether they have an account.', input_schema: { type: 'object', properties: { query: { type: 'string' }, minDpr: { type: 'number' }, group: { type: 'string', enum: ['g00', 'g50', 'g45', 'g40', 'g35'] } } } },
  { name: 'player_stats', description: 'Stats for one player (or the user if name omitted): DPR, reliability, record, win %, avg diff, recent games.', input_schema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'join_session', description: 'Claim a spot for the user in a session (or the waitlist if full).', input_schema: { type: 'object', properties: { sid: { type: 'string' } }, required: ['sid'] } },
  { name: 'leaderboard', description: 'Top players by DPR for doubles or singles, with a time window.', input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['doubles', 'singles'] }, window: { type: 'string', enum: ['7', '30', 'all'] }, limit: { type: 'integer' } } } },
  { name: 'delete_session', description: 'Delete (cancel) a session the user organizes. Also recalls every invite the user sent for it and removes the user\'s chat posts that carried it. Set confirm:true ONLY when the user clearly asked to cancel/delete it (e.g. "cancel that game"). notifyPlayers:true sends everyone who was invited or signed up a short "cancelled" notification.', input_schema: { type: 'object', properties: { sid: { type: 'string' }, confirm: { type: 'boolean' }, notifyPlayers: { type: 'boolean' } }, required: ['sid', 'confirm'] } },
  { name: 'recall_invites', description: 'Take back the invites the user sent for a session (removes the 🎟 notifications and the user\'s chat posts carrying the game) without deleting the session. notifyPlayers:true tells them it is off.', input_schema: { type: 'object', properties: { sid: { type: 'string' }, notifyPlayers: { type: 'boolean' } }, required: ['sid'] } },
  { name: 'delete_tournament', description: 'Delete a tournament (the active one when tid is omitted). Set confirm:true only when the user clearly asked. If the tournament already has scored games the tool returns needsConfirmScored; tell the user how many games would be lost and call again with confirmScored:true only if they still want it.', input_schema: { type: 'object', properties: { tid: { type: 'string' }, confirm: { type: 'boolean' }, confirmScored: { type: 'boolean' } }, required: ['confirm'] } },
  { name: 'open_screen', description: 'Navigate the app for the user: sessions, session (needs sid), leaderboard, chat, group (needs group), profile (needs name), notifications, history.', input_schema: { type: 'object', properties: { screen: { type: 'string' }, sid: { type: 'string' }, group: { type: 'string' }, name: { type: 'string' } }, required: ['screen'] } },
];

function systemPrompt(ctx) {
  return `You are the in-app assistant for PB Tourney, a pickleball club app in Miami (Brickell). You help the user DO things in the app by calling tools, and you answer questions about the club from tool results.

Today: ${ctx.today} (${ctx.weekday}), timezone America/New_York. User: ${ctx.userName}${ctx.isAdmin ? ' (admin, the founder)' : ''}. Their DPR: ${ctx.myDpr || 'unrated'}.
Courts the club uses (use these exact names when the user mentions one loosely): ${ctx.courts.join('; ')}.
Chat groups: g00 = Community (everyone on the app), g50 = 5.0+ Elite, g45 = 4.5+ Club, g40 = 4.0+ Crew, g35 = 3.5+ Open. DPR is the club's in-house rating on the DUPR scale.
${ctx.recentSessions ? 'Recent sessions this user created (good defaults for a new one): ' + ctx.recentSessions : ''}

How to behave:
- Be brief and friendly, like a sharp assistant texting. No bullet-point walls.
- Act, don't narrate. If a request is clear, call the tool. Infer sensible defaults (doubles, 8 spots, public, usual court times) and state them in one line afterwards instead of asking.
- Ask ONE question at a time, and only when a required piece is genuinely missing or ambiguous (e.g. no date). "Thursday" means the next Thursday from today.
- "The game tomorrow" / "my session": call list_upcoming_sessions first, then use the matching sid.
- "Same as last Saturday" / "run it back" / "duplicate the Brickell Pickle one" / "copy that event": call list_past_sessions (query by title, place or date), pick the match, then duplicate_session — it copies the Full Details page too, so never retype details by hand and never use create_session for a repeat. Say which date it landed on and that the full details came along.
- After creating something, summarize what you did in one or two lines and mention the next natural step (e.g. "want me to post it to the 4.0+ Crew?").
- Never invent players, sessions or numbers; everything comes from tools. If a tool reports someone has no account, say so plainly.
- Destructive actions (delete_session, delete_tournament, recall_invites): if the user plainly asked for it in this message ("cancel that game", "delete this tournament"), do it with confirm:true and report what happened — don't make them say yes twice. If it's ambiguous which one they mean, ask one question first. When cancelling a game people were invited to, default to notifyPlayers:true so nobody shows up.
- You cannot merge players or edit scores; if asked, say which screen does that (profile → Merge; Games page → tap the score).`;
}

function cors(origin) {
  const ok = ALLOWED_ORIGINS.some(o => (origin || '').startsWith(o));
  return { 'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0], 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Vary': 'Origin' };
}
async function verifyUser(idToken) {
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
  if (!r.ok) return null;
  const j = await r.json(); const u = j && j.users && j.users[0];
  return u ? { uid: u.localId, phone: u.phoneNumber || null, email: u.email || null } : null;
}


// ═══════════════════════════════ PAYMENTS ═══════════════════════════════
const ADMIN_UID = '4VIYfWzAOsWwp6e2j7f0U2vUurh2';
function form(obj, prefix) {   // nested object → x-www-form-urlencoded the way Stripe wants it
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') out.push(form(v, key)); else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.filter(Boolean).join('&');
}
async function stripe(env, path, body, method) {
  const r = await fetch('https://api.stripe.com/v1/' + path, { method: method || 'POST', headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body: method === 'GET' ? undefined : form(body) });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe error');
  return j;
}
// Firebase as the service account (RS256 JWT → OAuth token), cached for ~50 min
let _fbTok = null, _fbTokAt = 0;
function b64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function fbToken(env) {
  if (_fbTok && Date.now() - _fbTokAt < 50 * 60 * 1000) return _fbTok;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const enc = s => b64url(new TextEncoder().encode(s));
  const unsigned = enc(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + enc(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + unsigned + '.' + b64url(sig) });
  const j = await r.json(); if (!j.access_token) throw new Error('Firebase auth failed: ' + JSON.stringify(j));
  _fbTok = j.access_token; _fbTokAt = Date.now(); return _fbTok;
}
async function fbGet(env, path) { const r = await fetch(env.FIREBASE_DB_URL + '/' + path + '.json?access_token=' + await fbToken(env)); return r.json(); }
async function fbPatch(env, path, data) { const r = await fetch(env.FIREBASE_DB_URL + '/' + path + '.json?access_token=' + await fbToken(env), { method: 'PATCH', body: JSON.stringify(data) }); if (!r.ok) throw new Error('Firebase write failed'); return r.json(); }
async function verifyStripeSig(env, raw, header) {
  const m = Object.fromEntries(String(header || '').split(',').map(p => p.split('='))); if (!m.t || !m.v1) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(m.t + '.' + raw));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === m.v1 && Math.abs(Date.now() / 1000 - Number(m.t)) < 600;
}
function perPerson(s) {   // cents each; 'total' mode splits the total across the spots (fixed once set)
  if (!s || !s.price && !s.priceTotal) return 0;
  if (s.priceMode === 'total' && s.priceTotal) return Math.ceil(Number(s.priceTotal) / Math.max(1, Number(s.spots) || 1));
  return Number(s.price) || 0;
}
async function markPaid(env, cs) {   // a completed Checkout Session → payments/{sid}/{uid}
  const md = cs.metadata || {}; if (!md.sid || !md.uid) return;
  await fbPatch(env, 'payments/' + md.sid + '/' + md.uid, { status: 'paid', amount: cs.amount_total, currency: cs.currency, checkout: cs.id, paymentIntent: typeof cs.payment_intent === 'string' ? cs.payment_intent : (cs.payment_intent && cs.payment_intent.id) || null, name: md.name || null, paidAt: Date.now() });
}
async function handlePay(request, env, H, url) {
  const route = url.pathname.replace(/\/+$/, '');
  if (!env.STRIPE_SECRET_KEY || !env.FIREBASE_SERVICE_ACCOUNT || !env.FIREBASE_DB_URL) return new Response(JSON.stringify({ error: 'Payments are not set up on the worker yet (STRIPE_SECRET_KEY / FIREBASE_SERVICE_ACCOUNT / FIREBASE_DB_URL).' }), { status: 500, headers: H });
  // Stripe → us (no user token; signed by Stripe)
  if (route === '/pay/webhook') {
    const raw = await request.text();
    if (!env.STRIPE_WEBHOOK_SECRET || !(await verifyStripeSig(env, raw, request.headers.get('Stripe-Signature')))) return new Response('bad signature', { status: 400 });
    const ev = JSON.parse(raw);
    if (ev.type === 'checkout.session.completed' && ev.data.object.payment_status === 'paid') await markPaid(env, ev.data.object);
    if (ev.type === 'charge.refunded') { const pi = ev.data.object.payment_intent; const md = ev.data.object.metadata || {}; if (md.sid && md.uid) await fbPatch(env, 'payments/' + md.sid + '/' + md.uid, { status: 'refunded', refundedAt: Date.now() }); }
    return new Response('ok', { headers: H });
  }
  // app → us (signed-in user)
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const user = auth ? await verifyUser(auth) : null;
  if (!user) return new Response(JSON.stringify({ error: 'Sign in first.' }), { status: 401, headers: H });
  const body = await request.json().catch(() => ({}));
  const sid = String(body.sid || '').replace(/[^A-Za-z0-9_-]/g, ''); if (!sid) return new Response(JSON.stringify({ error: 'Missing session.' }), { status: 400, headers: H });
  const s = await fbGet(env, 'sessions/' + sid); if (!s) return new Response(JSON.stringify({ error: 'That session is gone.' }), { status: 404, headers: H });
  const cents = perPerson(s); if (!cents) return new Response(JSON.stringify({ error: 'This session is free — just claim a spot.' }), { status: 400, headers: H });
  const isOwner = user.uid === s.ownerUid || user.uid === ADMIN_UID;

  if (route === '/pay/checkout') {
    const roster = Object.values(s.roster || {}), wait = Object.values(s.waitlist || {});
    if (roster.some(r => r && r.uid === user.uid)) return new Response(JSON.stringify({ error: 'You already have a spot.' }), { status: 400, headers: H });
    if (roster.filter(Boolean).length >= (Number(s.spots) || 4)) return new Response(JSON.stringify({ error: 'full' }), { status: 409, headers: H });
    const existing = await fbGet(env, 'payments/' + sid + '/' + user.uid);
    if (existing && existing.status === 'paid') return new Response(JSON.stringify({ paid: true }), { headers: H });
    const name = String(body.name || '').slice(0, 60);
    const origin = (body.origin && /^https:\/\/(www\.)?mikek\.ai/.test(body.origin)) ? body.origin : 'https://mikek.ai';
    const cs = await stripe(env, 'checkout/sessions', {
      mode: 'payment', 'payment_method_types[0]': 'card', client_reference_id: sid + ':' + user.uid,
      'line_items[0][quantity]': 1, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': cents,
      'line_items[0][price_data][product_data][name]': (s.title || 'Pickleball session') + ' · ' + (s.date || ''),
      'line_items[0][price_data][product_data][description]': 'Reserves 1 spot' + (s.location ? ' · ' + s.location : '') + (s.startTime ? ' · ' + s.startTime : ''),
      'metadata[sid]': sid, 'metadata[uid]': user.uid, 'metadata[name]': name, 'payment_intent_data[metadata][sid]': sid, 'payment_intent_data[metadata][uid]': user.uid,
      success_url: origin + '/pbt/?s=' + sid + '&paid=1', cancel_url: origin + '/pbt/?s=' + sid,
      customer_email: user.email || undefined, expires_at: Math.floor(Date.now() / 1000) + 1800 });
    await fbPatch(env, 'payments/' + sid + '/' + user.uid, { status: 'pending', checkout: cs.id, amount: cents, currency: 'usd', name, at: Date.now() });
    return new Response(JSON.stringify({ url: cs.url, id: cs.id }), { headers: H });
  }
  if (route === '/pay/sync') {   // back from Stripe (or webhook delayed): confirm straight with Stripe
    const p = await fbGet(env, 'payments/' + sid + '/' + user.uid);
    if (p && p.status === 'paid') return new Response(JSON.stringify({ status: 'paid' }), { headers: H });
    if (!p || !p.checkout) return new Response(JSON.stringify({ status: 'none' }), { headers: H });
    const cs = await stripe(env, 'checkout/sessions/' + p.checkout, null, 'GET');
    if (cs.payment_status === 'paid') { await markPaid(env, cs); return new Response(JSON.stringify({ status: 'paid' }), { headers: H }); }
    return new Response(JSON.stringify({ status: cs.status === 'expired' ? 'expired' : 'pending' }), { headers: H });
  }
  if (route === '/pay/refund') {
    const target = String(body.uid || user.uid).replace(/[^A-Za-z0-9_-]/g, '');
    if (target !== user.uid && !isOwner) return new Response(JSON.stringify({ error: 'Only the organizer can refund someone else.' }), { status: 403, headers: H });
    if (target === user.uid && !isOwner) {   // self-refund only before the cutoff
      const hrs = s.refundCutoffH == null ? 24 : Number(s.refundCutoffH);
      const start = new Date((s.date || '2000-01-01') + 'T' + (s.startTime || '00:00') + ':00-04:00').getTime();
      if (Date.now() > start - hrs * 3600000) return new Response(JSON.stringify({ error: 'cutoff', hours: hrs }), { status: 400, headers: H });
    }
    const p = await fbGet(env, 'payments/' + sid + '/' + target);
    if (!p || p.status !== 'paid' || !p.paymentIntent) return new Response(JSON.stringify({ error: 'No payment to refund.' }), { status: 400, headers: H });
    await stripe(env, 'refunds', { payment_intent: p.paymentIntent });
    await fbPatch(env, 'payments/' + sid + '/' + target, { status: 'refunded', refundedAt: Date.now(), refundedBy: user.uid });
    return new Response(JSON.stringify({ ok: true, amount: p.amount }), { headers: H });
  }
  return new Response(JSON.stringify({ error: 'Unknown route' }), { status: 404, headers: H });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const H = Object.assign({ 'Content-Type': 'application/json' }, cors(origin));
    if (request.method === 'OPTIONS') return new Response(null, { headers: H });
    const url = new URL(request.url);
    if (url.pathname.startsWith('/pay/')) { try { return await handlePay(request, env, H, url); } catch (e) { return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: H }); } }
    if (request.method !== 'POST') return new Response(JSON.stringify({ ok: true, service: 'pbt-assistant', payments: !!(env.STRIPE_SECRET_KEY && env.FIREBASE_SERVICE_ACCOUNT) }), { headers: H });
    try {
      const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!auth) return new Response(JSON.stringify({ error: 'Sign in first.' }), { status: 401, headers: H });
      const user = await verifyUser(auth);
      if (!user) return new Response(JSON.stringify({ error: 'Your sign-in expired. Reopen the app and try again.' }), { status: 401, headers: H });
      const allowed = (env.ALLOWED_UIDS || '').trim();
      if (allowed && allowed !== 'all' && !allowed.split(/[\s,]+/).includes(user.uid)) return new Response(JSON.stringify({ error: 'The assistant is in private testing right now.' }), { status: 403, headers: H });
      if (!env.ANTHROPIC_API_KEY) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set on the worker.' }), { status: 500, headers: H });

      const body = await request.json();
      const messages = (body.messages || []).slice(-40);
      const ctx = body.context || {};
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: env.MODEL || 'claude-sonnet-5-5', max_tokens: 1024, system: systemPrompt(ctx), tools: TOOLS, messages })
      });
      const j = await r.json();
      if (!r.ok) return new Response(JSON.stringify({ error: (j.error && j.error.message) || 'Claude API error' }), { status: 502, headers: H });
      return new Response(JSON.stringify({ content: j.content, stop_reason: j.stop_reason, usage: j.usage }), { headers: H });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: H });
    }
  }
};
