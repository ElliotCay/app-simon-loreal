(() => {
  let session;
  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000)
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
  async function submitScore(name, score, attemptId) {
    name = name.trim();
    if (!name || name.length > 16 || !Number.isInteger(score) || score < -10000 || score > 20000) {
      throw new Error('Pseudo ou score invalide.');
    }
    await ensureSession();
    return request('/api/attempts', { method: 'POST', body: JSON.stringify({ name, score, attempt_id: attemptId }) });
  }
  async function getAttempts() {
    return request('/api/attempts');
  }
  const playerKey = 'spy-rush-player-v1';
  let playerName = '';
  function getPlayer() { try { return localStorage.getItem(playerKey) || playerName; } catch { return playerName; } }
  function setPlayer(name) { playerName = name.trim(); try { localStorage.setItem(playerKey, playerName); } catch {} }
  window.Leaderboard = { submitScore, getAttempts, getPlayer, setPlayer, ensureSession };
})();
