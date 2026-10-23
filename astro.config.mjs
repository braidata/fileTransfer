import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import react from '@astrojs/react';

// The playground is client-side; Connect API runs as a separate persistent service.
export default defineConfig({
  output: 'static',
  integrations: [tailwind({ configFile: './tailwind.config.cjs' }), react()],
});
