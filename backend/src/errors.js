'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (m) => new HttpError(400, m);
const notFound = (what) => new HttpError(404, `${what} not found`);
const conflict = (m) => new HttpError(409, m);
const upstream = (m) => new HttpError(502, m);

// Wrap an async route handler so rejections reach the error middleware.
const wrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { HttpError, badRequest, notFound, conflict, upstream, wrap };
