import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = (path) => readFileSync(`${root}${path}`, 'utf8');

test('each Vaucluse guide contains a complete editorial body, FAQ and related links', async () => {
  const { guides } = await import(`${root}src/data/guides.js`);
  assert.equal(guides.length, 8);
  for (const guide of guides) {
    assert.ok(guide.heroImage, `${guide.slug} needs an image`);
    assert.ok(guide.sections?.length >= 4, `${guide.slug} needs at least four sections`);
    assert.ok(guide.sections.every((section) => section.paragraphs?.length >= 2), `${guide.slug} needs substantive sections`);
    assert.ok(guide.faqs?.length >= 4, `${guide.slug} needs a local FAQ`);
    assert.ok(guide.relatedSlugs?.length >= 2, `${guide.slug} needs internal guide links`);
  }
});

test('local pages provide the required five local blocks, tools, FAQ and dense internal linking', () => {
  const page = source('src/components/LocalPage.astro');
  for (const marker of ['localContent(', 'SolarCalculator', 'SunMap', 'FAQ', 'nearby', 'guides/', 'aides-panneau-solaire-84', 'tarifs/', 'application/ld+json']) {
    assert.match(page, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.ok((page.match(/<section/g) || []).length >= 8, 'local page must have a real editorial journey');
});

test('legal and privacy pages contain a complete information framework instead of a placeholder', () => {
  for (const file of ['src/pages/mentions-legales.astro', 'src/pages/politique-confidentialite.astro']) {
    const page = source(file);
    assert.ok(page.length >= 3500, `${file} is too short`);
    for (const heading of ['<h2>', 'Données', 'Hébergement', 'droits']) assert.match(page, new RegExp(heading, 'i'));
    assert.doesNotMatch(page, /seront complétées|à compléter avant publication/i);
  }
});

test('home page ships real visual image assets, a calculator and topic clusters', () => {
  const home = source('src/pages/index.astro');
  for (const marker of ['Photo', 'SolarCalculator', 'guides/', 'communes/', 'tarifs/', 'aides-panneau-solaire-84']) assert.match(home, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('lead form guides a homeowner through project, property and contact steps', () => {
  const form = source('src/components/LeadForm.astro');
  for (const marker of ['data-step', 'Étape 1', 'Étape 2', 'Étape 3', 'surfaceToiture', 'projectTiming', 'previous', 'next']) assert.match(form, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
