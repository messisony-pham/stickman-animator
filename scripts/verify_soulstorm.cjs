'use strict';
// Headless harness: runs the REAL Soul Storm code lifted out of the shipped HTML
// with a stub DOM + virtual clock, so the minigame loop can be driven deterministically.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function extract(file) {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const a = s.indexOf('SOUL STORM (pumpkin boss end minigame)');
  const c = s.indexOf('Soul Storm result pane: retry the pumpkin boss');
  const d = s.indexOf('MUSIC PLAYER (hear every song)');
  // the region ends where the next unrelated function begins
  const b = s.indexOf('function updateDarkUniverseBoss');
  if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('markers not found in ' + file);
  // start each slice at the beginning of the `//` comment line so the comment stays intact
  return s.slice(s.lastIndexOf('//', a), s.lastIndexOf('\n', b)) + '\n' +
    s.slice(s.lastIndexOf('//', c), s.lastIndexOf('//', d));
}

// ------------------------------------------------------------------ stub DOM
const REG = {};
function mkEl(id, tag) {
  const el = {
    id: id || '', tagName: (tag || 'DIV').toUpperCase(), style: {}, dataset: {},
    children: [], textContent: '', value: '', _classes: new Set(), _ev: {}, _clicks: 0
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c)
  };
  el.appendChild = (ch) => { el.children.push(ch); if (ch.id) REG[ch.id] = ch; return ch; };
  el.removeChild = () => {};
  el.remove = () => {};
  el.addEventListener = (t, fn) => { el._ev[t] = fn; };
  el.click = () => { el._clicks++; if (el._ev.click) el._ev.click({ preventDefault() {} }); };
  el.querySelector = (sel) => findSel(el, sel);
  el.querySelectorAll = (sel) => findSelAll(el, sel);
  return el;
}
function parseSel(sel) {
  const m = /^([a-z.]*)(?:\[(?:data-)?lane="([^"]+)"\])?$/i.exec(sel);
  return { cls: m && m[1] ? m[1] : '', lane: m && m[2] ? m[2] : null };
}
function matches(el, sel) {
  const { cls, lane } = parseSel(sel);
  if (cls.startsWith('.')) {
    const c = cls.slice(1);
    if (!(el.className || '').split(/\s+/).includes(c)) return false;
  } else if (cls && el.tagName !== cls.toUpperCase()) {
    return false;
  }
  if (lane && el.dataset.lane !== lane) return false;
  return true;
}
function findSel(el, sel) { return findSelAll(el, sel)[0] || null; }
function findSelAll(el, sel) { return (el.children || []).filter((c) => matches(c, sel)); }

function makeCtx() {
  Object.keys(REG).forEach((k) => delete REG[k]);
  const ids = ['soulStormArena', 'soulStormHud', 'soulStormTime', 'soulStormSurvive', 'soulStormBlasts',
    'soulStormETimer', 'soulStormETarget', 'soulStormScreen', 'soulStormResult', 'soulStormResultMsg',
    'soulStormWin', 'soulStormWinMsg', 'soulStormInstr', 'mobBtnSoulStormE', 'soulStormRetryBtn',
    'soulStormMenuBtn', 'gameoverScreen', 'menuScreen', 'gameUI', 'pumpkinBossBtn', 'gameoverMsg'];
  ids.forEach((id) => { REG[id] = mkEl(id); });
  REG.gameUI._classes.add('hidden');

  const document = {
    getElementById: (id) => REG[id] || null,
    createElement: (tag) => mkEl('', tag),
    querySelector: (sel) => null
  };

  let now = 0;
  const rafQ = [];
  const timers = [];
  let timerSeq = 1;

  const sandbox = {
    document,
    console,
    Math,
    JSON,
    performance: { now: () => now },
    requestAnimationFrame: (fn) => { rafQ.push(fn); return rafQ.length; },
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    // game globals the region touches
    rhythmRestartTimer: null, rhythmActive: false, rhythmRAF: null, rhythmEnded: false,
    pendingPumpkinReward: null, gameMode: 'normal', gameUI: REG.gameUI, menuScreen: REG.menuScreen,
    gameState: 'menu', animFrameId: null, campaignMode: false, activeCampaignType: 'fighter',
    score: 0, kills: 0, scoreEl: mkEl(), killsEl: mkEl(), totalPoints: 0, bossPoints: 0,
    savePoints() {}, saveCandy() {}, addCandy() {}, updateMenuPoints() {}, updateCharLockUI() {},
    checkUltimateUnlock() {}, checkBossSpawn() {}, checkCampaignWin() {}, applyThemeMusic() {},
    startMenuMusic() {}, stopThemeMUsic() {}, stopThemeMusic() {}, stopBossMusic() {},
    startBossMusic() {}, bossMusicPlaying: false, exitSoulTestCalls: 0,
    // frame-guard helpers the shipped loops call (defined outside the region)
    LOOP_ERRORS: { gameLoop: 0, soulStormStep: 0, rhythmStep: 0, pumpkinRewards: 0 },
    loopErrors: [], reportLoopError(where) { sandbox.loopErrors.push(where); },
    resumeLoopCalls: 0, resumeGameLoop() { sandbox.resumeLoopCalls++; },
    exitSoulTest() { sandbox.exitSoulTestCalls++; },
    mkEl
  };
  sandbox.window = sandbox;
  // `winPane` style lookups used by launchSoulStorm
  sandbox.SOUL_STORM_END_E_TARGET = 35;
  return { sandbox, rafQ, timers, getNow: () => now, setNow: (v) => { now = v; } };
}

