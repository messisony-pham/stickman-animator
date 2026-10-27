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
  '      stick: stick,',
  '      punch: function () { performPunch(); },',
  '      kick: function () { performKickFighter(); },',
  '      cooldown: function () { return attackCooldown; },',
  '      launchSoulStorm: launchSoulStorm,',
  '      setHeld: soulStormSetHeld,',
  '      point: function () { return soulStormPointX; },\n',
  '      pressE: soulStormPressE,',
  '      getMiniBosses: function () { return miniBosses; },',
  '      player: function () { return { x: stick.x, y: stick.y }; },',
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
  '      forcePumpkin: function () { pumpkinSpawned = false; pumpkinTimer = PUMPKIN_SPAWN_INTERVAL; },',
  '      spawnIn: function (frames) { pumpkinSpawned = false; pumpkinTimer = PUMPKIN_SPAWN_INTERVAL - frames; return PUMPKIN_SPAWN_INTERVAL; },',
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
  '          warning: soulStormWarning ? soulStormWarning.zone : null,\n',
  '          pointX: soulStormPointX,\n',
  '          held: soulStormMoveHeld, rafAlive: soulStormRAF !== null,',
  '          animFrameId: animFrameId, frame: time, bosses: miniBosses.length,',
  '          tailwindCdn: typeof window.tailwind !== \'undefined\',',
  '          screenShown: !!(document.getElementById(\'soulStormScreen\') && !document.getElementById(\'soulStormScreen\').classList.contains(\'hidden\'))',
  '        };',
  '      }',
  '    };',
  // ---- Taoist hooks: drive the real abilities and read the real state back ----
  '    window.__taoist = {',
  '      state: function () {',
  '        return {',
  '          char: selectedChar, gameState: gameState, hp: playerHP, max: PLAYER_MAX_HP_CURRENT,',
  '          hpFloor: playerHpFloor(), reviveUsed: taoistReviveUsed, grace: gracePeriod,',
  '          dmg: taoistDmgMult(), spd: taoistSpdMult(), taken: taoistTakenMult(),',
  '          grant: isCharBought(\'taoist\'), points: totalPoints, bossPoints: bossPoints,',
  '          cooldowns: { sword: taoistSwordCD, pulse: taoistPulseCD, zombie: taoistZombieCD, seal: taoistSealCD, amulet: taoistAmuletCD, big: taoistBigZombieCD },',
  '          ultCharge: ultCharge, ultReady: ultReady,',
  '          amulet: { id: taoistAmulet.id, good: taoistAmulet.good, timer: taoistAmulet.timer, mult: taoistAmulet.mult },',
  '          pulse: { active: taoistPulseFx.active, timer: taoistPulseFx.timer },',
  '          swords: taoistSwords.map(function (s) { return { x: s.x, y: s.y, life: s.life, dmg: s.dmg }; }),',
  '          sealFx: taoistSealFx.length, ultAmulet: { active: taoistUltAmulet.active, timer: taoistUltAmulet.timer, tick: taoistUltAmulet.tick }',
  '        };',
  '      },',
  '      buy: function () { buyChar(\'taoist\'); return { grant: isCharBought(\'taoist\'), points: totalPoints, bossPoints: bossPoints }; },',
  '      select: function (c) { selectedChar = c; return selectedChar; },',
  '      play: function () { document.getElementById(\'playBtn\').click(); return gameState; },',
  '      resetCds: function () {',
  '        taoistSwordCD = 0; taoistPulseCD = 0; taoistZombieCD = 0; taoistSealCD = 0; taoistAmuletCD = 0; taoistBigZombieCD = 0;',
  '        attackCooldown = 0; return 1;',
  '      },',
  '      setGrace: function (n) { gracePeriod = n; return gracePeriod; },',
  '      setHp: function (n) { playerHP = n; updateHPBar(); return playerHP; },',
  '      aim: function (x, y) { mouseX = x; mouseY = y; return { x: mouseX, y: mouseY }; },',
  '      sword: function () { performTaoistSword(); return taoistSwords.length; },',
  '      pulse: function () { performTaoistPulse(); return playerHP; },',
  '      zombies: function () { performTaoistZombies(); return countTaoistAllies(); },',
  '      bigZombie: function () { performTaoistBigZombie(); return countTaoistAllies(); },',
  '      seal: function () { performTaoistSeal(); return sealedCount(); },',
  '      amulet: function () { performTaoistAmulet(); return { id: taoistAmulet.id, good: taoistAmulet.good, mult: taoistAmulet.mult, timer: taoistAmulet.timer }; },',
  '      chargeUlt: function () { ultCharge = 100; ultReady = true; return ultReady; },',
  '      ult: function () { performTaoistUlt(); return { active: taoistUltAmulet.active, timer: taoistUltAmulet.timer }; },',
  '      amuletBag: function () { var g = 0, b = 0; TAOIST_AMULETS.forEach(function (a) { if (a.good) g++; else b++; }); return { good: g, bad: b, total: TAOIST_AMULETS.length }; },',
  '      allies: function () { return allies.filter(function (a) { return a.type === \'zombie_ally\' || a.type === \'big_zombie_ally\'; }).map(function (a) { return { type: a.type, x: a.x, hp: a.hp, maxHp: a.maxHp, alive: a.alive }; }); },',
  '      clearAllies: function () { allies = []; return 0; },',
  '      dentAllies: function (hp) { allies.forEach(function (a) { if (a.alive) a.hp = hp; }); return allies.length; },',
  '      pushAlly: function (x, type, hp, maxHp) { allies.push({ x: x, y: GROUND_Y, type: type, hp: hp, maxHp: maxHp, attackCD: 60, life: 900, hitFlash: 0, alive: true, facing: 1 }); return allies.length; },',
  '      spawnZombie: function (x) { spawnZombie(x, false); return dummies.length; },',
  '      primeZombie: function (x) { spawnZombie(x, false); var d = dummies[dummies.length - 1]; if (d) d.attackCD = 1; return dummies.length; },',
  '      spawnTarget: function (x, hp) { dummies.push({ x: x, y: GROUND_Y, hp: hp, maxHp: hp, facing: -1, state: \'idle\', speed: 0, attackCD: 999999, hitFlash: 0, alive: true, animTime: 0 }); return dummies.length; },',
  '      enemies: function () { return dummies.filter(function (d) { return d.alive; }).map(function (d) { return { x: d.x, hp: d.hp, maxHp: d.maxHp, isZombie: !!d.isZombie, sealTimer: d.sealTimer || 0, stunTimer: d.stunTimer || 0 }; }); },',
  '      clearEnemies: function () { dummies = []; return 0; },',
  '      hurt: function (d) { damagePlayer(d, \'test\'); return playerHP; },',
  '      world: function () { return { cw: CW, groundY: GROUND_Y, stickX: stick.x, stickY: stick.y, pulseR: TAOIST_PULSE_RADIUS, ultR: TAOIST_ULT_RADIUS, zombieDmg: ZOMBIE_DMG, zombieMult: TAOIST_ZOMBIE_DMG_MULT, atkRange: DUMMY_ATK_RANGE }; }',
  '    };',
  '    function countTaoistAllies() { var n = 0; allies.forEach(function (a) { if (a.alive && (a.type === \'zombie_ally\' || a.type === \'big_zombie_ally\')) n++; }); return n; }',
  '    function sealedCount() { var n = 0; dummies.forEach(function (d) { if (d.alive && d.sealTimer > 0) n++; }); miniBosses.forEach(function (m) { if (m.alive && m.sealTimer > 0) n++; }); return n; }',
  '    function waitFrames(n) { return new Promise(function (res) { var i = 0; (function step() { if (++i >= n) return res(i); requestAnimationFrame(step); })(); }); }',
  '    window.__waitFrames = waitFrames;',
  ''
].join('\n');

const out = src.replace(anchor, expose + anchor);

// Harness-only: the debug build drives frames from timers instead of the compositor.
// A browser tab that is not being painted (occluded window, collapsed panel) stops
// firing requestAnimationFrame, which froze every timed check in this copy.
const shim = [
  '<script>',
  '/* harness-only frame source: timers, not the compositor */',
  '(function () {',
  '  window.__realRAF = window.requestAnimationFrame;',
  '  window.requestAnimationFrame = function (fn) { return setTimeout(function () { fn(performance.now()); }, 16); };',
  '  window.cancelAnimationFrame = function (id) { clearTimeout(id); };',
  '})();',
  '</scr' + 'ipt>',
  ''
].join('\n');
const lastOpen = out.lastIndexOf('<script>');
const outShimmed = out.slice(0, lastOpen) + shim + out.slice(lastOpen);
const dir = path.join(ROOT, 'scripts', '_dbg');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'index.html'), outShimmed);
console.log('wrote scripts/_dbg/index.html (' + outShimmed.length + ' bytes)');
