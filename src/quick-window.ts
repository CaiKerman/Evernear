import { BrowserWindow, Menu, screen, clipboard, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import type { Store } from './store.js';
import type { QuickInput } from './quick-input.js';

// A normal desktop window above the work area's lower edge. No global topmost
// level, shell injection or taskbar-icon displacement; fullscreen apps cover it.
export function createQuickWindow(store: Store, quick: QuickInput, settings: () => void) {
    const win = new BrowserWindow({ width: 620, height: 112, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: false, show: false,
        backgroundColor: '#10191d', title: '伴语 · 快捷输入',
        webPreferences: { preload: fileURLToPath(new URL('./quick-preload.cjs', import.meta.url)), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    let expanded = false, placing = false;
    const place = () => {
        if (win.isDestroyed()) return;
        const p = store.config.quickInput.position;
        const area = (p ? screen.getDisplayMatching({ ...p, width: 620, height: 112 }) : screen.getPrimaryDisplay()).workArea;
        const width = Math.min(620, area.width), height = Math.min(expanded ? 390 : 112, area.height);
        placing = true;
        win.setBounds({ x: Math.round(Math.max(area.x, Math.min(p?.x ?? area.x + (area.width - width) / 2, area.x + area.width - width))), y: area.y + area.height - height, width, height });
        placing = false;
    };
    const setVisible = (visible: boolean, focus = false) => {
        if (visible) { place(); if (focus) { win.show(); win.focus(); } else win.showInactive(); }
        else win.hide();
    };
    const saveVisible = (visible: boolean) => {
        const before = store.config;
        store.saveConfig({ ...store.config, quickInput: { ...store.config.quickInput, visible } });
        quick.settingsChanged(before);
        setVisible(visible, visible);
    };
    const on = (name: string, handler: (...args: any[]) => unknown) => ipcMain.handle(name, (e, ...args) => {
        if (e.sender !== win.webContents) throw new Error('不允许的快捷栏调用来源');
        return handler(...args);
    });
    on('quick:snapshot', () => quick.snapshot());
    on('quick:send', text => quick.send(text));
    on('quick:cancel', () => quick.cancel());
    on('quick:clear', () => quick.clear());
    on('quick:copy', () => clipboard.writeText(quick.snapshot().result));
    on('quick:settings', settings);
    on('quick:hide', () => saveVisible(false));
    on('quick:expand', (value: boolean) => { expanded = value === true; place(); });
    on('quick:mode', (preset: unknown, context: unknown) => {
        const before = store.config;
        store.saveConfig({ ...before, quickInput: { ...before.quickInput, preset, context } });
        quick.settingsChanged(before); return quick.snapshot();
    });
    quick.on('change', state => { if (!win.isDestroyed()) win.webContents.send('quick:change', state); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.on('context-menu', () => Menu.buildFromTemplate([
        { role: 'copy', label: '复制选中文字' }, { role: 'paste', label: '粘贴' }, { type: 'separator' },
        { label: '快捷栏设置', click: settings }, { label: '隐藏快捷栏', click: () => saveVisible(false) }
    ]).popup({ window: win }));
    win.on('moved', () => {
        if (placing || win.isDestroyed()) return;
        const { x, y } = win.getBounds();
        store.saveConfig({ ...store.config, quickInput: { ...store.config.quickInput, position: { x, y } } });
    });
    screen.on('display-metrics-changed', place); screen.on('display-removed', place);
    win.on('closed', () => { screen.removeListener('display-metrics-changed', place); screen.removeListener('display-removed', place); });
    win.once('ready-to-show', () => setVisible(store.config.quickInput.visible));
    void win.loadFile(fileURLToPath(new URL('./ui/quick.html', import.meta.url)));
    return { win, setVisible, toggle: () => saveVisible(!win.isVisible()) };
}
