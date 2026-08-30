import React, { useRef, useEffect, useState, useCallback } from 'react';

// ── Types ──────────────────────────────────────────────────────────────
interface Fighter {
  x: number; y: number; vx: number; vy: number;
  facing: number; state: string; animTime: number;
  health: number; maxHealth: number;
}

interface Enemy extends Fighter {
  type: 'grunt' | 'tank' | 'necro' | 'boss' | 'zombie';
  aiTimer: number; attackCd: number; scale: number; color: string;
}

interface DeathBoss extends Fighter {
  scytheCd: number; boneCd: number; zombieCd: number;
  scytheSwing: number; // 0 = not swinging, >0 = swing progress
}

interface BoneHand {
  px: number; py: number; // current position
  progress: number; // 0→1 reaching
  phase: 'reaching' | 'grabbing';
  grabTimer: number;
  side: -1 | 1; // left or right of player
}

interface Particle {
  x: number; y: number; vx: number; vy: number; life: number; color: string;
}

type Phase = 'wave1' | 'wave2' | 'wave3' | 'death' | 'victory' | 'gameOver';

// ── Constants ──────────────────────────────────────────────────────────
const CW = 900, CH = 500, GRAVITY = 0.6, GY = 380, SPEED = 5, JUMP = -14;
const WAVE1_DUR = 1200; // 20s
const WAVE2_DUR = 1800; // 30s
const WAVE3_DUR = 1800; // 30s before DEATH
const TANK_INT = 480;   // 8s
const NECRO_INT = 600;  // 10s
const D_SCYTHE_INT = 120;
const D_BONE_INT = 480;
const D_ZOMBIE_INT = 300;
const BONE_DUR = 300;   // 5s grab

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ── Drawing ────────────────────────────────────────────────────────────
function drawFighter(
  ctx: CanvasRenderingContext2D, f: { x: number; y: number; facing: number; state: string; animTime: number },
  time: number, color = '#111827', scale = 1
) {
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(scale, scale);
  ctx.translate(-f.x, -f.y);
  ctx.strokeStyle = color; ctx.lineWidth = 4.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  const isAtk = f.state === 'punch' || f.state === 'kick';
  const atkP = isAtk ? Math.min(f.animTime / 8, 1) : 0;
  const walk = f.state === 'walk' ? Math.sin(time * 0.25) : 0;
  const bob = f.state === 'walk' ? Math.abs(walk) * 3 : 0;
  const headY = f.y - 55 + bob;
  const bTop = headY + 22, bBot = bTop + 38, fd = f.facing;

  // Head
  ctx.beginPath(); ctx.arc(f.x, headY, 14, 0, Math.PI * 2); ctx.stroke();
  // Body
  ctx.beginPath(); ctx.moveTo(f.x, bTop); ctx.lineTo(f.x, bBot); ctx.stroke();
  // Legs
  const ls = f.state === 'walk' ? walk * 18 : f.state === 'jump' ? 22 : 14;
  ctx.beginPath(); ctx.moveTo(f.x, bBot);
  ctx.lineTo(f.x - ls * fd + (f.state === 'kick' && fd === 1 ? atkP * 35 : 0), bBot + 32);
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(f.x, bBot);
  ctx.lineTo(f.x + ls * fd - (f.state === 'kick' && fd === -1 ? atkP * 35 : 0), bBot + 32);
  ctx.stroke();
  // Arms
  const armY = bTop + 10;
  const pR = f.state === 'punch' ? atkP * 45 * fd : 0;
  ctx.beginPath(); ctx.moveTo(f.x, armY);
  ctx.lineTo(f.x - 22 * fd, armY + 24 + walk * 6); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(f.x, armY);
  ctx.lineTo(f.x + 22 * fd + pR, armY + (f.state === 'punch' ? -5 : 24) - walk * 6); ctx.stroke();
  // Attack flash
  if (f.state === 'punch' && atkP > 0.2) {
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(f.x + 26 * fd, armY - 5);
    ctx.lineTo(f.x + 55 * fd + pR * 0.5, armY - 8); ctx.stroke();
  }
  ctx.restore();
}

