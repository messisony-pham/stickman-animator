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

// Records the canvas draw calls the warning arrow makes, so the harness can prove
// the arrow is really painted (direction, length, on-canvas) instead of trusting
// that the code that draws it exists.
const pxOf = (v) => Number(String(v || '0').replace('px', ''));

function mkRecCtx() {
  const rec = { x: 0, y: 0, a: 0, stack: [], rot: [], paths: [], arcs: [], fills: 0, texts: [], _path: null };
  const abs = (px, py) => ({
    x: rec.x + px * Math.cos(rec.a) - py * Math.sin(rec.a),
    y: rec.y + px * Math.sin(rec.a) + py * Math.cos(rec.a)
  });
  const ctx = {
    save() { rec.stack.push({ x: rec.x, y: rec.y, a: rec.a }); },
    restore() { const s = rec.stack.pop(); if (s) { rec.x = s.x; rec.y = s.y; rec.a = s.a; } },
    translate(x, y) { rec.x += x; rec.y += y; },
    rotate(a) { rec.a += a; rec.rot.push(a); },
    beginPath() { rec._path = []; },
    moveTo(x, y) { if (rec._path) rec._path.push(abs(x, y)); },
    lineTo(x, y) { if (rec._path) rec._path.push(abs(x, y)); },
    closePath() { if (rec._path) { rec.paths.push(rec._path); rec._path = null; } },
    arc(x, y, r) { rec.arcs.push({ p: abs(x, y), r: r }); },
    fill() { rec.fills++; },
    stroke() {},
    fillRect() {},
    fillText(t, x, y) { rec.texts.push({ t: t, p: abs(x, y) }); },
    measureText: () => ({ width: 10 }),
    setLineDash() {},
    reset() { rec.x = 0; rec.y = 0; rec.a = 0; rec.stack.length = 0; rec.rot.length = 0; rec.paths.length = 0; rec.arcs.length = 0; rec.texts.length = 0; rec.fills = 0; rec._path = null; }
  };
  Object.defineProperties(ctx, {
    globalAlpha: { set() {}, get() { return 1; } },
    fillStyle: { set(v) { rec.fillStyle = v; }, get() { return rec.fillStyle; } },
    strokeStyle: { set() {}, get() { return '#000'; } },
    lineWidth: { set() {}, get() { return 1; } },
    font: { set() {}, get() { return '10px monospace'; } },
    textAlign: { set() {}, get() { return 'start'; } },
    globalCompositeOperation: { set() {}, get() { return 'source-over'; } }
  });
  ctx.__rec = rec;
  return ctx;
}

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

