import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** Owned synthetic loopback page only. Never starts a browser or a model. */
export async function createBrowserFixture() {
  const path = `/fixture-${randomBytes(12).toString('hex')}`;
  const value = randomBytes(16).toString('hex');
  const receipt = randomBytes(24).toString('hex');
  let submitted = 0, rejected = 0;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === path) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><body><h1>Synthetic owned browser test</h1><form><label>Synthetic value <input aria-label="Synthetic value" autocomplete="off"></label><button>Submit synthetic value</button></form><p id="result">No submission yet.</p><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch(${JSON.stringify(path + '/submit')},{method:'POST',headers:{'Content-Type':'text/plain'},body:document.querySelector('input').value});const d=await r.json();document.getElementById('result').textContent=d.receipt?'TEST_RECEIPT='+d.receipt:'Rejected synthetic input';};</script></body></html>`);
      return;
    }
    if (request.method === 'POST' && request.url === path + '/submit') {
      let body = '', bytes = 0;
      request.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 128) { rejected++; request.destroy(); return; }
        body += chunk.toString('utf8');
      });
      request.on('error', () => {});
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        if (body !== value || submitted !== 0) { rejected++; response.statusCode = 400; response.end('{}'); return; }
        submitted++;
        response.end(JSON.stringify({ receipt }));
      });
      return;
    }
    response.statusCode = 404; response.end('Synthetic route not found');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}${path}`, value,
    expected: `BROWSER_OK=${receipt}`,
    inputSha256: createHash('sha256').update(value).digest('hex'),
    verified: () => submitted === 1 && rejected === 0,
    async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

export const browserSmokeToolAllowed = name => ['browser_open', 'browser_observe', 'browser_click', 'browser_type', 'browser_close', 'native_custom_tool'].includes(name);
export function browserSmokeChecks(facts, toolEvents) {
  const completed = new Set(toolEvents.filter(event => event.status === 'done').map(event => event.name));
  return { fixtureSubmissionVerified: facts.fixtureSubmissionVerified === true,
    browserToolsCompleted: ['browser_open', 'browser_observe', 'browser_type', 'browser_click', 'browser_close'].every(name => completed.has(name)),
    browserOnlyTools: toolEvents.every(event => browserSmokeToolAllowed(event.name)),
    noUnrequestedHelpers: facts.helperCount === 0, fullPermission: facts.effectivePermission === 'full' };
}