function drawHPBar(ctx: CanvasRenderingContext2D, x: number, y: number, hp: number, maxHp: number, w = 36) {
  if (hp >= maxHp) return;
  const h = 4, bx = x - w / 2;
  ctx.fillStyle = '#1a1a1a'; ctx.fillRect(bx, y, w, h);
  ctx.fillStyle = hp > maxHp * 0.3 ? '#22c55e' : '#ef4444';
  ctx.fillRect(bx, y, w * clamp(hp / maxHp, 0, 1), h);
}

function drawDeath(ctx: CanvasRenderingContext2D, d: DeathBoss, time: number) {
  // Body (1.5× scale dark purple)
  drawFighter(ctx, d, time, '#581c87', 1.5);
  // HP bar
  drawHPBar(ctx, d.x, d.y - 100, d.health, d.maxHealth, 54);

  // Scythe
  const fd = d.facing;
  const armEndX = d.x + 22 * 1.5 * fd;
  const armEndY = d.y - 35;
  const swing = d.scytheSwing > 0 ? Math.sin((1 - d.scytheSwing / 12) * Math.PI) : 0;
  const handleLen = 55;
  const hx = armEndX + fd * handleLen * 0.3;
  const hy = armEndY - 5 + swing * -20;
  const tipX = hx + fd * handleLen;
  const tipY = hy - 8;

  ctx.strokeStyle = '#78350f'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tipX, tipY); ctx.stroke();
  // Blade
  ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(tipX, tipY, 22, -Math.PI * 0.85, -Math.PI * 0.15); ctx.stroke();
  // Scythe trail when swinging
  if (d.scytheSwing > 0) {
    ctx.strokeStyle = 'rgba(229,231,235,0.4)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(d.x + fd * 40, d.y - 40, 70, -Math.PI * 0.9, -Math.PI * 0.1);
    ctx.stroke();
  }

  // Eye glow
  ctx.fillStyle = '#ef4444';
  ctx.beginPath(); ctx.arc(d.x - 5 * fd, d.y - 60 * 1.5 + 55, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(d.x + 5 * fd, d.y - 60 * 1.5 + 55, 2.5, 0, Math.PI * 2); ctx.fill();
}

function drawBoneHands(ctx: CanvasRenderingContext2D, hands: BoneHand[], px: number, py: number) {
  hands.forEach(h => {
    const tx = px + h.side * 20;
    const ty = py - 30;
    // Arm line from current pos to player
    ctx.strokeStyle = 'rgba(212,212,216,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(h.px, h.py); ctx.lineTo(tx, ty); ctx.stroke();
    // Hand
    ctx.strokeStyle = '#d4d4d8'; ctx.lineWidth = 2;
    const r = h.phase === 'grabbing' ? 8 : 6;
    ctx.beginPath(); ctx.arc(tx, ty, r, 0, Math.PI * 2); ctx.stroke();
    // Fingers
    for (let i = 0; i < 4; i++) {
      const a = -Math.PI / 2 + (i - 1.5) * (h.phase === 'grabbing' ? 0.5 : 0.4);
      const len = h.phase === 'grabbing' ? 10 : 14;
      ctx.beginPath(); ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.cos(a) * len, ty + Math.sin(a) * len); ctx.stroke();
    }
    // Grab effect
    if (h.phase === 'grabbing') {
      ctx.strokeStyle = 'rgba(239,68,68,0.3)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(tx, ty, 14, 0, Math.PI * 2); ctx.stroke();
    }
  });
}

