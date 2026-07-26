import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=(p)=>readFileSync(`${root}${p}`,'utf8');

const commercial=['src/pages/index.astro','src/pages/tarifs.astro','src/pages/aides-panneau-solaire-84.astro','src/pages/guide-solaire-mas-provencal.astro','src/pages/devis.astro','src/pages/communes.astro'];

test('all major commercial pages use local real photography and bounded containers',()=>{
  for(const file of commercial){const source=read(file);assert.match(source,/Photo|<img/,`${file} missing photography`);assert.match(source,/container/,`${file} missing bounded container`);}
});

test('editorial and local page data no longer reference fake SVG illustrations',()=>{
  const source=read('src/data/editorial.js')+read('src/components/LocalPage.astro')+read('src/pages/index.astro');
  assert.doesNotMatch(source,/hero-panneau-solaire-vaucluse\.svg|guide-[a-z-]+\.svg/);
  assert.match(source,/images\/photos/);
});

test('photo library ships responsive WebP files with attribution metadata',()=>{
  const photos=JSON.parse(read('src/data/photos.json'));assert.ok(photos.length>=7);
  for(const photo of photos){for(const src of [photo.src,photo.src.replace('.webp','-768.webp')]){const path=`${root}public${src}`;assert.ok(existsSync(path),`missing ${path}`);assert.ok(statSync(path).size>20_000,`tiny ${path}`);assert.ok(statSync(path).size<500_000,`oversized ${path}`);}assert.ok(photo.author&&photo.license&&photo.source&&photo.alt);}
});

test('core CSS prevents horizontal overflow and uses a readable type scale',()=>{
  const css=read('src/styles/global.css');
  for(const marker of ['overflow-x: clip','overflow-wrap: anywhere','min-width: 0','clamp(2.25rem, 5vw, 4.75rem)','@media (max-width: 760px)']) assert.match(css,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('commercial guides and decision pages have substantial editorial depth',()=>{
  for(const file of ['src/pages/tarifs.astro','src/pages/aides-panneau-solaire-84.astro','src/pages/guide-solaire-mas-provencal.astro']) assert.ok(read(file).length>6500,`${file} is still thin`);
  const editorial=read('src/data/editorial.js'); assert.ok(editorial.length>22000,'guide data is still thin');
});

test('quote form captures project, property, energy use and contact details',()=>{
  const form=read('src/components/LeadForm.astro');
  for(const name of ['project','projectTiming','postalCode','city','roofType','surfaceToiture','orientation','annualConsumption','electricityBill','ownership','firstName','lastName','phone','email','address','consent']) assert.match(form,new RegExp(`name=["']${name}["']`),`missing ${name}`);
  assert.match(form,/Étape 4/);assert.match(form,/aria-current/);assert.match(form,/data-summary/);
});

test('lead wizard initialization never scrolls visitors to the form',()=>{
  const form=read('src/components/LeadForm.astro');
  assert.match(form,/setStep=\(target,shouldScroll=true\)/);
  assert.match(form,/setStep\(1,false\)/);
});

test('mobile pages provide a scroll-triggered sticky quote CTA',()=>{
  const layout=read('src/layouts/BaseLayout.astro');
  const css=read('src/styles/global.css');
  assert.match(layout,/class="mobile-sticky-cta"/);
  assert.match(layout,/data-mobile-sticky-cta/);
  assert.match(layout,/scrollY\s*>\s*320/);
  assert.match(css,/\.mobile-sticky-cta/);
  assert.match(css,/@media \(max-width: 760px\)/);
  assert.doesNotMatch(css,/\.mobile-sticky-cta>a\{[^}]*var\(--secondary\)/);
  assert.match(css,/\.mobile-sticky-cta>a\{[^}]*background-color:#f3ba27/);
});
