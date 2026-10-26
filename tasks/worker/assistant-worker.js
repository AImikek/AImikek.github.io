// Tasks Assistant — Cloudflare Worker
// Sits between mikek.ai/tasks and the Anthropic API so the API key never ships to the browser.
// Env vars (set in the Cloudflare dashboard): ANTHROPIC_API_KEY (secret), optional MODEL.

const ALLOWED_ORIGINS = ['https://mikek.ai', 'https://www.mikek.ai', 'https://aimikek.github.io'];
const FIREBASE_PROJECT = 'mikek-tasks';
const DEFAULT_MODEL = 'claude-haiku-5-5';

const PLAN_TOOL = {
  name: 'plan',
  description: 'The concrete changes to make to the user\'s tasks.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One sentence, plain English, describing what will happen. Say how many tasks and which days.' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Existing task id (omit when creating)' },
            due: { type: ['string', 'null'], description: 'New due date YYYY-MM-DD, or null to clear the date' },
            done: { type: 'boolean' },
            del: { type: 'boolean', description: 'Delete this task' },
            title: { type: 'string', description: 'Rename (existing) or name (new task)' },
            create: { type: 'boolean', description: 'true when this is a brand-new task' },
            repeat: { type: ['array', 'null'], items: { type: 'integer', minimum: 0, maximum: 6 }, description: 'Weekdays it repeats on, 0=Sunday … 6=Saturday. null to stop repeating.' }
          }
        }
      },
      answer: { type: 'string', description: 'For questions (what\'s left tomorrow?): the answer, as short lines.' }
    },
    required: ['summary', 'changes']
  }
};

function systemPrompt(today, tz, weekday) {
  return `You are the assistant inside "Tasks", a personal to-do app. You turn a plain-English instruction into concrete changes.

Today is ${weekday} ${today} (time zone ${tz}). Dates are YYYY-MM-DD. Weeks run Sunday to Saturday.

Rules of thumb:
- Day names refer to the nearest sensible occurrence. For tasks being MOVED FROM a day, prefer the most recent one if it is today or just passed and still has unfinished tasks ("from sat and sun" on a Sunday night = yesterday and today). For destinations, prefer the next upcoming one.
- "before monday" = all dated tasks due earlier than that Monday. "after", "between", "through", "up to", "from X on" work the same way.
- "this week" = the current Sun–Sat week. "the weekend" = Sat and Sun. "unfinished"/"open" = not done. If the user doesn't say, act on unfinished tasks only.
- Tasks with repeat days (pinned) are never moved by bulk commands unless the user names them specifically; mention in the summary that you left them alone.
- Spreading/distributing means assigning tasks as evenly as possible across the given days, keeping their current order.
- "shift forward one day" means each task moves to its own date + 1. "back" means earlier.
- Recurring: "Medicine every Tuesday and Friday" creates ONE task titled exactly "Medicine" with repeat [2,5] due on the next matching day (today counts). Strip words like "set recurring task:", quotes, and trailing instructions from the title.
- Never delete unless the user clearly asks to delete/remove/clear. "delete completed" = only done tasks.
- Never invent tasks that aren't in the list. Use ids exactly as given.
- If nothing matches, return an empty changes list and explain in summary.
- Do NOT ask clarifying questions. The user always sees a preview and must confirm before anything is applied, so make the most reasonable choice and state your assumption briefly in the summary ("Took 'this weekend' as Sat 24 and Sun 25").
- Keep summary short and human: "Move 11 unfinished tasks from Sat and Sun to Monday."`;
}

async function verifyFirebaseToken(idToken) {
  // Verify the Firebase ID token so only signed-in Tasks users can spend API credit.
  const [h, p, sig] = idToken.split('.');
  if (!h || !p || !sig) throw new Error('bad token');
  const b64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const header = JSON.parse(new TextDecoder().decode(b64(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64(p)));
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== FIREBASE_PROJECT || payload.iss !== 'https://securetoken.google.com/' + FIREBASE_PROJECT) throw new Error('wrong project');
  if (payload.exp < now - 60) throw new Error('expired');
  const jwks = await (await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com', { cf: { cacheTtl: 3600 } })).json();
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(sig), new TextEncoder().encode(h + '.' + p));
  if (!ok) throw new Error('bad signature');
  return payload;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors });
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response(JSON.stringify({ error: 'origin not allowed' }), { status: 403, headers: cors });

    try {
      const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      await verifyFirebaseToken(auth);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'not signed in (' + e.message + ')' }), { status: 401, headers: cors });
    }

    let body;
    try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: cors }); }
    const { instruction, today, tz, weekday, tasks = [], projects = [] } = body;
    if (!instruction || !today) return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400, headers: cors });

    // Compact task list so the request stays small even with a few hundred tasks.
    const lines = tasks.slice(0, 600).map(t =>
      `${t.id} | ${t.due || 'no date'} | ${t.done ? 'done' : 'open'}${t.repeat && t.repeat.length ? ' | repeats ' + t.repeat.join(',') : ''}${t.project ? ' | project ' + t.project : ''} | ${String(t.title || '').slice(0, 90)}`
    ).join('\n');
    const projLines = projects.map(p => `${p.id}: ${p.name}`).join('\n');

    const userMsg = `TASKS (id | due | status | title):\n${lines || '(none)'}\n\nPROJECTS:\n${projLines || '(none)'}\n\nINSTRUCTION: ${instruction}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: env.MODEL || DEFAULT_MODEL,
        max_tokens: 4000,
        system: systemPrompt(today, tz || 'America/New_York', weekday || ''),
        tools: [PLAN_TOOL],
        tool_choice: { type: 'tool', name: 'plan' },
        messages: [{ role: 'user', content: userMsg }]
      })
    });
    if (!res.ok) {
      const txt = await res.text();
      return new Response(JSON.stringify({ error: 'model error ' + res.status, detail: txt.slice(0, 300) }), { status: 502, headers: cors });
    }
    const data = await res.json();
    const tool = (data.content || []).find(c => c.type === 'tool_use');
    if (!tool) return new Response(JSON.stringify({ error: 'no plan returned' }), { status: 502, headers: cors });
    return new Response(JSON.stringify({ plan: tool.input, usage: data.usage }), { headers: cors });
  }
};
