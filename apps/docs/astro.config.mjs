// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const repo = 'https://github.com/equationalapplications/expo-llm-wiki';

// Served from GitHub Pages at https://equationalapplications.github.io/expo-llm-wiki/
// alongside the ScopeLab and WikiDemo apps (see .github/workflows/deploy.yml).
export default defineConfig({
  site: 'https://equationalapplications.github.io',
  base: '/expo-llm-wiki',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'LLM Wiki',
      description:
        'Persistent, local-first memory for AI agents. TypeScript + SQLite for Expo, React, and Node.js.',
      logo: { src: './src/assets/logo.svg', replacesTitle: false },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/apps/docs/` },
      lastUpdated: false,
      customCss: ['./src/styles/custom.css'],
      // Search engine ownership verification (Bing Webmaster Tools). The Google
      // Search Console token is the public/google*.html file. Keep both, or the
      // properties lose verification.
      head: [{ tag: 'meta', attrs: { name: 'msvalidate.01', content: '9B4234C102820E0A07B8D9C5B0A06CC0' } }],
      sidebar: [
        { label: 'Start here', items: [{ autogenerate: { directory: 'start' } }] },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Recipes', items: [{ autogenerate: { directory: 'recipes' } }] },
        { label: 'Packages', items: [{ autogenerate: { directory: 'packages' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        {
          label: 'Project',
          items: [
            { label: 'Live demos', slug: 'project/demos' },
            { label: 'Security', slug: 'project/security' },
            { label: 'Contributing', slug: 'project/contributing' },
            { label: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md`, attrs: { target: '_blank' } },
          ],
        },
      ],
    }),
  ],
});