function makeRunner(regionSource) {
  const ctx = makeCtx();
  const script = new vm.Script(regionSource, { filename: 'soulstorm-region.js' });
  const vmCtx = vm.createContext(ctx.sandbox);
  script.runInContext(vmCtx);
  const S = ctx.sandbox;
  const errors = [];
  const origErr = process.stderr.write.bind(process.stderr);

  function frame(ms) {
    const now = ctx.getNow() + (ms || 50);
    ctx.setNow(now);
    // due timers first (mutate in place: setTimeout pushes into this same array)
    const due = [];
    for (let i = ctx.timers.length - 1; i >= 0; i--) {
      if (ctx.timers[i].at <= now) due.push(ctx.timers.splice(i, 1)[0]);
    }
    due.forEach((t) => { try { t.fn(); } catch (e) { errors.push('timer: ' + e.message); } });
    const q = ctx.rafQ.splice(0, ctx.rafQ.length);
    q.forEach((fn) => { try { fn(now); } catch (e) { errors.push('raf: ' + e.message); } });
    return q.length;
  }
  return { S, ctx, frame, errors };
}

// ------------------------------------------------------------------- asserts
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

function run(file) {
  console.log('\n===== ' + file + ' =====');
  const region = extract(file);
  let src = region;
  if (file === 'index.standalone.html') src = region; // same marker slice

  // --- A: launch + one frame must not throw (the freeze regression) ---------
  {
    const { S, frame, errors } = makeRunner(src);
    S.buildSoulStormArena();
    S.launchSoulStorm();
    check('launchSoulStorm shows the screen', S.gameState === 'minigame');
    check('launchSoulStorm starts the loop', S.soulStormActive === true);
    frame(16);
    check('frame 1 throws nothing', errors.length === 0, errors.join('; '));
    check('loop reschedules itself', S.soulStormRAF !== null);
    for (let i = 0; i < 5; i++) frame(16);
    check('survival timer advances', S.soulStormSurvived > 0, 'got ' + S.soulStormSurvived);
    check('5 more frames throw nothing', errors.length === 0, errors.join('; '));
    // first rAF timestamps can predate the launch timestamp; dt must never be negative
    const { S: S2, frame: f2 } = makeRunner(src);
    S2.launchSoulStorm();
    f2(-15); f2(-10); f2(5); f2(20);
    check('negative rAF skew never rewinds the timer', S2.soulStormSurvived >= 0,
      'survived=' + S2.soulStormSurvived);
  }

  // --- B: dodging the warned lane survives -------------------------------
  {
    const { S, frame, errors } = makeRunner(src);
    S.launchSoulStorm();
    let warningsSeen = 0, blastsResolved = 0;
    const lanes = S.SOUL_STORM_LANES;
    for (let i = 0; i < 4000 && !S.soulStormEnded; i++) {
      if (S.soulStormWarning) {
        warningsSeen++;
        const other = lanes.find((l) => l !== S.soulStormWarning.lane);
        S.soulStormDodge(other);
      }
      const fired = S.soulStormBlastsFired;
      frame(50);
      if (S.soulStormBlastsFired > fired) { /* new blast queued */ }
      if (S.soulStormSurvived >= S.SOUL_STORM_SURVIVE) break;
    }
    blastsResolved = S.soulStormBlastsFired;
    check('warnings were shown', warningsSeen > 0);
    check('blasts were fired', blastsResolved > 0);
    check('dodging into a safe lane does not lose', S.soulStormEnded === false || S.soulStormWin === true);
    check('survived the full window', S.soulStormSurvived >= S.SOUL_STORM_SURVIVE - 0.06, 'survived=' + S.soulStormSurvived.toFixed(2));
    check('reached the E gauntlet', S.soulStormEActive === true);
    check('E button is shown in the arena', !!REG.soulStormArena.querySelector('button[data-lane="e"]') &&
      REG.soulStormArena.querySelector('button[data-lane="e"]').style.display === 'flex');
    check('no runtime errors during survival', errors.length === 0, errors.join('; '));
  }

  // --- C: one miss costs a heart, three misses ends the run -------------
  {
    const { S, frame, errors } = makeRunner(src);
    S.launchSoulStorm();
    let graceBlasts = null;
    // grace: nothing may blast before SOUL_STORM_START_GRACE seconds
    for (let i = 0; i < 200 && !S.soulStormEnded; i++) {
      frame(50);
      if (graceBlasts === null && S.soulStormSurvived >= S.SOUL_STORM_START_GRACE - 0.06) graceBlasts = S.soulStormBlastsFired;
      if (graceBlasts !== null) break;
    }
    check('no blasts during the GET READY grace window', graceBlasts === 0, 'blasts=' + graceBlasts);

    // first resolution with no dodge must NOT end the run
    const { S: S3, frame: f3 } = makeRunner(src);
    S3.launchSoulStorm();
    let firstMissEnded = null, firstMissHits = null;
    for (let i = 0; i < 400 && !S3.soulStormEnded; i++) {
      f3(50);
      if (S3.soulStormHits === 1 && firstMissEnded === null) {
        firstMissEnded = S3.soulStormEnded;
        firstMissHits = S3.soulStormHits;
        break;
      }
    }
    check('one missed blast survives (hearts)', firstMissEnded === false, 'ended=' + firstMissEnded + ' hits=' + firstMissHits);
    check('hits counter tracked', firstMissHits === 1, 'hits=' + firstMissHits);

    // keep missing until the hearts run out
    for (let i = 0; i < 2000 && !S3.soulStormEnded; i++) { f3(50); }
    check('running out of hearts fails the run', S3.soulStormEnded === true && S3.soulStormWin === false);
    check('exactly SOUL_STORM_HITS_ALLOWED misses were taken', S3.soulStormHits === S3.SOUL_STORM_HITS_ALLOWED,
      'hits=' + S3.soulStormHits + ' allowed=' + S3.SOUL_STORM_HITS_ALLOWED);

    const { S: S4, frame: f4, errors: e4 } = makeRunner(src);
    S4.launchSoulStorm();
    for (let i = 0; i < 2000 && !S4.soulStormEnded; i++) { f4(50); }
    check('lose path has no errors', e4.length === 0, e4.join('; '));  check('lose path shows the result pane', !REG.soulStormResult.classList.contains('hidden'));
    // the run is over: the loop must be dead, not left holding a stale frame id
    check('lose path leaves no pending minigame frame', S4.soulStormRAF === null,
      'raf=' + S4.soulStormRAF);
    }

  // --- D: E gauntlet win ------------------------------------------------
  {
    const { S, frame, errors } = makeRunner(src);
    S.pendingPumpkinReward = { candy: 7, points: 500, bossPoints: 5, score: 500 };
    REG.gameUI.classList.remove('hidden'); // in-game: the minigame must return to gameplay
    S.launchSoulStorm();
    frame(50); // warm-up frame latches the timestamp
    S.soulStormSurvived = S.SOUL_STORM_SURVIVE - 0.01;
    frame(50);
    check('E gauntlet started', S.soulStormEActive === true);
    check('queued blasts cleared on entering gauntlet', S.soulStormPendingBlasts.length === 0 && S.soulStormWarning === null);
    for (let i = 0; i < S.SOUL_STORM_END_E_TARGET; i++) S.soulStormPressE();
    check('35 E presses wins', S.soulStormWin === true && S.soulStormEnded === true);
    for (let i = 0; i < 30; i++) frame(50); // flush the 1100ms reward timeout
    check('rewards paid out', S.pendingPumpkinReward === null);
    check('win RESUMES the parked main game loop', S.resumeLoopCalls === 1, 'calls=' + S.resumeLoopCalls);
    check('win path has no errors', errors.length === 0, errors.join('; '));
  }

  // --- E: E gauntlet timeout loses, result pane usable -------------------
  {
    const { S, frame, errors } = makeRunner(src);
    S.launchSoulStorm();
    frame(50); // warm-up frame
    S.soulStormSurvived = S.SOUL_STORM_SURVIVE - 0.01;
    frame(50);
    for (let i = 0; i < 320 && !S.soulStormEnded; i++) frame(50);
    for (let i = 0; i < 20; i++) frame(50);
    check('E timeout loses', S.soulStormEnded === true && S.soulStormWin === false);
    check('result pane shown on failure', !REG.soulStormResult.classList.contains('hidden'));
    check('timeout path has no errors', errors.length === 0, errors.join('; '));
  }

  // --- E2: E timeout must end the run exactly ONCE ------------------------
  // Regression: the "TOO LATE" branch runs on every frame after the timer
  // expires, so without a one-shot guard it queued dozens of soulStormEnd
  // calls (measured 22 in a real browser), each restarting the music and
  // creating a new AudioContext.
  {
    const { S, frame, errors } = makeRunner(src);
    let endCalls = 0;
    const origEnd = S.soulStormEnd;
    S.soulStormEnd = function (w) { endCalls++; return origEnd(w); };

    S.launchSoulStorm();
    frame(50);
    S.soulStormSurvived = S.SOUL_STORM_SURVIVE - 0.01;
    frame(50);
    for (let i = 0; i < 320 && !S.soulStormEnded; i++) frame(50);
    for (let i = 0; i < 60; i++) frame(50); // keep stepping long after the deadline
    check('E timeout calls soulStormEnd exactly once', endCalls === 1, 'calls=' + endCalls);
    check('E timeout one-shot leaves no errors', errors.length === 0, errors.join('; '));

    // A fresh run must re-arm the guard, not inherit it.
    const before = endCalls;
    S.launchSoulStorm();
    frame(50);
    S.soulStormSurvived = S.SOUL_STORM_SURVIVE - 0.01;
    frame(50);
    for (let i = 0; i < 320 && !S.soulStormEnded; i++) frame(50);
    for (let i = 0; i < 60; i++) frame(50);
    check('second run also ends exactly once', endCalls - before === 1, 'calls=' + (endCalls - before));
  }

  // --- E3: a frame that throws must NOT kill the minigame loop -------------
  // Regression: the loop arms its next frame from inside its own body, so a single
  // thrown error used to drop the chain and freeze the arena on its last frame.
  {
    const { S, frame, errors } = makeRunner(src);
    S.launchSoulStorm();
    frame(50);
    const survivedBefore = S.soulStormSurvived;
    const realDraw = S.soulStormDrawIndicators;
    let threw = 0;
    S.soulStormDrawIndicators = function () { threw++; throw new Error('simulated frame error'); };
    for (let i = 0; i < 10; i++) frame(50);
    check('the simulated error was actually raised', threw === 10, 'threw=' + threw);
    check('a throwing frame is reported', S.loopErrors.filter((w) => w === 'soulStormStep').length === 10,
      'reports=' + JSON.stringify(S.loopErrors));
    check('a throwing frame does not escape the loop', errors.length === 0, errors.join('; '));
    check('the loop is still armed after 10 bad frames', S.soulStormRAF !== null);
    check('the survival timer still advanced through the bad frames', S.soulStormSurvived > survivedBefore,
      'before=' + survivedBefore + ' after=' + S.soulStormSurvived);
    // and it recovers fully once the fault is gone
    S.soulStormDrawIndicators = realDraw;
    const before = S.soulStormSurvived;
    for (let i = 0; i < 5; i++) frame(50);
    check('the minigame keeps running after the fault clears', S.soulStormSurvived > before,
      'before=' + before + ' after=' + S.soulStormSurvived);
    check('recovery frame throws nothing', errors.length === 0, errors.join('; '));
  }

  // --- E3b: a frame whose ARM throws must still leave a live loop ----------
  // The arm happens at the end of the frame, so an error there used to be the worst
  // case: the id was never scheduled, the loop stopped and the arena froze.
  {
    const { S, ctx, frame, errors } = makeRunner(src);
    S.launchSoulStorm();
    frame(50);
    const origRaf = ctx.sandbox.requestAnimationFrame;
    let throwOnce = true;
    ctx.sandbox.requestAnimationFrame = function (fn) {
      if (throwOnce) { throwOnce = false; throw new Error('simulated arm failure'); }
      return origRaf(fn);
    };
    frame(50);
    check('an arm failure is reported', S.loopErrors.indexOf('soulStormStep') >= 0, JSON.stringify(S.loopErrors));
    check('an arm failure does not escape the loop', errors.length === 0, errors.join('; '));
    check('the loop is still armed after an arm failure', S.soulStormRAF !== null, 'raf=' + S.soulStormRAF);
    ctx.sandbox.requestAnimationFrame = origRaf;
    const beforeArmFail = S.soulStormSurvived;
    for (let i = 0; i < 6; i++) frame(50);
    check('the minigame keeps running after an arm failure', S.soulStormSurvived > beforeArmFail,
      'before=' + beforeArmFail + ' after=' + S.soulStormSurvived);
    S.soulStormEnd(true);
    check('no stale minigame frame id once the run ends', S.soulStormRAF === null, 'raf=' + S.soulStormRAF);
  }

  // --- E4: a reward-chain error must still resume the parked game loop -----
  {
    const { S, frame, errors } = makeRunner(src);
    S.pendingPumpkinReward = { candy: 3, points: 500, bossPoints: 5, score: 500 };
    REG.gameUI.classList.remove('hidden');
    S.applyThemeMusic = function () { throw new Error('simulated music failure'); };
    S.launchSoulStorm();
    frame(50);
    S.soulStormSurvived = S.SOUL_STORM_SURVIVE - 0.01;
    frame(50);
    for (let i = 0; i < S.SOUL_STORM_END_E_TARGET; i++) S.soulStormPressE();
    for (let i = 0; i < 30; i++) frame(50);
    check('reward-chain error is reported', S.loopErrors.indexOf('pumpkinRewards') >= 0,
      'reports=' + JSON.stringify(S.loopErrors));
    check('game loop still resumes when the reward chain throws', S.resumeLoopCalls === 1,
      'calls=' + S.resumeLoopCalls);
    check('reward payout completed before the failure', S.pendingPumpkinReward === null);
    check('reward-chain error does not escape', errors.length === 0, errors.join('; '));
  }

  // --- F: retry / menu teardown -----------------------------------------
  {
    const { S, frame, errors } = makeRunner(src);
    S.launchSoulStorm();
    frame(50); // warm-up frame
    S.soulStormSurvived = S.SOUL_STORM_SURVIVE - 0.01;
    frame(50);
    for (let i = 0; i < 320 && !S.soulStormEnded; i++) frame(50);
    for (let i = 0; i < 20; i++) frame(50);
    REG.soulStormRetryBtn.click();
    check('RETRY does not throw', errors.length === 0, errors.join('; '));
    check('RETRY resets minigame state', S.soulStormActive === false && S.soulStormEnded === true);
    check('RETRY hides the overlay', REG.soulStormScreen.classList.contains('hidden'));
    check('RETRY re-arms the pumpkin boss', REG.pumpkinBossBtn._clicks === 1, 'clicks=' + REG.pumpkinBossBtn._clicks);
    S.launchSoulStorm();
    REG.soulStormMenuBtn.click();
    check('MENU returns to menu reset', S.exitSoulTestCalls === 1);
  }

  // --- H: real boss -> minigame handoff --------------------------------
  {
    const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const kStart = s.indexOf('function killPumpkinBoss(mb)');
    const kEnd = s.indexOf('function updateMiniBosses()');
    if (kStart < 0 || kEnd < 0) throw new Error('boss slice markers missing in ' + file);
    const bossSlice = s.slice(kStart, s.lastIndexOf('\n', kEnd));

    const { S, ctx, frame, errors } = makeRunner(src + '\n' + bossSlice);
    Object.assign(S, {
      GROUND_Y: 400, CW: 800, time: 0, CH: 500, stick: { x: 100, y: 400 },
      bullets: [], dummies: [], miniBosses: [], PUMPKIN_BLAST_DMG: 20, PUMPKIN_ORB_DMG: 8,
      PUMPKIN_ORB_TIME: 1200, PUMPKIN_HEAL_INTERVAL: 420, PUMPKIN_PHASE_HP: 2500,
      PUMPKIN_PHASES: 5, spawnPumpkinMinion() {}, createParticles() {}, createTextParticle() {},
      createExplosion() {}, damagePlayer() {}, stopPumpkinMusic() {}, startPumpkinMusic() {}
    });
    const mb = {
      x: 300, y: 400, baseY: 400, hp: 0, maxHp: 2500, alive: true, type: 'pumpkin',
      phase: 5, orbMode: true, orbTimer: 1, orbShootCD: 0, orbShootCDSet: 0,
      hitFlash: 0, speed: 1.2, attackCD: 60, healCD: 420, minionCD: 180,
      slamCD: 260, slamActive: false, slamVy: 0, phaseFlash: 0, facing: -1, animTime: 0
    };
    S.updatePumpkinBoss(mb, 200);
    check('orb form fires an 8-damage orb', S.bullets.length === 1 && S.bullets[0].dmg === 8,
      'bullets=' + JSON.stringify(S.bullets.map((b) => b.dmg)));
    check('orb timer expiring kills the boss', mb.alive === false);
    check('boss death launches Soul Storm', S.soulStormActive === true && S.gameState === 'minigame');
    check('previous game state replaced', S.gameState !== 'playing');
    frame(50); frame(50);
    check('minigame timer runs after the handoff', S.soulStormSurvived > 0, 'got ' + S.soulStormSurvived);
    check('handoff has no runtime errors', errors.length === 0, errors.join('; '));
    check('pending reward deferred, not paid', S.pendingPumpkinReward !== null);
  }

  // --- G: soul-orb damage ------------------------------------------------
  {
    const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const orbConst = /PUMPKIN_ORB_DMG\s*=\s*(\d+)/.exec(s);
    const orbUse = /mb\.orbMode\) \{[\s\S]{0,1200}?dmg: PUMPKIN_ORB_DMG/.test(s);
    const otherShots = (s.match(/dmg: PUMPKIN_BLAST_DMG/g) || []).length;
    check('PUMPKIN_ORB_DMG === 8', orbConst && Number(orbConst[1]) === 8, orbConst ? orbConst[1] : 'missing');
    check('soul-orb shots use PUMPKIN_ORB_DMG', orbUse);
    check('normal pumpkin shots keep PUMPKIN_BLAST_DMG', otherShots === 1, 'found ' + otherShots);
    check('boss death path still calls launchSoulStorm', /killPumpkinBoss[\s\S]{0,900}launchSoulStorm\(\)/.test(s));
  }
}

