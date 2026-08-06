# Cheaper desktop (menu-bar app)

A small tray / menu-bar app that starts the routing gateway and shows live savings.

This is a **scaffold ready to build** — producing signed `.dmg` (macOS) and `.exe`
(Windows) installers requires running the build on each OS with signing certificates,
which can't be done in a cloud sandbox. On a Mac or PC with Node installed:

```bash
cd desktop
npm install
npm start          # run it locally
npm run dist       # build an installer for the current OS (electron-builder)
```

`npm run dist:mac` / `dist:win` / `dist:linux` target a specific platform. Add your
Apple Developer ID / Windows signing config to `build` in `package.json` for signed,
notarized artifacts. `assets/trayTemplate.png` (a small monochrome icon) is expected;
drop one in before building — the app runs without it (blank tray icon) otherwise.

The app bundles the gateway (`extraResources`) and also falls back to the copy the
CLI installs at `~/.cheaper/gateway`.
