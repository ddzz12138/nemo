# Ranade webfonts

Ranade is designed by Eashna Ranade and distributed by Indian Type Foundry through [Fontshare](https://www.fontshare.com/fonts/ranade).

Applicable terms: [ITF Free Font License 2.0, 17 August 2026](https://www.fontshare.com/licenses/itf-ffl). The font is separately licensed; Nemo's MIT licence applies to Nemo's source, not to Ranade. Obtain and review the current official terms before using these fonts in another project.

The licence permits self-hosting for the licensee's own website, while restricting redistribution through repositories. The WOFF2 binaries are therefore ignored by Git. `scripts/prepare-fonts.mjs` downloads the official regular and medium assets for this website during preview/deployment, verifies their exact SHA-256 hashes, and leaves them unmodified. No font conversion, subsetting or metadata changes are performed. Visitors load these files from Nemo's own website, without a runtime Fontshare request.

If a download or hash check fails, deployment stops and the current published website remains in place. Font updates require an explicit source/hash review. Do not copy these binaries into the public source repository, a font collection or a general download release.
