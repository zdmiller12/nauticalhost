// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // This is a fully static site with no <Image> usage and no Astro sessions,
  // so skip the Cloudflare Images/KV bindings the adapter provisions by default.
  adapter: cloudflare({ imageService: 'passthrough' }),
  session: false,
  vite: {
    plugins: [tailwindcss()],
  },
});
