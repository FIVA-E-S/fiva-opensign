import assert from 'node:assert/strict';
import test from 'node:test';

import DocumentBeforesave from '../cloud/parsefunction/DocumentBeforesave.js';

for (const original of [undefined, {}]) {
  test(`a non-master request cannot set the sender brand: update=${Boolean(original)}`, async t => {
    const previousParse = globalThis.Parse;
    class ParseError extends Error {
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    }
    ParseError.OPERATION_FORBIDDEN = 119;
    globalThis.Parse = { Error: ParseError };
    t.after(() => { globalThis.Parse = previousParse; });
    await assert.rejects(
      DocumentBeforesave({
        master: false,
        original,
        object: { dirty: field => field === 'FivaSenderName' },
      }),
      error => error.code === 119 && error.message === 'FivaSenderName is managed by the server'
    );
  });
}

test('a non-master update cannot replace the Fiva creation correlation key', async t => {
  class ParseError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  ParseError.OPERATION_FORBIDDEN = 119;
  globalThis.Parse = { Error: ParseError };
  t.after(() => {
    delete globalThis.Parse;
  });

  await assert.rejects(
    DocumentBeforesave({
      master: false,
      original: {},
      object: {
        dirty: field => field === 'FivaIdempotencyKey',
      },
    }),
    error =>
      error.code === ParseError.OPERATION_FORBIDDEN &&
      error.message === 'FivaIdempotencyKey is managed by the server'
  );
});
