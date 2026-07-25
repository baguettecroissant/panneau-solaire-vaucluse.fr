import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import cloudflare from '@astrojs/cloudflare'; // Pages Functions are bundled from /functions by Wrangler.
export default defineConfig({site:'https://panneau-solaire-vaucluse.fr',output:'static',integrations:[sitemap({filter:(page)=>!page.includes('/merci')})]});
