(() => {
  const $ = id => document.getElementById(id);
  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true; $('refresh-board').disabled = true;
    $('board-mode').textContent = '● TOUTES LES TENTATIVES · CLASSEMENT PARTAGÉ';
    $('board-status').textContent = 'Actualisation…';
    try {
      const rows = await Leaderboard.getAttempts();
      const fragment = document.createDocumentFragment();
      for (const [index, row] of rows.entries()) {
        const tr = document.createElement('tr');
        if (row.is_mine) tr.className = 'player-row';
        for (const value of [String(index+1).padStart(2,'0'),row.name + (row.is_mine ? ' · Vous' : ''),row.score,new Date(row.created_at).toLocaleString('fr-FR')]) {
          const td = document.createElement('td'); td.textContent = value; tr.append(td);
        }
        fragment.append(tr);
      }
      $('leaderboard').replaceChildren(fragment);
      $('attempt-count').textContent = `${rows.length} TENTATIVE${rows.length === 1 ? '' : 'S'}`;
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
