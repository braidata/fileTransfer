import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel/serverless';
import tailwind from '@astrojs/tailwind';
import react from "@astrojs/react";

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: vercel(),
  integrations: [    tailwind({
    // Example: Provide a custom path to a Tailwind config file
    configFile: './tailwind.config.cjs',
  }), react({
    
  }),]
});