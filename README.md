# Nemo

A personal AI. For everyone at home. Nemo is an independent family experience built around Hermes, in early preview.

**[Visit the Nemo website](https://ddzz12138.github.io/nemo/)**

This repository contains the project announcement website in `docs/`, published through GitHub Pages. The app is in private family testing; public source, installation instructions, and downloads are being prepared for the first release.

The website contains fictional product examples and has no connection to a family's private Nemo server. The `VERSION` and `CHANGELOG.md` currently track the website publication, not an installable app release.

Home shows the vision; **How it works** shows the guided desktop setup; **About Nemo** explains Hermes and Nemo's family features. Shared family-calendar planning is labelled as a future feature. Optional connections and personal memory need their own setup.

The footer links to **Privacy**, **Terms & safety**, **Licences & credits**, and the public contact address. These explain the website and self-hosted app separately, connected-provider data handling and the current invited-adult preview. They do not claim Google verification or approval for children to use a particular AI account. Public child access remains pending provider and safety review.

## Preview and verification

Use Node.js 24 or later; there are no npm dependencies.

```sh
node scripts/prepare-fonts.mjs
node --test test/website.test.mjs
node --check docs/app.js
node preview-pages.mjs
```

Open [the local preview](http://127.0.0.1:8794/nemo/). The font command downloads and verifies the two official Ranade weights for this website's use. Its binaries stay out of Git; see [font licensing and provenance](docs/assets/fonts/README.md). Visitors load fonts from Nemo, without requests to Fontshare.

Browser verification also covers mobile layouts, native disclosures, keyboard focus, the coordinated conversation/headline loop, visibility pauses, scroll navigation, reduced motion and failure recovery. The automated checks protect release contracts and font integrity; they do not replace visual/browser checks.

## Publishing

The deployment workflow is [website.yml](.github/workflows/website.yml). It verifies pull requests without deploying them. A verified push to `main` prepares local font assets and publishes only `docs/` through GitHub Pages.

**Before rolling out this workflow, switch Settings → Pages → Source to GitHub Actions.** The previous branch-based publishing method would omit the separately downloaded fonts. This repository change does not itself switch that setting or deploy the branch. Keep `.nojekyll`, relative `/nemo/`-compatible links and consistent asset versions.

If a download, checksum or test fails, the workflow stops before deployment. Keep the previous deployment until the release is verified; revert an unsuccessful website release through the normal pull-request process.

Nemo is being built as free, open-source software under the MIT license. Ranade is separately licensed by Indian Type Foundry. A home computer, compatible Hermes setup, and any AI-provider usage costs are separate.
