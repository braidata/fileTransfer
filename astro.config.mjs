import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel/serverless';
import tailwind from '@astrojs/tailwind';
import react from '@astrojs/react';

export default defineConfig({
  output: 'server',
  adapter: vercel({ analytics: true }),
  integrations: [tailwind({ configFile: './tailwind.config.cjs' }), react()],
});