// ── Spawn helpers ──────────────────────────────────────────────────────
function mkEnemy(type: Enemy['type'], x: number): Enemy {
  const cfg: Record<string, { hp: number; spd: number; dmg: number; scale: number; color: string }> = {
    grunt:  { hp: 40,  spd: 2,   dmg: 5,  scale: 0.95, color: '#6b7280' },
    tank:   { hp: 200, spd: 1.5, dmg: 15, scale: 1.25, color: '#991b1b' },
    necro:  { hp: 80,  spd: 2.2, dmg: 10, scale: 1,    color: '#7c3aed' },
    boss:   { hp: 250, spd: 2.5, dmg: 20, scale: 1.35, color: '#dc2626' },
    zombie: { hp: 50,  spd: 2,   dmg: 5,  scale: 0.9,  color: '#4d7c0f' },
  };
  const c = cfg[type];
  return { x, y: GY, vx: 0, vy: 0, facing: -1, state: 'idle', animTime: 0, health: c.hp, maxHealth: c.hp, type, aiTimer: Math.random() * 60 | 0, attackCd: 0, scale: c.scale, color: c.color };
}

function mkDeath(x: number): DeathBoss {
  return { x, y: GY, vx: 0, vy: 0, facing: -1, state: 'idle', animTime: 0, health: 300, maxHealth: 300, scytheCd: 90, boneCd: 300, zombieCd: 150, scytheSwing: 0 };
}