['index.html', 'index.standalone.html'].forEach(run);

// --- H: the two shipped files must carry an IDENTICAL Soul Storm region ----
{
  console.log('\n===== region parity =====');
  const regionOf = (f) => {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const a = html.indexOf('SOUL STORM (pumpkin boss end minigame)');
    const b = html.indexOf('function updateDarkUniverseBoss');
    return html.slice(html.lastIndexOf('//', a), html.lastIndexOf('\n', b));
  };
  const mainBlock = regionOf('index.html');
  const mirrorRaw = regionOf('index.standalone.html');
  // the mirror is the main file's region de-indented by 4 spaces
  const mirrorAsMain = mirrorRaw.split('\n').map((l) => (l.trim() === '' ? l : '    ' + l)).join('\n');
  const norm = (x) => x.split('\n').map((l) => l.trim()).join('\n');
  check('mirror Soul Storm region matches index.html', norm(mirrorAsMain) === norm(mainBlock));
  check('grace window present in both', /SOUL_STORM_START_GRACE/.test(mainBlock) && /SOUL_STORM_START_GRACE/.test(mirrorRaw));
  check('hearts present in both', /SOUL_STORM_HITS_ALLOWED/.test(mainBlock) && /SOUL_STORM_HITS_ALLOWED/.test(mirrorRaw));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
