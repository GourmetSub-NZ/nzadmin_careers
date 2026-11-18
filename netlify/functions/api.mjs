// Gourmet Sub careers API (Netlify Function v2). One file, no external dependencies except @netlify/blobs.
//   Public:  GET  /api/jobs
//   HR:      POST /api/login   POST /api/logout   GET /api/me
//            GET/POST /api/admin/jobs   PUT/DELETE /api/admin/jobs/:id   POST /api/admin/generate
// Storage: Netlify Blobs store "jobs" (one JSON blob per listing). Sessions: signed HttpOnly cookie.
import { getStore } from '@netlify/blobs';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export const config = { path: '/api/*' };

const TYPES = ['Part-time or full-time', 'Part-time', 'Full-time', 'Casual', 'Fixed-term'];
const STATUSES = ['draft', 'open', 'closed'];
const SESSION_HOURS = 8;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

// ---------- sessions ----------
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (payload, secret) => createHmac('sha256', secret).update(payload).digest('base64url');
function makeToken(email, secret) {
  const p = b64(JSON.stringify({ sub: email, exp: Date.now() + SESSION_HOURS * 3600e3 }));
  return `${p}.${sign(p, secret)}`;
}
function readSession(req, secret) {
  const m = /(?:^|;\s*)hr_session=([^;]+)/.exec(req.headers.get('cookie') || '');
  if (!m || !secret) return null;
  const [p, sig] = m[1].split('.');
  if (!p || !sig) return null;
  const good = Buffer.from(sign(p, secret)), got = Buffer.from(sig);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(p, 'base64url').toString());
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
}
const cookie = (value, maxAge) => `hr_session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${maxAge}`;

// ---------- validation ----------
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => str(x, 200)).filter(Boolean).slice(0, 8);
function clean(b, partial = false) {
  const out = { t: str(b.t, 100), c: str(b.c, 60), ty: TYPES.includes(b.ty) ? b.ty : '', l: str(b.l, 80), d: str(b.d, 1000), u: list(b.u), q: list(b.q) };
  if (b.status !== undefined) out.status = STATUSES.includes(b.status) ? b.status : '';
  const missing = ['t', 'c', 'ty', 'l'].filter((k) => !out[k]);
  if (!partial && (out.status === 'open' || b.status === undefined)) {
    if (!out.d) missing.push('d');
    if (!out.u.length) missing.push('u');
    if (!out.q.length) missing.push('q');
  }
  if (out.status === '') missing.push('status');
  return { out, missing };
}
const template = (t, c) => ({
  d: `Join our ${c.toLowerCase()} team as ${t}. Help us make every order fresh, grilled to order and served with care.`,
  u: ['Deliver our fresh-to-order standard on every shift', 'Work with the team to keep service smooth and safe', 'Keep your area clean and follow food safety practices'],
  q: ['Reliable and happy to work as part of a team', 'Keen to learn and grow with Gourmet Sub'],
});
async function generate({ t, c, ty, l, n }, env) {
  const key = env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content:
          `You write job listings for Gourmet Sub, a New Zealand quick-service restaurant brand serving freshly grilled subs, wraps and salads. Voice: warm, clear and concise, like Apple. New Zealand English. Write a listing for: ${t} (${c}, ${ty}, ${l}).${n ? ' Extra notes: ' + n : ''} Rules: never mention or imply age, gender, ethnicity, religion, family status, health, disability, nationality or appearance; no pay figures; list only genuinely necessary requirements. Return only JSON: {"description":"one or two sentences","duties":["3 to 5 short items"],"requirements":["2 to 4 short items"]}` }] }),
      });
      const j = await r.json();
      const g = JSON.parse((j.content?.[0]?.text || '').replace(/```json|```/g, '').trim());
      if (g.description && g.duties?.length && g.requirements?.length) return { d: str(g.description, 1000), u: list(g.duties), q: list(g.requirements), source: 'ai' };
    } catch { /* fall through to template */ }
  }
  return { ...template(t, c), source: 'template' };
}

// ---------- login protection ----------
async function attempts(authStore, key) { return (await authStore.get(key, { type: 'json' })) || { n: 0, until: 0 }; }

