// Game rules. server.py holds the same values in RULES and POINTS: it draws every ranked
// round and recomputes its score. Change both sides together.
const DIFFICULTY = Object.freeze({
  duration: 30000,
  spawnDelay: [650, 250],
  targetLifetime: [1300, 550],
  maxTargets: [2, 6],
  popDuration: [200, 100],
  goodChance: [0.60, 0.45],
  comboStep: 4,
  comboMax: 5,
  levels: [10000, 20000],
  urgentTime: 5000,
  countdownStep: 600,
  slots: 12
});
(() => {
  const $ = id => document.getElementById(id);
  const debug = new URLSearchParams(location.search).get('debug') === '1';
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
  function playTones(type, notes, pitch = 1) {
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
        oscillator.frequency.setValueAtTime(from * pitch, startAt);
        oscillator.frequency.exponentialRampToValueAtTime(to * pitch, startAt + duration);
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
    combo: ['sine', [[990, 1320, 0, 0.14]]],
    record: ['sine', [[660, 660, 0, 0.1], [880, 880, 0.1, 0.1], [1320, 1320, 0.2, 0.3]]],
    end: ['sine', [[660, 660, 0, 0.12], [520, 520, 0.12, 0.12], [390, 390, 0.24, 0.3]]]
  };
  function playSound(name, pitch) { playTones(...SOUNDS[name], pitch); }
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
  $('combo-pips').innerHTML = '<i></i>'.repeat(DIFFICULTY.comboStep);
  let running = false, start = 0, raf = 0, score = 0, good = 0, errors = 0, streak = 0, bestStreak = 0, currentLevel = 1, lastDebug = -1, generation = 0, countdown = 0, lastTick = 0;
  // round: { game_id, targets } as drawn by the server; game_id is null for an unranked, locally drawn round.
  let round = null, nextTarget = 0, hits = [], saved = false;
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
  // Same draw as build_targets in server.py, used only when the server cannot be reached.
  function buildTargets() {
    const targets = [];
    for (let at = 0; at < DIFFICULTY.duration;) {
      const d = settings(at);
      if (targets.filter(([from, life]) => from + life > at).length < d.maxTargets) {
        const wantGood = Math.random() < d.goodChance;
        const pool = types.map((t, kind) => kind).filter(kind => (types[kind].points > 0) === wantGood);
        targets.push([at, Math.floor(d.targetLifetime), pool[Math.floor(Math.random()*pool.length)]]);
      }
      at += Math.floor(d.spawnDelay);
    }
    return targets;
  }
  function multiplier() { return Math.min(DIFFICULTY.comboMax, 1 + Math.floor(streak / DIFFICULTY.comboStep)); }
  function showCombo() {
    const level = multiplier(), filled = level === DIFFICULTY.comboMax ? DIFFICULTY.comboStep : streak % DIFFICULTY.comboStep;
    $('multiplier').textContent = `×${level}`; $('combo').dataset.level = level;
    [...$('combo-pips').children].forEach((pip, i) => pip.classList.toggle('on', i < filled));
  }
  function screen(id) { for (const name of ['home','game','end']) $(name).hidden = name !== id; document.body.classList.toggle('playing', id === 'game'); window.scrollTo({ top: 0, behavior: 'instant' }); }
  function remove(slot) { active.delete(slot); slot.replaceChildren(); }
  function spawn(index) {
    const [at, life, kind] = round.targets[index], type = types[kind];
    const free = slots.filter(s => !active.has(s));
    if (!free.length) return;
    const slot = free[Math.floor(Math.random()*free.length)];
    const button = document.createElement('button'); button.className = 'target'; button.style.setProperty('--pop-duration', `${settings(at).popDuration}ms`);
    button.setAttribute('aria-label', type.name); button.dataset.index = index; button.innerHTML = Sprites[type.sprite]();
    active.set(slot, { index, expires: at + life, type });
    // pointerdown answers as soon as the finger lands; click remains for the keyboard.
    button.addEventListener('pointerdown', event => { event.preventDefault(); hit(slot); });
    button.addEventListener('click', () => hit(slot)); slot.append(button);
  }
  function hit(slot) {
    // Whole milliseconds: the server replays the round with the very same numbers.
    const at = Math.floor(performance.now() - start);
    if (!running || at < 0) return;
    if (at >= DIFFICULTY.duration) { finish(); return; }
    const target = active.get(slot);
    if (!target) return;
    if (at >= target.expires) { remove(slot); return; }
    const isGood = target.type.points > 0, level = multiplier(), points = isGood ? target.type.points * level : target.type.points;
    score += points; hits.push([target.index, at]);
    if (isGood) { good++; streak++; bestStreak = Math.max(bestStreak, streak); } else { errors++; streak = 0; }
    playSound(isGood ? 'good' : 'bad', isGood ? 1 + (level - 1) * 0.12 : 1); vibrate(isGood ? 12 : [50, 40, 50]);
    $('score').textContent = score; showCombo();
    if (multiplier() > level) { restart($('combo'), 'bump'); playSound('combo', 1 + level * 0.12); }
    const feedback = document.createElement('span'); feedback.className = `feedback ${isGood ? '' : 'negative'}`;
    feedback.textContent = `${isGood ? '+' : '−'}${Math.abs(points)}`;
    feedback.style.left = `${slot.offsetLeft + slot.offsetWidth/2}px`; feedback.style.top = `${slot.offsetTop + slot.offsetHeight/2}px`;
    $('arena').append(feedback); feedback.addEventListener('animationend', () => feedback.remove(), { once: true });
    if (!isGood) restart($('arena'), 'shake');
    remove(slot); slot.classList.remove('hit-good', 'hit-bad'); restart(slot, isGood ? 'hit-good' : 'hit-bad');
  }
  function frame(now) {
    if (!running) return;
    const elapsed = Math.floor(now - start), remaining = Math.max(0, DIFFICULTY.duration-elapsed);
    if (elapsed < 0) {
      const step = Math.ceil(-elapsed / DIFFICULTY.countdownStep);
      if (step !== countdown) { countdown = step; $('countdown').textContent = step; restart($('countdown'), 'announce'); playSound('count'); }
      raf = requestAnimationFrame(frame); return;
    }
    if (countdown) { countdown = 0; $('countdown').textContent = ''; playSound('go'); }
    if (!remaining) { finish(); return; }
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
    for (const [slot,t] of active) { if (elapsed >= t.expires) remove(slot); else if (t.expires-elapsed < 100) slot.firstElementChild?.classList.add('leaving'); }
    for (; nextTarget < round.targets.length && round.targets[nextTarget][0] <= elapsed; nextTarget++) {
      // A target whose time has already passed (tab left in the background) is skipped.
      if (round.targets[nextTarget][0] + round.targets[nextTarget][1] > elapsed) spawn(nextTarget);
    }
    const bucket = Math.floor(elapsed/5000);
    if (debug && bucket !== lastDebug) { lastDebug = bucket; console.debug(`[Spy Rush] ${bucket*5} s`, settings(elapsed)); }
    raf = requestAnimationFrame(frame);
  }
  const saved0 = Leaderboard.getPlayer(); $('first-name').value = saved0.first; $('last-name').value = saved0.last;
  function playerName() { return Leaderboard.fullName($('first-name').value, $('last-name').value); }
  async function play() {
    if (!playerName()) {
      screen('home'); $('name-error').textContent = 'Indiquez votre prénom et votre nom (lettres, espaces, tirets et apostrophes ; 40 caractères au plus).';
      $('first-name').focus(); return;
    }
    $('name-error').textContent = '';
    prepareAudio();
    Leaderboard.setPlayer($('first-name').value, $('last-name').value);
    cancelAnimationFrame(raf); const version = ++generation; running = false; round = null; saved = false; hits = []; nextTarget = 0;
    score = good = errors = streak = bestStreak = 0; currentLevel = 1; lastDebug = -1; countdown = 0; lastTick = 0;
    for (const slot of slots) { remove(slot); slot.classList.remove('hit-good', 'hit-bad'); } document.querySelectorAll('.feedback').forEach(e => e.remove());
    $('score').textContent = '0'; $('timer').textContent = '30.0'; $('level').textContent = 'NIVEAU 1'; $('game').dataset.level = '1'; $('game').classList.remove('urgent'); $('arena').classList.remove('shake'); $('countdown').textContent = '';
    $('level-banner').classList.remove('announce'); $('level-banner').textContent = ''; $('time-bar').style.width = '100%'; showCombo();
    $('unranked').hidden = true; screen('game');
    let drawn;
    try { drawn = await Leaderboard.startGame(); } catch { drawn = { game_id: null, targets: buildTargets() }; }
    if (version !== generation) return;
    round = drawn; $('unranked').hidden = Boolean(round.game_id);
    running = true; start = performance.now() + 3 * DIFFICULTY.countdownStep; raf = requestAnimationFrame(frame);
  }
  function quit() { running = false; generation++; cancelAnimationFrame(raf); for (const slot of slots) remove(slot); screen('home'); }
  const verdicts = [
    [3000, 'Mission accomplie.', 'Beau sang-froid. Le prochain palier se joue sur les séries sans erreur.'],
    [0, 'Mission remplie.', 'Enchaînez les bons clics sans erreur pour faire monter le multiplicateur.'],
    [-Infinity, 'Couverture grillée.', 'Un mauvais clic coûte plus qu’un bon n’en rapporte. Mieux vaut laisser passer une cible douteuse.']
  ];
  function finish() {
    running = false; cancelAnimationFrame(raf); playSound('end'); for (const slot of slots) remove(slot);
    const [, title, advice] = verdicts.find(([floor]) => score >= floor);
    $('end-title').textContent = title; $('end-advice').textContent = advice;
    $('final-score').textContent = score; $('good-clicks').textContent = good; $('errors').textContent = errors; $('accuracy').textContent = `${good+errors ? Math.round(good/(good+errors)*100) : 0} %`; $('best-streak').textContent = bestStreak;
    $('record').hidden = true; $('standing').textContent = ''; $('save').hidden = true;
    screen('end'); saveScore();
  }
  async function refreshBoard() {
    const version = generation;
    $('board-status').textContent = 'Chargement…';
    try {
      const rows = await Leaderboard.getRanking();
      if (version !== generation) return;
      $('player-count').textContent = `${rows.length} JOUEUR${rows.length === 1 ? '' : 'S'}`;
      Leaderboard.renderRanking($('leaderboard'), rows);
      $('board-status').textContent = rows.length ? '' : 'Le terrain est libre. Signez le premier score.';
    } catch (error) { if (version === generation) $('board-status').textContent = 'Impossible de charger le classement. Vérifiez la connexion au serveur, puis réessayez.'; }
  }
  async function saveScore() {
    if (saved || !round) return;
    if (!round.game_id) { $('submit-status').textContent = 'Le serveur était injoignable au départ : cette partie ne compte pas au classement.'; refreshBoard(); return; }
    const version = generation; $('save').hidden = true; $('submit-status').textContent = 'Transmission…';
    try {
      const result = await Leaderboard.submitScore(playerName(), round.game_id, hits); if (version !== generation) return;
      saved = true; $('submit-status').textContent = '';
      $('record').hidden = false; $('record').textContent = result.new_best ? 'NOUVEAU RECORD PERSONNEL' : `VOTRE RECORD : ${result.best}`; $('record').classList.toggle('new', result.new_best);
      if (result.new_best) playSound('record');
      const rank = `${result.rank}${result.rank === 1 ? 'er' : 'e'} sur ${result.players} joueur${result.players === 1 ? '' : 's'}`;
      $('standing').textContent = result.gap === null ? `${rank}. Vous tenez la première place.` : `${rank}, à ${result.gap + 1} point${result.gap ? 's' : ''} de la place suivante.`;
    } catch (error) { if (version !== generation) return; $('submit-status').textContent = 'Enregistrement impossible. Vérifiez la connexion au serveur, puis réessayez.'; $('save').hidden = false; }
    await refreshBoard();
  }
  $('save').addEventListener('click', saveScore);
  $('player-form').addEventListener('submit', event => { event.preventDefault(); play(); }); $('replay').addEventListener('click',play); $('retry-game').addEventListener('click',play); $('quit-game').addEventListener('click',quit); $('refresh-board').addEventListener('click',refreshBoard);
  $('mute').addEventListener('click', () => { muted = !muted; try { localStorage.setItem(muteKey, muted ? '1' : '0'); } catch {} showMute(); });
  showMute(); showCombo();
  document.addEventListener('visibilitychange', () => { if (running && performance.now()-start >= DIFFICULTY.duration) finish(); });
  if (debug) window.SpyRushDebug = { settings, buildTargets, types, getState: () => ({ running, score, good, errors, streak, multiplier: multiplier(), active: active.size, hits, round }) };
})();
