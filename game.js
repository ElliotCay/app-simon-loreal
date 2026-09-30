const DIFFICULTY = Object.freeze({
  duration: 30000,
  spawnDelay: [650, 250],
  targetLifetime: [1300, 550],
  maxTargets: [2, 6],
  popDuration: [200, 100],
  goodChance: [0.60, 0.45],
  levels: [10000, 20000],
  urgentTime: 5000,
  countdownStep: 600,
  slots: 12
});
(() => {
  const $ = id => document.getElementById(id);
  const debug = new URLSearchParams(location.search).get('debug') === '1';
  function createAttemptId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }
  let audioContext;
  function prepareAudio() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return null;
      if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContext();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      return audioContext;
    } catch { return null; }
  }
  const muteKey = 'spy-rush-muted-v1';
  let muted = false;
  try { muted = localStorage.getItem(muteKey) === '1'; } catch {}
  function playTones(type, notes) {
    if (muted) return;
    const context = prepareAudio();
    if (!context) return;
    try {
      // Short, softly enveloped tones keep rapid clicks comfortable.
      for (const [from, to, delay, duration] of notes) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const startAt = context.currentTime + delay;
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(from, startAt);
        oscillator.frequency.exponentialRampToValueAtTime(to, startAt + duration);
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(0.09, startAt + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(startAt);
        oscillator.stop(startAt + duration + 0.01);
      }
    } catch { /* Audio availability must never interrupt a round. */ }
  }
  const SOUNDS = {
    good: ['sine', [[660, 880, 0, 0.12], [880, 1100, 0.08, 0.16]]],
    bad: ['triangle', [[220, 90, 0, 0.23]]],
    count: ['sine', [[440, 440, 0, 0.09]]],
    go: ['sine', [[880, 880, 0, 0.2]]],
    tick: ['square', [[1200, 1200, 0, 0.03]]],
    end: ['sine', [[660, 660, 0, 0.12], [520, 520, 0.12, 0.12], [390, 390, 0.24, 0.3]]]
  };
  function playSound(name) { playTones(...SOUNDS[name]); }
  function vibrate(pattern) { try { navigator.vibrate?.(pattern); } catch {} }
  function showMute() {
    $('mute').textContent = muted ? 'SON COUPÉ' : 'SON ACTIF';
    $('mute').setAttribute('aria-pressed', String(muted));
  }
  function restart(element, name) { element.classList.remove(name); void element.offsetWidth; element.classList.add(name); }
  const types = [
    { sprite: 'agentWithBadge', name: 'Agent avec badge', short: 'Seulement les bonnes personnes accèdent aux bons endroits', points: 100 },
    { sprite: 'doorClosed', name: 'Salle métier fermée', short: 'Objets de valeur ou confidentiels sécurisés', points: 100 },
    { sprite: 'emergencyPhone', name: 'Téléphone d’urgence', short: 'Le numéro d’urgence est au dos du badge, l’enregistrer ou l’appeler en cas d’urgence', points: 100 },
    { sprite: 'agentNoBadge', name: 'Agent sans badge', short: '', points: -150 },
    { sprite: 'doorOpen', name: 'Salle métier ouverte', short: '', points: -150 },
    { sprite: 'thief', name: 'Voleur', short: '', points: -200 }
  ];
  $('target-guide').innerHTML = types.map(t => `<div class="guide-card ${t.points > 0 ? 'good' : 'bad'}"><div class="guide-art">${Sprites[t.sprite]()}</div><div class="guide-copy"><strong>${t.name}</strong>${t.short ? `<span>${t.short}</span>` : ''}</div><b>${t.points > 0 ? '+' : '−'}${Math.abs(t.points)}</b></div>`).join('');
  let running = false, start = 0, nextSpawn = 0, raf = 0, score = 0, good = 0, errors = 0, currentLevel = 1, lastDebug = -1, submittedRow = null, generation = 0, attemptId = null, countdown = 0, lastTick = 0;
  const active = new Map();
  const slots = Array.from({ length: DIFFICULTY.slots }, () => {
    const slot = document.createElement('div'); slot.className = 'slot'; $('arena').append(slot); return slot;
  });
  function settings(elapsed) {
    const p = Math.min(1, Math.max(0, elapsed / DIFFICULTY.duration));
    const curve = p * p;
    const values = { p };
    for (const field of ['spawnDelay','targetLifetime','maxTargets','popDuration','goodChance']) {
      const [a,b] = DIFFICULTY[field]; values[field] = a + (b-a) * curve;
    }
    values.maxTargets = Math.round(values.maxTargets);
    return values;
  }
  function screen(id) { for (const name of ['home','game','end']) $(name).hidden = name !== id; document.body.classList.toggle('playing', id === 'game'); window.scrollTo({ top: 0, behavior: 'instant' }); }
  function remove(slot) { active.delete(slot); slot.replaceChildren(); }
  function spawn(now, d) {
    if (active.size >= d.maxTargets) return;
    const free = slots.filter(s => !active.has(s));
    const slot = free[Math.floor(Math.random()*free.length)];
    const pool = Math.random() < d.goodChance ? types.filter(t => t.points > 0) : types.filter(t => t.points < 0);
    const type = pool[Math.floor(Math.random()*pool.length)];
    const button = document.createElement('button'); button.className = 'target'; button.style.setProperty('--pop-duration', `${d.popDuration}ms`);
    button.setAttribute('aria-label', type.name); button.innerHTML = Sprites[type.sprite]();
    active.set(slot, { expires: now + d.targetLifetime, type });
    // pointerdown answers as soon as the finger lands; click remains for the keyboard.
    button.addEventListener('pointerdown', event => { event.preventDefault(); hit(slot); });
    button.addEventListener('click', () => hit(slot)); slot.append(button);
  }
  function hit(slot) {
    const now = performance.now();
    if (!running) return;
    if (now < start) return;
    if (now - start >= DIFFICULTY.duration) { finish(); return; }
    const target = active.get(slot);
    if (!target) return;
    if (now >= target.expires) { remove(slot); return; }
    score += target.type.points;
    const isGood = target.type.points > 0;
    playSound(isGood ? 'good' : 'bad'); vibrate(isGood ? 12 : [50, 40, 50]);
    isGood ? good++ : errors++;
    $('score').textContent = score;
    const feedback = document.createElement('span'); feedback.className = `feedback ${target.type.points < 0 ? 'negative' : ''}`;
    feedback.textContent = `${target.type.points > 0 ? '+' : '−'}${Math.abs(target.type.points)}`;
    feedback.style.left = `${slot.offsetLeft + slot.offsetWidth/2}px`; feedback.style.top = `${slot.offsetTop + slot.offsetHeight/2}px`;
    $('arena').append(feedback); feedback.addEventListener('animationend', () => feedback.remove(), { once: true });
    if (!isGood) restart($('arena'), 'shake');
    remove(slot); slot.classList.remove('hit-good', 'hit-bad'); restart(slot, isGood ? 'hit-good' : 'hit-bad');
  }
  function frame(now) {
    if (!running) return;
    const elapsed = now - start, remaining = Math.max(0, DIFFICULTY.duration-elapsed);
    if (elapsed < 0) {
      const step = Math.ceil(-elapsed / DIFFICULTY.countdownStep);
      if (step !== countdown) { countdown = step; $('countdown').textContent = step; restart($('countdown'), 'announce'); playSound('count'); }
      raf = requestAnimationFrame(frame); return;
    }
    if (countdown) { countdown = 0; $('countdown').textContent = ''; playSound('go'); }
    if (!remaining) { if (debug) console.debug('[Spy Rush] 30 s', settings(DIFFICULTY.duration)); finish(); return; }
    const d = settings(elapsed);
    $('timer').textContent = (remaining/1000).toFixed(1);
    $('time-bar').style.width = `${remaining/DIFFICULTY.duration*100}%`;
    $('game').classList.toggle('urgent', remaining <= DIFFICULTY.urgentTime);
    const second = Math.ceil(remaining / 1000);
    if (remaining <= DIFFICULTY.urgentTime && second !== lastTick) { lastTick = second; playSound('tick'); }
    const level = 1 + DIFFICULTY.levels.filter(t => elapsed >= t).length;
    if (level !== currentLevel) {
      currentLevel = level; $('level').textContent = `NIVEAU ${level}`; $('game').dataset.level = level;
      $('level-banner').textContent = `NIVEAU ${level}`; restart($('level-banner'), 'announce');
    }
    for (const [slot,t] of active) { if (now >= t.expires) remove(slot); else if (t.expires-now < 100) slot.firstElementChild?.classList.add('leaving'); }
    if (now >= nextSpawn) { spawn(now,d); nextSpawn = now + d.spawnDelay; }
    const bucket = Math.floor(elapsed/5000);
    if (debug && bucket !== lastDebug) { lastDebug = bucket; console.debug(`[Spy Rush] ${bucket*5} s`,d); }
    raf = requestAnimationFrame(frame);
  }
  $('player-name').value = Leaderboard.getPlayer();
  function play() {
    const player = $('player-name').value.trim();
    if (!player || player.length > 16) { $('player-name').focus(); return; }
    prepareAudio();
    Leaderboard.setPlayer(player); $('name').value = player;
    cancelAnimationFrame(raf); generation++; running = true; score = good = errors = 0; currentLevel = 1; lastDebug = -1; countdown = 0; lastTick = 0; submittedRow = null; attemptId = createAttemptId();
    for (const slot of slots) { remove(slot); slot.classList.remove('hit-good', 'hit-bad'); } document.querySelectorAll('.feedback').forEach(e => e.remove());
    $('score').textContent = '0'; $('timer').textContent = '30.0'; $('level').textContent = 'NIVEAU 1'; $('game').dataset.level = '1'; $('game').classList.remove('urgent'); $('arena').classList.remove('shake'); $('countdown').textContent = '';
    $('level-banner').classList.remove('announce'); $('level-banner').textContent = ''; $('time-bar').style.width = '100%';
    $('save').disabled = false; $('name').disabled = false; $('submit-status').textContent = ''; screen('game');
    start = performance.now() + 3 * DIFFICULTY.countdownStep; nextSpawn = start; raf = requestAnimationFrame(frame);
  }
  function quit() { running = false; generation++; cancelAnimationFrame(raf); for (const slot of slots) remove(slot); screen('home'); }
  function finish() {
    running = false; cancelAnimationFrame(raf); playSound('end'); for (const slot of slots) remove(slot);
    $('final-score').textContent = score; $('good-clicks').textContent = good; $('errors').textContent = errors; $('accuracy').textContent = `${good+errors ? Math.round(good/(good+errors)*100) : 0} %`;
    screen('end'); saveScore();
  }
  async function refreshBoard() {
    const version = generation;
    $('board-mode').textContent = '● TOUTES LES TENTATIVES · CLASSEMENT PARTAGÉ';
    $('board-status').textContent = 'Chargement…'; $('leaderboard').replaceChildren();
    try {
      const rows = await Leaderboard.getAttempts();
      if (version !== generation) return;
      $('attempt-count').textContent = `${rows.length} TENTATIVE${rows.length === 1 ? '' : 'S'}`;
      for (const [i,row] of rows.entries()) {
        const tr = document.createElement('tr');
        if (row.is_mine) tr.className = 'player-row';
        for (const value of [String(i+1).padStart(2,'0'), row.name + (row.is_mine ? ' · Vous' : ''), row.score]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
        $('leaderboard').append(tr);
      }
      $('board-status').textContent = rows.length ? '' : 'Le terrain est libre. Signez le premier score.';
    } catch (error) { if (version === generation) $('board-status').textContent = 'Impossible de charger le classement. Vérifiez la connexion au serveur, puis réessayez.'; }
  }
  async function saveScore() { if (submittedRow || $('save').disabled) return;
    const name = $('name').value.trim(); if (!name) { $('submit-status').textContent = 'Entrez un nom de code (1 à 16 caractères).'; return; }
    Leaderboard.setPlayer(name); $('player-name').value = name;
    const version = generation; $('save').disabled = true; $('name').disabled = true; $('submit-status').textContent = 'Transmission…';
    try {
      const row = await Leaderboard.submitScore(name,score,attemptId); if (version !== generation) return;
      submittedRow = row; $('submit-status').textContent = 'Partie enregistrée dans le classement partagé.'; await refreshBoard();
    } catch (error) { if (version !== generation) return; $('submit-status').textContent = 'Enregistrement impossible. Vérifiez la connexion au serveur, puis réessayez.'; $('save').disabled = false; $('name').disabled = false; await refreshBoard(); }
  }
  $('score-form').addEventListener('submit', event => { event.preventDefault(); saveScore(); });
  $('player-form').addEventListener('submit', event => { event.preventDefault(); play(); }); $('replay').addEventListener('click',play); $('retry-game').addEventListener('click',play); $('quit-game').addEventListener('click',quit); $('refresh-board').addEventListener('click',refreshBoard);
  $('mute').addEventListener('click', () => { muted = !muted; try { localStorage.setItem(muteKey, muted ? '1' : '0'); } catch {} showMute(); });
  showMute();
  document.addEventListener('visibilitychange', () => { if (running && performance.now()-start >= DIFFICULTY.duration) finish(); });
  if (debug) window.SpyRushDebug = { settings, types, getState: () => ({ running, score, good, errors, active: active.size }) };
})();
