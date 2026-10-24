import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errorText } from '../src/narrow.ts';

describe('errorText', () => {
  it('uses Error.message', () => {
    assert.equal(errorText(new Error('oops')), 'oops');
  });

  it('stringifies non-Error throws', () => {
    assert.equal(errorText('boom'), 'boom');
    assert.equal(errorText(null), 'null');
  });

  it('reads message from plain object', () => {
    assert.equal(errorText({ message: 'from object' }), 'from object');
  });

  it('falls back when message is empty', () => {
    assert.ok(errorText({ message: '' }).length > 0);
  });

  it("uses the Error's name when its message is blank", () => {
    assert.equal(errorText(new TypeError('   ')), 'TypeError');
  });

  it('ignores a blank or non-string message on a plain object', () => {
    assert.equal(errorText({ message: '  ' }), '[object Object]');
    assert.equal(errorText({ message: 42 }), '[object Object]');
  });

  it('does not throw on an Error whose message is not a string', () => {
    assert.equal(errorText(Object.assign(new Error('x'), { message: undefined })), 'Error');
    assert.equal(errorText(Object.assign(new RangeError('x'), { message: 42 })), 'RangeError');
  });

  it('does not throw on a value that cannot be stringified', () => {
    assert.equal(errorText(Object.create(null)), 'Unknown error');
  });
});
