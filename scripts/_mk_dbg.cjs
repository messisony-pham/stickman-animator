'use strict';
// Builds a debug copy of index.html that exposes the Soul Storm internals on
// window.__dbg so a real browser can drive/measure the minigame.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, process.argv[2] || 'index.html'), 'utf8');

const anchor = '    startMenuMusic();\n    animFrameId = requestAnimationFrame(gameLoop);';
if (src.indexOf(anchor) < 0) throw new Error('anchor not found');

const expose = [
  '    window.__dbg = {',
  '      killPumpkinBoss: killPumpkinBoss,',
  '      launchSoulStorm: launchSoulStorm,',
  '      dodge: soulStormDodge,',
  '      pressE: soulStormPressE,',
  '      getMiniBosses: function () { return miniBosses; },',
  '      kick: function () { animFrameId = null; resumeGameLoop(); return animFrameId; },',
  '      heal: function () { playerHP = PLAYER_MAX_HP_CURRENT; updateHPBar(); return playerHP; },',
  '      setOrbTimer: function (n) { miniBosses.forEach(function (b) { if (b.alive && b.type === \'pumpkin\') b.orbTimer = n; }); },',
  '      timeRef: function () { return time; },',
  '      dealDamage: dealDamageToMiniBoss,',
  '      hurtPumpkin: function (dmg) {',
  '        var mb = null;',
  '        miniBosses.forEach(function (b) { if (b.alive && b.type === \'pumpkin\') mb = b; });',
  '        if (mb) dealDamageToMiniBoss(mb, dmg, \'test\');',
  '        return mb ? { hp: mb.hp, phase: mb.phase, orbMode: mb.orbMode, orbTimer: mb.orbTimer, alive: mb.alive } : null;',
  '      },',
  '      forcePumpkin: function () { pumpkinSpawned = false; pumpkinTimer = 3600; },',
  '      killPumpkin: function () {',
  '        var mb = null;',
  '        miniBosses.forEach(function (b) { if (b.alive && b.type === \'pumpkin\') mb = b; });',
  '        if (mb) killPumpkinBoss(mb);',
  '        return !!mb;',
  '      },',
  '      tick: function () {',
  '        return {',
  '          gameMode: gameMode, campaignMode: campaignMode, phantom: phantomMissionActive,',
  '          halloween: isHalloweenEvent(), pumpkinTimer: pumpkinTimer, pumpkinSpawned: pumpkinSpawned,',
  '          miniBossCount: miniBosses.length,',
  '          playerHP: typeof playerHP === \'number\' ? playerHP : null,',
  '          types: miniBosses.map(function (b) { return b.type + (b.alive ? \'+\' : \'-\'); }).join(\',\')',
  '        };',
  '      },',
  '      state: function () {',
  '        return {',
  '          gameState: gameState,',
  '          active: soulStormActive, ended: soulStormEnded, eActive: soulStormEActive,',
  '          survived: soulStormSurvived, ePresses: soulStormEPresses, eTimer: soulStormETimer,',
  '          hits: soulStormHits, pending: soulStormPendingBlasts.length,',
  '          warning: soulStormWarning ? soulStormWarning.lane : null,',
  '          lane: soulStormPlayerLane, rafAlive: soulStormRAF !== null,',
  '          animFrameId: animFrameId, frame: time, bosses: miniBosses.length,',
  '          tailwindCdn: typeof window.tailwind !== \'undefined\',',
  '          screenShown: !!(document.getElementById(\'soulStormScreen\') && !document.getElementById(\'soulStormScreen\').classList.contains(\'hidden\'))',
  '        };',
  '      }',
  '    };',
  ''
].join('\n');

const out = src.replace(anchor, expose + anchor);
const dir = path.join(ROOT, 'scripts', '_dbg');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'index.html'), out);
console.log('wrote scripts/_dbg/index.html (' + out.length + ' bytes)');
