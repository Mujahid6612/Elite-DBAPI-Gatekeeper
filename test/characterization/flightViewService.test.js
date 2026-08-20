'use strict';

/**
 * CHARACTERIZATION TEST — services/flightViewService.js.
 *
 * Pins the upstream query string exactly: field order, the leading 1=1, omission of
 * empty values and the deliberate absence of URL encoding (guardrail G10). Any
 * refactor that "helpfully" adds encodeURIComponent will fail here, by design.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const envConfig = require('../../config/env');
const flightViewService = require('../../services/flightViewService');

/** Replaces global fetch, records the requested URL, and returns a canned body. */
function withStubbedFetch(response, run) {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(url);
    return response;
  };
  return Promise.resolve(run(calls)).finally(() => {
    global.fetch = originalFetch;
  });
}

const okXml = (body) => ({ ok: true, status: 200, text: async () => body });

test('builds the query in the fixed field order after the literal 1=1', async () => {
  await withStubbedFetch(okXml('<r/>'), async (calls) => {
    await flightViewService.fetchFlightView({
      SIMPLESTATUS: 'S',
      AL: 'AA',
      ARRHR: '10',
      ARRDATE: '2026-08-19',
      ARRAP: 'JFK',
      DEPHR: '08',
      DEPDATE: '2026-08-19',
      DEPAP: 'LAX',
      ACID: 'AA100'
    });
    assert.equal(
      calls[0],
      envConfig.flightViewUrl +
        '1=1&ACID=AA100&DEPAP=LAX&DEPDATE=2026-08-19&DEPHR=08' +
        '&ARRAP=JFK&ARRDATE=2026-08-19&ARRHR=10&AL=AA&SIMPLESTATUS=S',
      'field order must follow FLIGHT_QUERY_FIELDS, not the caller object order'
    );
  });
});

test('omits absent and empty fields but keeps 1=1', async () => {
  await withStubbedFetch(okXml('<r/>'), async (calls) => {
    await flightViewService.fetchFlightView({ ACID: 'AA100', DEPAP: '', ARRAP: '   ' });
    // fixNullString trims, so a whitespace-only value is treated as empty.
    assert.equal(calls[0], `${envConfig.flightViewUrl}1=1&ACID=AA100`);
  });

  await withStubbedFetch(okXml('<r/>'), async (calls) => {
    await flightViewService.fetchFlightView({});
    assert.equal(calls[0], `${envConfig.flightViewUrl}1=1`);
  });
});

test('query values are NOT url-encoded — preserved deliberately (G10)', async () => {
  await withStubbedFetch(okXml('<r/>'), async (calls) => {
    await flightViewService.fetchFlightView({ ACID: 'A A&B=C' });
    assert.equal(calls[0], `${envConfig.flightViewUrl}1=1&ACID=A A&B=C`);
  });
});

test('only exact key spellings are read — the match is case-sensitive', async () => {
  await withStubbedFetch(okXml('<r/>'), async (calls) => {
    await flightViewService.fetchFlightView({ acid: 'lower', Acid: 'mixed' });
    assert.equal(calls[0], `${envConfig.flightViewUrl}1=1`, 'lowercase keys must be ignored');
  });
});

test('repeated query parameters are joined with commas', async () => {
  await withStubbedFetch(okXml('<r/>'), async (calls) => {
    await flightViewService.fetchFlightView({ ACID: ['AA1', 'AA2'] });
    assert.equal(calls[0], `${envConfig.flightViewUrl}1=1&ACID=AA1,AA2`);
  });
});

test('returns the upstream body verbatim when RESP is not JSON', async () => {
  const xml = '<flights><flight id="1">text</flight></flights>';
  await withStubbedFetch(okXml(xml), async () => {
    assert.equal(await flightViewService.fetchFlightView({}), xml);
    assert.equal(await flightViewService.fetchFlightView({ RESP: 'XML' }), xml);
  });
});

test('RESP=JSON converts using @-prefixed attributes and #text nodes', async () => {
  const xml = '<flights><flight id="1">text</flight></flights>';
  await withStubbedFetch(okXml(xml), async () => {
    const result = await flightViewService.fetchFlightView({ RESP: 'JSON' });
    assert.equal(result, JSON.stringify({ flights: { flight: { '#text': 'text', '@id': '1' } } }));
  });
});

test('RESP matching is case-insensitive', async () => {
  await withStubbedFetch(okXml('<a>1</a>'), async () => {
    assert.equal(await flightViewService.fetchFlightView({ RESP: 'json' }), '{"a":"1"}');
    assert.equal(await flightViewService.fetchFlightView({ RESP: 'Json' }), '{"a":"1"}');
  });
});

test('RESP=JSON keeps numeric-looking values as strings', async () => {
  await withStubbedFetch(okXml('<a><n>0012</n></a>'), async () => {
    const result = await flightViewService.fetchFlightView({ RESP: 'JSON' });
    assert.equal(result, '{"a":{"n":"0012"}}', 'parseTagValue:false must be preserved');
  });
});

test('a non-ok upstream response throws the .NET-style status message', async () => {
  await withStubbedFetch({ ok: false, status: 503, text: async () => '' }, async () => {
    await assert.rejects(() => flightViewService.fetchFlightView({}), {
      message: 'Response status code does not indicate success: 503.'
    });
  });
});
