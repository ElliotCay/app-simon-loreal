(() => {
  let session;
  async function request(path, options = {}, timeout = 15000) {
    const response = await fetch(path, {
      ...options, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeout)
    });
    if (!response.ok) throw new Error(`Serveur indisponible (${response.status}).`);
    return response.json();
  }
  function ensureSession() {
    if (!session) session = request('/api/session', { method: 'POST', body: '{}' }).catch(error => {
      session = null; throw error;
    });
    return session;
  }
  // The server draws the round; a short timeout keeps the start snappy when it cannot be reached.
  async function startGame() {
    await ensureSession();
    return request('/api/games', { method: 'POST', body: '{}' }, 5000);
  }
  async function submitScore(name, gameId, hits) {
    await ensureSession();
    return request('/api/scores', { method: 'POST', body: JSON.stringify({ name, game_id: gameId, hits }) });
  }
  function getRanking() { return request('/api/scores'); }
  function getPrivacy() { return request('/api/privacy'); }
  const playerKey = 'spy-rush-player-v2';
  async function erase() {
    const result = await request('/api/scores', { method: 'DELETE' });
    session = null; player = { first: '', last: '' };
    try { localStorage.removeItem(playerKey); localStorage.removeItem('spy-rush-player-v1'); } catch {}
    return result;
  }
  // Same rule as the server: letters, with single spaces, hyphens or apostrophes inside.
  const namePart = /^\p{L}+(?:[ '’-]\p{L}+)*$/u;
  function fullName(first, last) {
    first = first.trim().replace(/\s+/g, ' '); last = last.trim().replace(/\s+/g, ' ');
    const name = `${first} ${last}`;
    return namePart.test(first) && namePart.test(last) && name.length <= 40 ? name : '';
  }
  let player = { first: '', last: '' };
  function getPlayer() {
    try { const saved = JSON.parse(localStorage.getItem(playerKey)); if (saved) player = { first: String(saved.first || ''), last: String(saved.last || '') }; } catch {}
    return player;
  }
  function setPlayer(first, last) { player = { first: first.trim(), last: last.trim() }; try { localStorage.setItem(playerKey, JSON.stringify(player)); } catch {} }
  function renderRanking(tbody, rows) {
    const fragment = document.createDocumentFragment();
    for (const [index, row] of rows.entries()) {
      const tr = document.createElement('tr');
      if (row.is_mine) tr.className = 'player-row';
      for (const value of [String(index + 1).padStart(2, '0'), row.name + (row.is_mine ? ' · Vous' : ''), row.score]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      fragment.append(tr);
    }
    tbody.replaceChildren(fragment);
  }
  window.Leaderboard = { startGame, submitScore, getRanking, getPrivacy, erase, fullName, getPlayer, setPlayer, renderRanking, ensureSession };
})();
