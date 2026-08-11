# Bundled fonts

Cockpit Tools bundles these fonts for offline use:

- Inter variable (`opsz`, `wght`), used for Latin text.
- Noto Sans SC variable (`wght`), used for Simplified Chinese text.

The files come from the official Google Fonts repository at commit
`038b637da7b3fd956a4ed93ffc607c3d5e4ce172` and are distributed under the
SIL Open Font License 1.1. The corresponding license files are stored in
`public/licenses/fonts` so Vite includes them in packaged builds.

Run `node scripts/download-fonts.mjs` to retrieve the pinned source files
through the local SOCKS5 proxy at `127.0.0.1:20081`.
