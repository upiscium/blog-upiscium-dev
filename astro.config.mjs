import { defineConfig } from 'astro/config';
import remarkGfm from 'remark-gfm';

export default defineConfig({
  site: 'https://upiscium.dev',
  output: 'static',
  markdown: {
    remarkPlugins: [remarkGfm],
  },
});
