// Certification Tracker Editor app (3.3.0): service worker for the installed editor.
// It doesn't cache anything (the editor always loads fresh from GitHub Pages); it only handles
// clicks on reminder notifications, bringing the editor to the front and opening the reminder.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    const editor = all.find(c => new URL(c.url).pathname.endsWith('/project-management.html'));
    if(editor){
      await editor.focus();
      editor.postMessage({type: 'open-reminder'});
      return;
    }
    await self.clients.openWindow('./project-management.html#reminder');
  })());
});
