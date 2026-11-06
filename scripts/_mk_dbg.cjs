'use strict';
// Builds an instrumented copy of the game for measurements the shipped file must not
// carry. The hook lands *inside* the game's own IIFE, so it can drive gameStep and read
// the real variables — no re-implementation of the rules, no guessed numbers.
//
//   node scripts/_mk_dbg.cjs            -> scripts/_dbg/index.html
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const outDir = path.join(__dirname, '_dbg');
fs.mkdirSync(outDir, { recursive: true });

const HOOK = `
    // ---- measurement hook (instrumented copy only, never shipped) -------------
    window.__sm = {
      step: function (n, skipDraw) { n = n || 1; var t0 = performance.now(); for (var i = 0; i < n; i++) gameStep(skipDraw); return performance.now() - t0; },
      get state() { return gameState; },
      set state(v) { gameState = v; },
      get char() { return selectedChar; },
      set char(v) { selectedChar = v; },
      get mode() { return gameMode; },
      set mode(v) { gameMode = v; },
      get dummies() { return dummies; },
      get miniBosses() { return miniBosses; },
      get particles() { return particles; },
      get time() { return time; },
      get hp() { return playerHP; },
      set hp(v) { playerHP = v; },
      get maxhp() { return PLAYER_MAX_HP_CURRENT; },
      get ultReady() { return ultReady; },
      get ultCharge() { return ultCharge; },
      set ultCharge(v) { ultCharge = v; },
      get ultraUlt() { return ultraUlt; },
      get ultraPulse() { return ultraPulseUses; },
      get timeStop() { return typeof ultraTimeStop === 'undefined' ? null : ultraTimeStop; },
      get extra() { return typeof ultraUltCasts === 'undefined' ? null : ultraUltCasts; },
      setup: function (mode, char) {
        gameMode = mode; selectedChar = char;
        gameState = 'playing';
        fullReset();
        gameState = 'playing';
        return { hp: playerHP, maxhp: PLAYER_MAX_HP_CURRENT };
      },
      spawn: function (n, hp) {
        for (var i = 0; i < n; i++) {
          dummies.push({ x: 60 + (i * 37) % (CW - 120), y: GROUND_Y, hp: hp || 999999, maxHp: hp || 999999,
            speed: 1, alive: true, facing: -1, hitFlash: 0, type: 'dummy', animTime: 0, vy: 0, attackCD: 60 });
        }
        return dummies.length;
      },
      world: function (o) {
        if (!o) return null;
        dummies.forEach(function (d) { d.hp = o.hp; d.maxHp = o.hp; d.x = o.x; });
        return dummies.length;
      },
      punch: function () { return performUltraPunch(); },
      blast: function () { return performUltraBlast(); },
      laser: function () { return performUltraLaser(); },
      pulse: function () { return performUltraPulse(); },
      slam: function () { return performUltraSlam(); },
      dash: function () { return performUltraDash(); },
      ult: function () { return performUltraUlt(); },
      // Profiling handles: draw and update for a crowd, timed separately.
      drawDummies: function () { for (var i = 0; i < dummies.length; i++) drawDummy(dummies[i]); },
      updateDummies: function () { updateNormalDummies(); },
      drawPlayer: function () { drawStickman(); },
      drawMini: function () { for (var i = 0; i < miniBosses.length; i++) drawMiniBoss(miniBosses[i]); },
      updateMini: function () { updateMiniBosses(); },
      ultUI: function () { updateUltUI(); },
      // Gating + ultimate helpers for the browser checks.
      setPoints: function (p, b) { totalPoints = p; bossPoints = b; savePoints(); },
      buy: function (c) { buyChar(c); },
      get boughtUltra() { return boughtUltra; },
      get points() { return totalPoints; },
      get bossPoints() { return bossPoints; },
      gating: function () { return { fifty: ultraHasFifty(), lv11: ultraBeatLv11(), ok: ultraUnlocked() }; },
      readyUlt: function () { ultReady = true; ultCharge = 100; },
      casts: function () { return ultraUltCasts; },
      // Records every damage event with its source label, to trace where damage comes from.
      logDamage: function () {
        window.__dmgLog = [];
        var orig = dealDamageToDummy;
        dealDamageToDummy = function (d, dmg, src) { window.__dmgLog.push(src + ':' + dmg + '@' + time); return orig(d, dmg, src); };
        return true;
      },
      placeOne: function (off) { var d = dummies[0]; d.x = stick.x + off; d.alive = true; return { px: stick.x, dx: d.x }; },
      use: function (c) { trackCharUse(c || 'ultra'); return charUses.ultra; },
      get px() { return stick.x; },
      timeStopNow: function () { return ultraTimeStop; },
      // Level-up path: set the kill count, then run the game's own level-up routine.
      setKills: function (n) { totalKills = n; checkUltimateUnlock(); return { lv: playerLevel, maxhp: PLAYER_MAX_HP_CURRENT, hp: playerHP }; },
      level: function () { return { lv: playerLevel, maxhp: PLAYER_MAX_HP_CURRENT, hp: playerHP, char: selectedChar }; },
      lvStats: function () { return { lv: playerLevel, dmg: lvDmgMult(), spd: lvSpeedMult() }; },
      slayerState: function () { return { multiCD: slayerMultiSlashCD, active: slayerMultiSlashActive, proj: slayerProjectiles.length }; },
      sword: function () {
        return { active: slayerSwordFall.active, x: Math.round(slayerSwordFall.x), y: Math.round(slayerSwordFall.y), rot: +slayerSwordFall.rot.toFixed(2), timer: slayerSwordFall.timer, dropAt: slayerSwordFall.dropAt || 0, shock: slayerSwordShock.active, ultActive: slayerUltActive };
      },
      // Fire another character's basic/ultimate to inspect their flare.
      rosterFlare: function (which) {
        ultraFx = [];
        if (which === 'slayer') performSlayerSlash();
        else if (which === 'slayerult') performSlayerUlt();
        else if (which === 'knight') performKnightSlash();
        else if (which === 'mage') performMageFireball();
        else if (which === 'slayermulti') performSlayerMultiSlash();
        var o = {};
        ultraFx.forEach(function (f) { o[f.type] = (o[f.type] || 0) + 1; });
        return o;
      },
      // Effect inspection for the visuals: what shapes each ability actually pushes.
      get fx() { return ultraFx; },
      fxTypes: function () {
        var o = {};
        ultraFx.forEach(function (f) { o[f.type] = (o[f.type] || 0) + 1; });
        return o;
      },
      clearFx: function () { ultraFx = []; return true; },
      abilityFx: function (name) {
        ultraFx = [];
        if (name === 'punch') performUltraPunch();
        else if (name === 'blast') performUltraBlast();
        else if (name === 'laser') performUltraLaser();
        else if (name === 'pulse') performUltraPulse();
        else if (name === 'slam') performUltraSlam();
        else if (name === 'dash') performUltraDash();
        else if (name === 'ult') { ultReady = true; ultCharge = 100; performUltraUlt(); }
        var o = {};
        ultraFx.forEach(function (f) { o[f.type] = (o[f.type] || 0) + 1; });
        return o;
      },
      frame: function () { return { acc: FRAME.acc, step: FRAME.step, maxSteps: FRAME.maxSteps }; },
      loop: function (dt) { FRAME.acc = dt; FRAME.last = 0; gameLoop(0); },
      // --- Shadow Magic campaign -------------------------------------------------
      shadow: function () {
        var def = campaignLvDef();
        return {
          type: activeCampaignType, level: campaignLevel, mode: campaignMode,
          timer: campaignTimer, name: def ? def.name : null, duration: def ? def.duration : null,
          progress: shadowProgress, max: shadowMaxLevels, state: gameState,
          char: selectedChar, maxhp: PLAYER_MAX_HP_CURRENT,
          runes: masterRunes.map(function (r) { return { x: Math.round(r.x), delay: r.delay, life: r.life }; }),
          minis: miniBosses.map(function (m) {
            return { type: m.type, hp: Math.round(m.hp), max: m.maxHp, phase: m.phase || 1, state: m.state || null };
          }),
          summoners: dummies.filter(function (d) { return d.isSummoner; }).length,
          dummies: dummies.length, bullets: bullets.length, magicBullets: bullets.filter(function (b) { return b.magic; }).length
        };
      },
      shadowStart: function (lv) { startShadowCutscene(lv - 1); return true; },
      shadowLaunch: function (lv) { launchShadowLevel(lv); return true; },
      advanceAll: function () { var g = 0; while (!document.getElementById('cutsceneScreen').classList.contains('hidden') && g++ < 60) advanceCutscene(); return g; },
      shadowStep: function (n) { for (var i = 0; i < (n || 1); i++) gameStep(true); return true; },
      shadowHitMaster: function (dmg) {
        var m = null;
        for (var i = 0; i < miniBosses.length; i++) if (miniBosses[i].type === 'master_mage') m = miniBosses[i];
        if (!m) return null;
        dealDamageToMiniBoss(m, dmg, 'punch');
        return { hp: Math.round(m.hp), max: m.maxHp, alive: m.alive, phase: m.phase || 1 };
      },
      shadowKillMaster: function () {
        var m = null;
        for (var i = 0; i < miniBosses.length; i++) if (miniBosses[i].type === 'master_mage') m = miniBosses[i];
        if (!m) return null;
        m.hp = 1;
        dealDamageToMiniBoss(m, 50, 'punch');
        return { alive: m.alive };
      },
      shadowResetProgress: function () {
        shadowProgress = 1; localStorage.setItem('sm_campaignShadow', 1); return true;
      },
      cutscene: function () {
        return {
          open: !document.getElementById('cutsceneScreen').classList.contains('hidden'),
          data: cutsceneData === SHADOW_WIN_CUTSCENE ? 'shadow-win' : 'other',
          speaker: document.getElementById('cutsceneName').textContent
        };
      }
    };
`;

// The boot call, taken from the END of the file: `startMenuMusic()` also appears inside
// menu handlers, and injecting there cuts a live function in half.
const marker = 'startMenuMusic();';
const at = src.lastIndexOf(marker);
if (at < 0) throw new Error('anchor not found');
const lineStart = src.lastIndexOf('\n', at) + 1;
const dbg = src.slice(0, lineStart) + HOOK + '\n' + src.slice(lineStart);
fs.writeFileSync(path.join(outDir, 'index.html'), dbg);
console.log('wrote scripts/_dbg/index.html (' + dbg.length + ' bytes)');
