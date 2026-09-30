const electron = require('electron');
console.log('[TEST] electron type:', typeof electron);
console.log('[TEST] electron keys:', Object.keys(electron).slice(0, 10));
const { app } = electron;
console.log('[TEST] app:', typeof app);
if (app) {
  console.log('[TEST] app.getName():', app.getName());
  app.quit();
}
