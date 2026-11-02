#!/usr/bin/env node
// Exercise real menu lifecycle code without Electron or a desktop session.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeWindow extends EventEmitter {
  constructor() {
    super(); this.visible = false; this.bounds = null; this.focusCount = 0;
    this.webContents = new EventEmitter();
    this.webContents.send = () => {};
    this.webContents.isLoading = () => false;
    FakeWindow.instance = this;
  }
  isDestroyed() { return false; }
  isVisible() { return this.visible; }
  loadFile() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
  setBounds(bounds) { this.bounds = bounds; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() { this.focusCount++; }
}

const timers = [];
const context = {
  module: { exports: {} }, process,
  __dirname: path.join(__dirname, '../src/main'),
  setTimeout: callback => timers.push(callback),
  require: name => {
    if (name === 'electron') return {
      BrowserWindow: FakeWindow,
      screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }
    };
    if (name === './pet-window') return { getPetWindow: () => null };
    return require(name);
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/menu-window.js'), 'utf8'), context);
const menu = context.module.exports;
const anchor = { x: 1600, y: 800 };
menu.openMenuWindow({ anchor });
menu.applyMenuSize({ width: 200, height: 240 });
const window = FakeWindow.instance;
assert.equal(window.bounds.x, 1602);
assert.equal(window.bounds.y, 802);
menu.applyMenuSize({ width: 220, height: 260 });
assert.equal(window.bounds.x, 1602, 'a second size report retains the opening anchor');
assert.equal(window.bounds.y, 802);
timers.shift()();
assert.equal(window.bounds.x, 1602, 'the fallback timer must not reposition an open menu at the origin');
assert.equal(window.focusCount, 1, 'size reports must not repeatedly steal focus');

menu.hideMenuWindow();
const before = window.bounds;
menu.applyMenuSize({ width: 230, height: 270 });
assert.equal(window.bounds, before, 'late size reports leave a closed menu alone');
assert.equal(window.isVisible(), false);

menu.openMenuWindow({ anchor: { x: 100, y: 100 } });
menu.applyMenuSize({ width: 200, height: 240 });
assert.equal(window.bounds.x, 102, 'reopening uses the new anchor');
assert.equal(window.bounds.y, 102);
console.log('Menu anchor regression checks passed.');