// ── Component ──────────────────────────────────────────────────────────
export default function StickmanAnimator() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>('wave1');
  const [announce, setAnnounce] = useState('WAVE 1');
  const [announceTimer, setAnnounceTimer] = useState(180);
  const [score, setScore] = useState(0);
  const [playerHp, setPlayerHp] = useState(100);
  const [playerColor, setPlayerColor] = useState('#6b7280');
  const [showHelp, setShowHelp] = useState(true);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const stickRef = useRef<Fighter>({ x: 200, y: GY, vx: 0, vy: 0, facing: 1, state: 'idle', animTime: 0, health: 100, maxHealth: 100 });
  const enemiesRef = useRef<Enemy[]>([]);
  const deathRef = useRef<DeathBoss | null>(null);
  const boneHandsRef = useRef<BoneHand[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const keysRef = useRef<Set<string>>(new Set());
  const timeRef = useRef(0);
  const atkCdRef = useRef(0);
  const waveTimerRef = useRef(0);
  const tankSpawnRef = useRef(0);
  const necroSpawnRef = useRef(0);
  const grabbedRef = useRef(false);
  const animRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>('wave1');
  const hpRef = useRef(100);
  const announceTimerRef = useRef(180);

  // Keep refs in sync with React state
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { hpRef.current = playerHp; }, [playerHp]);
  useEffect(() => { announceTimerRef.current = announceTimer; }, [announceTimer]);

  const spawnP = useCallback((x: number, y: number, n: number, color: string) => {
    for (let i = 0; i < n; i++)
      particlesRef.current.push({ x, y, vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8 - 2, life: 20 + Math.random() * 15, color });
  }, []);

  const showAnnounce = useCallback((text: string) => {
    setAnnounce(text); setAnnounceTimer(180);
  }, []);

  const updatePlayer = useCallback(() => {
    const s = stickRef.current;
    const k = keysRef.current;
    if (grabbedRef.current) { s.state = 'idle'; s.animTime = (s.animTime + 1) % 60; return; }
    let tvx = 0;
    if (atkCdRef.current === 0) {
      if (k.has('ArrowLeft') || k.has('a') || k.has('A')) tvx -= SPEED;
      if (k.has('ArrowRight') || k.has('d') || k.has('D')) tvx += SPEED;
    }
    s.vx = tvx; s.x += s.vx; s.x = clamp(s.x, 50, CW - 50);
    if (tvx !== 0) s.facing = tvx > 0 ? 1 : -1;
    if ((k.has(' ') || k.has('Spacebar')) && s.y >= GY - 1 && s.vy === 0) { s.vy = JUMP; s.state = 'jump'; spawnP(s.x, s.y + 5, 6, '#64748b'); }
    s.vy += GRAVITY; s.y += s.vy;
    if (s.y >= GY) { s.y = GY; s.vy = 0; if (s.state === 'jump') s.state = 'idle'; }
    const inAtk = atkCdRef.current > 0;
    if (!inAtk || (s.state !== 'punch' && s.state !== 'kick'))
      s.state = s.y < GY - 5 ? 'jump' : Math.abs(s.vx) > 0.5 ? 'walk' : 'idle';
    if (atkCdRef.current > 0) { atkCdRef.current--; if (atkCdRef.current === 0 && (s.state === 'punch' || s.state === 'kick')) s.state = 'idle'; }
    s.animTime = (s.animTime + 1) % 60;
  }, [spawnP]);

  const performAttack = useCallback((type: 'punch' | 'kick') => {
    const s = stickRef.current;
    if (atkCdRef.current > 0) return;
    s.state = type; s.animTime = 0;
    atkCdRef.current = type === 'punch' ? 14 : 18;
    const ax = s.x + 38 * s.facing, ay = s.y - 35;
    spawnP(ax, ay, 12, type === 'punch' ? '#f59e0b' : '#ef4444');
    const dmg = type === 'punch' ? 18 : 28;
    const range = 65;
    // Hit enemies
    enemiesRef.current.forEach(e => {
      if (e.health <= 0) return;
      if (Math.abs(ax - e.x) < range && Math.abs(ay - (e.y - 30)) < 45) {
        e.health -= dmg;
        spawnP(e.x, e.y - 30, 8, '#22c55e');
        if (e.health <= 0) { setScore(sc => sc + (e.type === 'boss' ? 50 : e.type === 'tank' ? 30 : e.type === 'necro' ? 25 : 10)); spawnP(e.x, e.y - 20, 15, '#ef4444'); }
      }
    });
    // Hit DEATH
    if (deathRef.current && deathRef.current.health > 0) {
      const d = deathRef.current;
      if (Math.abs(ax - d.x) < range * 1.3 && Math.abs(ay - (d.y - 30)) < 55) {
        d.health -= dmg;
        spawnP(d.x, d.y - 40, 10, '#a855f7');
        if (d.health <= 0) {
          spawnP(d.x, d.y - 30, 30, '#fbbf24');
          deathRef.current = null;
          setPhase('victory');
        }
      }
    }
  }, [spawnP]);

  // ── Enemy AI ──
  const updateEnemies = useCallback(() => {
    enemiesRef.current = enemiesRef.current.filter(e => {
      if (e.health <= 0) return false;
      const s = stickRef.current;
      const dx = s.x - e.x;
      e.facing = dx > 0 ? 1 : -1;
      e.aiTimer++;
      if (e.attackCd > 0) { e.attackCd--; e.state = e.attackCd > 6 ? 'punch' : 'idle'; e.animTime = (e.animTime + 1) % 60; return true; }
      const d = Math.abs(dx);
      const ms = e.type === 'tank' ? 1.5 : e.type === 'necro' ? 2.2 : e.type === 'zombie' ? 2 : 2.5;
      if (d < 55 && e.aiTimer % 40 < 6) {
        e.state = 'punch'; e.animTime = 0; e.attackCd = 18;
        const dmg = e.type === 'tank' ? 15 : e.type === 'boss' ? 20 : e.type === 'necro' ? 10 : 5;
        setPlayerHp(hp => { const n = hp - dmg; if (n <= 0) setPhase('gameOver'); return Math.max(0, n); });
        spawnP(s.x, s.y - 30, 5, '#ef4444');
      } else if (d > 50) { e.x += e.facing * ms; e.state = 'walk'; }
      else { e.state = 'idle'; }
      e.x = clamp(e.x, 350, CW - 20);
      e.animTime = (e.animTime + 1) % 60;
      return true;
    });
  }, [spawnP]);

  // ── DEATH AI ──
  const updateDeath = useCallback(() => {
    const d = deathRef.current;
    if (!d || d.health <= 0) return;
    const s = stickRef.current;
    const dx = s.x - d.x;
    d.facing = dx > 0 ? 1 : -1;
    const spd = 2.2;

    // Movement
    if (Math.abs(dx) > 80) { d.x += d.facing * spd; d.state = 'walk'; }
    else { d.state = 'idle'; }
    d.x = clamp(d.x, 300, CW - 20);

    // Scythe attack
    if (d.scytheSwing > 0) {
      d.scytheSwing--;
      if (d.scytheSwing === 6) {
        // Damage at peak
        if (Math.abs(dx) < 100) {
          setPlayerHp(hp => { const n = hp - 10; if (n <= 0) setPhase('gameOver'); return Math.max(0, n); });
          spawnP(s.x, s.y - 30, 8, '#e5e7eb');
        }
      }
    } else {
      d.scytheCd--;
      if (d.scytheCd <= 0) { d.scytheSwing = 12; d.scytheCd = D_SCYTHE_INT; }
    }

    // Bone hands
    d.boneCd--;
    if (d.boneCd <= 0 && boneHandsRef.current.length === 0) {
      boneHandsRef.current = [
        { px: d.x, py: d.y - 40, progress: 0, phase: 'reaching', grabTimer: BONE_DUR, side: -1 },
        { px: d.x, py: d.y - 40, progress: 0, phase: 'reaching', grabTimer: BONE_DUR, side: 1 },
      ];
      d.boneCd = D_BONE_INT;
    }

    // Zombie spawn
    d.zombieCd--;
    if (d.zombieCd <= 0) {
      for (let i = 0; i < 5; i++) {
        enemiesRef.current.push(mkEnemy('zombie', d.x + (Math.random() - 0.5) * 100));
      }
      d.zombieCd = D_ZOMBIE_INT;
      spawnP(d.x, d.y - 30, 10, '#4d7c0f');
    }

    d.animTime = (d.animTime + 1) % 60;
  }, [spawnP]);

  // ── Bone hands ──
  const updateBoneHands = useCallback(() => {
    const s = stickRef.current;
    let anyGrabbing = false;
    boneHandsRef.current = boneHandsRef.current.filter(h => {
      const tx = s.x + h.side * 20;
      const ty = s.y - 30;
      if (h.phase === 'reaching') {
        h.progress += 0.025;
        h.px += (tx - h.px) * 0.08;
        h.py += (ty - h.py) * 0.08;
        if (h.progress >= 1) { h.phase = 'grabbing'; h.grabTimer = BONE_DUR; }
      }
      if (h.phase === 'grabbing') {
        anyGrabbing = true;
        h.grabTimer--;
        // Damage every 60 frames (1 per second)
        if (h.grabTimer % 60 === 0) {
          setPlayerHp(hp => { const n = hp - 5; if (n <= 0) setPhase('gameOver'); return Math.max(0, n); });
          spawnP(s.x, s.y - 30, 3, '#ef4444');
        }
        return h.grabTimer > 0;
      }
      return h.progress < 1;
    });
    grabbedRef.current = anyGrabbing;
  }, [spawnP]);

  // ── Game loop ──
  const gameLoop = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    timeRef.current++;
    const ph = phaseRef.current;

    // Announce timer (read from ref, not stale state)
    if (announceTimerRef.current > 0) {
      announceTimerRef.current--;
      setAnnounceTimer(announceTimerRef.current);
    }

    if (ph === 'wave1' || ph === 'wave2' || ph === 'wave3' || ph === 'death') {
      updatePlayer();

      if (ph === 'wave1') {
        waveTimerRef.current++;
        updateEnemies();
        // Spawn grunts every 5s (2-3 at a time)
        tankSpawnRef.current++;
        if (tankSpawnRef.current >= 300) {
          tankSpawnRef.current = 0;
          const count = 2 + Math.floor(Math.random() * 2);
          for (let i = 0; i < count; i++)
            enemiesRef.current.push(mkEnemy('grunt', 550 + Math.random() * 250));
        }
        if (waveTimerRef.current >= WAVE1_DUR) {
          enemiesRef.current = [];
          waveTimerRef.current = 0; tankSpawnRef.current = 0;
          setPhase('wave2'); phaseRef.current = 'wave2';
          showAnnounce('WAVE 2');
        }
      } else if (ph === 'wave2') {
        waveTimerRef.current++;
        updateEnemies();
        // Spawn tanks every 8s
        tankSpawnRef.current++;
        if (tankSpawnRef.current >= TANK_INT) {
          tankSpawnRef.current = 0;
          enemiesRef.current.push(mkEnemy('tank', 600 + Math.random() * 200));
          enemiesRef.current.push(mkEnemy('tank', 650 + Math.random() * 200));
        }
        // Spawn necros every 10s
        necroSpawnRef.current++;
        if (necroSpawnRef.current >= NECRO_INT) {
          necroSpawnRef.current = 0;
          enemiesRef.current.push(mkEnemy('necro', 650 + Math.random() * 150));
        }
        // Wave end
        if (waveTimerRef.current >= WAVE2_DUR) {
          enemiesRef.current = [];
          waveTimerRef.current = 0; tankSpawnRef.current = 0; necroSpawnRef.current = 0;
          setPhase('wave3'); phaseRef.current = 'wave3';
          showAnnounce('WAVE 3');
          for (let i = 0; i < 3; i++) enemiesRef.current.push(mkEnemy('boss', 550 + i * 70));
          for (let i = 0; i < 2; i++) enemiesRef.current.push(mkEnemy('necro', 700 + i * 60));
        }
      } else if (ph === 'wave3') {
        waveTimerRef.current++;
        updateEnemies();
        if (waveTimerRef.current >= WAVE3_DUR) {
          enemiesRef.current = [];
          waveTimerRef.current = 0;
          deathRef.current = mkDeath(650);
          boneHandsRef.current = [];
          setPhase('death'); phaseRef.current = 'death';
          showAnnounce('☠ DEATH ☠');
        }
      } else if (ph === 'death') {
        updateEnemies();
        updateDeath();
        updateBoneHands();
      }

      // Sync HP from ref (not stale state)
      stickRef.current.health = hpRef.current;
    }

    // Particles
    particlesRef.current = particlesRef.current.filter(p => { p.x += p.vx; p.y += p.vy; p.vy += 0.15; p.life--; return p.life > 0; });

    // ── Draw ──
    ctx.fillStyle = '#111111'; ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, GY + 15, CW, CH - GY);
    ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) { ctx.beginPath(); ctx.moveTo(0, GY + 25 + i * 9); ctx.lineTo(CW, GY + 25 + i * 9); ctx.stroke(); }

    // Enemies
    enemiesRef.current.forEach(e => {
      if (e.health <= 0) return;
      drawFighter(ctx, e, timeRef.current, e.color, e.scale);
      drawHPBar(ctx, e.x, e.y - 55 * e.scale - 12, e.health, e.maxHealth, 30 * e.scale);
    });

    // DEATH
    if (deathRef.current && deathRef.current.health > 0) drawDeath(ctx, deathRef.current, timeRef.current);

    // Bone hands
    if (boneHandsRef.current.length > 0) drawBoneHands(ctx, boneHandsRef.current, stickRef.current.x, stickRef.current.y);

    // Player
    drawFighter(ctx, stickRef.current, timeRef.current, playerColor);
    drawHPBar(ctx, stickRef.current.x, stickRef.current.y - 78, playerHp, 100, 50);

    // Grab indicator
    if (grabbedRef.current) {
      ctx.fillStyle = 'rgba(239,68,68,0.15)';
      ctx.fillRect(0, 0, CW, CH);
      ctx.fillStyle = '#ef4444'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center';
      ctx.fillText('GRABBED!', stickRef.current.x, stickRef.current.y - 90);
    }

    // Particles
    particlesRef.current.forEach(p => { ctx.fillStyle = p.color; ctx.globalAlpha = Math.min(p.life / 35, 1); ctx.fillRect(p.x - 2, p.y - 2, 4, 4); });
    ctx.globalAlpha = 1;

    animRef.current = requestAnimationFrame(gameLoop);
  }, [showAnnounce, updatePlayer, updateEnemies, updateDeath, updateBoneHands]);

  // ── Input ──
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Spacebar','q','Q','e','E'].includes(e.key)) e.preventDefault();
    keysRef.current.add(e.key);
    if (phaseRef.current === 'wave1' || phaseRef.current === 'wave2' || phaseRef.current === 'wave3' || phaseRef.current === 'death') {
      if (e.key.toLowerCase() === 'q') performAttack('punch');
      if (e.key.toLowerCase() === 'e') performAttack('kick');
    }
    if (e.key === '?') setShowHelp(s => !s);
  }, [performAttack]);

  const handleKeyUp = useCallback((e: KeyboardEvent) => { keysRef.current.delete(e.key); }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (phaseRef.current !== 'wave1' && phaseRef.current !== 'wave2' && phaseRef.current !== 'wave3' && phaseRef.current !== 'death') return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = (e.clientX - rect.left) * (CW / rect.width);
    stickRef.current.facing = cx > stickRef.current.x ? 1 : -1;
    performAttack(e.button === 2 ? 'kick' : 'punch');
  }, [performAttack]);

  // ── Lifecycle ──
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    animRef.current = requestAnimationFrame(gameLoop);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [handleKeyDown, handleKeyUp, gameLoop]);

  const restart = () => {
    setPhase('wave1'); phaseRef.current = 'wave1';
    setAnnounce('WAVE 1'); setAnnounceTimer(180);
    setScore(0); setPlayerHp(100); setShowHelp(true);
    stickRef.current = { x: 200, y: GY, vx: 0, vy: 0, facing: 1, state: 'idle', animTime: 0, health: 100, maxHealth: 100 };
    enemiesRef.current = []; deathRef.current = null; boneHandsRef.current = []; particlesRef.current = [];
    atkCdRef.current = 0; waveTimerRef.current = 0; tankSpawnRef.current = 0; necroSpawnRef.current = 0;
    grabbedRef.current = false; hpRef.current = 100; announceTimerRef.current = 180;
    setPlayerColor('#6b7280'); setShowColorPicker(false);
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Header */}
      <div className="border-b border-gray-800 bg-gray-900/80 backdrop-blur">
        <div className="max-w-6xl mx-auto px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-gray-500 to-gray-600 flex items-center justify-center"><span className="font-mono text-xl font-bold">S</span></div>
            <div>
              <div className="font-semibold text-2xl tracking-tighter">Boss Rush</div>
              <div className="text-xs text-gray-500 -mt-1">{phase === 'wave1' ? 'Wave 1 — Warm Up' : phase === 'wave2' ? 'Wave 2 — Survival' : phase === 'wave3' ? 'Wave 3 — Elite' : phase === 'death' ? '☠ DEATH' : phase === 'victory' ? 'DEMO COMPLETE' : 'GAME OVER'}</div>
            </div>
          </div>
          <div className="flex items-center gap-6 text-sm">
            <div className="relative">
              <button onClick={() => setShowColorPicker(s => !s)} className="w-8 h-8 rounded-full border-2 border-gray-600 hover:border-gray-400 transition-colors" style={{ backgroundColor: playerColor }} title="Pick Color" />
              {showColorPicker && (
                <div className="absolute top-10 right-0 bg-gray-900 border border-gray-700 rounded-xl p-3 flex gap-2 z-50">
                  {['#6b7280','#ef4444','#f59e0b','#22c55e','#3b82f6','#8b5cf6','#ec4899','#06b6d4','#f97316','#ffffff'].map(c => (
                    <button key={c} onClick={() => { setPlayerColor(c); setShowColorPicker(false); }} className="w-7 h-7 rounded-full border-2 hover:scale-110 transition-transform" style={{ backgroundColor: c, borderColor: playerColor === c ? '#ffffff' : '#374151' }} />
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-col items-center"><span className="text-gray-400 text-xs">HP</span><span className="font-mono text-lg font-semibold text-red-400">{playerHp}/100</span></div>
            <div className="flex flex-col items-center"><span className="text-gray-400 text-xs">SCORE</span><span className="font-mono text-lg font-semibold text-amber-400">{score}</span></div>
            <button onClick={restart} className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-xs font-medium">RESTART</button>
          </div>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="relative">
          <canvas ref={canvasRef} width={CW} height={CH}
            className="rounded-2xl border border-gray-800 shadow-2xl cursor-crosshair bg-gray-950"
            onMouseDown={handleMouseDown} onContextMenu={e => e.preventDefault()} />

          {/* Wave announcement */}
          {announceTimer > 0 && (phase === 'wave1' || phase === 'wave2' || phase === 'wave3' || phase === 'death') && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-6xl font-black tracking-wider drop-shadow-2xl"
                style={{ opacity: Math.min(announceTimer / 30, 1), color: phase === 'death' ? '#dc2626' : '#f59e0b', textShadow: '0 0 40px rgba(0,0,0,0.8)' }}>
                {announce}
              </div>
            </div>
          )}

          {/* Help */}
          {showHelp && (phase === 'wave1' || phase === 'wave2' || phase === 'wave3' || phase === 'death') && (
            <div className="absolute top-4 right-4 bg-gray-900/95 border border-gray-700 rounded-xl p-5 w-64 text-sm backdrop-blur">
              <div className="font-semibold mb-3 flex justify-between">CONTROLS <button onClick={() => setShowHelp(false)} className="text-gray-400 hover:text-white">✕</button></div>
              <div className="space-y-1.5 text-gray-300 font-mono text-xs">
                <div className="flex justify-between"><span>A/D or ← →</span><span className="text-gray-500">MOVE</span></div>
                <div className="flex justify-between"><span>SPACE</span><span className="text-gray-500">JUMP</span></div>
                <div className="flex justify-between"><span>CLICK / Q</span><span className="text-gray-500">PUNCH (18 dmg)</span></div>
                <div className="flex justify-between"><span>RCLICK / E</span><span className="text-gray-500">KICK (28 dmg)</span></div>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-800 text-[10px] text-gray-500">
                Survive 3 waves → Kill DEATH to complete the demo
              </div>
            </div>
          )}

          {/* Victory */}
          {phase === 'victory' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70 rounded-2xl">
              <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 text-center space-y-4">
                <div className="text-4xl font-black text-gray-300">🏆 DEMO COMPLETE</div>
                <div className="text-gray-300 text-lg">You defeated DEATH!</div>
                <div className="text-gray-400">Final Score: {score}</div>
                <div className="text-xs text-gray-500 mt-2">Thanks for playing the demo. More waves coming soon!</div>
                <button onClick={restart} className="px-8 py-3 rounded-xl bg-gradient-to-r from-gray-600 to-gray-500 hover:from-gray-500 hover:to-gray-400 font-bold text-lg transition-all mt-2">
                  Play Again
                </button>
              </div>
            </div>
          )}

          {/* Game Over */}
          {phase === 'gameOver' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70 rounded-2xl">
              <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 text-center space-y-4">
                <div className="text-4xl font-black text-gray-300">💀 DEFEATED</div>
                <div className="text-gray-400">Score: {score}</div>
                <button onClick={restart} className="px-8 py-3 rounded-xl bg-gradient-to-r from-gray-600 to-gray-500 hover:from-gray-500 hover:to-gray-400 font-bold text-lg transition-all mt-2">
                  Try Again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom */}
      <div className="border-t border-gray-800 py-3 px-8 text-center text-xs text-gray-500 font-mono">
        Wave 1: 20s grunts • Wave 2: 30s tanks & necros • Wave 3: bosses + DEATH • Beat DEATH to win
      </div>
    </div>
  );
}
