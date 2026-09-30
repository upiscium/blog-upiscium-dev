import { defineConfig } from 'astro/config';
import remarkGfm from 'remark-gfm';
import {
  qiitaMarkdownValidationIntegration,
  remarkCodeFenceFilenames,
  remarkQiitaNotes,
} from './src/lib/markdown/qiita-compat.mjs';

export default defineConfig({
  site: 'https://upiscium.dev',
  output: 'static',
  integrations: [qiitaMarkdownValidationIntegration()],
  markdown: {
    remarkPlugins: [remarkGfm, remarkQiitaNotes, remarkCodeFenceFilenames],
  },
});
