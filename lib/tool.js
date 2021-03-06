'use strict';

var util = require('util');
var hasOwn = Object.prototype.hasOwnProperty;

exports.setPrivate = function(ctx, key, value) {
  Object.defineProperty(ctx, key, {
    value: value,
    writable: false,
    enumerable: false,
    configurable: false
  });
};

exports.slice = function(args, start) {
  start = start || 0;
  if (start >= args.length) return [];
  var len = args.length, ret = Array(len - start);
  while (len-- > start) ret[len - start] = args[len];
  return ret;
};

exports.log = function(err) {
  if (err == null) return console.log.apply(console, arguments);
  if (!util.isError(err)) return console.error(err);
  var msg = err.stack || err.toString();
  console.error(msg.replace(/^/gm, '  '));
};

exports.each = function(obj, iterator, context, arrayLike) {
  var i, l, key;

  if (!obj) return;
  if (arrayLike == null) arrayLike = Array.isArray(obj);
  if (arrayLike) {
    for (i = 0, l = obj.length; i < l; i++) iterator.call(context, obj[i], i, obj);
  } else {
    for (key in obj) {
      if (hasOwn.call(obj, key)) iterator.call(context, obj[key], key, obj);
    }
  }
};
