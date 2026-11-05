'use strict';
// Content checks: every rule below is asserted against the shipped HTML itself, so the
// two published files can never drift from what was verified.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// A Windows checkout hands back CRLF, so every regex below that spans two lines
// (`});\n`) would silently miss. Normalise once, at the read, so the same suite
// verifies the same text on every machine.
const fsRawRead = fs.readFileSync;
fs.readFileSync = function () {
  const out = fsRawRead.apply(fs, arguments);
  return typeof out === 'string' ? out.replace(/\r\n/g, '\n') : out;
};

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
    // Counting the steps is not enough: a catch-up burst used to paint every one of them,
    // so a phone that fell behind did 3x the drawing per frame and stayed behind.
    check(file + ': the game runs on a fixed 60Hz step instead of one step per frame',
      /var FRAME = \{ last: 0, acc: 0, step: 1000 \/ 60, maxSteps: 3 \};/.test(html) &&
      /function gameStep\(skipDraw\) \{/.test(html) &&
      /while \(FRAME\.acc >= FRAME\.step && steps < FRAME\.maxSteps\)/.test(html) &&
      /var lastStep = !\(FRAME\.acc >= FRAME\.step && steps < FRAME\.maxSteps\);/.test(html) &&
      /gameStep\(!lastStep\);/.test(html) &&
      !/function gameStep\([^)]*\)[\s\S]{0,200}?requestAnimationFrame\(gameLoop\)[\s\S]{0,40}?loopFrameArmed = true/.test(html));
    check(file + ': catch-up steps skip the drawing entirely',
      /\/\/ === DRAW ===\n      if \(!skipDraw\) \{/.test(html));
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

// --- O: animation rig, sprint, skins, cross-device saves ----------------------
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
    // The crowd is the frame's biggest cost, so every enemy draws its whole skeleton in
    // one path with a single stroke() instead of five, and off-screen enemies draw nothing.
    check(file + ': ground enemies walk on the same rig, batched into one path',
      /var erg = stickRig\(\{[\s\S]{0,200}?legLen: 13/.test(html) &&
      /ctx\.moveTo\(dx, wHip\); ctx\.lineTo\(elg\.kx, elg\.ky\); ctx\.lineTo\(elg\.fx, elg\.fy\);/.test(html) &&
      /ctx\.moveTo\(dx, wSh \+ 10\); ctx\.lineTo\(ear\.ex, ear\.ey\); ctx\.lineTo\(ear\.hx, ear\.hy \+ 2\);/.test(html) &&
      /if \(dx < -70 \|\| dx > CW \+ 70\) return;/.test(html) &&
      !/strokeLimb\(dx, wHip, elg\.kx, elg\.ky, elg\.fx, elg\.fy\)/.test(html));
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

    // Werewolf skin
    check(file + ': the werewolf skin is in the Halloween skin list',
      /id: 'fighter_werewolf', char: 'fighter', name: 'Werewolf'/.test(html));
    check(file + ': the werewolf skin is drawn (ears, snout, claws, tail)',
      /selectedSkin === 'fighter_werewolf'/.test(html) &&
      /\/\/ Snout/.test(html) && /\/\/ Claws on both hands/.test(html) && /\/\/ Ears/.test(html));
    check(file + ': the werewolf perk is wired to real damage',
      /selectedSkin === 'fighter_werewolf'\) \{\s*\n\s*return \(typeof playerHP === 'number'/.test(html));

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
  console.log('\n===== death mode =====');
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    check(file + ': death mode is a selectable mode with its own button',
      /<button id="modeDeath"[^>]*>☠️ DEATH<\/button>/.test(html) &&
      /document\.getElementById\('modeDeath'\)\.addEventListener\('click', \(\) => selectMode\('death'\)\)/.test(html) &&
      /document\.getElementById\('modeDeath'\)\.className = m === 'death'/.test(html));
    // 100 waves of the existing 10-second clock: 600 fixed steps each.
    check(file + ': death mode is 100 waves of 10 seconds',
      /const DEATH_TOTAL_WAVES = 100;/.test(html) && /const WAVE_FRAMES = 600;/.test(html) &&
      /if \(wave > DEATH_TOTAL_WAVES && !deathRunWon\) \{/.test(html));
    // The curve has to rise and still stop: HP 6x, damage 2.5x, i.e. beatable.
    check(file + ': enemies ramp in HP and damage but the curve is capped',
      /const DEATH_HP_STEP = 0\.05, DEATH_HP_CAP = 6;/.test(html) &&
      /const DEATH_DMG_STEP = 0\.015, DEATH_DMG_CAP = 2\.5;/.test(html) &&
      /if \(deathHpMult\(\) > 1\) baseHp = Math\.round\(baseHp \* deathHpMult\(\)\);/.test(html) &&
      /if \(deathDmgMult\(\) > 1 && !noDeathScale\) dmg = Math\.max\(1, Math\.round\(dmg \* deathDmgMult\(\)\)\);/.test(html));
    check(file + ': a boss lands on every tenth wave',
      /if \(wave % 10 === 0\) spawnDeathBoss\(wave\);/.test(html) &&
      /function spawnDeathBoss\(w\) \{/.test(html) &&
      // Bosses scale on a gentler curve than the trash, so the wave-100 trio stays a fight.
      /function deathBossHpMult\(\) \{ return deathOn\(\) \? Math\.min\(2\.5, 1 \+ 0\.02 \* \(deathWave\(\) - 1\)\) : 1; \}/.test(html) &&
      /var mult = deathBossHpMult\(\);/.test(html) &&
      /if \(deathOn\(\)\) return; \/\/ death mode fields its own bosses every 10th wave/.test(html));
    check(file + ': the field gets denser and faster every wave',
      /deathOn\(\) \? Math\.min\(9, 3 \+ Math\.floor\(wave \/ 12\)\) : SPAWN_COUNT/.test(html) &&
      /var spawnGap = deathOn\(\) \? Math\.max\(180, Math\.round\(SPAWN_INTERVAL \/ \(1 \+ 0\.04 \* wave\)\)\) : SPAWN_INTERVAL;/.test(html) &&
      /wave >= 20 && r < 0\.16/.test(html) && /wave >= 3 && r < 0\.70/.test(html));
    // Every enemy from every mode: heavies cycle, the horde arrives, and the tank/speed
    // pair keeps its normal-mode stats instead of riding the death ramp.
    check(file + ': every enemy from every mode shows up in death mode',
      /var DEATH_HEAVY_ROSTER = \['necro', 'sniper', 'medic', 'big_gunner', 'giant_gunner', 'titan_gunner', 'titan', 'boss'\];/.test(html) &&
      /var type = DEATH_HEAVY_ROSTER\[deathHeavyIdx % DEATH_HEAVY_ROSTER\.length\];/.test(html) &&
      /function spawnDeathZombies\(\)/.test(html) &&
      /function updateDeathSpawns\(\)/.test(html) &&
      /if \(deathOn\(\) && !campaignMode && !phantomMissionActive\) updateDeathSpawns\(\);/.test(html) &&
      /deathRunWon = false; deathHeavyTimer = 0; deathHeavyIdx = 0; deathZombieTimer = 0;/.test(html));
    check(file + ': the tank and speed pair is never made harder in death mode',
      /deathOn\(\) && \(mb\.type === 'tank' \|\| mb\.type === 'speed'\)\);/.test(html) &&
      /if \(deathDmgMult\(\) > 1 && !noDeathScale\)/.test(html) &&
      // their HP comes straight from the shared constants, with no death multiplier applied
      /hp: gameMode === 'easy' \? EASY_TANK_HP : TANK_HP, maxHp: gameMode === 'easy' \? EASY_TANK_HP : TANK_HP, speed: TANK_SPD/.test(html) &&
      /hp: gameMode === 'easy' \? EASY_SPEED_HP : SPEED_HP, maxHp: gameMode === 'easy' \? EASY_SPEED_HP : SPEED_HP, speed: SPEED_SPD/.test(html));
    check(file + ': clearing wave 100 is a win with a payout, then endless',
      /totalPoints \+= 5000; bossPoints \+= 25; savePoints\(\);/.test(html) &&
      /localStorage\.setItem\('sm_deathCleared', 'true'\)/.test(html) &&
      /'endless continues — good luck'/.test(html));
    check(file + ': the best wave is kept and shown in the menu',
      /let deathBest = loadNum\('sm_deathBest'\);/.test(html) &&
      /localStorage\.setItem\('sm_deathBest', deathBest\)/.test(html) &&
      /id="deathBestLine"/.test(html) &&
      /updateDeathBestLine\(\);\n    \/\/ ==================== SKIN UI/.test(html));
    check(file + ': the death HUD shows the wave clock, and the death screen shows the wave',
      /'☠️ WAVE ' \+ wave \+ \(wave <= DEATH_TOTAL_WAVES/.test(html) &&
      /'☠️ Wave ' \+ wave \+ ' \/ ' \+ DEATH_TOTAL_WAVES/.test(html));
  });

  console.log('\n===== boot safety =====');
  // Regression: a removed feature left `bar: bossrushBar` pointing at a function that no
  // longer existed. The ReferenceError killed the whole boot IIFE, so the menu showed 0
  // points and PLAY did nothing. Every soundtrack bar named in the theme table must exist.
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const table = (/var THEME_TRACKS = \{[\s\S]*?\n    \};/.exec(html) || [])[0] || '';
    const bars = [...table.matchAll(/bar: ([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    const missing = bars.filter((b) => !new RegExp('function ' + b + '\\(ac, dest, t0, bar, step\\)').test(html));
    check(file + ': every soundtrack bar in the theme table is a real function',
      bars.length >= 12 && missing.length === 0, 'bars=' + bars.length + ' missing=' + missing.join(','));
    // And the energy balance is painted on load, not only after the first kill.
    check(file + ': the energy balance is painted on load',
      /updateMenuPoints\(\); updateCharLockUI\(\); updateCandyUI\(\);/.test(html));
    // The ninja's dash button must call a function that exists.
    check(file + ': the ninja dash button calls a real function',
      /selectedChar === 'ninja' \? performNinjaFarDash\(\)/.test(html));
    // Regression: a stray mini-boss line landed inside dealDamageToDummy and threw
    // `mb is not defined` on every punch, so nothing could ever be killed.
    const dummyFn = (/function dealDamageToDummy\(d, dmg, source\) \{[\s\S]*?\n    \}/.exec(html) || [])[0] || '';
    check(file + ': dealing damage to a dummy never touches a mini-boss',
      dummyFn.length > 300 && !/\bmb\s*\./.test(dummyFn), 'bodyLen=' + dummyFn.length);
    // Regression: the Halloween strip removed the line that actually applied the damage,
    // so mini-bosses printed a -dmg number and never lost HP. Fighters showed the number
    // and nothing died — the tank, necro, snipers, titan and every DEATH heavy were immortal.
    const mbFn = (/function dealDamageToMiniBoss\(mb, dmg, source\) \{[\s\S]*?\n    \}/.exec(html) || [])[0] || '';
    check(file + ': damaging a mini-boss actually subtracts its HP',
      mbFn.length > 300 &&
      /mb\.hp -= dmg; mb\.hitFlash = 6; vampireHeal\(dmg\);/.test(mbFn) &&
      mbFn.indexOf('mb.hp -= dmg') < mbFn.indexOf('if (mb.hp <= 0)'),
      'bodyLen=' + mbFn.length);
    // Energy rate: 0.25 an enemy, 0.5 a boss. The kill counter already pays one enemy's
    // share, so the boss payout is the top-up.
    check(file + ': energy pays 0.25 an enemy and 0.5 a boss',
      /var ENERGY_PER_KILL = 0\.25, ENERGY_PER_BOSS = 0\.5;/.test(html) &&
      /function addEnergyForBoss\(\) \{ addCandy\(ENERGY_PER_BOSS - ENERGY_PER_KILL\); \}/.test(html));
  });

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

// --- W: skins, energy points, The Hollow and the drag sticks ------------------
{
  console.log('\n===== skins / energy / hollow / sticks =====');
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const num = (re) => Number((re.exec(html) || [])[1]);

    check(file + ': the Hollow skin is in the skin grid',
      /id: 'fighter_hollow', char: 'fighter', name: 'The Hollow'/.test(html));
    check(file + ': the Hollow costs a flat 150 energy',
      /id: 'fighter_hollow'[\s\S]{0,160}price: 150/.test(html) &&
      /var skCost = sk\.price \|\| sk\.cost \* SKIN_COST_MULT;/.test(html));
    check(file + ': the Hollow is x1.3 damage with x3 speed (the x3 damage is gone)',
      /function hollowOn\(\) \{ return selectedSkin === 'fighter_hollow'; \}/.test(html) &&
      /if \(hollowOn\(\)\) return 1\.3;/.test(html) &&
      /\* \(hollowOn\(\) \? 3 : 1\)/.test(html) &&
      /if \(hollowOn\(\)\) return 3;/.test(html) === false);

    // ---- energy points + waves -------------------------------------------
    check(file + ': energy is earned by playing, not by the calendar',
      /var ENERGY_PER_KILL = 0\.25, ENERGY_PER_BOSS = 0\.5;/.test(html) &&
      /function addEnergyForKill\(n\) \{ addCandy\(\(n \|\| 1\) \* ENERGY_PER_KILL\); \}/.test(html) &&
      /function addEnergyForBoss\(\) \{ addCandy\(ENERGY_PER_BOSS - ENERGY_PER_KILL\); \}/.test(html) &&
      /if \(gameMode !== 'sandbox'\) addEnergyForBoss\(\);/.test(html) &&
      /if \(gameMode !== 'sandbox'\) addEnergyForKill\(gained\);/.test(html));
    check(file + ': energy is saved under its own key and old candy carries over',
      /let candy = loadNum\('sm_energy'\);/.test(html) &&
      /var _legacyCandy = loadNum\('sm_candy'\)/.test(html) &&
      /localStorage\.setItem\('sm_energy', candy\)/.test(html));
    check(file + ': every skin is priced in energy',
      /skCost \+ ' ⚡'/.test(html) &&
      /id="skinEnergy"/.test(html) &&
      /energy — click to buy \/ equip/.test(html) &&
      /else if \(candy >= skCost\) \{/.test(html));
    check(file + ': a wave is 10 seconds and the HUD counts them',
      /const WAVE_FRAMES = 600;/.test(html) &&
      /let wave = 1, waveTimer = 0;/.test(html) &&
      /if \(waveTimer >= WAVE_FRAMES\) \{\s*\n\s*waveTimer = 0; wave\+\+; updateWaveUI\(\);/.test(html) &&
      /id="waveCount"/.test(html) &&
      /wave = 1; waveTimer = 0; updateWaveUI\(\);/.test(html));
    check(file + ': no halloween content is left in the game',
      /id="modeHalloween"/.test(html) === false &&
      /id="halloweenShopBtn"/.test(html) === false &&
      /id="pumpkinBossBtn"/.test(html) === false &&
      /id="bgSetHalloween"/.test(html) === false &&
      /PUMPKIN_PHASE_HP/.test(html) === false &&
      /function halloweenOn\(\)/.test(html) === false &&
      /SOUL STORM/.test(html) === false &&
      /sm_candy', candy/.test(html) === false);
    check(file + ': the skins themselves survive the purge',
      /const SKINS = \[/.test(html) &&
      /id: 'fighter_ghost'/.test(html) &&
      /id: 'fighter_werewolf'/.test(html) &&
      /id: 'fighter_hollow'/.test(html) &&
      /id="skinGrid"/.test(html) &&
      /function renderSkins\(\)/.test(html));
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
    // Soldier campaign story: the Gun Friend is killed by the Ancient Colossal in
    // level 10, so levels 10-15 deploy no ally; level 15 is a week without food or
    // water and the ending is the soldier dying once the Amethyst is down.
    check(file + ': level 10 kills the Gun Friend, and gone is his ally from there on',
      /var SOLDIER_FRIEND_DEATH_CUTSCENE = \[/.test(html) &&
      /name: 'Level 10: The Giant Gunner',\s*cutscene: SOLDIER_FRIEND_DEATH_CUTSCENE,/.test(html) &&
      /SOLDIER_FRIEND_DEATH_CUTSCENE = \[[\s\S]{0,1600}speaker: 'Ancient Colossal'/.test(html) &&
      /SOLDIER_FRIEND_DEATH_CUTSCENE = \[[\s\S]{0,1600}stone fist comes down on your Gun Friend/.test(html) &&
      (html.match(/gunFriend: true/g) || []).length === 4 &&
      (html.match(/gunFriend: false/g) || []).length === 6,
      'true=' + (html.match(/gunFriend: true/g) || []).length + ' false=' + (html.match(/gunFriend: false/g) || []).length);
    check(file + ': level 15 is a week of no food and no drink',
      /name: 'Level 15: The Amethyst',\s*cutscene: SOLDIER_FINAL_INTRO_CUTSCENE,/.test(html) &&
      /A week has passed since the Ancient Colossal took your Gun Friend/.test(html) &&
      /A week of fighting\. No food\. No drink\./.test(html));
    check(file + ': the soldier says Finally and does not get up',
      /\{ speaker: 'Soldier', color: '#4ade80', text: 'Finally\.', portrait: 'soldier' \}/.test(html) &&
      /lies down on the field, and he does not get up again/.test(html) &&
      /speaker: 'Narrator', color: '#22d3ee', text: 'A little further on, his Gun Friend is waiting for him\.'/.test(html));
    check(file + ': both new scenes are painted, not just spoken',
      /\} else if \(cutsceneData === SOLDIER_FRIEND_DEATH_CUTSCENE\) \{/.test(html) &&
      /Ancient Colossal — a mountain of old stone and moss/.test(html) &&
      /var solX = cw \* 0\.34, lie = sidx >= 3;/.test(html) &&
      /His friend's grave: a rifle in the dirt/.test(html));
    // The Hollow's beam is no longer a free toggle: 7s of laser, then 7s of cooldown,
    // and cutting it short costs the same cooldown as letting it run out.
    check(file + ': the sky laser burns for 7s then cools down for 7s',
      num(/HOLLOW_LASER_BURN = (\d+)/) === 420 &&
      num(/HOLLOW_LASER_COOLDOWN = (\d+)/) === 420 &&
      /hollowLaser\.burn = HOLLOW_LASER_BURN;/.test(html) &&
      /hollowLaser\.burn--;[\s\S]{0,120}endHollowLaser\('🔆 SKY LASER SPENT'\)/.test(html) &&
      /hollowLaser\.cool = HOLLOW_LASER_COOLDOWN;/.test(html) &&
      /if \(hollowLaser\.cool > 0\) \{[\s\S]{0,140}return;/.test(html) &&
      /Math\.ceil\(hollowLaser\.cool \/ 60\)/.test(html) &&
      /SKY LASER READY/.test(html),
      'burn=' + num(/HOLLOW_LASER_BURN = (\d+)/) + ' cool=' + num(/HOLLOW_LASER_COOLDOWN = (\d+)/));

    // ---- 150 achievements + the saved record -------------------------------
    // Counted off the source so the total can never drift from the copy that says 150.
    var achTiers = (html.match(/goals: \[([^\]]+)\]/g) || []).map(function (g) {
      return g.replace(/[^,]/g, '').length + 1; // commas + 1 = number of tiers
    });
    var achSum = achTiers.reduce(function (a, b) { return a + b; }, 0);
    check(file + ': there are exactly 150 achievements',
      achSum === 150 &&
      achTiers.length === 16 &&
      /var ACH_TOTAL = ACHIEVEMENTS\.length;/.test(html) &&
      /var ACH_TRACKS = \[/.test(html) &&
      /ACHIEVEMENTS\.push\(\{/.test(html),
      'tiers=' + achTiers.length + ' total=' + achSum);
    // ---- the 50 wave badges (40 any-mode + 10 death) ------------------------
    check(file + ': 50 wave achievements, 10 of them death mode',
      /\{ key: 'waves', icon: '🌊', what: 'Reach', unit: 'waves',/.test(html) &&
      /\{ key: 'deathWaves', icon: '☠️', what: 'Survive', unit: 'death waves',/.test(html) &&
      (function () {
        // 40 any-mode wave tiers + 10 death tiers = the 50 the request asked for.
        var tr = /\{ key: 'waves'[\s\S]{0,900}?goals: \[([^\]]+)\]/.exec(html);
        var dt = /\{ key: 'deathWaves'[\s\S]{0,600}?goals: \[([^\]]+)\]/.exec(html);
        var wn = tr ? tr[1].split(',').length : 0;
        var dn = dt ? dt[1].split(',').length : 0;
        return wn === 40 && dn === 10;
      })() &&
      // and the wave-50 death badge is the big one on the board
      /big: t\.key === 'deathWaves' && g === 50,/.test(html) &&
      /var big = !!a\.big;/.test(html) &&
      /text-2xl/.test(html) &&
      /The wave-50 DEATH badge is the biggest on the board, so it gets a big tile\./.test(html));
    check(file + ': the wave ladder counts in every mode, not just death',
      /function lifeMax\(key, n\) \{/.test(html) &&
      /lifeMax\('bestWave', wave\);/.test(html) &&
      /waves: lifeGet\('bestWave'\),/.test(html) &&
      /deathWaves: deathBest/.test(html));
    check(file + ': achievements are recorded, not just shown',
      /var ACH_KEY = 'sm_ach_unlocked';/.test(html) &&
      /achRecord\[a\.id\] = Date\.now\(\);/.test(html) &&
      /localStorage\.setItem\(ACH_KEY, JSON\.stringify\(achRecord\)\)/.test(html) &&
      /when\.toLocaleDateString\(\)/.test(html) &&
      /if \(time % 30 === 0\) checkAchievements\(true\);/.test(html) &&
      /lifeBump\('bosses'\)/.test(html));
    check(file + ': the record screen filters all / unlocked / locked',
      /id="achList"/.test(html) &&
      /data-achfilter="all"/.test(html) &&
      /data-achfilter="unlocked"/.test(html) &&
      /data-achfilter="locked"/.test(html) &&
      /function setAchFilter\(f\)/.test(html) &&
      /function renderAchievements\(\)/.test(html) &&
      /btn\.addEventListener\('click', function \(\) \{ setAchFilter\(btn\.getAttribute\('data-achfilter'\)\); \}\)/.test(html));

    // ---- Adapt trait -------------------------------------------------------
    check(file + ': Adapt is a mythic trait worth x7.5 damage',
      /\{ id: 'adapt',\s+name: 'Adapt',\s+emoji: '🧬',\s+rarity: 'mythic',\s+weight: 0\.25,\s+mult: 7\.5,/.test(html) &&
      /id: 'adapt',[\s\S]{0,140}rarity: 'mythic'/.test(html) &&
      /mythic:    \{ label: 'Mythic',/.test(html));

    // ---- Multiverse map + its song -----------------------------------------
    check(file + ': the multiverse map exists and is painted',
      /if \(activeBg === 'multiverse'\) \{/.test(html) &&
      /Perspective grid floor/.test(html) &&
      /Ringed planet/.test(html) &&
      /id="bgSetMultiverse"/.test(html) &&
      /bgMultiBtn\.addEventListener\('click', function\(\) \{ selectBg\('multiverse'\); \}\)/.test(html) &&
      /cheese: 'bgSetCheese', multiverse: 'bgSetMultiverse'/.test(html));
    check(file + ': the multiverse map brings a banger of its own',
      /function multiverseBar\(ac, dest, t0, bar, step\)/.test(html) &&
      num(/multiverse: \{ bpm: (\d+)/) === 140 &&
      num(/multiverse: \{ bpm: \d+, vol: 0\.(\d+)/) >= 30 &&
      /case 'multiverse': return 'multiverse';/.test(html) &&
      /\{ id: 'multiverse',\s+name: 'Multiverse Collapse'/.test(html) &&
      /if \(s % 4 === 0\) _mKick\(ac, dest, t, 0\.72\);/.test(html));

    // ---- one button per family of screens ----------------------------------
    check(file + ': rank, music, map and skin live behind ONE Customize button',
      /id="customizeBtn"/.test(html) &&
      /id="customizeScreen"/.test(html) &&
      /data-custo="skin"/.test(html) &&
      /data-custo="music"/.test(html) &&
      /data-custo="bg"/.test(html) &&
      /data-custo="rank"/.test(html) &&
      /function openCustomizeTab\(tab\)/.test(html) &&
      /function backToCustomize\(\)/.test(html) &&
      /document\.getElementById\('skinClose'\)\.addEventListener\('click', function\(\) \{ backToCustomize\(\); \}\)/.test(html) &&
      /document\.getElementById\('musicClose'\)\.addEventListener\('click', function\(\) \{ backToCustomize\(\); \}\)/.test(html) &&
      /document\.getElementById\('rankClose'\)\.addEventListener\('click', function\(\) \{ backToCustomize\(\); \}\)/.test(html) &&
      // the single old buttons are gone
      /id="skinBtn"/.test(html) === false &&
      /id="musicBtn"/.test(html) === false &&
      /id="rankListBtn"/.test(html) === false);
    check(file + ': the Background grid is hosted by the Map tab',
      /id="bgGridHost"/.test(html) &&
      /function moveBgGrid\(\) \{\s*var host = document\.getElementById\('bgGridHost'\);/.test(html) &&
      /var block = document\.getElementById\('bgBlock'\);/.test(html) &&
      /if \(host && block && block\.parentNode !== host\) host\.appendChild\(block\);/.test(html));
    check(file + ': Daily and Taoist quests share one Quests button with tabs',
      /id="questsBtn"/.test(html) &&
      /id="questScreen"/.test(html) &&
      /data-quest="daily"/.test(html) &&
      /data-quest="taoist"/.test(html) &&
      /function openQuestsTab\(tab\)/.test(html) &&
      /function backToQuests\(\)/.test(html) &&
      /document\.getElementById\('dailyQuestClose'\)\.addEventListener\('click', function\(\) \{ backToQuests\(\); \}\)/.test(html) &&
      /document\.getElementById\('taoistQuestClose'\)\.addEventListener\('click', function\(\) \{ backToQuests\(\); \}\)/.test(html) &&
      /id="dailyQuestBtn"/.test(html) === false &&
      /id="taoistQuestBtn"/.test(html) === false);

    // ---- INSANE rework -----------------------------------------------------
    check(file + ': insane spawns 5 x 100 HP dummies every 5s',
      num(/BIG_DUMMY_HP = (\d+)/) === 100 &&
      num(/INSANE_BIG_COUNT = (\d+)/) === 5 &&
      num(/INSANE_BIG_INTERVAL = (\d+)/) === 300 &&
      /for \(var bi = 0; bi < INSANE_BIG_COUNT; bi\+\+\)/.test(html) &&
      /var nd = createDummy\(bx, \{ big: true, hp: BIG_DUMMY_HP, speed: BIG_DUMMY_SPD \}\);/.test(html) &&
      // The advertised 100 HP is enforced after createDummy, which would otherwise apply
      // the mode's 1.5x and make the wave 150 HP.
      /nd\.hp = nd\.maxHp = BIG_DUMMY_HP;/.test(html) &&
      /dummies\.push\(nd\);/.test(html),
      'hp=' + num(/BIG_DUMMY_HP = (\d+)/) + ' count=' + num(/INSANE_BIG_COUNT = (\d+)/));
    check(file + ': insane fields the 3 boss-rush heavyweights together',
      num(/INSANE_TRIO_INTERVAL = (\d+)/) === 3600 &&
      /function spawnInsaneTrio\(\)/.test(html) &&
      /type: 'giant'/.test(html) &&
      /type: 'colossal', animTime: 0, vy: 0, dmgReduction: COLOSSAL_RESIST/.test(html) &&
      /type: 'amethyst', animTime: 0, vy: 0, state: 'chase', dmgReduction: AMETHYST_RESIST/.test(html) &&
      /if \(insaneTrioTimer >= INSANE_TRIO_INTERVAL\) \{ insaneTrioTimer = 0; spawnInsaneTrio\(\); \}/.test(html) &&
      /3 STRONG BOSSES — BOSS RUSH TRIO/.test(html) &&
      /spawnInsaneGiant\(\)/.test(html) === false);

    // ---- redeem code: the owner's big payout --------------------------------
    check(file + ': code 2212022019.192010 pays 30,000 points and 1,000 boss points',
      /'2212022019\.192010': \{ points: 30000, bossPts: 1000 \}/.test(html) &&
      // the input is upper-cased first, and the code is digits + a dot so it survives that
      /var code = \(val \|\| ''\)\.trim\(\)\.toUpperCase\(\);/.test(html) &&
      /totalPoints \+= reward\.points; bossPoints \+= reward\.bossPts; savePoints\(\);/.test(html));

    // ---- phone jump button ------------------------------------------------
    var dpadAt = html.indexOf('id="dpadArea"');
    var actAt = html.indexOf('id="actionArea"');
    check(file + ': the phone JUMP button moved to the right thumb',
      actAt > dpadAt &&
      /id="dpadJump"/.test(html.slice(actAt, actAt + 400)) &&
      /dpadJump/.test(html.slice(dpadAt, actAt)) === false &&
      /\.mob-jump \{ width: 150px; height: 44px;/.test(html));
  });
}

// --- ULTRA: the purple gear-halo character ----------------------------------
{
  console.log('\n===== Ultra =====');
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const num = (re) => { const m = html.match(re); return m ? Number(m[1]) : NaN; };

    check(file + ': Ultra is a buyable character card',
      /id="charUltra"/.test(html) &&
      /onclick="buyChar\('ultra'\)"/.test(html) &&
      /let boughtUltra = localStorage\.getItem\('sm_boughtUltra'\) === 'true';/.test(html) &&
      /if \(c === 'ultra'\) return boughtUltra;/.test(html) &&
      /c === 'ultra' && ultraUnlocked\(\) && totalPoints >= ULTRA_COST && bossPoints >= ULTRA_BOSS_COST/.test(html) &&
      /var ulEl = document\.getElementById\('charUltra'\);\n      if \(ulEl\) ulEl\.classList\.toggle\('selected', c === 'ultra'\);/.test(html));

    check(file + ': he costs 5,000 points and 10 boss points, and is kept forever',
      num(/var ULTRA_COST = (\d+)/) === 5000 &&
      num(/ULTRA_BOSS_COST = (\d+)/) === 10 &&
      /totalPoints -= ULTRA_COST; bossPoints -= ULTRA_BOSS_COST;/.test(html) &&
      // A five-round rental would silently delete a 5,000 point character.
      /if \(c === 'ultra'\) return; \/\/ bought outright, never burns out/.test(html) &&
      !/if \(c === 'ultra'\) \{ boughtUltra = false;/.test(html));

    check(file + ': the Fifty badge and a cleared Fighter Lv 11 are required to buy him',
      /function ultraHasFifty\(\)/.test(html) &&
      /a\['deathWaves:50'\]/.test(html) &&
      /\(l\.deathWaves \|\| 0\) >= 50/.test(html) &&
      /function ultraBeatLv11\(\) \{ return localStorage\.getItem\('sm_fighterLv11Down'\) === '1'; \}/.test(html) &&
      /function ultraUnlocked\(\) \{ return ultraHasFifty\(\) && ultraBeatLv11\(\); \}/.test(html) &&
      // Winning the last level is what stamps it, since progress clamps at 11 either way.
      /try \{ localStorage\.setItem\('sm_fighterLv11Down', '1'\); \} catch \(e\) \{\}/.test(html) &&
      /if \(!ultraHasFifty\(\)\) ulMiss\.push\('🏅 THE FIFTY'\);/.test(html) &&
      /if \(!ultraBeatLv11\(\)\) ulMiss\.push\('📖 FIGHTER LV 11'\);/.test(html));

    check(file + ': 450 HP, and fullReset knows about him',
      num(/ULTRA_HP = (\d+)/) === 450 &&
      /selectedChar === 'ultra' \? ULTRA_HP : 100\) \* skinHpMult\(\)/.test(html) &&
      /selectedChar === 'ultra' \? ULTRA_HP/.test(html));

    check(file + ': punch 20, blast 23, pulse 30 with +5% per use capped at +50%',
      num(/ULTRA_PUNCH_DMG = (\d+)/) === 20 &&
      num(/ULTRA_BLAST_DMG = (\d+)/) === 23 &&
      num(/ULTRA_PULSE_DMG = (\d+)/) === 30 &&
      /const ULTRA_PULSE_STEP = 0\.05, ULTRA_PULSE_MAX_USES = 10;/.test(html) &&
      /return 1 \+ Math\.min\(ULTRA_PULSE_MAX_USES, ultraPulseUses\) \* ULTRA_PULSE_STEP;/.test(html) &&
      /ultraPulseUses = Math\.min\(ULTRA_PULSE_MAX_USES, ultraPulseUses \+ 1\);/.test(html));

    check(file + ': sky laser ticks 1 damage every 0.1s for 10s',
      num(/ULTRA_LASER_DMG = (\d+)/) === 1 &&
      num(/ULTRA_LASER_DUR = (\d+)/) === 600 &&
      /if \(ultraLaser\.tick % ULTRA_LASER_TICK === 0\) \{/.test(html) &&
      /ultraHitRadius\(ultraLaser\.x, 46, ULTRA_LASER_DMG, 'laser'\)/.test(html) &&
      num(/ULTRA_LASER_TICK = (\d+)/) === 6);

    check(file + ': super slam is 45 + stun, super dash is 35 + a shockwave',
      num(/ULTRA_SLAM_DMG = (\d+)/) === 45 &&
      /ultraStunAround\(stick\.x, ULTRA_SLAM_RADIUS\);/.test(html) &&
      num(/ULTRA_DASH_DMG = (\d+)/) === 35 &&
      /ultraHitRadius\(\(fromX \+ toX\) \/ 2, Math\.abs\(toX - fromX\) \/ 2 \+ 45, ULTRA_DASH_DMG, 'dash'\);/.test(html) &&
      /ultraHitRadius\(stick\.x, ULTRA_WAVE_RADIUS, ULTRA_WAVE_DMG, 'wave'\);/.test(html) &&
      // A boss can be stunned too, not just the small stuff.
      /if \(boss\.stunTimer > 0\) \{ boss\.stunTimer--;/.test(html));

    check(file + ': heaven time strike is 40/0.5s for 5s then a 65% supernova',
      num(/ULTRA_ULT_TICK_DMG = (\d+)/) === 40 &&
      num(/ULTRA_ULT_DUR = (\d+)/) === 300 &&
      num(/ULTRA_ULT_NOVA_PCT = ([0-9.]+)/) === 0.65 &&
      /ultraHitAll\(ULTRA_ULT_TICK_DMG, 'ult'\);/.test(html) &&
      // Percentage of each enemy's OWN max HP, bosses included.
      /function ultraHitAllPct\(pct\)/.test(html) &&
      /Math\.round\(\(t\.maxHp \|\| t\.hp \|\| 1\) \* pct\)/.test(html) &&
      /if \(boss && boss\.alive\) dealDamageToBoss\(pctOf\(boss\), 'nova'\);/.test(html));

    check(file + ': 20% damage reduction, extra speed, and a 10% heal every 15s',
      num(/ULTRA_TAKEN_MULT = ([0-9.]+)/) === 0.8 &&
      /if \(selectedChar === 'ultra'\) dmg = Math\.max\(1, Math\.floor\(dmg \* ULTRA_TAKEN_MULT\)\);/.test(html) &&
      /if \(selectedChar === 'ultra'\) spdMult \*= ULTRA_SPEED_MULT;/.test(html) &&
      num(/ULTRA_HEAL_EVERY = (\d+)/) === 900 &&
      num(/ULTRA_HEAL_PCT = ([0-9.]+)/) === 0.1);

    check(file + ': purple gear halo behind him and a purple star eye',
      /ULTRA: the purple gear halo sits BEHIND him/.test(html) &&
      /Purple star eye — five points, turning slowly/.test(html) &&
      /ctx\.strokeStyle = 'rgba\(192,132,252,0\.5\)'; ctx\.lineWidth = 3;/.test(html) &&
      /fillStyle = '#c084fc'/.test(html));

    check(file + ': every input path reaches his abilities',
      /} else if \(selectedChar === 'ultra'\) \{\n        if \(e\.key === '1'\) performUltraLaser\(\);/.test(html) &&
      /if \(e\.button === 2\) performUltraBlast\(\); else performUltraPunch\(\);/.test(html) &&
      /else if \(selectedChar === 'ultra'\) performUltraPulse\(\);/.test(html) &&
      /ultBtn3\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); selectedChar === 'ultra' \? performUltraUlt\(\)/.test(html) &&
      /updateKnightAbilities\(\); updateHyperAbilities\(\); updateUltraAbilities\(\);/.test(html));

    // Every ability has to look like something, not just deal a number: each one pushes at
    // least two of the bespoke effect types the renderer now understands.
    // The effect pass used to sit in updateHyperAbilities(), which runs before the frame is
    // painted — every Ultra visual was drawn underneath the background and never seen.
    const hyperUpdateBody = html.slice(html.indexOf('function updateHyperAbilities()'), html.indexOf('function updateUltraAbilities()'));
    check(file + ': the effect pass draws with the scene, not inside an update function',
      hyperUpdateBody.length > 0 &&
      hyperUpdateBody.indexOf('Ultra effects') === -1 &&
      /Ultra effects: the orbiting[\s\S]{0,14000}drawHollowLaser\(\); drawStickman\(\);/.test(html));

    check(file + ': every ability is visually dressed',
      // The renderer knows all eight effect shapes.
      /f\.type === 'crescent'/.test(html) &&
      /f\.type === 'burst'/.test(html) &&
      /f\.type === 'gear'/.test(html) &&
      /f\.type === 'flash'/.test(html) &&
      /f\.type === 'pillar'/.test(html) &&
      /f\.type === 'crack'/.test(html) &&
      // Punch: crescent + burst + flash.
      /ubPf > 0 \? -0.72 : Math\.PI - 0\.72, width: 5/.test(html) &&
      // Blast: a third ring, a cog imprint and a white core.
      /type: 'gear', count: 8, spin: 0, life: 22, maxLife: 22/.test(html) &&
      // Laser: targeting cog and a starlight column at cast.
      /type: 'pillar', width: 26, life: 22, maxLife: 22/.test(html) &&
      // Pulse: strobing triple wave keeps the stacking buff readable.
      /ULTRA_PULSE_RADIUS \* 1\.1, '#7c3aed', 'wave', 26/.test(html) &&
      // Slam: fractured floor plus a second wall of force.
      /type: 'crack', count: 9, life: 26, maxLife: 26/.test(html) &&
      // Dash: launch crescent and speed lines.
      /ultraDashDir > 0 \? Math\.PI - 0\.7 : -0\.7, width: 4/.test(html) &&
      // Ult: gears on the floor and overhead, plus a light column.
      /type: 'gear', count: 16, spin: 0, life: 40, maxLife: 40/.test(html) &&
      /type: 'gear', count: 14, spin: 0, life: 70, maxLife: 70/.test(html) &&
      // Live beam visuals while the 10s laser runs.
      /for \(var ubScanI = 0; ubScanI < 3; ubScanI\+\+\)/.test(html) &&
      // Time stop: clock hands and cracked-glass spokes.
      /var ubTsAng = -Math\.PI \/ 2 \+ \(1 - tsLeft\) \* Math\.PI \* 2;/.test(html) &&
      /for \(var ubSpokeI = 0; ubSpokeI < 10; ubSpokeI\+\+\)/.test(html));

    // Level-up used to guess base HP from a ternary chain that forgot Fighter and Ultra, so
    // both fell through to the 80 default and LOSING pool on level up (Ultra 450 → 89).
    const charBaseBody = html.slice(html.indexOf('function charBaseHp('), html.indexOf('function checkUltimateUnlock('));
    check(file + ': levelling up never shrinks a character\'s HP pool',
      charBaseBody.length > 0 &&
      /case 'ultra': return ULTRA_HP;/.test(charBaseBody) &&
      /case 'fighter': return 100;/.test(charBaseBody) &&
      /case 'soldier': return 110;/.test(charBaseBody) &&
      /case 'ninja': return \(NINJA_HP_BY_LEVEL\[level\] \|\| NINJA_HP\);/.test(charBaseBody) &&
      /PLAYER_MAX_HP_CURRENT = Math\.floor\(charBaseHp\(selectedChar, playerLevel\) \* \(1 \+ \(playerLevel - 1\) \* 0\.12\)\);/.test(html) &&
      // The old 80-HP fallback ternary is gone for good.
      !/=== 'hyper' \? HYPER_HP : 80;/.test(html));

    // The rest of the roster gets one ring and one spark burst — deliberately lighter than
    // Ultra's layered set — and the effect list renders for every character, not just him.
    check(file + ': the other characters get lighter ability flares',
      /function charFlare\(color, x, y, big\)/.test(html) &&
      (html.match(/charFlare\('/g) || []).length >= 24 &&
      /charFlare\('#f97316'\);/.test(html) &&
      /charFlare\('#ef4444', undefined, undefined, true\);/.test(html) &&
      // Only ONE burst per flare: no crescent/gear/pillar stack like Ultra's.
      /ultraFx\.push\(\{ x: cx, y: cy, r: 7, max: big \? 54 : 32, color: color, type: 'burst'/.test(html) &&
      /Ability effects are shared by the whole roster/.test(html));

    // The Slayer's F used to re-damage everything it overlapped on EVERY frame of the
    // projectile's 60-frame flight — roughly ten times its designed 9 x 5.
    check(file + ': wave projectiles hit each enemy once, so F is not a damage spam',
      /function phantomHitOnce\(cx, radius, dmg, source, hitList\)/.test(html) &&
      /if \(!obj \|\| hitList\.indexOf\(obj\) >= 0\) return;/.test(html) &&
      /phantomHitOnce\(p\.x, p\.range, p\.dmg, 'slash', p\.hits \|\| \(p\.hits = \[\]\)\);/.test(html) &&
      !/phantomHitAll\(p\.x, p\.range, p\.dmg, 'slash'\);/.test(html) &&
      // Design value stays 9 waves x 5 damage.
      num(/SLAYER_MULTI_SLASH_DMG = (\d+)/) === 5 &&
      num(/SLAYER_MULTI_SLASH_HITS = (\d+)/) === 9);

    check(file + ': levelling up also raises damage and speed',
      /const LV_DMG_PER_LEVEL = 0\.06, LV_SPEED_PER_LEVEL = 0\.015;/.test(html) &&
      /function lvDmgMult\(\) \{ return 1 \+ Math\.max\(0, playerLevel - 1\) \* LV_DMG_PER_LEVEL; \}/.test(html) &&
      /function lvSpeedMult\(\) \{ return 1 \+ Math\.max\(0, playerLevel - 1\) \* LV_SPEED_PER_LEVEL; \}/.test(html) &&
      /spdMult \*= lvSpeedMult\(\);/.test(html) &&
      (html.match(/pickupDmgMult\(\) \* lvDmgMult\(\)/g) || []).length >= 6 &&
      /\+ Math\.round\(\(lvDmgMult\(\) - 1\) \* 100\) \+ '% DMG/.test(html));

    check(file + ': Slayer blades are drawn and Ultra carries an energy aura',
      /type: 'crescent', spin: slDir > 0 \? -0\.7 : Math\.PI - 0\.7/.test(html) &&
      /type: 'crescent', spin: slayerLungeDir > 0 \? Math\.PI - 0\.8 : -0\.8/.test(html) &&
      /for \(var suI = 0; suI < 3; suI\+\+\) ultraFx\.push/.test(html) &&
      /Energy aura — he is always humming with power/.test(html) &&
      /var uaGrad = ctx\.createRadialGradient\(stick\.x, stick\.y - 32, 4, stick\.x, stick\.y - 32, 96\)/.test(html) &&
      /for \(var uaI = 0; uaI < 5; uaI\+\+\)/.test(html));

    // The brief is a comparison, so it is checked as one: every Ultra number against the
    // Slayer's same-slot number, read from the same file.
    const sl = {
      hp: num(/SLAYER_HP = (\d+)/),
      basic: num(/SLAYER_SLASH_DMG = (\d+)/), basicCD: num(/SLAYER_SLASH_CD = (\d+)/), basicR: num(/SLAYER_SLASH_RANGE = (\d+)/),
      slam: num(/SLAYER_BLADE_SLAM_DMG = (\d+)/), slamCD: num(/SLAYER_BLADE_SLAM_CD = (\d+)/), slamR: num(/SLAYER_BLADE_SLAM_RADIUS = (\d+)/),
      superSlash: num(/SLAYER_SUPER_SLASH_DMG = (\d+)/), superSlashCD: num(/SLAYER_SUPER_SLASH_CD = (\d+)/),
      multi: num(/SLAYER_MULTI_SLASH_DMG = (\d+)/) * num(/SLAYER_MULTI_SLASH_HITS = (\d+)/), multiCD: num(/SLAYER_MULTI_SLASH_CD = (\d+)/),
      tornado: num(/SLAYER_TORNADO_DMG = (\d+)/), tornadoCD: num(/SLAYER_TORNADO_CD = (\d+)/),
      lungeCD: num(/SLAYER_LUNGE_CD = (\d+)/), lungeDist: num(/SLAYER_LUNGE_DIST = (\d+)/),
      ult: num(/SLAYER_ULT_EXPLODE_DMG = (\d+)/)
    };
    const ul = {
      hp: num(/ULTRA_HP = (\d+)/),
      basic: num(/ULTRA_PUNCH_DMG = (\d+)/), basicCD: num(/ULTRA_PUNCH_CD = (\d+)/), basicR: num(/ULTRA_PUNCH_RANGE = (\d+)/),
      blast: num(/ULTRA_BLAST_DMG = (\d+)/), blastCD: num(/ULTRA_BLAST_CD = (\d+)/),
      slam: num(/ULTRA_SLAM_DMG = (\d+)/), slamCD: num(/ULTRA_SLAM_CD = (\d+)/), slamR: num(/ULTRA_SLAM_RADIUS = (\d+)/),
      dash: num(/ULTRA_DASH_DMG = (\d+)/), dashCD: num(/ULTRA_DASH_CD = (\d+)/), dashDist: num(/ULTRA_DASH_DIST = (\d+)/),
      laser: num(/ULTRA_LASER_DMG = (\d+)/) * (num(/ULTRA_LASER_DUR = (\d+)/) / num(/ULTRA_LASER_TICK = (\d+)/)), laserCD: num(/ULTRA_LASER_CD = (\d+)/),
      pulse: num(/ULTRA_PULSE_DMG = (\d+)/), pulseCD: num(/ULTRA_PULSE_CD = (\d+)/),
      ultTick: num(/ULTRA_ULT_TICK_DMG = (\d+)/) * (num(/ULTRA_ULT_DUR = (\d+)/) / num(/ULTRA_ULT_TICK = (\d+)/)),
      ultNova: num(/ULTRA_ULT_NOVA_PCT = ([0-9.]+)/)
    };
    // Damage done to a boss-scale target (the 1,200 HP Ancient Colossal) is the only fair
    // way to compare a flat nuke against a percentage one.
    const BOSS_HP = 1200, SMALL_BOSS_HP = 1000;
    const ultraOnBoss = ul.ultTick + Math.round(BOSS_HP * ul.ultNova);
    const ultraOnSmallBoss = ul.ultTick + Math.round(SMALL_BOSS_HP * ul.ultNova);
    const pairs = [
      ['HP', ul.hp, sl.hp],
      ['M1 damage', ul.basic, sl.basic], ['M1 reach', ul.basicR, sl.basicR], ['M1 cooldown (lower wins)', sl.basicCD, ul.basicCD],
      ['M2 blast vs lunge', ul.blast, 0], ['M2 cooldown (lower wins)', sl.lungeCD, ul.blastCD],
      ['1 laser total', ul.laser, sl.multi], ['1 cooldown (lower wins)', sl.multiCD, ul.laserCD],
      ['2 pulse', ul.pulse, sl.tornado], ['2 cooldown (lower wins)', sl.tornadoCD, ul.pulseCD],
      ['F slam', ul.slam, sl.slam], ['F cooldown (lower wins)', sl.slamCD, ul.slamCD], ['F radius', ul.slamR, sl.slamR],
      ['E dash', ul.dash, sl.superSlash], ['E cooldown (lower wins)', sl.superSlashCD, ul.dashCD], ['E distance', ul.dashDist, sl.lungeDist],
      ['3 ult on a 1200 HP boss', ultraOnBoss, sl.ult],
      ['3 ult on a 1000 HP boss', ultraOnSmallBoss, sl.ult]
    ];
    const worse = pairs.filter((p) => !(p[1] >= p[2])).map((p) => p[0] + ' ' + p[1] + ' < ' + p[2]);
    check(file + ': every ability beats the Slayer on damage, reach and cooldown', worse.length === 0, worse.join(', '));

    check(file + ': every third ultimate stops time for 7s, then a 60% supernova',
      num(/ULTRA_ULT_CASTS_FOR_STOP = (\d+)/) === 3 &&
      num(/ULTRA_TIME_STOP_DUR = (\d+)/) === 420 &&
      num(/ULTRA_TIME_STOP_NOVA_PCT = ([0-9.]+)/) === 0.6 &&
      // The cast counter still gates the freeze; effect lines may sit between them.
      /ultraUltCasts\+\+;(?:[^\n]*\n){0,12}\s*if \(ultraUltCasts >= ULTRA_ULT_CASTS_FOR_STOP\) \{/.test(html) &&
      /ultraUltCasts = 0;\n        ultraTimeStop = ULTRA_TIME_STOP_DUR;/.test(html) &&
      /if \(ultraTimeStop === 0\) \{\n          ultraHitAllPct\(ULTRA_TIME_STOP_NOVA_PCT\);/.test(html) &&
      // Enemies stop dead; the player and his own attacks keep running.
      /function ultraTimeFrozen\(\) \{ return ultraTimeStop > 0; \}/.test(html) &&
      /var frozen = ultraTimeFrozen\(\);\n      updateStickman\(\); if \(!frozen\) \{ updateNormalDummies\(\);/.test(html) &&
      /if \(ultraTimeStop > 0\) \{\n          \/\/ Time stop: a violet film/.test(html) &&
      /ultraUltCasts = 0; ultraTimeStop = 0;/.test(html));
  });
}

// --- TIME CHAINER: the fighter campaign's new final boss --------------------
{
  console.log('\n===== the Time Chainer (Fighter Lv 11) =====');
  ['index.html', 'index.standalone.html'].forEach((file) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const num = (re) => { const m = html.match(re); return m ? Number(m[1]) : NaN; };

    check(file + ': Lv 11 exists and the fighter campaign now runs to 11',
      /name: 'Level 11: The Time Chainer'/.test(html) &&
      /spawnTimeChainer: true/.test(html) &&
      /campaignMaxLevels = CAMPAIGN_LEVELS\.length;/.test(html) &&
      // Level 10 keeps its "THE END... or NOT?" cliffhanger instead of ending the campaign.
      /if \(campaignLevel === 10 && typeof POST_WIN_CUTSCENE !== 'undefined'\) \{/.test(html));

    check(file + ': he has 1250 HP and a 550 HP second phase',
      num(/TC_HP = (\d+)/) === 1250 &&
      num(/TC_PHASE2_HP = (\d+)/) === 550 &&
      /if \(mb\.type === 'time_chainer' && mb\.phase === 1\) \{/.test(html) &&
      /mb\.phase = 2; mb\.hp = TC_PHASE2_HP; mb\.maxHp = TC_PHASE2_HP;/.test(html) &&
      /\/\/ PHASE TWO: he does not die, he rewinds/.test(html));

    check(file + ': the chains pin the player in place',
      /timeChainTimer = p2 \? TC_CHAIN2_FRAMES : TC_CHAIN_FRAMES;/.test(html) &&
      /if \(timeChainTimer > 0\) \{/.test(html) &&
      /timeChainTimer--;/.test(html) &&
      // Rooted inside updateStickman, so it beats keyboard and touch input alike.
      html.indexOf('if (timeChainTimer > 0) {') < html.indexOf('let targetVx = 0;'));

    check(file + ': sky blasts land for 30 and shock ticks for 16',
      num(/TC_BLAST_DMG = (\d+)/) === 30 &&
      num(/TC_ZAP_DMG = (\d+)/) === 16 &&
      /tcBlasts\.push\(\{ x: bx, life: TC_BLAST_WARN \+ 40, delay: TC_BLAST_WARN, hit: false \}\)/.test(html) &&
      /if \(Math\.abs\(stick\.x - b\.x\) < TC_BLAST_RADIUS\) damagePlayer\(TC_BLAST_DMG, '#fbbf24'\);/.test(html) &&
      // Blasts resolve even if he dies mid-cast.
      /updateTimeChainerBlasts\(\);\n      \/\/ His theme only lasts/.test(html));

    check(file + ': he teleports, and electrifies the player on the tether',
      /case 'teleport': \{/.test(html) &&
      /case 'zap': \{/.test(html) &&
      /if \(mb\.cast > 6 && mb\.cast % every === 0\) \{/.test(html) &&
      // A fixed rotation means every move shows up instead of being left to chance.
      /var rot = mb\.atkCount % 4;/.test(html));

    check(file + ': he carries his own background music',
      /timechainer: \{ bpm: 132, vol: 0\.34, rain: false, bar: timeChainerBar \}/.test(html) &&
      /function timeChainerBar\(ac, dest, t0, bar, step\)/.test(html) &&
      /function startTimeChainerMusic\(\)/.test(html) &&
      /startThemeMusic\('timechainer'\)/.test(html) &&
      /function stopTimeChainerMusic\(\)/.test(html) &&
      // The track can never outlive the boss or the round.
      /if \(tcMusicOn && \(!miniBosses\.some\(function\(m\) \{ return m\.alive && m\.type === 'time_chainer'; \}\) \|\| gameState !== 'playing'\)\) stopTimeChainerMusic\(\);/.test(html));

    check(file + ': Hyper starts the final fight with a full ultimate',
      /if \(level >= 11\) \{\n        ultCharge = 100; ultReady = true;\n        ultBar\.style\.width = '100%'; ultBarText\.textContent = '100%';/.test(html));

    check(file + ': the fighter hands Lv 11 over to Hyper',
      /if \(level >= 11\) \{\n        selectedChar = 'hyper';/.test(html) &&
      /The power I emerge\.\.\. has already started\./.test(html) &&
      /\{ speaker: 'Hyper', color: '#c084fc', text: 'Your hour is up\. I will be taking it\.'/.test(html) &&
      // Hyper's real HP pool — fullReset used to fall through to 100 for him.
      /selectedChar === 'hyper' \? HYPER_HP : selectedChar === 'ultra' \? ULTRA_HP : 100\) \* skinHpMult\(\)/.test(html));

    check(file + ': the level is won only once he is truly broken',
      /if \(lv\.spawnTimeChainer\) \{/.test(html) &&
      /campaignSpecialTimers\['tc_spawned'\] && !tcAlive && campaignTimer > 120/.test(html) &&
      /\/\/ Breaking him for good frees anyone still chained\.\n        if \(mb\.type === 'time_chainer'\) \{ timeChainTimer = 0; \}/.test(html) &&
      /var TIME_CHAINER_WIN_CUTSCENE = \[/.test(html) &&
      /cutsceneData === TIME_CHAINER_WIN_CUTSCENE/.test(html));
  });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
