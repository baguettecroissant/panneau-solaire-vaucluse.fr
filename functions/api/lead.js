const SITE_DOMAIN = 'panneau-solaire-vaucluse.fr';
const SITE_NICHE = 'panneau-solaire';
const DEPT_CODE = '84';
const CP_PATTERN = /^84\d{3}$/;
const VUD_PING_URL = 'https://www.viteundevis.com/api/ping.php';
const VUD_LEAD_URL = 'https://www.viteundevis.com/api/get.php';
const MAX_BODY_BYTES = 16_384;

const allowed = (origin, env) => origin === `https://${SITE_DOMAIN}` || origin === `https://www.${SITE_DOMAIN}` || origin === 'https://panneau-solaire-vaucluse-fr.pages.dev' || (env.ALLOW_LOCAL_ORIGIN === 'true' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
const json = (body, status = 200, origin = '') => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': origin || `https://${SITE_DOMAIN}`, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'Origin' } });
const normalizePhone = (value = '') => { let digits = String(value).replace(/\D/g, ''); if (digits.startsWith('0033')) digits = `0${digits.slice(4)}`; if (digits.startsWith('33') && digits.length === 11) digits = `0${digits.slice(2)}`; return /^0[1-9]\d{8}$/.test(digits) ? digits : null; };
const sbHeaders = (env) => ({ 'content-type': 'application/json', apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` });
const timedFetch = async (url, options, fetcher) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000); try { return await fetcher(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); } };

export async function handleLead({ request, env = {} }, fetcher = fetch) {
  const origin = request.headers.get('origin') || '';
  if (!allowed(origin, env)) return json({ success: false, message: 'Origine non autorisée.' }, 403, origin);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.VUD_API_KEY) return json({ success: false, message: 'Service temporairement en configuration.' }, 503, origin);
  if (!request.headers.get('content-type')?.includes('application/json')) return json({ success: false, message: 'Format invalide.' }, 415, origin);
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return json({ success: false, message: 'Requête trop volumineuse.' }, 413, origin);

  let raw;
  try { const text = await request.text(); if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return json({ success: false, message: 'Requête trop volumineuse.' }, 413, origin); raw = JSON.parse(text); } catch { return json({ success: false, message: 'JSON invalide.' }, 400, origin); }
  // honeypot: the hidden website input must remain blank.
  if (raw.website) return json({ success: true }, 200, origin);
  const phone = normalizePhone(raw.phone);
  const postalCode = String(raw.postalCode || '');
  const errors = [];
  for (const field of ['firstName', 'lastName', 'email', 'phone', 'address', 'city', 'postalCode', 'idempotency']) if (!String(raw[field] || '').trim()) errors.push(`${field} requis`);
  if (!CP_PATTERN.test(postalCode)) errors.push('Le projet doit être situé dans le Vaucluse (84).');
  if (!phone) errors.push('Téléphone invalide.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw.email || ''))) errors.push('Email invalide.');
  if (raw.consent !== true) errors.push('Consentement requis.');
  if (errors.length) return json({ success: false, errors }, 400, origin);

  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const submissionId = String(raw.idempotency);
  const existing = await timedFetch(`${base}/rest/v1/rank_rent_leads?submission_id=eq.${encodeURIComponent(submissionId)}&select=id,vud_status,vud_devis_id`, { headers: sbHeaders(env) }, fetcher);
  if (!existing.ok) return json({ success: false, message: 'Service temporairement indisponible.' }, 503, origin);
  const prior = await existing.json();
  if (prior?.length) return json({ success: true, duplicate: true, status: prior[0].vud_status || 'captured', devisId: prior[0].vud_devis_id || null }, 200, origin);

  const description = `Projet panneaux solaires à ${raw.city} (${postalCode}) dans le Vaucluse. Projet : ${raw.project || 'à étudier'}.`;
  const lead = { source_site: SITE_DOMAIN, niche: SITE_NICHE, departement: DEPT_CODE, cat_id: 37, cat_name: 'Panneaux photovoltaïques', nom: String(raw.lastName).trim(), prenom: String(raw.firstName).trim(), email: String(raw.email).trim().toLowerCase(), telephone: phone, adresse: String(raw.address).trim(), ville: String(raw.city).trim(), code_postal: postalCode, description, submission_id: submissionId, page_url: String(raw.pageUrl || `https://${SITE_DOMAIN}`).slice(0, 500), consent_at: new Date().toISOString(), vud_status: 'pending' };
  const saved = await timedFetch(`${base}/rest/v1/rank_rent_leads`, { method: 'POST', headers: { ...sbHeaders(env), prefer: 'return=representation' }, body: JSON.stringify(lead) }, fetcher);
  if (!saved.ok) return json({ success: false, message: 'Enregistrement impossible.' }, 502, origin);
  const record = (await saved.json())?.[0];
  const patch = async (data) => { try { await timedFetch(`${base}/rest/v1/rank_rent_leads?id=eq.${encodeURIComponent(record.id)}`, { method: 'PATCH', headers: sbHeaders(env), body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }) }, fetcher); } catch {} };

  let ping;
  try {
    const response = await timedFetch(VUD_PING_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: env.VUD_API_KEY, cat_id:'37', code_postal: postalCode, pays: 'fr', description, cpl_mini: '0' }) }, fetcher);
    ping = await response.json();
  } catch { await patch({ vud_status: 'ping_error' }); return json({ success: true, status: 'ping_error' }, 202, origin); }
  if (Number(ping.accept) !== 1) { await patch({ vud_status: 'no_buyer', vud_ping_buyers: Number(ping.buyers) || 0 }); return json({ success: true, status: 'no_buyer' }, 202, origin); }

  try {
    const mobile = phone.startsWith('06') || phone.startsWith('07');
    const response = await timedFetch(VUD_LEAD_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key: env.VUD_API_KEY, cat_id:'37', nom: lead.nom, prenom: lead.prenom, email: lead.email, tel: mobile ? '' : phone, mobile: mobile ? phone : '', adresse1: lead.adresse, cp: postalCode, ville: lead.ville, cp_projet: postalCode, ville_projet: lead.ville, pays: 'fr', tp: '1', description, site_name: SITE_DOMAIN, format_return: 'json' }) }, fetcher);
    const result = await response.json(); const devisId = result?.devis_data?.devis_id || null;
    await patch({ vud_status: devisId ? 'sent' : 'captured', vud_devis_id: devisId ? String(devisId) : null, vud_response: result });
    return json({ success: true, status: devisId ? 'sent' : 'captured', devisId }, devisId ? 200 : 202, origin);
  } catch { await patch({ vud_status: 'captured' }); return json({ success: true, status: 'captured' }, 202, origin); }
}
export const onRequestOptions = ({ request, env }) => allowed(request.headers.get('origin') || '', env) ? new Response(null, { status: 204, headers: { 'access-control-allow-origin': request.headers.get('origin') || `https://${SITE_DOMAIN}`, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } }) : json({ success: false }, 403, request.headers.get('origin') || '');
export const onRequestPost = (context) => handleLead(context);
export const onRequest = ({ request }) => json({ success: false, message: 'Méthode non autorisée.' }, 405, request.headers.get('origin') || '');
export { SITE_DOMAIN, SITE_NICHE, DEPT_CODE, CP_PATTERN };
