const SITE_DOMAIN = 'panneau-solaire-vaucluse.fr';
const SITE_NICHE = 'panneau-solaire';
const DEPT_CODE = '84';
const CP_PATTERN = /^84\d{3}$/;
const VUD_PING_URL = 'https://www.viteundevis.com/api/ping.php';
const VUD_LEAD_URL = 'https://www.viteundevis.com/api/get.php';
const MAX_BODY_BYTES = 16_384;
const VUD_LEASE_MS = 120_000;
const TERMINAL_VUD_STATUSES = new Set(['sent', 'captured', 'no_buyer']);
const CONSENT_TEXT = 'J’accepte d’être contacté(e) par téléphone par ViteUnDevis.com et ses partenaires afin de qualifier ma demande de devis.';
const CONSENT_VERSION = 'vud-phone-v1';

export function canonicalizeLeadPageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid_page_url');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('invalid_page_url'); }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.port
    || ![SITE_DOMAIN, `www.${SITE_DOMAIN}`].includes(url.hostname)
  ) throw new Error('invalid_page_url');
  url.search = '';
  url.hash = '';
  return `${url.origin}${url.pathname}`;
}

const allowed = (origin, env) => origin === `https://${SITE_DOMAIN}` || origin === `https://www.${SITE_DOMAIN}` || /^https:\/\/(?:[a-z0-9-]+\.)?panneau-solaire-vaucluse-fr\.pages\.dev$/.test(origin) || (env.ALLOW_LOCAL_ORIGIN === 'true' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
const json = (body, status = 200, origin = '') => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': origin || `https://${SITE_DOMAIN}`, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'Origin' } });
const normalizePhone = (value = '') => { let digits = String(value).replace(/\D/g, ''); if (digits.startsWith('0033')) digits = `0${digits.slice(4)}`; if (digits.startsWith('33') && digits.length === 11) digits = `0${digits.slice(2)}`; return /^0[1-9]\d{8}$/.test(digits) ? digits : null; };
const sbHeaders = (env) => ({
  'content-type': 'application/json',
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
});
const timedFetch = async (url, options, fetcher) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000); try { return await fetcher(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); } };
const canonicalSelect = 'id,vud_status,vud_devis_id,vud_processing_at,nom,prenom,email,telephone,adresse,ville,code_postal,description,page_url,consent_at,vud_response';
const canonicalLookupUrl = (base, submissionId) => `${base}/rest/v1/rank_rent_leads?source_site=eq.${encodeURIComponent(SITE_DOMAIN)}&submission_id=eq.${encodeURIComponent(submissionId)}&lead_hub_server_verified=eq.true&select=${canonicalSelect}`;
const terminalResponse = (record, origin) => TERMINAL_VUD_STATUSES.has(record?.vud_status)
  ? json({ success: true, duplicate: true, status: record.vud_status, devisId: record.vud_devis_id || null }, 200, origin)
  : null;

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
  const consentIp = request.headers.get('cf-connecting-ip') || '';
  const consentTimestamp = String(raw.consent_timestamp || '').trim().slice(0, 40);
  let consentUrl;
  try { consentUrl = canonicalizeLeadPageUrl(raw.pageUrl); } catch { return json({ success: false, errors: ['Preuve de consentement invalide.'] }, 400, origin); }
  if (!consentIp || !consentTimestamp) return json({ success: false, errors: ['Preuve de consentement incomplète.'] }, 400, origin);
  const phone = normalizePhone(raw.phone);
  const postalCode = String(raw.postalCode || '');
  const errors = [];
  for (const field of ['firstName', 'lastName', 'email', 'phone', 'address', 'city', 'postalCode', 'idempotency']) if (!String(raw[field] || '').trim()) errors.push(`${field} requis`);
  if (!CP_PATTERN.test(postalCode)) errors.push('Le projet doit être situé dans le Vaucluse (84).');
  if (!phone) errors.push('Téléphone invalide.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw.email || ''))) errors.push('Email invalide.');
  if (raw.consent !== true) errors.push('Consentement requis.');
  if (errors.length) return json({ success: false, errors }, 400, origin);

  const detail = (value, fallback = 'non précisé') => String(value || fallback).replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
  const description = [
    `Projet panneaux solaires à ${raw.city} (${postalCode}) dans le Vaucluse.`,
    `Demande : ${detail(raw.project)}. Statut : ${detail(raw.ownership)}. Calendrier : ${detail(raw.projectTiming)}.`,
    `Toiture : ${detail(raw.roofType)}, surface ${detail(raw.surfaceToiture)}, orientation ${detail(raw.orientation)}, ombres ${detail(raw.shading)}.`,
    `Énergie : ${detail(raw.annualConsumption)}, facture ${detail(raw.electricityBill)}, usages ${detail(raw.uses)}, priorité ${detail(raw.priority)}.`
  ].join(' ');
  const submissionId = String(raw.idempotency);
  const lead = { source_site: SITE_DOMAIN, niche: SITE_NICHE, departement: DEPT_CODE, cat_id: 37, cat_name: 'Panneaux photovoltaïques', nom: String(raw.lastName).trim(), prenom: String(raw.firstName).trim(), email: String(raw.email).trim().toLowerCase(), telephone: phone, adresse: String(raw.address).trim(), ville: String(raw.city).trim(), code_postal: postalCode, description, submission_id: submissionId, page_url: consentUrl, consent_at: consentTimestamp, consent_version: CONSENT_VERSION, vud_response: { consent: { date: consentTimestamp, ip: consentIp, text: CONSENT_TEXT, url: consentUrl } }, vud_status: 'pending' };

  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const canonicalUrl = canonicalLookupUrl(base, submissionId);
  const existing = await timedFetch(canonicalUrl, { headers: sbHeaders(env) }, fetcher);
  if (!existing.ok) return json({ success: false, message: 'Service temporairement indisponible.' }, 503, origin);
  let record = (await existing.json())?.[0] || null;
  const priorTerminal = terminalResponse(record, origin);
  if (priorTerminal) return priorTerminal;

  if (!record) {
    const saved = await timedFetch(`${base}/rest/v1/rank_rent_leads`, { method: 'POST', headers: { ...sbHeaders(env), prefer: 'return=representation' }, body: JSON.stringify(lead) }, fetcher);
    if (!saved.ok) {
      if (saved.status === 409) {
        const existingAfterConflict = await timedFetch(canonicalUrl, { headers: sbHeaders(env) }, fetcher);
        if (existingAfterConflict.ok) record = (await existingAfterConflict.json())?.[0] || null;
      }
      if (!record) return json({ success: false, message: 'Enregistrement impossible.' }, 502, origin);
      const conflictTerminal = terminalResponse(record, origin);
      if (conflictTerminal) return conflictTerminal;
    } else {
      record = (await saved.json())?.[0] || null;
    }
  }

  if (!record?.id) return json({ success: false, message: 'Enregistrement impossible.' }, 502, origin);

  const leaseToken = crypto.randomUUID();
  const leaseStartedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - VUD_LEASE_MS).toISOString();
  const claimFilter = `(vud_status.in.(pending,ping_error),vud_status.is.null,and(vud_status.eq.processing,vud_processing_at.lt.${staleBefore}))`;
  const claimUrl = `${base}/rest/v1/rank_rent_leads?id=eq.${encodeURIComponent(record.id)}&lead_hub_server_verified=eq.true&or=${encodeURIComponent(claimFilter)}&select=${canonicalSelect}`;
  const claim = await timedFetch(claimUrl, {
    method: 'PATCH',
    headers: { ...sbHeaders(env), prefer: 'return=representation' },
    body: JSON.stringify({
      vud_status: 'processing',
      vud_processing_token: leaseToken,
      vud_processing_at: leaseStartedAt,
      updated_at: leaseStartedAt,
    }),
  }, fetcher);
  if (!claim.ok) return json({ success: false, message: 'Service temporairement indisponible.' }, 503, origin);
  const claimed = (await claim.json())?.[0] || null;
  if (!claimed) {
    const current = await timedFetch(canonicalUrl, { headers: sbHeaders(env) }, fetcher);
    if (current.ok) {
      const latest = (await current.json())?.[0] || null;
      const latestTerminal = terminalResponse(latest, origin);
      if (latestTerminal) return latestTerminal;
    }
    return json({ success: true, status: 'processing' }, 202, origin);
  }
  record = { ...record, ...claimed };

  const finalize = async (data) => {
    try {
      const finalUrl = `${base}/rest/v1/rank_rent_leads?id=eq.${encodeURIComponent(record.id)}&lead_hub_server_verified=eq.true&vud_processing_token=eq.${encodeURIComponent(leaseToken)}`;
      const response = await timedFetch(finalUrl, {
        method: 'PATCH',
        headers: sbHeaders(env),
        body: JSON.stringify({
          ...data,
          vud_processing_token: null,
          vud_processing_at: null,
          updated_at: new Date().toISOString(),
        }),
      }, fetcher);
      return response.ok;
    } catch {
      return false;
    }
  };

  const persisted = {
    nom: record.nom || lead.nom,
    prenom: record.prenom || lead.prenom,
    email: record.email || lead.email,
    telephone: record.telephone || lead.telephone,
    adresse: record.adresse || lead.adresse,
    ville: record.ville || lead.ville,
    code_postal: record.code_postal || lead.code_postal,
    description: record.description || lead.description,
  };
  const persistedConsent = record.vud_response?.consent || lead.vud_response.consent;

  let ping;
  try {
    const response = await timedFetch(VUD_PING_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: env.VUD_API_KEY, cat_id:'37', code_postal: persisted.code_postal, pays: 'fr', description: persisted.description, cpl_mini: '0' }) }, fetcher);
    ping = await response.json();
  } catch {
    await finalize({ vud_status: 'ping_error' });
    return json({ success: true, status: 'ping_error' }, 202, origin);
  }
  if (Number(ping.accept) !== 1) {
    await finalize({ vud_status: 'no_buyer', vud_ping_buyers: Number(ping.buyers) || 0 });
    return json({ success: true, status: 'no_buyer' }, 202, origin);
  }

  try {
    const mobile = persisted.telephone.startsWith('06') || persisted.telephone.startsWith('07');
    const response = await timedFetch(VUD_LEAD_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key: env.VUD_API_KEY, cat_id:'37', nom: persisted.nom, prenom: persisted.prenom, email: persisted.email, tel: mobile ? '' : persisted.telephone, mobile: mobile ? persisted.telephone : '', adresse1: persisted.adresse, cp: persisted.code_postal, ville: persisted.ville, cp_projet: persisted.code_postal, ville_projet: persisted.ville, pays: 'fr', tp: '1', description: persisted.description, site_name: SITE_DOMAIN, format_return: 'json', consent_date: persistedConsent.date, consent_ip: persistedConsent.ip, consent_texte: persistedConsent.text, consent_url: persistedConsent.url }) }, fetcher);
    const result = await response.json();
    const devisId = result?.devis_data?.devis_id || null;
    await finalize({ vud_status: devisId ? 'sent' : 'captured', vud_devis_id: devisId ? String(devisId) : null, vud_response: { consent: persistedConsent, response: result } });
    return json({ success: true, status: devisId ? 'sent' : 'captured', devisId }, devisId ? 200 : 202, origin);
  } catch {
    await finalize({ vud_status: 'captured' });
    return json({ success: true, status: 'captured' }, 202, origin);
  }
}

export const onRequestOptions = ({ request, env }) => allowed(request.headers.get('origin') || '', env) ? new Response(null, { status: 204, headers: { 'access-control-allow-origin': request.headers.get('origin') || `https://${SITE_DOMAIN}`, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } }) : json({ success: false }, 403, request.headers.get('origin') || '');
export const onRequestPost = (context) => handleLead(context);
export const onRequest = ({ request }) => json({ success: false, message: 'Méthode non autorisée.' }, 405, request.headers.get('origin') || '');
export { SITE_DOMAIN, SITE_NICHE, DEPT_CODE, CP_PATTERN };
