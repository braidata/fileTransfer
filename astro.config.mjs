import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel/serverless';
import tailwind from '@astrojs/tailwind';
import react from "@astrojs/react";
import { loadEnv } from 'vite';
import auth from 'auth-astro'
import Google from "@auth/core/providers/google"
 
const env = loadEnv('production', process.cwd(), '');

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: vercel({analytics: true}),
  integrations: [    tailwind({
    // Example: Provide a custom path to a Tailwind config file
    configFile: './tailwind.config.cjs',
  }), react({
    
  }),
  auth({
    providers: [
      Google({
        clientId: env.GOOGLE_ID,
        clientSecret: env.GOOGLE_SECRET
      })
    ]
  })

]
});