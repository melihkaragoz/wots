'use strict';

// ── Sound Effects Engine (Web Audio API) ─────────────────────────────────
// All sounds are synthesized — no external files needed.
const SFX = (() => {
  let ctx = null;
  let masterGain = null;
  let volume = parseFloat(localStorage.getItem('snakeVol') ?? '0.5');
  let muted = localStorage.getItem('snakeMuted') === '1';

  function ensure() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : volume;
    masterGain.connect(ctx.destination);
  }

  // Resume on first user interaction (browser autoplay policy)
  function unlock() {
    ensure();
    if (ctx.state === 'suspended') ctx.resume();
  }
  document.addEventListener('click', unlock, { once: false });
  document.addEventListener('keydown', unlock, { once: false });

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    localStorage.setItem('snakeVol', volume);
    if (masterGain && !muted) masterGain.gain.value = volume;
  }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem('snakeMuted', muted ? '1' : '0');
    if (masterGain) masterGain.gain.value = muted ? 0 : volume;
    return muted;
  }

  // ── Synth helpers ──────────────────────────────────────────────────────
  function osc(type, freq, dur, gainVal, detune) {
    ensure();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    g.gain.setValueAtTime(gainVal, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g); g.connect(masterGain);
    o.start(ctx.currentTime);
    o.stop(ctx.currentTime + dur);
  }

  function noise(dur, gainVal) {
    ensure();
    const bufSize = ctx.sampleRate * dur;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(g); g.connect(masterGain);
    src.start(); src.stop(ctx.currentTime + dur);
  }

  function sweep(type, startFreq, endFreq, dur, gainVal) {
    ensure();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(startFreq, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(endFreq, ctx.currentTime + dur);
    g.gain.setValueAtTime(gainVal, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g); g.connect(masterGain);
    o.start(); o.stop(ctx.currentTime + dur);
  }

  // ── Sound library ──────────────────────────────────────────────────────

  function eatFruit() {
    osc('sine', 520, 0.08, 0.25);
    setTimeout(() => osc('sine', 680, 0.08, 0.2), 50);
  }

  function eatSoul() {
    osc('sine', 400, 0.12, 0.3);
    setTimeout(() => osc('sine', 600, 0.12, 0.25), 60);
    setTimeout(() => osc('sine', 900, 0.15, 0.25), 130);
  }

  function death() {
    // Soft descending tone — gentle sine sweep + quiet triangle undertone
    sweep('sine', 440, 140, 0.45, 0.2);
    setTimeout(() => osc('triangle', 180, 0.3, 0.08), 80);
    setTimeout(() => osc('sine', 120, 0.25, 0.06), 200);
  }

  function kill() {
    osc('square', 180, 0.08, 0.2);
    setTimeout(() => osc('square', 260, 0.1, 0.2), 60);
    setTimeout(() => osc('square', 380, 0.12, 0.18), 130);
  }

  function respawn() {
    sweep('sine', 300, 800, 0.3, 0.2);
    setTimeout(() => osc('sine', 800, 0.15, 0.15), 250);
  }

  function bombThrow() {
    sweep('sine', 600, 200, 0.2, 0.2);
    noise(0.08, 0.1);
  }

  function bombExplode() {
    noise(0.5, 0.4);
    sweep('sawtooth', 120, 30, 0.5, 0.35);
    setTimeout(() => noise(0.3, 0.2), 100);
  }

  function mineHit() {
    noise(0.3, 0.35);
    sweep('square', 200, 50, 0.3, 0.25);
  }

  function boostOn() {
    sweep('sine', 300, 600, 0.15, 0.12);
  }

  function boostOff() {
    sweep('sine', 500, 250, 0.12, 0.08);
  }

  function countdownTick() {
    osc('sine', 880, 0.1, 0.2);
  }

  function countdownGo() {
    osc('sine', 660, 0.1, 0.25);
    setTimeout(() => osc('sine', 880, 0.15, 0.25), 80);
    setTimeout(() => osc('sine', 1100, 0.2, 0.25), 170);
  }

  function matchStart() {
    osc('sine', 440, 0.1, 0.2);
    setTimeout(() => osc('sine', 554, 0.1, 0.2), 100);
    setTimeout(() => osc('sine', 660, 0.1, 0.2), 200);
    setTimeout(() => osc('sine', 880, 0.25, 0.25), 300);
  }

  function matchEnd() {
    osc('sine', 660, 0.15, 0.2);
    setTimeout(() => osc('sine', 554, 0.15, 0.2), 150);
    setTimeout(() => osc('sine', 440, 0.15, 0.2), 300);
    setTimeout(() => osc('sine', 330, 0.4, 0.2), 450);
  }

  function uiClick() {
    osc('sine', 700, 0.04, 0.1);
  }

  function uiOpen() {
    sweep('sine', 400, 700, 0.1, 0.1);
  }

  function uiClose() {
    sweep('sine', 600, 350, 0.08, 0.08);
  }

  function chat() {
    osc('sine', 1000, 0.04, 0.07);
    setTimeout(() => osc('sine', 1200, 0.04, 0.06), 30);
  }

  function shield() {
    sweep('sine', 500, 1200, 0.2, 0.15);
    osc('triangle', 1200, 0.15, 0.1);
  }

  function invisibility() {
    sweep('sine', 800, 300, 0.3, 0.12);
    osc('sine', 300, 0.2, 0.08);
  }

  function dash() {
    sweep('sawtooth', 200, 800, 0.12, 0.15);
    noise(0.06, 0.1);
  }

  function goldEarned() {
    osc('sine', 800, 0.08, 0.15);
    setTimeout(() => osc('sine', 1000, 0.08, 0.15), 70);
    setTimeout(() => osc('sine', 1200, 0.12, 0.15), 140);
  }

  function error() {
    osc('square', 200, 0.15, 0.15);
    setTimeout(() => osc('square', 150, 0.2, 0.12), 120);
  }

  // ── Public API ─────────────────────────────────────────────────────────
  return {
    setVolume, toggleMute, getVolume: () => volume, isMuted: () => muted,
    eatFruit, eatSoul, death, kill, respawn,
    bombThrow, bombExplode, mineHit,
    boostOn, boostOff,
    countdownTick, countdownGo, matchStart, matchEnd,
    uiClick, uiOpen, uiClose, chat,
    shield, invisibility, dash,
    goldEarned, error,
  };
})();
