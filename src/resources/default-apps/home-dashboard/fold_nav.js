window.FoldNav = {
  bind(app) {
    [['fold-prev', 'prev'], ['fold-next', 'next']].forEach(([id, dir]) => {
      const el = document.getElementById(id);
      el.addEventListener('mouseenter', () => !el.classList.contains('disabled') && el.classList.add('peeling'));
      el.addEventListener('mouseleave', () => el.classList.remove('peeling'));
      el.addEventListener('click', (e) => {
        e.preventDefault();
        if (!el.classList.contains('disabled')) app.turn(dir);
      });
    });
  }
};