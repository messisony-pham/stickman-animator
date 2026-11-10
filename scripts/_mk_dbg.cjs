'use strict';
// Builds an instrumented copy of the game for measurements the shipped file must not
// carry. The hook lands *inside* the game's own IIFE, so it can drive gameStep and read
// the real variables — no re-implementation of the rules, no guessed numbers.
//
//   node scripts/_mk_dbg.cjs            -> index.dbg.html (project root, so relative
//                                          asset paths behave exactly like production)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const outFile = path.join(ROOT, 'index.dbg.html');

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
      // Quest-board handles: prove the daily streak moves, and that the achievement
      // snapshot counts every campaign track (instrumented copy only).
      quest: {
        daily: function () { return loadDailyQuests(); },
        streak: function () {
          return { now: dailyStreakNow(), best: dailyStreakBest(), stored: localStorage.getItem('sm_daily_streak'),
            last: localStorage.getItem('sm_daily_lastDone'), today: dayKey(0), yday: dayKey(-1), twoAgo: dayKey(-2) };
        },
        setLast: function (k) { localStorage.setItem('sm_daily_lastDone', k); },
        setStreak: function (n) { localStorage.setItem('sm_daily_streak', n); },
        setBest: function (n) { localStorage.setItem('sm_daily_best', n); },
        advance: function (kind, n) { advanceQuestProgress(kind, n); return loadDailyQuests(); },
        setBoard: function (board) { saveDailyQuests(board); return loadDailyQuests(); },
        key: function () { return getDailyQuestKey(); },
        completeBoard: function () {
          var q = loadDailyQuests();
          q.forEach(function (x) { x.progress = x.goal; x.done = true; });
          saveDailyQuests(q);
          return touchDailyStreak(q);
        },
        clearBoard: function () { localStorage.removeItem(getDailyQuestKey()); },
        render: function () { renderDailyQuests(); return true; }
      },
      ach: {
        stats: function () { return achStats(); },
        cleared: function () { return achCampaignCleared(); },
        campaign: function () { return { f: campaignProgress, s: soldierProgress, sh: shadowProgress }; },
        setCampaign: function (f, s, sh) { campaignProgress = f || 1; soldierProgress = s || 1; shadowProgress = sh || 1; return achCampaignCleared(); },
        total: function () { return ACH_TOTAL; }
      },
      // v3.2.0 content handles (instrumented copy only).
      ranks: function () { return { count: RANKS.length, names: RANKS.map(function (r) { return r.name; }), current: currentRank(rankPoints).rank.name }; },
      skinStats: function () { return { skin: selectedSkin, dmg: skinDmgMult(), spd: skinSpeedMult(), hp: skinHpMult() }; },
      setSkin: function (id) { selectedSkin = id; saveSkins(); return selectedSkin; },
      setEnergy: function (n) { candy = n; saveCandy(); updateCandyUI(); return candy; },
      shopState: function () { return { rankBoost: shopUpgrades.rankBoost, lifesteal: shopUpgrades.lifesteal, maxBoost: SHOP_MAX_LEVELS.rankBoost, maxSteal: SHOP_MAX_LEVELS.lifesteal }; },
      get rankPts() { return rankPoints; },
      killOne: function () {
        if (!dummies.length) return false;
        var d = dummies[0];
        d.hp = 1; d.alive = true;
        dealDamageToDummy(d, 5, 'punch');
        return true;
      },
      hurtPlayer: function (n) { damagePlayer(n || 20, '#f87171'); return playerHP; },
      heal: function (d) { vampireHeal(d); return playerHP; },
      setShop: function (k, v) { shopUpgrades[k] = v; saveUpgrades(); return shopUpgrades[k]; },
      menuRecord: function () {
        var g = function (id) { var el = document.getElementById(id); return el ? el.textContent : null; };
        var bar = document.getElementById('menuRankBar');
        return { rank: g('menuRank'), next: g('menuRankNext'), width: bar ? bar.style.width : null, wave: g('menuBestWave'), streak: g('menuStreak'), ach: g('menuAchCount') };
      },
      theme: function () { return { current: themeCurrent, playing: themePlaying, gain: themeMaster ? +themeMaster.gain.value.toFixed(3) : null, base: themeBaseVol }; },
      music: {
        songs: function () { return SONGS.map(function (s) { return s.id; }); },
        play: function (id) {
          var s = null;
          for (var i = 0; i < SONGS.length; i++) if (SONGS[i].id === id) s = SONGS[i];
          if (!s) return null;
          playSong(s);
          return { current: themeCurrent, gain: themeMaster ? +themeMaster.gain.value.toFixed(3) : null };
        },
        lyric: function () {
          var el = document.getElementById('lyricOverlay');
          return { hidden: el ? el.classList.contains('hidden') : null, text: (document.getElementById('lyricText') || {}).textContent || '', shown: lyricShown };
        },
        atBar: function (b) { novaritesLyricBar(b); return this.lyric(); },
        clear: function () { clearLyrics(); return this.lyric(); },
        bars: function () { return THEME_TRACKS.novarites_lyric.bars; },
        vocalBar: function (b) { return THEME_TRACKS.novarites_lyric.bar === novaritesVocalBar && b >= 0; },
        line: function (b) { var l = novaLineAt(b); return l ? { bar: l.bar, text: l.text, s: l.s, n: l.n } : null; },
        vocal: function () { return { on: novaVocalOn, loaded: !!novaVocalBuffer, loading: novaVocalLoading, dur: novaVocalBuffer ? +novaVocalBuffer.duration.toFixed(1) : 0, duck: novaDuck }; },
        // Renders the real boss bar plus the recorded singer offline, and reports how the
        // two sit against each other. Measures the shipped arrangement, not a guess.
        mixTest: function (bars, useVoice) {
          bars = bars || 4;
          var T = THEME_TRACKS.novarites, step = 60 / T.bpm / 2;
          var off = new OfflineAudioContext(1, Math.ceil((bars * step * 16 + 1) * 22050), 22050);
          var master = off.createGain(); master.gain.value = T.vol; master.connect(off.destination);
          for (var b = 0; b < bars; b++) T.bar(off, master, 0.05 + b * step * 16, 4 + b, step);
          var g = off.createGain(); g.gain.value = 1.12; g.connect(master);
          // The recording starts at song bar 4, like the live path does.
          if (novaVocalBuffer && useVoice !== false) { var s = off.createBufferSource(); s.buffer = novaVocalBuffer; s.connect(g); s.start(0.05 + 4 * step * 16); }
          return off.startRendering().then(function (buf) {
            var d = buf.getChannelData(0), peak = 0, sum = 0;
            for (var i = 0; i < d.length; i++) { peak = Math.max(peak, Math.abs(d[i])); sum += d[i] * d[i]; }
            // Compare the first line (voice) with the four-bar intro (band only).
            function win(t0, dur) { var s0 = Math.round(t0 * 22050), n = Math.round(dur * 22050), a = 0; for (var i = 0; i < n && s0 + i < d.length; i++) a += d[s0 + i] * d[s0 + i]; return +Math.sqrt(a / n).toFixed(3); }
            return { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(3), bandOnly: win(0.1, 1.2), withVoice: win(0.1 + 4 * step * 16, 2.2) };
          });
        },
        // Offline render of one lyric phrase through the real singer, solo, so the melody
        // can actually be measured: a sung line moves through its written notes.
        render: function (bar) {
          var T = THEME_TRACKS.novarites;
          var step = 60 / T.bpm / 2;
          if (bar < 0 || bar >= 36) return Promise.resolve(null);
          var sr = 22050, secs = step * 32 + 0.4;
          var ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, Math.ceil(sr * secs), sr);
          // A lyric line is two bars: sing both, or the render is only half the phrase.
          novaSing(ac, ac.destination, 0.05, bar, step);
          novaSing(ac, ac.destination, 0.05 + step * 16, bar + 1, step);
          return ac.startRendering().then(function (buf) {
            var d = buf.getChannelData(0), peak = 0, sum = 0;
            for (var i = 0; i < d.length; i++) { var a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; }
            var win = Math.floor(sr * 0.04), hop = Math.floor(sr * 0.12), hz = [];
            for (var o = 0; o + win + 260 < d.length; o += hop) {
              var rms = 0;
              for (var k = 0; k < win; k += 4) rms += d[o + k] * d[o + k];
              rms = Math.sqrt(rms / (win / 4));
              if (rms < 0.008) { hz.push(0); continue; }
              var best = -1, bestLag = 0;
              for (var lag = Math.floor(sr / 900); lag <= Math.floor(sr / 90); lag++) {
                var s = 0;
                for (var j = 0; j < win; j += 4) s += d[o + j] * d[o + j + lag];
                if (s > best) { best = s; bestLag = lag; }
              }
              hz.push(bestLag ? Math.round(sr / bestLag) : 0);
            }
            return { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(4), hz: hz };
          });
        },
        // The whole arrangement offline: peak and clipping under the real master gain.
        renderMix: function (bar, bars) {
          var T = THEME_TRACKS.novarites, step = 60 / T.bpm / 2, n = bars || 2, sr = 22050;
          var ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, Math.ceil(sr * (step * 16 * n + 0.5)), sr);
          var master = ac.createGain(); master.gain.value = T.vol; master.connect(ac.destination);
          for (var i = 0; i < n; i++) novaritesBar(ac, master, 0.02 + i * step * 16, bar + i, step);
          return ac.startRendering().then(function (buf) {
            var d = buf.getChannelData(0), peak = 0, sum = 0, clip = 0;
            for (var k = 0; k < d.length; k++) { var a = Math.abs(d[k]); if (a > peak) peak = a; if (a > 0.99) clip++; sum += d[k] * d[k]; }
            return { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(4), clipped: clip };
          });
        }
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
      // ---- Antidot handles (instrumented copy only) ----
      antidot: {
        select: function () { boughtAntidot = true; localStorage.setItem('sm_boughtAntidot', 'true'); selectedChar = 'antidot'; return selectedChar; },
        pick: function () { buyChar('antidot'); return { bought: boughtAntidot, sel: selectedChar, pts: totalPoints, boss: bossPoints }; },
        reset: function () { gameState = 'playing'; fullReset(); gameState = 'playing'; ultReady = true; ultCharge = 100; return { hp: playerHP, max: PLAYER_MAX_HP_CURRENT }; },
        punch: function () { antidotPunchCD = 0; performAntidotPunch(); return true; },
        blast: function () { antidotBlastCD = 0; performAntidotBlast(); return playerBullets.filter(function (b) { return b.type === 'ink'; }).length; },
        wave: function () { antidotWaveCD = 0; performAntidotWave(); return true; },
        pulse: function () { antidotPulseCD = 0; performAntidotPulse(); return true; },
        summon: function () { antidotSummonCD = 0; performAntidotSummon(); return allies.filter(function (a) { return a.ink; }).length; },
        dash: function () { antidotDashCD = 0; performAntidotDash(); return true; },
        ult: function () { ultReady = true; ultCharge = 100; performAntidotUlt(); return !!antidotUlt; },
        state: function () {
          return { char: selectedChar, hp: playerHP, maxhp: PLAYER_MAX_HP_CURRENT, awake: !!antidotUlt,
            ultTimer: antidotUlt ? antidotUlt.timer : 0, dmgMult: antidotDmgMult(), taken: ANTIDOT_TAKEN_MULT,
            dashing: antidotDashActive, cds: [antidotWaveCD, antidotPulseCD, antidotPulseCD, antidotSummonCD, antidotDashCD] };
        },
        enemies: function (n, hp) {
          dummies = [];
          for (var i = 0; i < n; i++) dummies.push({ x: stick.x + 60 + i * 40, y: GROUND_Y, hp: hp, maxHp: hp, speed: 0, alive: true, facing: -1, hitFlash: 0, type: 'dummy', animTime: 0, vy: 0, attackCD: 999 });
          return dummies.map(function (d) { return d.hp; });
        },
        hpNow: function () { return { hp: playerHP, maxhp: PLAYER_MAX_HP_CURRENT }; },
        hurt: function (n) { return damagePlayer ? damagePlayer(n) : null; }
      },
      // ---- Novarites secret boss handles (instrumented copy only) ----
      nova: {
        find: function () {
          var m = null;
          for (var i = 0; i < miniBosses.length; i++) if (miniBosses[i].type === 'novarites') m = miniBosses[i];
          return m;
        },
        snap: function () {
          var m = this.find();
          return m ? { hp: Math.round(m.hp), maxHp: m.maxHp, shield: m.shield, shieldMax: m.shieldMax,
            speed: m.speed, phase: m.phase, state: m.state, alive: m.alive, cast: m.cast,
            x: Math.round(m.x), facing: m.facing } : null;
        },
        start: function () { startNovaritesFight(); return this.snap(); },
        hurt: function (d) { var m = this.find(); if (!m) return null; dealDamageToMiniBoss(m, d, 'punch'); return this.snap(); },
        killPhase: function () { var m = this.find(); if (!m) return null; m.hp = 1; dealDamageToMiniBoss(m, 1, 'punch'); return this.snap(); },
        step: function (n) { for (var i = 0; i < (n || 1); i++) gameStep(true); return this.snap(); },
        force: function (st) { var m = this.find(); if (!m) return null; m.state = st; m.cast = 0; m.attackCD = 9999; return m.state; },
        fx: function () {
          return { stars: novaStars.map(function (s) { return { x: Math.round(s.x), delay: s.delay, life: s.life }; }),
            beam: novaBeam ? { y: Math.round(novaBeam.y), timer: novaBeam.timer, charge: novaBeam.charge, dir: novaBeam.dir, tick: novaBeam.tick } : null,
            nightmare: novaNightmare ? { timer: novaNightmare.timer, tick: novaNightmare.tick, x: Math.round(novaNightmare.x) } : null };
        },
        place: function (x, y) { stick.x = x; if (y !== undefined) stick.y = y; return { px: stick.x, py: stick.y }; },
        // Damage applied per hit is what the shield actually lets through.
        sampleHit: function (d) { var m = this.find(); if (!m) return null; var before = m.shield, bhp = m.hp; dealDamageToMiniBoss(m, d, 'punch'); return { shieldLost: +(before - m.shield).toFixed(2), hpLost: +(bhp - m.hp).toFixed(2) }; },
        clear: function () { miniBosses = []; novaStars = []; novaBeam = null; novaNightmare = null; return true; }
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
fs.writeFileSync(outFile, dbg);
console.log('wrote index.dbg.html (' + dbg.length + ' bytes)');
