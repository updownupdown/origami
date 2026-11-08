import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://updownupdown.github.io',
  base: '/origami',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
