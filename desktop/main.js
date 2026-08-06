'use strict';
// Cheaper menu-bar app. Runs the routing gateway as a child process and shows a
// small monitor window from the tray. Cross-platform (macOS menu bar / Windows
// & Linux tray). Build signed installers with `npm run dist` on each OS.
const { app, Tray, Menu, BrowserWindow, nativeImage, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.CHEAPER_PORT || '8787';
let tray = null;
let win = null;
let gateway = null;

function gatewayDir() {
  // Prefer the packaged copy; fall back to ~/.cheaper/gateway from the CLI installer.
  const packaged = path.join(process.resourcesPath || __dirname, 'gateway');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(os.homedir(), '.cheaper', 'gateway');
}

function py() {
  for (const cand of ['python3', 'python']) {
    try { if (spawnSync(cand, ['--version']).status === 0) return cand; } catch {}
  }
  return 'python3';
}

function startGateway() {
  if (gateway) return;
  const dir = gatewayDir();
  spawnSync(py(), ['-m', 'pip', 'install', '-r', path.join(dir, 'requirements.txt'),
    '--quiet', '--break-system-packages']);
  gateway = spawn(py(), ['-m', 'uvicorn', '--app-dir', path.join(dir, 'app'),
    'app:app', '--port', PORT], { stdio: 'ignore' });
  refreshMenu();
}

function stopGateway() {
  if (gateway) { gateway.kill(); gateway = null; refreshMenu(); }
}

function showMonitor() {
  if (win) { win.show(); return; }
  win = new BrowserWindow({
    width: 460, height: 560, resizable: false, title: 'Cheaper',
    webPreferences: { contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

function refreshMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: gateway ? 'Gateway: running' : 'Gateway: stopped', enabled: false },
    { type: 'separator' },
    { label: gateway ? 'Stop gateway' : 'Start gateway',
      click: () => (gateway ? stopGateway() : startGateway()) },
    { label: 'Open monitor', click: showMonitor },
    { label: 'Open dashboard in browser',
      click: () => shell.openExternal(`http://localhost:${PORT}/dashboard`) },
    { type: 'separator' },
    { label: 'Quit Cheaper', click: () => { stopGateway(); app.quit(); } },
  ]));
}

app.whenReady().then(() => {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Cheaper — adaptive model routing');
  refreshMenu();
  if (process.platform === 'darwin') app.dock && app.dock.hide();
});

app.on('window-all-closed', (e) => e.preventDefault()); // stay in the menu bar
