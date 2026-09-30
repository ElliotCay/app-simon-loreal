(() => {
  const $ = id => document.getElementById(id);
  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true; $('refresh-board').disabled = true;
    $('board-status').textContent = 'Actualisation…';
    try {
      const rows = await Leaderboard.getRanking();
      Leaderboard.renderRanking($('leaderboard'), rows);
      $('player-count').textContent = `${rows.length} JOUEUR${rows.length === 1 ? '' : 'S'}`;
      $('board-status').textContent = rows.length ? '' : 'Aucun score pour le moment. Lancez la première partie !';
      $('updated-at').textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR')} · Actualisation toutes les 15 s`;
    } catch {
      $('board-status').textContent = 'Actualisation impossible. Les résultats affichés peuvent être anciens. Réessayez dans un instant.';
    } finally { loading = false; $('refresh-board').disabled = false; }
  }
  $('refresh-board').addEventListener('click', refresh);
  window.addEventListener('focus', refresh);
  window.addEventListener('storage', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  refresh();
})();
