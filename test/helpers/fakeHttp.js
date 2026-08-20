'use strict';

/** Minimal req/res doubles exposing only what utils/webApiCompat.js touches. */
function fakeReq(accept) {
  return { headers: accept === undefined ? {} : { accept } };
}

function fakeRes() {
  const state = { statusCode: null, contentType: null, body: undefined };
  const res = {
    status(code) {
      state.statusCode = code;
      return res;
    },
    type(value) {
      state.contentType = value;
      return res;
    },
    send(payload) {
      state.body = payload;
      return res;
    },
    state
  };
  return res;
}

module.exports = { fakeReq, fakeRes };
