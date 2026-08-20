'use strict';

const http = require('http');

/**
 * Boots an Express app on an ephemeral port for the duration of `run`.
 * Uses node:http rather than fetch so that tests are free to stub global.fetch
 * (services/flightViewService.js calls it for the upstream FlightView feed).
 */
async function withServer(app, run) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          headers: res.headers,
          body: text
        })
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

module.exports = { withServer, request };