// --------------------------------------------------------------------- lint
// Finds names used before their own `const`/`let` declaration inside a function.
// This is the bug class that froze the taoist fight: drawStickman's draw blocks
// reference shared locals (`armY`) that are declared further down the function,
// which is a ReferenceError at run time but perfectly valid-looking source.
function stripSourceNoise(s) {
  // Blank out comments and string literals *in place* (same length, newlines kept)
  // so the offset math still lines up and prose like "the shared armY const" is
  // not mistaken for code.
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return s
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, blank);
}
function tdzOffenders(html) {
  const start = html.indexOf('function drawStickman');
  let from = start, body = html;
  if (start >= 0) {
    let depth = 0, end = html.length;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
    }
    body = stripSourceNoise(html.slice(start, end));
    from = 0;
  } else {
    from = 0;
  }
  // `var` counts too: it is hoisted, so a later var is never a use-before-init bug.
  const declRe = /(?:^|[;{}\n])\s*(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=/g;
  const firstDecl = {};
  let m;
  while ((m = declRe.exec(body))) {
    if (!(m[1] in firstDecl)) firstDecl[m[1]] = m.index + m[0].indexOf(m[1]);
  }
  const bad = [];
  Object.keys(firstDecl).forEach((name) => {
    const useRe = new RegExp('(^|[^\\w$.:\'"])' + name + '\\b', 'g');
    let u;
    while ((u = useRe.exec(body))) {
      const at = u.index + u[1].length;
      if (at < firstDecl[name]) { bad.push(name); break; }
    }
  });
  return bad;
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

  // --- B: holding a direction out of the warned zone survives -------------
  // The point slides while ◀/▶ is held, so the harness holds the way OUT of the
  // warned zone, exactly like a player would, and must lose no hearts doing it.
  {
    const { S, frame, errors } = makeRunner(src);
    S.launchSoulStorm();
    let warningsSeen = 0, movedOff = 0;
    const release = () => { S.soulStormSetHeld('left', false); S.soulStormSetHeld('right', false); };
    // Hold exactly the direction the on-screen hint names, so this asserts the HINT is
    // safe to follow — including at a wall, where the only way out is the inner side.
    const escapeHeld = (zoneX) => (S.soulStormEscapeDir(zoneX) < 0 ? 'left' : 'right');
    for (let i = 0; i < 6000 && !S.soulStormEnded && S.soulStormSurvived < S.SOUL_STORM_SURVIVE; i++) {
      const w = S.soulStormWarning;
      if (w) {
        warningsSeen++;
        if (Math.abs(S.soulStormPointX - w.zone) <= S.SOUL_STORM_ZONE_W / 2) {
          const dir = escapeHeld(w.zone);
          S.soulStormSetHeld(dir, true);
          S.soulStormSetHeld(dir === 'left' ? 'right' : 'left', false);
          movedOff++;
        } else {
          release();
        }
      } else {
        release();
      }
      frame(16);
    }
    // A zone hugging a wall can only be escaped on the inner side: the hint has to say so.
    {
      const minX = S.SOUL_STORM_POINT_R + S.SOUL_STORM_ZONE_EDGE;
      S.soulStormPointX = minX;
      const leftZone = S.SOUL_STORM_ZONE_W / 2 + S.SOUL_STORM_ZONE_EDGE;
      check('a zone against the left wall hints RIGHT, not into the wall',
        S.soulStormEscapeDir(leftZone) === 1, 'dir=' + S.soulStormEscapeDir(leftZone));
      S.soulStormPointX = S.SOUL_STORM_ARENA_W - minX;
      const rightZone = S.SOUL_STORM_ARENA_W - (S.SOUL_STORM_ZONE_W / 2 + S.SOUL_STORM_ZONE_EDGE);
      check('a zone against the right wall hints LEFT, not into the wall',
        S.soulStormEscapeDir(rightZone) === -1, 'dir=' + S.soulStormEscapeDir(rightZone));
      S.soulStormPointX = S.SOUL_STORM_ARENA_W / 2;
      check('a mid-track zone hints away from its own centre',
        S.soulStormEscapeDir(S.SOUL_STORM_ARENA_W / 2 - 20) === 1 &&
        S.soulStormEscapeDir(S.SOUL_STORM_ARENA_W / 2 + 20) === -1);
    }
    check('warnings were shown', warningsSeen > 0);
    check('blasts were fired', S.soulStormBlastsFired > 0);
    check('the point really had to move out of a zone', movedOff > 0, 'moved=' + movedOff);
    check('holding the way out costs no hearts', S.soulStormHits === 0, 'hits=' + S.soulStormHits);
    check('survived the full window', S.soulStormSurvived >= S.SOUL_STORM_SURVIVE - 0.06, 'survived=' + S.soulStormSurvived.toFixed(2));
    check('reached the E gauntlet', S.soulStormEActive === true);
    check('E button is shown in the arena', !!REG.soulStormArena.querySelector('button[data-lane="e"]') &&
      REG.soulStormArena.querySelector('button[data-lane="e"]').style.display === 'flex');
    check('the ◀ ▶ pads are hidden during the E gauntlet',
      REG.soulStormArena.querySelectorAll('.soulStormPad').every((p) => p.style.display === 'none'),
      REG.soulStormArena.querySelectorAll('.soulStormPad').map((p) => p.dataset.pad + ':' + p.style.display).join(','));
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
    // The point never moves here, but the zones are random, so a miss can take a while to
    // happen: step until one does (a 60s cap) instead of assuming a fixed number of frames.
    // Steering INTO the warned zone makes every blast land, so the heart count is down to
    // the player being careless rather than to where the random zone happened to fall.
    const missInto = () => {
      const w = S3.soulStormWarning;
      if (!w) {
        S3.soulStormSetHeld('left', false); S3.soulStormSetHeld('right', false);
        return;
      }
      S3.soulStormSetHeld(S3.soulStormPointX < w.zone ? 'right' : 'left', true);
    };
    for (let i = 0; i < 1200 && !S3.soulStormEnded; i++) {
      missInto();
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
    for (let i = 0; i < 2000 && !S3.soulStormEnded; i++) { missInto(); f3(50); }
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

  // --- H: real soul form -> minigame handoff ------------------------------
  // The soul form is an ATTACKABLE 5,000 HP phase now: it must be killed with damage
  // to reach Soul Storm. The old 20s auto-death must be gone (it decided the fight
  // for the player) and only the stall safety net may advance the fight.
  function wireBoss(S, C) {
    Object.assign(S, {
      GROUND_Y: 400, CW: 800, time: 0, CH: 500, stick: { x: 100, y: 400 },
      bullets: [], dummies: [], miniBosses: [], PUMPKIN_BLAST_DMG: 20, PUMPKIN_ORB_DMG: 8,
      PUMPKIN_ORB_TIME: 1200, PUMPKIN_HEAL_INTERVAL: 420, PUMPKIN_PHASE_HP: C.phaseHp,
      PUMPKIN_PHASES: C.phases, PUMPKIN_SOUL_HP: C.soulHp, PUMPKIN_SOUL_TIMEOUT: C.soulTimeout,
      PUMPKIN_ORB_SHOT_CD: C.orbShotCd,
      spawnPumpkinMinion() {}, createParticles() {}, createTextParticle() {}, createExplosion() {},
      damagePlayer() {}, stopPumpkinMusic() {}, startPumpkinMusic() {}, bumpPumpkinMusic() {},
      getShopUpgradeEffect() { return 1; }, getTraitMult() { return 1; }, pickupDmgMult() { return 1; },
      vampireHeal() {}
    });
  }
  const mkPumpkin = (C, over) => Object.assign({
    x: 300, y: 400, baseY: 400, hp: C.phaseHp, maxHp: C.phaseHp, alive: true, type: 'pumpkin',
    phase: C.phases, orbMode: false, orbTimer: 0, orbShootCD: 0, soulTimer: 0,
    hitFlash: 0, speed: 1.2, attackCD: 60, healCD: 420, minionCD: 180,
    slamCD: 260, slamActive: false, slamVy: 0, phaseFlash: 0, facing: -1, animTime: 0
  }, over || {});
  {
    const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const kStart = s.indexOf('function dealDamageToMiniBoss(mb, dmg, source)');
    const kEnd = s.indexOf('function updateMiniBosses()');
    if (kStart < 0 || kEnd < 0) throw new Error('boss slice markers missing in ' + file);
    const bossSlice = s.slice(kStart, s.lastIndexOf('\n', kEnd));
    const num = (re, fallback) => { const m = re.exec(s); return m ? Number(m[1]) : fallback; };
    const C = {
      soulHp: num(/PUMPKIN_SOUL_HP\s*=\s*(\d+)/, 0),
      soulTimeout: num(/PUMPKIN_SOUL_TIMEOUT\s*=\s*(\d+)/, 0),
      phaseHp: num(/PUMPKIN_PHASE_HP\s*=\s*(\d+)/, 2500),
      phases: num(/PUMPKIN_PHASES\s*=\s*(\d+)/, 5),
      orbShotCd: num(/PUMPKIN_ORB_SHOT_CD\s*=\s*(\d+)/, 16)
    };
    check('PUMPKIN_SOUL_HP ships as 5000', C.soulHp === 5000, 'got ' + C.soulHp);
    check('PUMPKIN_ORB_SHOT_CD ships a usable blast cadence',
      C.orbShotCd > 0 && C.orbShotCd <= 60, 'got ' + C.orbShotCd);
    check('the soul form is no longer flagged invulnerable in the damage path',
      !/orbMode\)\s*\{\s*createTextParticle\(mb\.x, mb\.y - 20, '[^']*IMMUNE/.test(s));
    check('the old "orbTimer expiring kills the boss" rule is gone',
      !/if \(mb\.orbTimer <= 0\) killPumpkinBoss\(mb\);/.test(s));
    check('a stall safety net exists for the soul fight',
      /PUMPKIN_SOUL_TIMEOUT/.test(s) && /mb\.soulTimer >= PUMPKIN_SOUL_TIMEOUT\) killPumpkinBoss\(mb\)/.test(s));
    // The soul form's blasts must be telegraphed by a LONG arrow that charges over
    // the real blast cooldown and is clamped so it can never run off the canvas.
    check('the soul form telegraphs its blasts with a long charge arrow',
      /var warnAim = Math\.atan2\(\(stick\.y - 30\) - gy, stick\.x - dx\)/.test(s) &&
      /ctx\.rotate\(warnAim\)/.test(s) && /ctx\.moveTo\(34, -7\)/.test(s));
    check('the warning arrow charges over the real blast cooldown',
      /PUMPKIN_ORB_SHOT_CD\s*=\s*(\d+)/.test(s) && /mb\.orbShootCD = PUMPKIN_ORB_SHOT_CD;/.test(s));
    check('the warning arrow is clamped to the canvas', /var warnEdge = 620/.test(s));

    // A) damaging the last physical phase turns the boss into the 5,000 HP soul form
    const { S, frame, errors } = makeRunner(src + '\n' + bossSlice);
    wireBoss(S, C);
    const soul = mkPumpkin(C);
    S.dealDamageToMiniBoss(soul, C.phaseHp, 'test');
    check('clearing the last phase enters the soul form', soul.orbMode === true, 'orb=' + soul.orbMode);
    check('the soul form starts at 5,000 HP', soul.hp === 5000 && soul.maxHp === 5000,
      'hp=' + soul.hp + ' maxHp=' + soul.maxHp);

    // B) attacks land on the soul form instead of bouncing off as IMMUNE
    const hpBefore = soul.hp;
    S.dealDamageToMiniBoss(soul, 500, 'shoot');
    check('the soul form takes real damage', soul.hp === hpBefore - 500, 'hp=' + soul.hp);
    check('hits still flash the soul form', soul.hitFlash === 6, 'hitFlash=' + soul.hitFlash);

    // C) finishing its 5,000 HP is what sends the player into the minigame
    S.dealDamageToMiniBoss(soul, soul.hp, 'test');
    check('defeating the soul form kills the boss', soul.alive === false, 'alive=' + soul.alive);
    check('defeating the soul form launches Soul Storm', S.soulStormActive === true && S.gameState === 'minigame');
    check('previous game state replaced', S.gameState !== 'playing');
    frame(50); frame(50);
    check('minigame timer runs after the handoff', S.soulStormSurvived > 0, 'got ' + S.soulStormSurvived);
    check('handoff has no runtime errors', errors.length === 0, errors.join('; '));
    check('pending reward deferred, not paid', S.pendingPumpkinReward !== null);

    // D) an untouched soul form must NOT auto-die on the old 20s timer
    const { S: S2 } = makeRunner(src + '\n' + bossSlice);
    wireBoss(S2, C);
    const lazy = mkPumpkin(C, { orbMode: true, hp: C.soulHp, maxHp: C.soulHp, orbTimer: 1, orbShootCD: 0 });
    for (let i = 0; i < 40; i++) S2.updatePumpkinBoss(lazy, 200);
    check('orb form fires an 8-damage orb', S2.bullets.length > 0 && S2.bullets.every((b) => b.dmg === 8),
      'bullets=' + JSON.stringify(S2.bullets.map((b) => b.dmg).slice(0, 3)));
    check('an unkilled soul form survives its old 20s timer', lazy.alive === true && lazy.orbMode === true,
      'alive=' + lazy.alive + ' frame=' + lazy.orbTimer);
    check('the soul form keeps its 5,000 HP pool while it fights', lazy.hp === 5000, 'hp=' + lazy.hp);
    for (let i = 0; i < C.soulTimeout + 5; i++) S2.updatePumpkinBoss(lazy, 200);
    check('the stall safety net eventually advances the fight', lazy.alive === false, 'alive=' + lazy.alive);
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

  // --- J: the long warning arrow really draws, aimed at the player -----------
  // drawMiniBoss is run against a recording canvas so the painted polygon (not the
  // source text) is what gets asserted: it must start at the orb, point at the
  // player, stay on the canvas, and grow as the next blast charges.
  {
    const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const ds = s.indexOf('function drawMiniBoss(mb)');
    const de = s.indexOf('function updatePumpkinBoss');
    if (ds < 0 || de < 0) throw new Error('drawMiniBoss markers missing in ' + file);
    const num = (re, fallback) => { const m = re.exec(s); return m ? Number(m[1]) : fallback; };
    const rec = mkRecCtx();
    const { S } = makeRunner(src + '\n' + s.slice(ds, s.lastIndexOf('\n', de)));
    const C2 = {
      phaseHp: num(/PUMPKIN_PHASE_HP\s*=\s*(\d+)/, 2500), phases: num(/PUMPKIN_PHASES\s*=\s*(\d+)/, 5),
      soulHp: num(/PUMPKIN_SOUL_HP\s*=\s*(\d+)/, 5000), soulTimeout: num(/PUMPKIN_SOUL_TIMEOUT\s*=\s*(\d+)/, 7200),
      orbShotCd: num(/PUMPKIN_ORB_SHOT_CD\s*=\s*(\d+)/, 16)
    };
    wireBoss(S, C2);
    S.PUMPKIN_SOUL_HP = C2.soulHp;
    S.PUMPKIN_ORB_SHOT_CD = C2.orbShotCd;
    S.CW = 900; S.CH = 500; S.time = 12;
    S.ctx = rec;
    S.stick = { x: 700, y: 400 };
    const orb = mkPumpkin(C2, {
      x: 300, y: 210, baseY: 210, orbMode: true, hp: C2.soulHp, maxHp: C2.soulHp
    });
    const paint = (cd) => {
      orb.orbShootCD = cd;
      rec.reset();
      S.drawMiniBoss(orb);
      const p = rec.__rec.paths[0];
      return p && p.length === 7 ? p : null;   // 7 points == the arrow polygon
    };
    const charged = paint(0);
    const idle = paint(S.PUMPKIN_ORB_SHOT_CD);
    check('the warning arrow paints a 7-point arrow polygon', !!charged && !!idle);
    if (charged) {
      const toPlayer = Math.atan2(370 - 210, 700 - 300);
      const tip = charged[3];
      const tail = charged[0];
      const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
      const tipAngle = Math.atan2(tip.y - 210, tip.x - 300);
      const offAxis = Math.abs(Math.atan2(Math.sin(tipAngle - toPlayer), Math.cos(tipAngle - toPlayer)));
      check('the arrow emanates from the soul form (tail sits just outside the orb)',
        dist(tail, { x: 300, y: 210 }) > 30 && dist(tail, { x: 300, y: 210 }) < 40, 'tail dist=' + dist(tail, { x: 300, y: 210 }).toFixed(1));
      check('the arrow points straight at the player', offAxis < 0.02, 'off-axis=' + offAxis.toFixed(4));
      check('the arrow is long (>250px)', dist(tip, { x: 300, y: 210 }) > 250, 'len=' + dist(tip, { x: 300, y: 210 }).toFixed(1));
      check('the arrow stays on the canvas', tip.x >= 0 && tip.x <= S.CW && tip.y >= 0 && tip.y <= S.CH,
        'tip=' + tip.x.toFixed(1) + ',' + tip.y.toFixed(1));
      check('the arrow grows as the next blast charges',
        dist(charged[3], { x: 300, y: 210 }) > dist(idle[3], { x: 300, y: 210 }) + 100,
        'charged=' + dist(charged[3], { x: 300, y: 210 }).toFixed(1) + ' idle=' + dist(idle[3], { x: 300, y: 210 }).toFixed(1));
    }
  }

  // --- K: the minigame's LONG warning arrow ------------------------------
  // The Soul Storm warning used to be colour + text only. Every lane now owns a
  // long arrow that appears for the warning window, charges amber -> red as the
  // blast closes in, and puts its head on the lane button that is about to go off.
  {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
    check('the source ships a long minigame warning arrow',
      /soulStormArrow absolute pointer-events-none/.test(raw) && /a\.wrap\.style\.left = \(w\.zone - 30\)/.test(raw));

    const { S, frame, errors } = makeRunner(src);
    S.buildSoulStormArena();
    S.launchSoulStorm();
    const arrows = () => REG.soulStormArena.querySelectorAll('.soulStormArrow');
    const shown = () => arrows().filter((a) => a.style.display === 'block');
    const px = (v) => Number(String(v || '0').replace('px', ''));
    const arrowZone = (a) => px(a.style.left) + 30;      // 60px wide wrap, centred on the zone
    frame(16);
    check('exactly one long warning arrow is built', arrows().length === 1, 'found ' + arrows().length);
    check('no arrow is up during GET READY', shown().length === 0, 'shown=' + shown().length);
    let warned = null;
    for (let i = 0; i < 120 && !warned; i++) { frame(50); if (S.soulStormWarning) warned = S.soulStormWarning.zone; }
    check('a zone gets warned', typeof warned === 'number', 'warned=' + warned);
    const up = shown();
    check('exactly one long arrow is on screen', up.length === 1, 'shown=' + up.length);
    check('the arrow is aimed at the warned zone', up.length === 1 && Math.abs(arrowZone(up[0]) - warned) <= 1,
      'arrow=' + (up[0] && arrowZone(up[0])) + ' warned=' + warned);
    const a = up[0] || mkEl();
    const kids = (a.children || []).map((c) => c.className);
    check('the arrow has a shaft and an arrow head', a.children.length === 2 &&
      /soulStormArrowShaft/.test(kids[0]) && /soulStormArrowHead/.test(kids[1]), kids.join('|'));
    check('the head points DOWN at the track (CSS triangle)',
      /^30px solid #/.test(a.children[1] && a.children[1].style.borderTop || ''), a.children[1] && a.children[1].style.borderTop);
    check('the arrow is long, not a stub', px(a.style.height) >= 200, 'height=' + a.style.height);
    check('the head lands inside the track', px(a.style.top) + px(a.style.height) >= S.SOUL_STORM_TRACK_Y &&
      px(a.style.top) + px(a.style.height) <= S.SOUL_STORM_TRACK_Y + S.SOUL_STORM_TRACK_H,
      'bottom=' + (px(a.style.top) + px(a.style.height)) + ' track=' + S.SOUL_STORM_TRACK_Y + '..' + (S.SOUL_STORM_TRACK_Y + S.SOUL_STORM_TRACK_H));
    check('the arrow charges as the warning counts down', /^scaleY\(/.test(a.style.transform || ''), 'transform=' + a.style.transform);
    check('the arrow shaft deepens toward the head',
      /^linear-gradient\(to bottom/.test(a.children[0].style.background || ''), a.children[0].style.background);

    // Drive the whole survival phase: the arrow must be re-aimed at every warned zone,
    // must never linger between warnings, and must be gone for the E gauntlet and after.
    let tracked = 0, mismatch = 0, stale = 0, hintMismatch = 0;
    for (let i = 0; i < 2600 && !S.soulStormEActive && !S.soulStormEnded; i++) {
      const w = S.soulStormWarning;
      const visible = shown();
      if (w) {
        tracked++;
        if (visible.length !== 1 || Math.abs(arrowZone(visible[0]) - w.zone) > 1) mismatch++;
        const inside = Math.abs(S.soulStormPointX - w.zone) <= S.SOUL_STORM_ZONE_W / 2;
        if (inside) {
          const dir = S.soulStormEscapeDir(w.zone);
          // The on-screen hint must name the same way out that actually works.
          const hint = S.soulStormMoveHint();
          if (hint.indexOf(dir < 0 ? 'LEFT' : 'RIGHT') < 0) hintMismatch++;
          S.soulStormSetHeld(dir < 0 ? 'left' : 'right', true);
        } else { S.soulStormSetHeld('left', false); S.soulStormSetHeld('right', false); }
      } else if (S.soulStormSurvived >= S.SOUL_STORM_START_GRACE && visible.length) {
        stale++;
      }
      frame(16);
    }
    check('the arrow followed every warned zone', tracked > 0 && mismatch === 0, 'tracked=' + tracked + ' mismatches=' + mismatch);
    check('no arrow lingers between warnings', stale === 0, 'stale frames=' + stale);
    check('the hint always names the escape that actually works', hintMismatch === 0, 'wrong hints=' + hintMismatch);
    check('escaping every zone kept every heart', S.soulStormHits === 0, 'hits=' + S.soulStormHits);
    check('the survival phase reached the E gauntlet', S.soulStormEActive === true);
    check('no arrow during the E gauntlet', shown().length === 0, 'shown=' + shown().length);
    for (let i = 0; i < S.SOUL_STORM_END_E_TARGET; i++) S.soulStormPressE();
    for (let i = 0; i < 40; i++) frame(50);
    check('the run was won', S.soulStormWin === true);
    check('no arrow left on the result pane', shown().length === 0, 'shown=' + shown().length);
    check('the arrow run has no runtime errors', errors.length === 0 && S.loopErrors.length === 0,
      errors.concat(S.loopErrors).join('; '));
  }

  // --- L: the point moves with ◀/▶ and the blast hit-rule follows it -------
  {
    const { S, frame, errors } = makeRunner(src);
    S.buildSoulStormArena();
    S.launchSoulStorm();
    const startX = S.soulStormPointX;
    const margin = S.SOUL_STORM_POINT_R + S.SOUL_STORM_ZONE_EDGE;
    check('the point starts centred on the track', Math.abs(startX - S.SOUL_STORM_ARENA_W / 2) < 0.001, 'x=' + startX);
    S.soulStormSetHeld('right', true);
    for (let i = 0; i < 20; i++) frame(16);
    check('holding ▶ slides the point right', S.soulStormPointX > startX + 20, 'x=' + S.soulStormPointX.toFixed(1));
    S.soulStormSetHeld('right', false);
    const released = S.soulStormPointX;
    for (let i = 0; i < 10; i++) frame(16);
    check('the point stops when the key is released', S.soulStormPointX === released, 'x=' + S.soulStormPointX.toFixed(1));
    S.soulStormSetHeld('left', true);
    for (let i = 0; i < 300; i++) frame(16);
    S.soulStormSetHeld('left', false);
    check('the point cannot leave the track', Math.abs(S.soulStormPointX - margin) < 0.001, 'x=' + S.soulStormPointX);
    check('the point is drawn where the model says it is',
      REG.soulStormPoint && pxOf(REG.soulStormPoint.style.left) === S.soulStormPointX - S.SOUL_STORM_POINT_R,
      'dotLeft=' + (REG.soulStormPoint && REG.soulStormPoint.style.left) + ' x=' + S.soulStormPointX);

    // Standing in the warned zone must cost a heart; being clear of it must not.
    const hitRun = (leave) => {
      const r = makeRunner(src);
      const T = r.S;
      T.launchSoulStorm();
      let seen = false;
      for (let i = 0; i < 400 && !seen && !T.soulStormEnded; i++) {
        if (T.soulStormWarning && T.soulStormSurvived >= T.SOUL_STORM_START_GRACE) {
          seen = true;
          T.soulStormPointX = leave ? T.soulStormWarning.zone + T.SOUL_STORM_ZONE_W : T.soulStormWarning.zone;
        }
        r.frame(16);
      }
      if (!seen) return null;
      for (let i = 0; i < 400 && !T.soulStormEnded; i++) {
        if (T.soulStormWarning) {
          T.soulStormPointX = leave ? T.soulStormWarning.zone + T.SOUL_STORM_ZONE_W : T.soulStormWarning.zone;
        }
        r.frame(16);
        if (!leave && T.soulStormHits >= 1) break;
      }
      return T.soulStormHits;
    };
    check('standing in the warned zone costs a heart', hitRun(false) === 1);
    check('being clear of the warned zone is safe', hitRun(true) === 0);
    check('movement run has no runtime errors', errors.length === 0, errors.join('; '));
  }

  // --- M: the pumpkin boss is OPT-IN — only the 🎃 Fight Boss button ------------
  // The boss used to arrive on a Halloween-gated timer, which (depending on tuning)
  // either never showed up in a normal run or crashed into every mode. The shipped
  // contract is now the opposite: EASY / NORMAL / HARD, sandbox, boss rush, campaign
  // and phantom missions never spawn it — only the menu's 🎃 Fight Boss button asks
  // for it by setting `pumpkinBossRequested`, and the boss walks in on the next
  // frame. The main loop sits outside the extracted region, so these are
  // source-level guards (a live browser run covers the behaviour).
  {
    const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
    check('the opt-in request flag exists', /let pumpkinBossRequested = false;/.test(s));
    check('the old timed spawn interval is gone', !/PUMPKIN_SPAWN_INTERVAL/.test(s));
    check('the old frame-timer arrival is gone', !/pumpkinTimer/.test(s));
    check('the single spawn sink waits on the request flag',
      /if \(pumpkinBossRequested && !pumpkinSpawned\) \{\s*\n\s*pumpkinBossRequested = false; pumpkinSpawned = true; miniBosses\.push\(\{/.test(s));
    const sinks = (s.match(/pumpkinSpawned = true/g) || []).length;
    check('the boss can only be spawned from that one sink', sinks === 1, 'found ' + sinks);
    check('the spawned boss is the pumpkin', /type: 'pumpkin', animTime: 0/.test(s));
    check('the 🎃 Fight Boss button asks for the boss',
      /getElementById\('pumpkinBossBtn'\)\.addEventListener\('click'/.test(s) &&
      /pumpkinBossRequested = true; \/\/ the boss walks in on the very next frame/.test(s));
    const setters = (s.match(/pumpkinBossRequested = true/g) || []).length;
    check('only the 🎃 Fight Boss button can request the boss', setters === 1, 'found ' + setters);
    check('the button is kept visible all year round',
      /var pbb = document\.getElementById\('pumpkinBossBtn'\); if \(pbb\) pbb\.classList\.remove\('hidden'\);/.test(s));
  }
}

['index.html', 'index.standalone.html'].forEach(run);

// --- I: the minigame overlay must be reachable in BOTH shipped files ---------
// Regression: index.standalone.html shipped with #soulStormScreen nested INSIDE the
// hidden #rhythmScreen (one </div> was missing and a stray one closed rhythmScreen
// later). The parent's `hidden` (display:none) meant the arena never rendered while
// the main game loop was parked for the minigame — the "boss fight minigame freezes"
// bug, which only ever happened in the standalone file the game is played from.
{
  console.log('\n===== overlay reachability =====');
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const re = /<(\/?)div\b[^>]*>/g;
    let depth = 0, rhythm = null, soul = null, m;
    while ((m = re.exec(html))) {
      if (m[1] === '/') { depth--; continue; }
      const id = (/\sid="([^"]+)"/.exec(m[0]) || [])[1];
      if (id === 'rhythmScreen') rhythm = depth + 1;
      if (id === 'soulStormScreen') soul = depth + 1;
      depth++;
    }
    check(file + ': #soulStormScreen exists', soul !== null);
    check(file + ': #rhythmScreen exists', rhythm !== null);
    check(file + ': #soulStormScreen is a SIBLING of #rhythmScreen (not trapped inside the hidden one)',
      soul !== null && soul === rhythm, 'soulDepth=' + soul + ' rhythmDepth=' + rhythm);
  });
}

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

  // The warning arrow block must be byte-identical in the two shipped files, or the
  // file the game is actually played from can drift from the published one again.
  const arrowOf = (f) => {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const a = html.indexOf('---- LONG WARNING ARROW');
    const b = html.indexOf('var orbP = 1 + Math.sin(time * 0.3) * 0.15;', a);
    return a < 0 || b < 0 ? null : html.slice(a, b).split('\n').map((l) => l.trim()).join('\n');
  };
  const arrowMain = arrowOf('index.html');
  check('warning arrow present in both files', arrowMain !== null && arrowOf('index.standalone.html') !== null);
  check('warning arrow is identical in both files', arrowMain === arrowOf('index.standalone.html'));
}

// --- N: the mobile layer — the game has to be playable on a phone -----------
// Regression: the touch pads needed a hidden Settings toggle, sat on top of the
// menus/minigames eating their taps, laid five 48px ability buttons plus a 120px
// d-pad across one row (wider than a phone), never released the JUMP key, and the
// canvas was sized from innerHeight so mobile toolbars clipped the ground away.
{
  console.log('\n===== mobile playability =====');
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    check(file + ': the viewport opts into safe areas', /name="viewport"[^>]*viewport-fit=cover/.test(html));
    check(file + ': touch pads auto-enable on touch devices and are remembered',
      /var TOUCH_DEVICE = /.test(html) && /storedMobileMode === null \? TOUCH_DEVICE/.test(html));
    check(file + ': the canvas is sized from the visual viewport',
      /function viewportSize\(\)/.test(html) && /window\.visualViewport/.test(html));
    // Landscape hands the arena the height (the thumb clusters hug the side edges there
    // instead of sitting under it), portrait reserves room for the pads below it, and the
    // scale is capped at 1 so the 900x500 bitmap is never stretched and blurred.
    const reserved = (/var reserved = mobileMode \? \(landscape \? (\d+) : (\d+)\) : (\d+);/.exec(html) || []).slice(1).map(Number);
    check(file + ': the canvas fills the play area but never upscales (no blur)',
      reserved.length === 3 && reserved[0] <= 40 && reserved[1] >= 120 && reserved[2] >= 120 &&
      /var s = Math\.min\(maxW \/ CW, maxH \/ CH, 1\);/.test(html),
      'reserved=' + reserved.join('/'));
    check(file + ': in portrait the arena centres above the pads, not under them',
      /body\.mob-hud #playArea \{ align-items: center; padding-bottom: calc\(128px \+ env\(safe-area-inset-bottom\)\); \}/.test(html));
    // 120Hz phones ran the whole fight at double speed until the loop became fixed-step.
    check(file + ': the game runs on a fixed 60Hz step instead of one step per frame',
      /var FRAME = \{ last: 0, acc: 0, step: 1000 \/ 60, maxSteps: 3 \};/.test(html) &&
      /function gameStep\(\) \{/.test(html) &&
      /while \(FRAME\.acc >= FRAME\.step && steps < FRAME\.maxSteps\)/.test(html) &&
      !/function gameStep\(\)[\s\S]{0,200}?requestAnimationFrame\(gameLoop\)[\s\S]{0,40}?loopFrameArmed = true/.test(html));
    check(file + ': a backgrounded tab pauses instead of losing the run',
      /addEventListener\('visibilitychange'/.test(html) && /if \(document\.hidden && gameState === 'playing'\)/.test(html));
    check(file + ': the canvas is not re-fitted on every URL-bar twitch',
      /lastCanvasBox/.test(html) && /if \(box === lastCanvasBox\)/.test(html));
    check(file + ': thumb pads keep their hold when the finger slides off',
      /lostpointercapture/.test(html) && /setPointerCapture/.test(html) &&
      !/addEventListener\('pointerleave', release\)/.test(html));
    check(file + ': a lift anywhere releases the pad it belongs to',
      /window\.addEventListener\('pointerup', function \(e\) \{ releaseMobPointer\(e\.pointerId\); \}\)/.test(html));
    check(file + ': the fixed-size minigame boards scale to the screen', /function fitMiniArenas/.test(html));
    check(file + ': pads use pointer events (touch and mouse)', /addEventListener\('pointerdown', press\)/.test(html));
    check(file + ': the old touch-only handlers are gone',
      !/getElementById\('mobBtnAtk'\)\.addEventListener\('touchstart'/.test(html));
    check(file + ': JUMP is released when the thumb lifts', /function\(\) \{ keys\.delete\(' '\); \}/.test(html));
    check(file + ': the pads are hidden over menus and minigames', /function syncMobileControls\(\)/.test(html));
    check(file + ': the HUD collapses on narrow screens',
      /\.hud-lbl, #expWrap, #ultBtnRow \{ display: none !important; \}/.test(html));
    check(file + ': the touch pad shrinks on tiny screens',
      /\.mob-ability \{ width: 34px; height: 34px;/.test(html) && /\.mob-dir \{ width: 46px; height: 46px; \}/.test(html));
    check(file + ': the cutscene stacks instead of clipping on a phone', /#cutsceneScreen \{ flex-direction: column;/.test(html));
    check(file + ': short menu screens scroll instead of hiding PLAY',
      /#menuScreen, #campaignScreen, #settingsScreen \{\s*\n\s*overflow-y: auto;/.test(html));
    check(file + ': the menu is capped to the screen and the character grid reflows',
      /#menuScreen > div \{ width: 100%; \}/.test(html) &&
      /#charGrid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/.test(html));
    check(file + ': the mode row wraps instead of stretching the menu',
      /flex gap-3 justify-center mb-4 flex-wrap/.test(html));
    check(file + ': the settings and campaign cards stay inside a narrow screen',
      /w-96 max-w-\[92vw\]/.test(html) && /w-80 max-w-\[92vw\]/.test(html));
  });
  // The published build and the standalone build must carry the same pads.
  const mobOf = (f) => {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const a = html.indexOf('<!-- Mobile Controls Overlay');
    const b = html.indexOf('<!-- Game UI -->');
    return a < 0 || b < 0 ? null : html.slice(a, b).split('\n').map((l) => l.trim()).join('\n');
  };
  const pads = mobOf('index.html');
  check('the touch pad markup exists in both files', pads !== null && mobOf('index.standalone.html') !== null);
  check('the touch pad markup is identical in both files', pads === mobOf('index.standalone.html'));
  // Both thumb clusters must fit side by side on a 320px-wide phone: the narrow-screen
  // breakpoint shrinks the pad to 104px and the five ability keys to 34px/gap 4.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const narrow = /#dpadArea \{ width: 104px; \}/.test(html) && /#mobAbilityRow \{ gap: 4px; \}/.test(html);
  const dpadW = 104, rowW = 5 * 34 + 4 * 4, margins = 20;
  check('both thumb clusters fit a 320px phone without overlapping', narrow && dpadW + rowW + margins <= 320,
    'dpad=' + dpadW + ' row=' + rowW);
}

// --- O: animation rig, sprint, werewolf skin, pumpkin HP, cross-device saves ---
{
  console.log('\n===== animation / content / saves =====');
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // One shared pose solver drives the player AND the grunts.
    check(file + ': a shared stick-figure rig exists',
      /function stickRig\(o\) \{/.test(html) && /function strokeLimb\(ox, oy, jx, jy, ex, ey\)/.test(html));
    check(file + ': the rig bends knees and elbows (two segments per limb)',
      /legs\.push\(\{ kx: kneeX, ky: kneeY, fx: footX, fy: footY \}\)/.test(html) &&
      /arms\.push\(\{ ex: elbowX, ey: elbowY, hx: handX, hy: handY \}\)/.test(html));
    check(file + ': the player is drawn from the rig, with joints visible',
      /const rig = stickRig\(\{ x: x, y: y, facing: facing, state: state, vy: vy/.test(html) &&
      /strokeLimb\(x, bbY, lg\.kx, lg\.ky, lg\.fx, lg\.fy\)/.test(html));
    check(file + ': ground enemies walk on the same rig',
      /var erg = stickRig\(\{[\s\S]{0,200}?legLen: 13/.test(html) && /strokeLimb\(dx, wHip, elg\.kx, elg\.ky, elg\.fx, elg\.fy\)/.test(html));
    check(file + ': idle / walk / sprint / jump all have their own pose',
      /var sprint = state === 'sprint';/.test(html) && /if \(state === 'jump'\) \{\n\s*\/\/ Rising/.test(html));
    check(file + ': sprint is reachable without an extra button (hold a direction)',
      /const SPRINT_HOLD_FRAMES = 27, SPRINT_SPEED_MULT = 1.3;/.test(html) &&
      /var sprinting = wantsMove && \(sprintHold > SPRINT_HOLD_FRAMES \|\| shiftHeld\)/.test(html));
    check(file + ': sprint is a real state, entered from the movement state machine',
      /stick\.state = sprinting \? 'sprint' : 'walk'/.test(html));
    check(file + ': landing squashes the knees then recovers',
      /let landSquash = 0;/.test(html) && /landSquash = Math\.min\(9, 3 \+ stick\.vy \* 0\.6\)/.test(html) &&
      /if \(landSquash > 0\) landSquash = Math\.max\(0, landSquash - 1\.6\)/.test(html));

    // Halloween werewolf skin
    check(file + ': the werewolf skin is in the Halloween skin list',
      /id: 'fighter_werewolf', char: 'fighter', name: 'Werewolf'/.test(html));
    check(file + ': the werewolf skin is drawn (ears, snout, claws, tail)',
      /selectedSkin === 'fighter_werewolf'/.test(html) &&
      /\/\/ Snout/.test(html) && /\/\/ Claws on both hands/.test(html) && /\/\/ Ears/.test(html));
    check(file + ': the werewolf perk is wired to real damage',
      /selectedSkin === 'fighter_werewolf'\) \{\s*\n\s*return \(typeof playerHP === 'number'/.test(html));

    // Pumpkin boss tuning
    const phaseHp = Number((/const PUMPKIN_PHASE_HP = (\d+);/.exec(html) || [])[1]);
    const soulHp = Number((/const PUMPKIN_SOUL_HP = (\d+);/.exec(html) || [])[1]);
    const phases = Number((/const PUMPKIN_PHASES = (\d+);/.exec(html) || [])[1]);
    check(file + ': the pumpkin boss has 500 HP per phase', phaseHp === 500, 'found ' + phaseHp);
    check(file + ': every phase refills to that same 500 HP',
      /mb\.phase\+\+; mb\.hp = PUMPKIN_PHASE_HP;/.test(html), 'phases=' + phases);
    check(file + ': the soul form is untouched at 5,000 HP', soulHp === 5000, 'found ' + soulHp);
    check(file + ': the total is 5 x 500 = 2,500', phaseHp * phases === 2500, 'total=' + phaseHp * phases);

    // Cross-device / cross-account saves
    check(file + ': storage is wrapped so a blocked localStorage cannot kill the game',
      /var localStorage = \(function \(\) \{/.test(html) && /getItem: get, setItem: set, removeItem: del/.test(html));
    check(file + ': numeric saves are healed instead of loading as NaN',
      /function loadNum\(key, fallback\)/.test(html) && /let totalPoints = loadNum\('sm_totalPoints'\)/.test(html));
    check(file + ': saves carry a version that migrates old data',
      /const SAVE_VERSION = 3, BUILD = '3\.0\.0';/.test(html) && /function migrateSave\(\)/.test(html) &&
      /localStorage\.setItem\('sm_saveVersion', SAVE_VERSION\)/.test(html));
    check(file + ': the menu shows the build so a second device can be checked',
      /id="buildStamp"/.test(html));
    // Regression: a round started after a death kept the previous round's empty HP bar
    // until the first hit, because fullReset() set playerHP without refreshing the HUD.
    check(file + ': a fresh round refreshes the HP / EXP HUD',
      /playerHP = PLAYER_MAX_HP_CURRENT; attackCooldown = 0;\n(?:\s*\/\/[^\n]*\n)+\s*updateHPBar\(\); updateEXPBar\(\); updateShieldBar\(\);/.test(html));
    check(file + ': a fresh round clears the sprint and landing timers',
      /landSquash = 0; sprintHold = 0;/.test(html));
  });
  // Both shipped files must stay identical — they are the same game.
  const a1 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const a2 = fs.readFileSync(path.join(ROOT, 'index.standalone.html'), 'utf8');
  check('index.html and index.standalone.html are the same build', a1 === a2);
}

// --- P: the frame clock must be refresh-rate independent ---------------------
// A 90/120Hz phone used to run the whole fight at 1.5-2x speed because the game advanced
// one step per animation frame. The real scheduler is lifted out of the shipped file and
// driven with fake timestamps at 120Hz, 60Hz and 30Hz.
{
  console.log('\n===== frame clock =====');
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const frameDecl = (/var FRAME = \{[^}]*\};/.exec(html) || [])[0];
    const start = html.indexOf('function gameLoop(ts) {');
    const end = start < 0 ? -1 : html.indexOf('\n    }\n', start);
    check(file + ': the fixed-step scheduler is present', !!frameDecl && start >= 0 && end > start);
    if (!frameDecl || start < 0 || end < 0) return;
    const loopSrc = html.slice(start, end + 7);
    const make = new Function([
      "var gameState = 'playing', animFrameId = null, steps = 0;",
      'var pending = [], nextId = 1;',
      'function requestAnimationFrame(fn) { pending.push(fn); return nextId++; }',
      'function gameStep() { steps++; }',
      frameDecl,
      loopSrc,
      // the real build arms the first frame at startup, so do the same here
      'requestAnimationFrame(gameLoop);',
      'return {',
      '  tick: function (ts) { var f = pending; pending = []; for (var i = 0; i < f.length; i++) f[i](ts); },',
      '  steps: function () { return steps; },',
      '  raf: function () { return animFrameId; },',
      '  setState: function (s) { gameState = s; },',
      '  reset: function () { steps = 0; }',
      '};'
    ].join('\n'));
    const run = (hz, seconds) => {
      const T = make();
      const dt = 1000 / hz;
      const frames = Math.round(hz * seconds);
      for (let i = 1; i <= frames; i++) T.tick(i * dt);
      return T;
    };
    const at120 = run(120, 1);
    check(file + ': 120Hz advances ~60 steps per second (not 120)',
      Math.abs(at120.steps() - 60) <= 1, 'steps=' + at120.steps());
    const at60 = run(60, 1);
    check(file + ': 60Hz advances ~60 steps per second',
      Math.abs(at60.steps() - 60) <= 1, 'steps=' + at60.steps());
    // At 30Hz two steps land per frame; the accumulator quantises a little, so allow 3.
    const at30 = run(30, 1);
    check(file + ': 30Hz catches up to ~60 steps per second',
      Math.abs(at30.steps() - 60) <= 3, 'steps=' + at30.steps());
    check(file + ': a running game keeps its next frame armed', at60.raf() !== null);
    // A long stall (tab switch, GC) must not fast-forward dozens of frames at once.
    const stall = make();
    stall.tick(16.7); stall.tick(5000);
    check(file + ': a 5s stall advances at most the 3 catch-up steps',
      stall.steps() <= 1 + 3, 'steps=' + stall.steps());
    // Pausing stops the chain entirely; the wrapper must not keep spinning.
    const paused = make();
    paused.tick(16.7);
    paused.setState('paused');
    paused.tick(33.4);
    check(file + ': pausing stops the scheduler', paused.raf() === null);
  });
}

// --- Q: the shared rig hands out sane joints in every state ------------------
{
  console.log('\n===== rig joints =====');
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const g = html.indexOf('function stickRig(o) {');
    const h = html.indexOf('// A two-segment limb');
    if (g < 0 || h < 0) { check(file + ': rig source found', false); return; }
    const rigSrc = html.slice(g, h);
    const at = (state, speed, vy, t, crouch) => {
      const mm = { exports: {} };
      new Function('module', 'exports', 'var time=' + t + ';' + rigSrc + ';module.exports={stickRig};')(mm, mm.exports);
      const r = mm.exports.stickRig({ x: 100, y: 380, facing: 1, state, speed: speed || 0, vy: vy || 0, crouch: crouch || 0, animTime: 6 });
      return r;
    };
    let bad = 0, detail = '';
    ['idle', 'walk', 'sprint', 'jump', 'kick', 'shoot', 'dash', 'grenade'].forEach((st) => {
      for (let t = 0; t < 80; t++) {
        const r = at(st, 6.5, (t % 20) - 10, t, 0);
        const vals = [r.headY, r.shoulderY, r.hipY, r.legs[0].fx, r.legs[0].fy, r.legs[1].fx, r.legs[1].fy, r.arms[0].hx, r.arms[1].hy];
        if (vals.some((v) => !isFinite(v))) { bad++; detail = st + '@' + t + ' NaN'; }
        if (!(r.headY < r.hipY)) { bad++; detail = st + '@' + t + ' head below hip'; }
      }
    });
    check(file + ': every state produces finite, connected joints', bad === 0, detail);
    const walkA = at('walk', 5, 0, 20, 0), walkB = at('walk', 5, 0, 40, 0);
    check(file + ': the walk cycle actually moves the feet',
      Math.abs(walkA.legs[0].fx - walkB.legs[0].fx) > 4 && Math.abs(walkA.legs[1].fx - walkB.legs[1].fx) > 4,
      'A=' + walkA.legs[0].fx.toFixed(1) + ' B=' + walkB.legs[0].fx.toFixed(1));
    check(file + ': one foot lifts while the other is planted',
      Math.abs(walkA.legs[0].fy - walkA.legs[1].fy) > 3,
      'feet=' + walkA.legs[0].fy.toFixed(1) + '/' + walkA.legs[1].fy.toFixed(1));
    const up = at('jump', 5, -14, 17, 0), down = at('jump', 5, 9, 17, 0);
    check(file + ': the jump tucks on the way up and reaches on the way down',
      up.legs[0].fy < down.legs[0].fy - 8, 'up=' + up.legs[0].fy.toFixed(1) + ' down=' + down.legs[0].fy.toFixed(1));
    const idle = at('idle', 0, 0, 30, 0), squash = at('idle', 0, 0, 30, 8);
    check(file + ': a landing squash drops the hips but keeps the feet planted',
      squash.hipY > idle.hipY + 2 && Math.abs(squash.legs[0].fy - idle.legs[0].fy) < 0.01,
      'hip ' + idle.hipY.toFixed(1) + '->' + squash.hipY.toFixed(1));
    const sprint = at('sprint', 6.5, 0, 20, 0);
    check(file + ': sprinting leans the body in without moving the feet line',
      sprint.lean > 0.05 && Math.abs(sprint.legs[0].fy - idle.legs[0].fy) < 12, 'lean=' + sprint.lean);
    const kick = at('kick', 0, 0, 17, 0);
    check(file + ': the kick throws the front foot far ahead of the hips',
      kick.legs[1].fx > 120, 'foot=' + kick.legs[1].fx.toFixed(1));
  });
}

// --- Q: the Taoist — the newest playable character ---------------------------
// The character card promises 120 HP, one half-health revival, 20% softer zombie hits
// and six abilities; every one of those is pinned here so a later edit cannot quietly
// drop an input, a damage number or the amulet's five blessings / five curses.
{
  console.log('\n===== taoist =====');
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const num = (re) => Number((re.exec(html) || [])[1]);

    check(file + ': the taoist has 120 HP', num(/const TAOIST_HP = (\d+);/) === 120,
      'hp=' + num(/const TAOIST_HP = (\d+);/));
    check(file + ': he revives once at half health',
      num(/const TAOIST_REVIVE_PCT = ([\d.]+)/) === 0.5 && /function reviveTaoist\(\)/.test(html) &&
      /playerHP = Math\.max\(1, Math\.floor\(PLAYER_MAX_HP_CURRENT \* revivePct\)\)/.test(html));
    check(file + ': the revival is spent, and only a new round restores it',
      /taoistReviveUsed = true;/.test(html) && /taoistReviveUsed = false;/.test(html) &&
      /gameState === 'gameover' && selectedChar === 'taoist' && !taoistReviveUsed/.test(html));
    check(file + ': zombies hit him 20% softer',
      num(/TAOIST_ZOMBIE_DMG_MULT = ([\d.]+)/) === 0.8 &&
      /selectedChar === 'taoist' \? Math\.max\(1, Math\.round\(ZOMBIE_DMG \* TAOIST_ZOMBIE_DMG_MULT\)\)/.test(html));

    // M1 — the thrown wooden sword has to actually reach the enemies.
    check(file + ': M1 throws a wooden sword that damages what it crosses',
      num(/TAOIST_SWORD_DMG = (\d+)/) === 14 && /function performTaoistSword\(\)/.test(html) &&
      /dealDamageToDummy\(d, s\.dmg, 'taoist'\)/.test(html) &&
      /dealDamageToMiniBoss\(m, s\.dmg, 'taoist'\)/.test(html));
    // Right click — a 2% heal for the taoist and every ally inside the ring.
    check(file + ': right click is a 2% heal pulse for him and nearby allies',
      num(/TAOIST_PULSE_HEAL_PCT = ([\d.]+)/) === 0.02 && /function performTaoistPulse\(\)/.test(html) &&
      /playerHP = Math\.min\(PLAYER_MAX_HP_CURRENT, playerHP \+ heal\)/.test(html) &&
      /Math\.abs\(a\.x - stick\.x\) > TAOIST_PULSE_RADIUS/.test(html));
 
    // 1 / 2 / 3 / E / F
    check(file + ': 1 raises three zombie allies',
      num(/TAOIST_ZOMBIE_COUNT = (\d+)/) === 3 && /function performTaoistZombies\(\)/.test(html));
    check(file + ': 2 seals three enemies so they cannot move or attack',
      num(/TAOIST_SEAL_TARGETS = (\d+)/) === 3 && /function performTaoistSeal\(\)/.test(html) &&
      /\.sealTimer = TAOIST_SEAL_DUR/.test(html));
    const amulets = (/const TAOIST_AMULETS = \[([\s\S]*?)\n    \];/.exec(html) || [])[1] || '';
    const blessings = (amulets.match(/good: true/g) || []).length;
    const curses = (amulets.match(/good: false/g) || []).length;
    check(file + ': E draws from five blessings and five curses',
      blessings === 5 && curses === 5 && /function performTaoistAmulet\(\)/.test(html),
      'good=' + blessings + ' bad=' + curses);
    check(file + ': the amulet really moves damage, speed and damage taken',
      /pickupDmgMult\(\)[\s\S]{0,90}taoistDmgMult\(\)/.test(html) &&
      /skinSpeedMult\(\)[^\n]*taoistSpdMult\(\)/.test(html) &&
      /dmg \* taoistTakenMult\(\)/.test(html));
    check(file + ': F spawns the big zombie',
      /function performTaoistBigZombie\(\)/.test(html) && /big_zombie_ally/.test(html));
    check(file + ': 3 is the 250-damage amulet, every 3s for 9s',
      num(/TAOIST_ULT_DMG = (\d+)/) === 250 && num(/TAOIST_ULT_TICK = (\d+)/) === 180 &&
      num(/TAOIST_ULT_DUR = (\d+)/) === 540, 'tick=' + num(/TAOIST_ULT_TICK = (\d+)/) +
      ' dur=' + num(/TAOIST_ULT_DUR = (\d+)/));
    check(file + ': the heaven amulet hits every enemy around it',
      /phantomHitAll\(taoistUltAmulet\.x, TAOIST_ULT_RADIUS, TAOIST_ULT_DMG, 'taoist'\)/.test(html));

    // Every input has to be wired on desktop AND on the phone pads.
    // Anchored on the key-1 line so the drawing / damage blocks of the same character
    // cannot be mistaken for the input handler.
    const taoistKeys = /\} else if \(selectedChar === 'taoist'\) \{\n\s*if \(e\.key === '1'\) performTaoistZombies\(\);\n(?:[^\n]*\n){4}/.exec(html);
    check(file + ': keyboard 1/2/3/E/F all reach the taoist kit',
      !!taoistKeys && /performTaoistZombies/.test(taoistKeys[0]) && /performTaoistSeal/.test(taoistKeys[0]) &&
      /performTaoistUlt/.test(taoistKeys[0]) && /performTaoistBigZombie/.test(taoistKeys[0]) &&
      /performTaoistAmulet/.test(taoistKeys[0]));
    check(file + ': left click / right click are sword and pulse',
      /if \(e\.button === 2\) performTaoistPulse\(\); else performTaoistSword\(\);/.test(html));
    // Punch and kick are drag sticks now, so the pads are wired through mobStick().
    check(file + ': the phone pads drive the same six abilities',
      /mobStick\('mobBtnAtk', mobPunch\)[\s\S]{0,2600}performTaoistSword/.test(html) &&
      /mobStick\('mobBtnKick', mobKick\)[\s\S]{0,3200}performTaoistPulse/.test(html) &&
      /function mobAbility1\(\)[\s\S]{0,700}performTaoistZombies/.test(html) &&
      /function mobAbility2\(\)[\s\S]{0,700}performTaoistSeal/.test(html) &&
      /function mobAbility3\(\)[\s\S]{0,700}performTaoistUlt/.test(html) &&
      /function mobAbilityF\(\)[\s\S]{0,700}performTaoistBigZombie/.test(html) &&
      /function mobAbilityE\(\)[\s\S]{0,900}performTaoistAmulet/.test(html));

    // The look: yin-yang hat, amulet over the left eye, wooden sword in hand.
    check(file + ': he wears the yin-yang hat and the left-eye amulet',
      /Yin-yang hat/.test(html) && /Talisman paper over the left eye/.test(html) &&
      /Spinning yin-yang disc/.test(html));
    check(file + ': he carries a wooden sword', /Wooden sword held in the front hand/.test(html));

    // The character draw blocks all sit ABOVE the shared `armY` const inside
    // drawStickman. Reading a declaration that comes later in the same function
    // throws a temporal-dead-zone ReferenceError on EVERY frame; the loop guard
    // swallows it, so the round silently freezes with a frozen canvas. Source-text
    // checks cannot see that, so lint the function for use-before-declaration.
    const tdzProbe = 'function f() {\n  var a = armY + 18;\n  const armY = 1;\n  return a;\n}\n';
    check(file + ': the TDZ guard really detects a use before declaration',
      tdzOffenders(tdzProbe).includes('armY'), JSON.stringify(tdzOffenders(tdzProbe)));
    const offenders = tdzOffenders(html);
    check(file + ': drawStickman never reads a declaration before it exists',
      offenders.length === 0, 'reads-before-declaration: ' + offenders.join(', '));

    // Menu entry + unlock gate: Taoist Quest 1, not points.
    check(file + ': the menu shows the taoist card behind a quest gate',
      /id="charTaoist"/.test(html) && /id="taoistLock"/.test(html) &&
      /if \(!taoistQuestUnlocked\(\)\)/.test(html) &&
      !/c === 'taoist' && totalPoints >= 1200/.test(html));
    check(file + ': the taoist unlock is permanent, not a rental',
      /if \(c === 'taoist'\) return; \/\/ permanent/.test(html));

    // The quest system: live daily board + taoist line that gates the character.
    const questDefs = (/var TAOIST_QUEST_DEFS = \[([\s\S]*?)\n    \];/.exec(html) || [])[1] || '';
    check(file + ': the taoist line has exactly five quests',
      (questDefs.match(/\{ id: \d+/g) || []).length === 5, 'defs=' + (questDefs.match(/\{ id: \d+/g) || []).length);
    check(file + ': taoist quest 1 unlocks him and quest 5 ascends him',
      /UNLOCKS TAOIST/.test(questDefs) && /ASCENDS TAOIST/.test(questDefs) &&
      /taoistQuestUnlocked\(\) \{ return isCharBought\('taoist'\) \|\| taoistQuestsDone\(\) >= 1; \}/.test(html) &&
      /if \(done >= 1 && !boughtTaoist\)/.test(html) &&
      /if \(done >= quests\.length && !taoistAscended\)/.test(html));
    check(file + ': ascension buffs HP, damage and the revival',
      num(/const TAOIST_HP_ASCENDED = (\d+)/) === 160 &&
      num(/TAOIST_ASCENDED_DMG_MULT = ([\d.]+)/) === 1.25 &&
      num(/TAOIST_REVIVE_PCT_ASCENDED = ([\d.]+)/) === 0.75 &&
      /function taoistMaxHp\(\) \{ return taoistAscendedNow\(\) \? TAOIST_HP_ASCENDED : TAOIST_HP; \}/.test(html) &&
      /taoistAmuletMult\('dmg'\) \* \(taoistAscendedNow\(\) \? TAOIST_ASCENDED_DMG_MULT : 1\)/.test(html));
    check(file + ': the daily board is driven by real gameplay and pays out',
      /function tickQuestProgress\(\)/.test(html) && /tickQuestProgress\(\);/.test(html) &&
      /function advanceQuestProgress\(kind, amount\)/.test(html) &&
      /advanceQuestProgress\('kills', dk\)/.test(html) &&
      /advanceQuestProgress\('points', dp\)/.test(html) &&
      /advanceQuestProgress\('rounds', 1\)/.test(html) &&
      /totalPoints \+= paid;/.test(html));
    check(file + ': a finished daily quest counts toward taoist quest 3',
      /stats\.dailies \+= finished\.length/.test(html) &&
      /metric: 'dailies'/.test(html) &&
      /q\.progress = Math\.min\(q\.goal, stats\[q\.metric\] \|\| 0\)/.test(html));

    // Dying outside a campaign used to freeze the canvas with no game-over screen, which
    // left a phone player with no way out (there is no ESC key).
    check(file + ': a normal-mode death reveals the game-over screen',
      /if \(gameState === 'gameover'\) \{\s*var gosScreen = document\.getElementById\('gameoverScreen'\)/.test(html) &&
      /if \(gosScreen && gosScreen\.classList\.contains\('hidden'\)\)/.test(html));
    check(file + ': RETRY restarts a non-campaign round instead of sitting on a dead screen',
      /if \(campaignMode\) \{ launchCampaignLevel\(campaignLevel\); return; \}[\s\S]{0,220}fullReset\(\); gameState = 'playing'; resumeGameLoop\(\);/.test(html));
  });
}

// --- W: HALLOWEEN mode, the candy economy, The Hollow and the drag sticks ------.
{
  console.log('\n===== halloween mode =====');
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const num = (re) => Number((re.exec(html) || [])[1]);

    check(file + ': the menu offers a HALLOWEEN mode and it really switches mode',
      /id="modeHalloween"/.test(html) &&
      /getElementById\('modeHalloween'\)\.addEventListener\('click', \(\) => selectMode\('halloween'\)\)/.test(html) &&
      /getElementById\('modeHalloween'\)\.className = m === 'halloween'/.test(html) &&
      /gameMode === 'halloween' \? ' 🎃HALL'/.test(html));

    check(file + ': a mini pumpkin every 3s and a big one every 9s',
      num(/HALLOWEEN_MINI_INTERVAL = (\d+)/) === 180 &&
      num(/HALLOWEEN_BIG_INTERVAL = (\d+)/) === 540 &&
      /function updateHalloweenSpawns\(\)/.test(html) &&
      /halloweenMiniTimer >= HALLOWEEN_MINI_INTERVAL\) \{ halloweenMiniTimer = 0; spawnHalloweenPumpkin\(false\); \}/.test(html) &&
      /halloweenBigTimer >= HALLOWEEN_BIG_INTERVAL\) \{ halloweenBigTimer = 0; spawnHalloweenPumpkin\(true\); \}/.test(html) &&
      /if \(halloweenOn\(\) && !campaignMode && !phantomMissionActive\) updateHalloweenSpawns\(\);/.test(html),
      'mini=' + num(/HALLOWEEN_MINI_INTERVAL = (\d+)/) + ' big=' + num(/HALLOWEEN_BIG_INTERVAL = (\d+)/));

    check(file + ': every pumpkin drops a candy every 2s, 15% of them a bag of 10',
      num(/HALLOWEEN_CANDY_CD = (\d+)/) === 120 &&
      num(/HALLOWEEN_BAG_CHANCE = ([\d.]+)/) === 0.15 &&
      num(/HALLOWEEN_BAG_SIZE = (\d+)/) === 10 &&
      /var bag = Math\.random\(\) < HALLOWEEN_BAG_CHANCE;/.test(html) &&
      /createPickup\(d\.x, GROUND_Y, bag \? 'candybag' : 'candy1'\)/.test(html) &&
      /type === 'candy1'[\s\S]{0,120}addCandy\(1\)/.test(html) &&
      /type === 'candybag'[\s\S]{0,120}addCandy\(HALLOWEEN_BAG_SIZE\)/.test(html),
      'cd=' + num(/HALLOWEEN_CANDY_CD = (\d+)/) + ' bag%=' + num(/HALLOWEEN_BAG_CHANCE = ([\d.]+)/));

    check(file + ': the pumpkins are drawn and they hit for their own damage',
      /if \(d\.isPumpkin\) \{/.test(html) && /isPumpkin: true, pumpkinBig: !!big/.test(html) &&
      /damagePlayer\(d\.pumpkinDmg \|\| MINI_PUMPKIN_DMG, '#fb923c'\)/.test(html) &&
      num(/MINI_PUMPKIN_HP = (\d+)/) === 70 && num(/BIG_PUMPKIN_HP = (\d+)/) === 320);

    // A pumpkin farm, not a gauntlet: normal waves, titan and boss all stand down.
    check(file + ': halloween mode freezes the normal spawn clocks and the boss',
      /allySpawnTimer\+\+; if \(!halloweenOn\(\)\) \{ spawnTimer\+\+;/.test(html) &&
      /function checkBossSpawn\(\) \{[\s\S]{0,240}if \(halloweenOn\(\)\) return;/.test(html) &&
      /if \(halloweenOn\(\)\) \{ dummies = \[\]; spawnHalloweenPumpkin\(false\);/.test(html));

    // The mode has to be able to pay candy even outside October.
    check(file + ': halloween mode earns candy all year round',
      /function halloweenCandyOn\(\) \{ return isHalloweenEvent\(\) \|\| halloweenOn\(\); \}/.test(html) &&
      /if \(n <= 0 \|\| !halloweenCandyOn\(\)\) return;/.test(html) &&
      /gameMode !== 'sandbox' && gameMode !== 'halloween'\) addCandy/.test(html));

    // ---- candy economy ------------------------------------------------------
    check(file + ': a boss point costs 20 candy and everything else is 50% off',
      /const CANDY_PRICES = \{ bossPoint: 20, points: 25, maxHp: 25, damage: 38, speed: 30 \};/.test(html) &&
      /halloweenBuy\(CANDY_PRICES\.bossPoint/.test(html) &&
      /halloweenBuy\(CANDY_PRICES\.points/.test(html) &&
      /halloweenBuy\(CANDY_PRICES\.maxHp/.test(html) &&
      /halloweenBuy\(CANDY_PRICES\.damage/.test(html) &&
      /halloweenBuy\(CANDY_PRICES\.speed/.test(html) &&
      num(/SKIN_COST_MULT = (\d+)/) === 2,
      'skinMult=' + num(/SKIN_COST_MULT = (\d+)/));
    check(file + ': the shop labels are written from the same price table',
      /function applyCandyPriceLabels\(\)/.test(html) &&
      (html.match(/data-candy-price="/g) || []).length === 5 &&
      /<button id="candyBuyBoss"[\s\S]{0,200}data-candy-price="bossPoint"/.test(html) &&
      /applyCandyPriceLabels\(\);/.test(html) &&
      /CANDY_PRICES\[k\] \+ '🍬'/.test(html));

    // ---- The Hollow ---------------------------------------------------------
    check(file + ': the Hollow skin is in the skin grid',
      /id: 'fighter_hollow', char: 'fighter', name: 'The Hollow'/.test(html));
    check(file + ': the Hollow costs a flat 150 candy',
      /id: 'fighter_hollow'[\s\S]{0,160}price: 150/.test(html) &&
      /var skCost = sk\.price \|\| sk\.cost \* SKIN_COST_MULT;/.test(html));
    check(file + ': the Hollow is +200% damage AND +200% speed',
      /function hollowOn\(\) \{ return selectedSkin === 'fighter_hollow'; \}/.test(html) &&
      /if \(hollowOn\(\)\) return 3;/.test(html) &&
      /\* \(hollowOn\(\) \? 3 : 1\)/.test(html));
    check(file + ': S drops a draggable mini sky laser for 4 dmg every 0.75s',
      num(/HOLLOW_LASER_DMG = (\d+)/) === 4 &&
      num(/HOLLOW_LASER_TICK = (\d+)/) === 45 &&
      /function toggleHollowLaser\(\)/.test(html) &&
      // A SKIN ability, so S is bound outside the per-character branches.
      /keys\.add\(e\.key\);\s*\/\/ The Hollow's sky laser is a SKIN ability[\s\S]{0,160}if \(selectedSkin === 'fighter_hollow' && e\.key\.toLowerCase\(\) === 's'\) toggleHollowLaser\(\);/.test(html) &&
      /hollowLaser\.x = Math\.max\(30, Math\.min\(CW - 30, mouseX\)\);/.test(html) &&
      /dealDamageToDummy\(d, HOLLOW_LASER_DMG, 'laser'\)/.test(html) &&
      /hollowLaser\.cd < HOLLOW_LASER_TICK/.test(html),
      'dmg=' + num(/HOLLOW_LASER_DMG = (\d+)/) + ' tick=' + num(/HOLLOW_LASER_TICK = (\d+)/));
    check(file + ': the beam is drawn and can be dragged by a finger too',
      /function drawHollowLaser\(\)/.test(html) &&
      /drawHollowLaser\(\); drawStickman\(\);/.test(html) &&
      /addEventListener\('touchmove'[\s\S]{0,400}mouseX = \(t\.clientX - rect\.left\)/.test(html));
    check(file + ': the phone gets its own S button for the Hollow ability',
      /<button id="mobBtnS" class="mob-btn mob-ability" style="display:none;">S<\/button>/.test(html) &&
      /function refreshMobSButton\(\)/.test(html) &&
      /var want = hollowOn\(\) \? 'inline-flex' : 'none';/.test(html) &&
      /refreshMobSButton\(\);/.test(html) &&
      /mobTap\('mobBtnS', function\(\) \{ if \(gameState === 'playing' && hollowOn\(\)\) toggleHollowLaser\(\); \}\);/.test(html));

    // ---- skins are universal -----------------------------------------------
    check(file + ': every skin works on every character',
      /if \(selectedSkin === 'fighter_werewolf'\)/.test(html) &&
      /if \(selectedSkin === 'mage_witch'\) return 1\.2;/.test(html) &&
      /if \(selectedSkin === 'hyper_spirit'\) return 2;/.test(html) &&
      /if \(selectedSkin === 'phantom_reaper'\) return 1\.5;/.test(html) &&
      /selectedSkin === 'phantom_reaper' \? 1\.5 : 1/.test(html) &&
      /selectedSkin === 'fighter_zombie' \? 0\.88 : 1/.test(html) &&
      /function vampireHeal\(dmg\) \{ if \(selectedSkin === 'ninja_vampire'\)/.test(html) &&
      /if \(selectedSkin === 'fighter_ghost' && ghostDodgeCharges > 0\)/.test(html) &&
      /if \(selectedSkin === 'fighter_ghost'\) \{ ghostDodgeTimer\+\+;/.test(html) &&
      /if \(selectedChar === 'fighter' && selectedSkin ===/.test(html) === false,
      'a leftover char+skin gate is still in the page');
    check(file + ': the skin HP bonus applies to every character',
      /function skinHpMult\(\) \{ return selectedSkin === 'fighter_zombie' \? 1\.25 : selectedSkin === 'soldier_skeleton' \? 1\.2 : 1; \}/.test(html) &&
      /\: 100\) \* skinHpMult\(\)\);/.test(html) &&
      /PLAYER_MAX_HP_CURRENT = Math\.floor\(PLAYER_MAX_HP_CURRENT \* skinHpMult\(\)\)/.test(html) &&
      /skinMaxHpMult|fighterSkinHpMult/.test(html) === false);
    check(file + ': the skin screen says the skins are universal',
      /Every skin works on every character\./.test(html) &&
      /every character<\/div>/.test(html));

    // ---- mobile drag sticks -------------------------------------------------
    check(file + ': punch and kick are drag sticks on the phone',
      /id="mobBtnAtk" class="mob-stick"/.test(html) &&
      /id="mobBtnKick" class="mob-stick"/.test(html) &&
      /mobStick\('mobBtnAtk', mobPunch\)/.test(html) &&
      /mobStick\('mobBtnKick', mobKick\)/.test(html) &&
      /function mobStick\(id, fire\)/.test(html));
    // The stick is an AIM, not just a side: the drag moves the aim point that every
    // aim-based attack already fires at, and the aiming arm follows that point.
    check(file + ': the stick drags the arm and the shot follows it',
      /let mobAim = \{ x: 1, y: 0 \}, mobAimTimer = 0/.test(html) &&
      /function setMobAim\(dx, dy\)/.test(html) &&
      /mouseX = Math\.max\(20, Math\.min\(CW - 20, stick\.x \+ mobAim\.x \* MOB_AIM_REACH\)\)/.test(html) &&
      /mouseY = Math\.max\(10, Math\.min\(CH - 10, \(stick\.y - 40\) \+ mobAim\.y \* MOB_AIM_REACH\)\)/.test(html) &&
      /setMobAim\(dx, dy\);/.test(html) &&
      /updateMobAim\(\);/.test(html) &&
      /if \(mobAimHeld > 0\) \{ mobAimTimer = MOB_AIM_HOLD; applyMobAim\(\); return; \}/.test(html) &&
      /mobAimHeld = Math\.max\(0, mobAimHeld - 1\);/.test(html) &&
      /if \(state === 'shoot' \|\| state === 'dash' \|\| mobAimTimer > 0\)/.test(html) &&
      /ctx\.lineTo\(x \+ mobAim\.x \* 72, armY \+ mobAim\.y \* 72\)/.test(html));
    check(file + ': the stick drags a knob and aims your facing',
      /var knob = el\.querySelector\('\.mob-knob'\)/.test(html) &&
      /knob\.style\.transform = 'translate\('/.test(html) &&
      /if \(Math\.abs\(dx\) > MOB_STICK_DEADZONE\) stick\.facing = dx > 0 \? 1 : -1;/.test(html) &&
      /el\.addEventListener\('pointermove'/.test(html) &&
      /el\.setPointerCapture\(e\.pointerId\)/.test(html));
    // Pressing fires at once, dragging aims, and holding keeps firing — so the stick
    // both shoots on press and keeps shooting while it is dragged around.
    check(file + ': pause and shop moved to the left thumb side',
      /style="left:max\(10px, env\(safe-area-inset-left\)\); top:52px;">\s*<button id="mobBtnPause"/.test(html) &&
      /<!-- Pause \+ shop sit on the LEFT[\s\S]{0,300}id="mobBtnPause"/.test(html) &&
      /style="right:max\(10px, env\(safe-area-inset-right\)\); top:52px;"/.test(html) === false);
    check(file + ': the menu scrolls on a phone instead of clipping its buttons',
      /#menuScreen \{ overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; \}/.test(html) &&
      /@media \(max-width: 760px\) \{\s*#menuScreen \{ justify-content: flex-start; padding: 10px 0 26px; \}/.test(html));
    check(file + ': pressing and dragging fires, and holding keeps firing',
      num(/MOB_STICK_REPEAT_MS = (\d+)/) === 110 &&
      /\/\/ DRAGGING IS ATTACKING[\s\S]{0,400}fire\(\);/.test(html) &&
      /repeatId = setInterval\(repeatFire, MOB_STICK_REPEAT_MS\);/.test(html) &&
      /function stopRepeat\(\) \{ if \(repeatId\) \{ clearInterval\(repeatId\); repeatId = null; \} \}/.test(html) &&
      /function release\(e\)[\s\S]{0,260}stopRepeat\(\)/.test(html),
      'repeat=' + num(/MOB_STICK_REPEAT_MS = (\d+)/));
  });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
