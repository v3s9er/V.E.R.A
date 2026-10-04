import { extname, join } from 'node:path';
import express, { type Express } from 'express';

/** HTML selects the hashed client bundle, so it must be fetched after updates. */
export function mountWebUi(app: Express, directory: string): void {
  app.use(express.static(directory, {
    setHeaders(response, path) {
      if (extname(path).toLowerCase() === '.html') response.setHeader('Cache-Control', 'no-store, max-age=0');
    },
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) { next(); return; }
    // An old renderer may request a chunk removed by an update. Never disguise
    // this as a successful HTML response (or an apparently valid JS bundle).
    if (req.path.startsWith('/assets/') || extname(req.path)) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.status(404).type('text/plain').send('Client asset not found. Reload the application.');
      return;
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.sendFile(join(directory, 'index.html'));
  });
}
