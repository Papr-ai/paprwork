// Keep the legacy entry point; browser modules hold the small, isolated views.
import('./ui/controller.js').then(({ mount }) => mount()).catch((error) => {
  document.getElementById('summary').textContent = `Cannot load Outreach Console: ${error.message}`;
});
