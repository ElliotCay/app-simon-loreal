(() => {
  const $ = id => document.getElementById(id);
  Leaderboard.getPrivacy().then(info => {
    if (info.controller) $('controller').textContent = info.controller;
    if (info.contact) $('contact').textContent = info.contact;
    if (info.legal_basis) { $('legal-basis').textContent = info.legal_basis; $('legal-basis-block').hidden = false; }
    $('retention').textContent = `${info.retention_days} jours`;
  }).catch(() => {});
  $('erase').addEventListener('click', async () => {
    $('erase').disabled = true; $('erase-status').textContent = 'Suppression…';
    try {
      const { deleted } = await Leaderboard.erase();
      $('erase-status').textContent = deleted
        ? `${deleted} partie${deleted === 1 ? '' : 's'} supprimée${deleted === 1 ? '' : 's'}, ainsi que l’identifiant de ce navigateur.`
        : 'Aucune partie n’était enregistrée depuis ce navigateur. Son identifiant a été supprimé.';
    } catch {
      $('erase-status').textContent = 'Suppression impossible pour le moment. Réessayez dans un instant.';
    } finally { $('erase').disabled = false; }
  });
})();