export async function handle(req, ctx, deps) {
  const { jobs, auth, env } = deps;
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const secret = env.SESSION_SECRET;
  const isPublic = path === '/api/jobs' && method === 'GET';

  if (isPublic) {
    const all = await readAll(jobs);
    return json(all.filter((j) => j.status === 'open').sort((a, b) => b.publishedAt - a.publishedAt)
      .map(({ id, t, c, ty, l, d, u, q }) => ({ _id: id, t, c, ty, l, d, u, q })));
  }

  // state-changing requests must be same-origin and carry the custom header
  if (method !== 'GET') {
    const origin = req.headers.get('origin');
    if ((origin && origin !== url.origin) || req.headers.get('x-hr') !== '1') return json({ error: 'forbidden' }, 403);
  }

  if (path === '/api/login' && method === 'POST') {
    if (!secret) return json({ error: 'not_configured' }, 500);
    let b; try { b = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
    const email = str(b.email, 200).toLowerCase(), password = String(b.password ?? '').slice(0, 200);
    const ip = ctx?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
    const key = 'fail:' + createHmac('sha256', secret).update(email + '|' + ip).digest('hex').slice(0, 32);
    const a = await attempts(auth, key);
    if (a.until > Date.now()) return json({ error: 'locked' }, 429);
    let users = []; try { users = JSON.parse(env.HR_USERS || '[]'); } catch { /* none */ }
    const u = users.find((x) => x.email === email);
    const hash = scryptSync(password, u ? u.salt : 'x'.repeat(32), 64);      // always hash: no timing leak for unknown emails
    const ok = u && timingSafeEqual(hash, Buffer.from(u.hash, 'hex'));
    if (!ok) {
      const n = a.n + 1;
      await auth.setJSON(key, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      return json({ error: 'invalid' }, 401);
    }
    await auth.delete(key);
    return json({ ok: true, email }, 200, { 'Set-Cookie': cookie(makeToken(email, secret), SESSION_HOURS * 3600) });
  }
  if (path === '/api/logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });

  // everything below needs a valid HR session
  const session = readSession(req, secret);
  if (!session) return json({ error: 'unauthorised' }, 401);
  if (path === '/api/me') return json({ email: session.sub });

  if (path === '/api/admin/generate' && method === 'POST') {
    let b; try { b = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
    const t = str(b.t, 100), c = str(b.c, 60);
    if (!t || !c) return json({ error: 'missing' }, 400);
    return json(await generate({ t, c, ty: str(b.ty, 40), l: str(b.l, 80), n: str(b.n, 300) }, env));
  }

  if (path === '/api/admin/jobs' && method === 'GET') return json((await readAll(jobs)).sort((a, b) => b.createdAt - a.createdAt));
  if (path === '/api/admin/jobs' && method === 'POST') {
    let b; try { b = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
    const { out, missing } = clean({ ...b, status: b.status ?? 'draft' });
    if (missing.length) return json({ error: 'invalid', fields: missing }, 400);
    const now = Date.now(), job = { id: randomUUID(), ...out, createdAt: now, updatedAt: now, publishedAt: out.status === 'open' ? now : 0, by: session.sub };
    await jobs.setJSON(job.id, job);
    return json(job, 201);
  }
  const m = /^\/api\/admin\/jobs\/([\w-]{8,64})$/.exec(path);
  if (m) {
    const cur = await jobs.get(m[1], { type: 'json' });
    if (!cur) return json({ error: 'not_found' }, 404);
    if (method === 'DELETE') { await jobs.delete(m[1]); return json({ ok: true }); }
    if (method === 'PUT') {
      let b; try { b = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
      const merged = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([k]) => ['t', 'c', 'ty', 'l', 'd', 'u', 'q', 'status'].includes(k))) };
      const { out, missing } = clean(merged);
      if (missing.length) return json({ error: 'invalid', fields: missing }, 400);
      const now = Date.now();
      const job = { ...cur, ...out, updatedAt: now, publishedAt: out.status === 'open' && cur.status !== 'open' ? now : cur.publishedAt, by: session.sub };
      await jobs.setJSON(job.id, job);
      return json(job);
    }
  }
  return json({ error: 'not_found' }, 404);
}

async function readAll(store) {
  const { blobs } = await store.list();
  return (await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })))).filter(Boolean);
}

export default async (req, ctx) =>
  handle(req, ctx, {
    jobs: getStore({ name: 'jobs', consistency: 'strong' }),
    auth: getStore({ name: 'auth', consistency: 'strong' }),
    env: process.env,
  });
