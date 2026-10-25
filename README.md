# Nemo

A personal AI. For everyone at home. Nemo is an independent family experience built around Hermes, in early preview.

**[Visit the Nemo website](https://ddzz12138.github.io/nemo/)**

This repository currently publishes the project announcement website from `docs/` using GitHub Pages. The app is in private family testing; public source, installation instructions, and downloads are being prepared for the first release.

The website contains fictional product examples and has no connection to a family's private Nemo server. The `VERSION` and `CHANGELOG.md` currently track the website publication, not an installable app release.

Home shows the vision; **How it works** shows the guided desktop setup; **About Nemo** explains Hermes and Nemo's family features. Shared family-calendar planning is labelled as a future feature. Optional connections and personal memory need their own setup.

Configure GitHub **Settings → Pages → Deploy from a branch → `main` → `/docs`** once. Website updates then go through a pull request; after merging to `main`, GitHub Pages publishes `docs/`. Keep `.nojekyll` in that folder and use relative asset paths so the site works under `/nemo/`.

Nemo is being built as free, open-source software under the MIT license. A home computer, compatible Hermes setup, and any AI-provider usage costs are separate.
