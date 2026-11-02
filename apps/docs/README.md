# docs

Source for the developer guide at <https://equationalapplications.github.io/expo-llm-wiki/>.
Built with [Starlight](https://starlight.astro.build/) (Astro). Not published to npm.

```bash
pnpm --filter docs dev      # http://localhost:4321/expo-llm-wiki/
pnpm --filter docs build    # static site in apps/docs/dist
```

Pages live in `src/content/docs/` as `.md` / `.mdx`. The sidebar is generated from the
folder structure; order pages with `sidebar.order` in frontmatter.

Deployed by `.github/workflows/deploy.yml` together with ScopeLab and WikiDemo.
