const path = require('node:path');
const { app, BrowserWindow, dialog, shell } = require('electron');

let service = null;
let mainWindow = null;
let quitting = false;

app.setName('JNU 蹲课抢课助手');
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

async function createWindow() {
  process.env.JNU_RUNTIME_DIR = path.join(app.getPath('userData'), 'runtime');
  const { startServer } = require('./src/server');
  service = await startServer(0);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#08152f',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    title: 'JNU 蹲课抢课助手',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  const appUrl = `http://127.0.0.1:${service.port}`;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === appUrl || url.startsWith(`${appUrl}/`)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  await mainWindow.loadURL(appUrl);
}

if (hasSingleInstanceLock) {
  app.whenReady().then(createWindow).catch(error => {
    dialog.showErrorBox('JNU 蹲课抢课助手启动失败', error.stack || error.message);
    app.exit(1);
  });
}

app.on('window-all-closed', async () => {
  if (quitting) return;
  quitting = true;
  if (service) await service.shutdown().catch(() => {});
  app.quit();
});
