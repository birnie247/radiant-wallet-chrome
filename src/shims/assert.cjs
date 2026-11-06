/**
 * Minimal `assert` for the browser build — CommonJS on purpose.
 *
 * radiantjs calls assertions on hot paths, e.g.
 *   encoding/bufferwriter.js:   var assert = require('assert'); assert(Buffer.isBuffer(buf))
 *   hdprivatekey.js:            assert(Buffer.isBuffer(buff), name + " argument is not a buffer")
 *
 * Vite externalizes Node's `assert` to an EMPTY module in a browser build, so
 * `assert(...)` throws "assert is not a function" — and in this codebase that
 * happens while building an HD private key and while SERIALISING A TRANSACTION,
 * i.e. exactly when signing. It is not a cosmetic warning.
 *
 * This file is .cjs rather than .ts because the library does
 * `var assert = require('assert')` and then CALLS the result. An ES module
 * would hand it a namespace object (not callable); module.exports = fn is the
 * only shape that works through the CommonJS interop.
 */

"use strict";

function AssertionError(message) {
  this.name = "AssertionError";
  this.message = message || "Assertion failed";
  if (Error.captureStackTrace) Error.captureStackTrace(this, AssertionError);
  else this.stack = new Error(this.message).stack;
}
AssertionError.prototype = Object.create(Error.prototype);
AssertionError.prototype.constructor = AssertionError;

function assert(value, message) {
  if (!value) throw new AssertionError(message);
}

assert.ok = assert;

assert.equal = function (actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual != expected) {
    throw new AssertionError(message || String(actual) + " != " + String(expected));
  }
};

assert.strictEqual = function (actual, expected, message) {
  if (actual !== expected) {
    throw new AssertionError(message || String(actual) + " !== " + String(expected));
  }
};

assert.notEqual = function (actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual == expected) {
    throw new AssertionError(message || String(actual) + " == " + String(expected));
  }
};

assert.notStrictEqual = function (actual, expected, message) {
  if (actual === expected) {
    throw new AssertionError(message || String(actual) + " === " + String(expected));
  }
};

assert.deepEqual = function (actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AssertionError(message || "Values are not deeply equal");
  }
};

assert.fail = function (message) {
  throw new AssertionError(message);
};

assert.AssertionError = AssertionError;
assert["default"] = assert;

module.exports = assert;
