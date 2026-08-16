import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalizeLeadPageUrl, handleLead } from '../functions/api/lead.js';

const source = readFileSync(new URL('../functions/api/lead.js', import.meta.url), 'utf8');
const formSource = readFileSync(new URL('../src/components/LeadForm.astro', import.meta.url), 'utf8');

const validBody = (overrides = {}) => ({
  firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test',
  phone: '0612345678', address: '1 rue du Test', city: 'Avignon',
  postalCode: '84000', idempotency: 'fixture-idempotency-1',
  consent: true, consent_timestamp: '2026-08-15T10:00:00.000Z',
  pageUrl: 'https://panneau-solaire-vaucluse.fr/devis?utm_source=test#form',
  ...overrides,
});

const makeRequest = (overrides) => new Request('https://panneau-solaire-vaucluse.fr/api/lead', {
  method: 'POST',
  headers: {
    origin: 'https://panneau-solaire-vaucluse.fr',
    'content-type': 'application/json',
    'cf-connecting-ip': '192.0.2.1',
  },
  body: JSON.stringify(validBody(overrides)),
});

const fixtureEnv = {
  SUPABASE_URL: 'https://fixture.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role',
  VUD_API_KEY: 'fixture-vud-key',
};

const row = (overrides = {}) => ({
  id: '81000000-0000-4000-8000-000000000001',
  vud_status: 'pending',
  vud_devis_id: null,
  vud_processing_at: null,
  ...overrides,
});

const isRankRent = (url) => String(url).includes('/rest/v1/rank_rent_leads');
const methodOf = (options = {}) => options.method || 'GET';

test('canonicalise la page de consentement sur le domaine Vaucluse sans tracking', () => {
  assert.equal(
    canonicalizeLeadPageUrl('https://panneau-solaire-vaucluse.fr/devis?utm_source=test#form'),
    'https://panneau-solaire-vaucluse.fr/devis',
  );
  assert.equal(
    canonicalizeLeadPageUrl('https://www.panneau-solaire-vaucluse.fr/devis/'),
    'https://www.panneau-solaire-vaucluse.fr/devis/',
  );
  assert.throws(() => canonicalizeLeadPageUrl(''));
  assert.throws(() => canonicalizeLeadPageUrl('https://attacker.example/devis'));
  assert.throws(() => canonicalizeLeadPageUrl('http://panneau-solaire-vaucluse.fr/devis'));
  assert.throws(() => canonicalizeLeadPageUrl('https://user@panneau-solaire-vaucluse.fr/devis'));
});

test('persiste la version et la date, jamais le texte complet de consentement', () => {
  assert.match(source, /CONSENT_VERSION\s*=\s*'vud-phone-v1'/);
  assert.match(formSource, /ViteUnDevis\.com et ses partenaires/);
  assert.match(formSource, /data\.pageUrl\s*=\s*location\.href/);
  assert.match(formSource, /data\.consent_timestamp\s*=\s*new Date\(\)\.toISOString\(\)/);
  const persistence = source.match(/const lead = \{[\s\S]*?const saved = await timedFetch/)?.[0] ?? '';
  assert.ok(persistence);
  assert.match(persistence, /submission_id\s*:\s*submissionId/);
  assert.match(persistence, /consent_at\s*:\s*consentTimestamp/);
  assert.match(persistence, /consent_version\s*:\s*CONSENT_VERSION/);
  assert.match(persistence, /page_url\s*:\s*consentUrl/);
  assert.doesNotMatch(persistence, /consent_text\s*:/);
});

test('toutes les relectures canoniques exigent une provenance serveur vérifiée', () => {
  const lookupDefinition = source.match(/const canonicalLookupUrl[\s\S]*?;/)?.[0] ?? '';
  assert.ok(lookupDefinition);
  assert.match(lookupDefinition, /source_site=eq\./);
  assert.match(lookupDefinition, /submission_id=eq\./);
  assert.match(lookupDefinition, /lead_hub_server_verified=eq\.true/);
  assert.doesNotMatch(source, /submission_id=eq\.\$\{[^}]+\}&select=/);
});

test('un squatter non vérifié ne bloque pas la persistance ni la route VUD', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const href = String(url);
    const method = methodOf(options);
    calls.push({ url: href, options });
    if (isRankRent(href) && method === 'GET') {
      if (href.includes('lead_hub_server_verified=eq.true')) return new Response('[]', { status: 200 });
      return new Response(JSON.stringify([row({ id: 'unverified-squatter' })]), { status: 200 });
    }
    if (isRankRent(href) && method === 'POST') return new Response(JSON.stringify([row()]), { status: 201 });
    if (isRankRent(href) && method === 'PATCH') {
      const payload = JSON.parse(options.body);
      if (payload.vud_status === 'processing') {
        return new Response(JSON.stringify([row({ vud_status: 'processing', vud_processing_at: payload.vud_processing_at })]), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }
    if (href.includes('/api/ping.php')) return new Response('{"accept":0,"buyers":0}', { status: 200 });
    throw new Error(`appel réseau inattendu: ${method} ${href}`);
  };

  const result = await handleLead({ request: makeRequest(), env: fixtureEnv }, fetcher);
  assert.equal(result.status, 202);
  assert.deepEqual(await result.json(), { success: true, status: 'no_buyer' });
  assert.equal(calls.filter((call) => call.url.includes('/api/ping.php')).length, 1);
  assert.equal(calls.filter((call) => isRankRent(call.url) && methodOf(call.options) === 'POST').length, 1);
});

test('un pending orphelin est repris sous lease au retry au lieu de court-circuiter VUD', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const href = String(url);
    const method = methodOf(options);
    calls.push({ url: href, options });
    if (isRankRent(href) && method === 'GET') return new Response(JSON.stringify([row()]), { status: 200 });
    if (isRankRent(href) && method === 'PATCH') {
      const payload = JSON.parse(options.body);
      if (payload.vud_status === 'processing') {
        assert.match(String(payload.vud_processing_token), /^[0-9a-f-]{36}$/i);
        assert.ok(payload.vud_processing_at);
        return new Response(JSON.stringify([row({ vud_status: 'processing', vud_processing_at: payload.vud_processing_at })]), { status: 200 });
      }
      assert.equal(payload.vud_status, 'no_buyer');
      assert.equal(payload.vud_processing_token, null);
      assert.equal(payload.vud_processing_at, null);
      return new Response(null, { status: 204 });
    }
    if (href.includes('/api/ping.php')) return new Response('{"accept":0,"buyers":0}', { status: 200 });
    throw new Error(`appel réseau inattendu: ${method} ${href}`);
  };

  const result = await handleLead({ request: makeRequest({ idempotency: 'orphan-pending-1' }), env: fixtureEnv }, fetcher);
  assert.equal(result.status, 202);
  assert.deepEqual(await result.json(), { success: true, status: 'no_buyer' });
  assert.equal(calls.filter((call) => call.url.includes('/api/ping.php')).length, 1);
  assert.equal(calls.filter((call) => isRankRent(call.url) && methodOf(call.options) === 'POST').length, 0);
});

test('une issue VUD terminale reste idempotente et ne relance aucun appel commercial', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify([row({ vud_status: 'sent', vud_devis_id: 'devis-1' })]), { status: 200 });
  };
  const result = await handleLead({ request: makeRequest({ idempotency: 'terminal-1' }), env: fixtureEnv }, fetcher);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    success: true,
    duplicate: true,
    status: 'sent',
    devisId: 'devis-1',
  });
  assert.equal(calls.length, 1);
});
