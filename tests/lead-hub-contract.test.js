import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalizeLeadPageUrl, handleLead } from '../functions/api/lead.js';

const source = readFileSync(new URL('../functions/api/lead.js', import.meta.url), 'utf8');
const formSource = readFileSync(new URL('../src/components/LeadForm.astro', import.meta.url), 'utf8');

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

test('récupère une collision unique par relecture sans nouvel appel commercial', () => {
  assert.match(source, /saved\.status\s*===\s*409/);
  assert.match(source, /existingAfterConflict|conflictExisting/);
  assert.match(source, /idempotent\s*:\s*true/);
  const conflictBranch = source.match(/if \(!saved\.ok\)[\s\S]*?const record =/)?.[0] ?? '';
  assert.ok(conflictBranch);
  assert.doesNotMatch(conflictBranch, /ping\.php|get\.php/);
});

test('une collision 409 est relue sur le même site puis sort avant VUD', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return new Response('[]', { status: 200 });
    if (calls.length === 2) return new Response('{"code":"23505"}', { status: 409 });
    if (calls.length === 3) {
      return new Response('[{"id":"fixture","vud_status":"pending","vud_devis_id":null}]', { status: 200 });
    }
    throw new Error('appel réseau inattendu');
  };
  const request = new Request('https://panneau-solaire-vaucluse.fr/api/lead', {
    method: 'POST',
    headers: {
      origin: 'https://panneau-solaire-vaucluse.fr',
      'content-type': 'application/json',
      'cf-connecting-ip': '192.0.2.1',
    },
    body: JSON.stringify({
      firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test',
      phone: '0612345678', address: '1 rue du Test', city: 'Avignon',
      postalCode: '84000', idempotency: 'fixture-idempotency-1',
      consent: true, consent_timestamp: '2026-08-15T10:00:00.000Z',
      pageUrl: 'https://panneau-solaire-vaucluse.fr/devis?utm_source=test#form',
    }),
  });
  const result = await handleLead({
    request,
    env: {
      SUPABASE_URL: 'https://fixture.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role',
      VUD_API_KEY: 'fixture-vud-key',
    },
  }, fetcher);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    success: true,
    duplicate: true,
    idempotent: true,
    status: 'pending',
    devisId: null,
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /source_site=eq\.panneau-solaire-vaucluse\.fr/);
  assert.equal(calls[2].url, calls[0].url);
  const persisted = JSON.parse(calls[1].options.body);
  assert.equal(persisted.consent_version, 'vud-phone-v1');
  assert.equal(persisted.page_url, 'https://panneau-solaire-vaucluse.fr/devis');
  assert.equal('consent_text' in persisted, false);
});
