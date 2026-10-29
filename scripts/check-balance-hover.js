const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..');
function load(file, mocks = {}, extra = {}) {
  const context = vm.createContext({ module: { exports: {} }, console, process, URL,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    __dirname: path.dirname(path.join(root, file)),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    ...extra });
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  return context;
}
class Window extends EventEmitter {
  constructor(options = {}) { super(); this.bounds = {x:options.x||0,y:options.y||0,width:options.width||100,height:options.height||100}; this.visible = false; this.moves = []; this.webContents = new EventEmitter();
    this.webContents.send = () => {}; this.webContents.isLoading = () => false; Window.latest = this; }
  isDestroyed() { return false; }
  setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} loadFile() {}
  isVisible() { return this.visible; } show() { this.visible = true; }
  focus() {} hide() { this.visible = false; }
  setBounds(bounds) { this.bounds = bounds; this.moves.push(bounds); }
  getPosition() { return [this.bounds.x,this.bounds.y]; }
  getSize() { return [this.bounds.width,this.bounds.height]; }
  setPosition(x,y) { this.bounds={...this.bounds,x,y}; this.emit('move'); }
  setIgnoreMouseEvents() {} setOpacity() {}
}
async function main() {
  const near = load('src/main/pet-window.js', {electron:{}, '../shared/store':{}}).module.exports.isCursorNearPet;
  const bounds = {x:500,y:500,width:165,height:165};
  assert.equal(near({x:475,y:550}, bounds), true, 'nearby cursor needs no contact');
  assert.equal(near({x:450,y:550}, bounds), false);
  assert.equal(near({x:470,y:470}, bounds), false, 'diagonal radius is bounded');

  const display = {workArea:{x:0,y:0,width:1920,height:1080}};
  const savedPositions=[];
  const petModule=load('src/main/pet-window.js',{
    electron:{BrowserWindow:Window,screen:{getPrimaryDisplay:()=>display}},
    '../shared/store':{getWindowPosition:()=>({petX:500,petY:500}),getPetConfig:()=>({scale:1,crop:0.55}),
      saveWindowPosition:(x,y)=>savedPositions.push([x,y])}
  }).module.exports;
  const movingPet=await petModule.createPetWindow();
  const bubbleModule=load('src/main/bubble-window.js',{
    electron:{BrowserWindow:Window,screen:{getDisplayNearestPoint:()=>display}},
    './pet-window':{getPetWindow:()=>movingPet},
    '../shared/store':{getBubbleConfig:()=>({})}
  }).module.exports;
  bubbleModule.createBubbleWindow();
  const followingBubble=Window.latest;
  petModule.setPetGeometryListener(()=>bubbleModule.positionBubble());
  bubbleModule.positionBubble();
  const beforeMove={...followingBubble.bounds};
  movingPet.setPosition(600,550);
  assert.equal(followingBubble.bounds.x,beforeMove.x+100,'bubble follows each programmatic drag step horizontally');
  assert.equal(followingBubble.bounds.y,beforeMove.y+50,'bubble follows each programmatic drag step vertically');
  movingPet.emit('moved');
  assert.deepEqual(savedPositions.at(-1),[600,550],'new pet location remains persistent');

  let fetches = 0, hidden = 0, resolveBalance, tick, now = 1000, menuVisible = false;
  let point = {x:475,y:550};
  const shown = [], balanceConfig = {enabled:true,hoverEnabled:true};
  // No pet renderer, focused window, mouse events or active browser page is supplied.
  const backgroundPet = {isDestroyed:()=>false,isVisible:()=>true,getBounds:()=>bounds,setAlwaysOnTop(){},moveTop(){}};
  const hover = load('src/main/balance-hover.js', {
    electron:{screen:{getCursorScreenPoint:()=>point}},
    './pet-window':{getPetWindow:()=>backgroundPet,isCursorNearPet:near},
    './menu-window':{getMenuWindow:()=>({isVisible:()=>menuVisible})},
    './bubble-window':{showBubble:payload=>shown.push(payload),hideBubble:()=>hidden++},
    '../shared/store':{getBalanceConfig:()=>balanceConfig,getLLMConfig:()=>({apiKey:'test-only'})},
    '../shared/deepseek-api':{fetchBalance:()=>{fetches++;return new Promise(resolve=>{resolveBalance=resolve;});}}
  },{Date:{now:()=>now},setInterval:callback=>{tick=callback;return{unref(){}};}}).module.exports;
  hover.startBalanceHover();
  balanceConfig.hoverEnabled=false;
  tick(); assert.equal(fetches,0,'hover requires explicit opt-in');
  balanceConfig.hoverEnabled=true;
  tick(); now=1300; tick(); assert.equal(fetches,1,'unfocused/occluded renderer is not needed');
  point={x:0,y:0}; now=1400; tick(); assert.equal(hidden,1);
  const before=shown.length;
  resolveBalance({balances:[{currency:'CNY',totalBalance:'12.34'}]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(shown.length,before,'late results cannot reopen a dismissed bubble');
  point={x:475,y:550}; now=1500; tick(); now=1800; tick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fetches,1,'re-entry uses cached results');
  assert.equal(shown.at(-1).duration,0);
  assert.equal(shown.at(-1).data.balances[0].currency,'CNY');
  menuVisible=true; tick(); assert.equal(hidden,2,'menus suppress hover bubbles');
  menuVisible=false; balanceConfig.enabled=false; now=1900; tick();
  assert.equal(fetches,1,'disabled balances do not query');
  balanceConfig.enabled=true; hover.invalidateBalanceCache(); now=2000; tick();now=2300;tick();
  assert.equal(fetches,2,'new credentials invalidate cached results');
  point={x:0,y:0};tick();resolveBalance({balances:[]});await new Promise(resolve=>setImmediate(resolve));

  console.log('PASS: proximity; programmatic drag following; background hover without renderer; cache, cancellation, menu and opt-in behavior.');
}
main().catch(error => { console.error(error); process.exitCode=1; });
