// Uses the existing Tasks owner sign-in; no signer details are public.
const PROJECT = 'mikek-tasks';
const API_KEY = 'AIzaSyCiuMP0cdDVPf9yTFVOrGRbYMOmPNJAjyk';
const OWNERS = ['michaelkrilivsky@gmail.com', 'm@mikek.ai'];

export async function hubOwner(request, fetcher = fetch) {
  const token = (request.headers.get('Authorization') || '').match(/^Bearer (\S+)$/)?.[1];
  if (!token || token.length > 10000) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== PROJECT || claims.iss !== `https://securetoken.google.com/${PROJECT}` ||
        !claims.sub || !Number.isFinite(claims.exp) || claims.exp <= now ||
        !Number.isFinite(claims.auth_time) || claims.auth_time > now) return false;
    // Google validates the token. Decoded claims alone never grant access.
    const response = await fetcher(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({idToken: token}), signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return false;
    const user = (await response.json()).users?.[0];
    return Boolean(user && user.localId === claims.sub && user.emailVerified === true && !user.disabled &&
      OWNERS.includes(String(user.email || '').toLowerCase()) && claims.auth_time >= Number(user.validSince || 0));
  } catch { return false; }
}

export async function hubSummary(request, env, headers, fetcher = fetch) {
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  if (!(await hubOwner(request, fetcher))) return new Response(JSON.stringify({error: 'Owner authentication required.'}), {status: 401, headers});
  const [counts, recent] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN agreement_type IN ('signed_nda', 'signed_nda_prior') THEN 1 ELSE 0 END) AS signed,
      SUM(CASE WHEN agreement_type = 'legacy_acknowledgment' THEN 1 ELSE 0 END) AS legacy
      FROM acknowledgments`).first(),
    env.DB.prepare('SELECT id, name, company, agreement_type, acknowledged_at FROM acknowledgments ORDER BY acknowledged_at DESC LIMIT 100').all()
  ]);
  return new Response(JSON.stringify({total: Number(counts.total || 0), signed: Number(counts.signed || 0), legacy: Number(counts.legacy || 0),
    rows: (recent.results || []).map(r => ({id: r.id, name: r.name, company: r.company,
      status: ['signed_nda', 'signed_nda_prior'].includes(r.agreement_type) ? 'Signed NDA' : 'Legacy acknowledgment', at: Date.parse(r.acknowledged_at) || 0}))
  }), {status: 200, headers});
}
