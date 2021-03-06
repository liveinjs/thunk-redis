'use strict';

var net = require('net');
var util = require('util');
var resp = require('respjs');
var Thunk = require('thunks')();

var tool = require('./tool');
var Queue = require('./queue');

exports.initSocket = initSocket;
exports.sendCommand = sendCommand;

function initSocket(redis, options, socketState) {
  var waitForAuth = false;
  var waitForSelect = false;
  var socket = redis._socket = net.createConnection(options);

  socket.setNoDelay(redis._options.noDelay);
  socket.setTimeout(redis._options.timeout);
  socket.setKeepAlive(redis._options.keepAlive);

  socket.pendingWatcher = null;
  socket.redisConnected = false;
  socket.debugMode = redis._options.debugMode;
  socket.returnBuffers = redis._options.returnBuffers;
  socket.commandsHighWater = redis._options.commandsHighWater;

  tool.setPrivate(socket, 'frequency', socketState.frequency);
  tool.setPrivate(socket, 'commandQueue', socketState.commandQueue);

  if (redis._options.authPass) {
    waitForAuth = true;
    redis.auth(redis._options.authPass)(function(error) {
      if (error) return socket.emit('error', error);
      waitForAuth = false;
      checkReady();
    });
  }

  if (redis._options.database) {
    waitForSelect = true;
    redis.select(redis._options.database)(function(error) {
      if (error) return socket.emit('error', error);
      waitForSelect = false;
      checkReady();
    });
  }

  socket
    .on('connect', checkReady)
    .on('data', function(chunk) {
      var reply = socket.pendingWatcher;
      if (socket.debugMode) tool.log({
        socketChunk: chunk
      });
      if (!reply) return redis.emit('error', new Error('Unexpected reply: ' + chunk));
      if (!reply.resp) reply.resp = initResp(redis, reply);
      reply.resp.feed(chunk);
    })
    .on('error', function(error) {
      flushAll(socket, error);
      redis.emit('error', error);
    })
    .on('close', function(hadError) {
      flushAll(socket, new Error('The redis connection was closed'));
      redis.emit('close', hadError);
    })
    .on('timeout', function() {
      var error = new Error('The redis connection was timeout');
      redis.emit('timeout');
      if (socketState.attempts <= redis._options.maxAttempts) {
        flushPending(socket, error);
        socket.removeAllListeners();
        socket.destroy();

        redis.emit('reconnecting', {
          delay: redis._options.retryDelay,
          attempts: ++socketState.attempts
        });

        setTimeout(function() {
          initSocket(redis, options, {
            attempts: socketState.attempts,
            commandQueue: socket.commandQueue,
            frequency: socket.frequency
          });
        }, redis._options.retryDelay);
      } else {
        flushAll(socket, error);
        redis.clientEnd();
      }
    })
    .on('end', function() {
      flushAll(socket, new Error('The redis connection was ended'));
      redis.clientEnd();
    })
    .on('queueDrain', function() {
      redis.emit('drain');
    });

  function checkReady() {
    if (waitForAuth || waitForSelect) return execQueue(redis, true);
    redis._redisState.connected = socket.redisConnected = true;
    redis.emit('connect');
    execQueue(redis);
  }
}

function initResp(redis, reply) {
  var socket = redis._socket;
  var redisState = redis._redisState;

  return new resp.Resp({
      expectResCount: reply.commands.length,
      returnBuffers: socket.returnBuffers
    })
    .on('error', function(error) {
      if (socket.debugMode) tool.log({
        respError: error
      });
      flushPending(socket, error);
      redis.emit('error', error);
    })
    .on('data', function(data) {
      if (socket.debugMode) tool.log({
        respData: data
      });

      var command = reply.commands.first();

      if (redisState.monitorMode && (!command || command.name !== 'quit')) return redis.emit('monitor', data);
      if (isMessageReply(data)) return redis.emit.apply(redis, data);

      if (isUnSubReply(data)) {
        if (redisState.pubSubMode && !data[2]) {
          redisState.pubSubMode = false;
          if (command) this.setAutoEnd(reply.commands.length);
        }
        if (!command) this.end();
        else if (data[0] === command.name) {
          reply.commands.shift();
          command.callback();
        }
        return redis.emit.apply(redis, data);
      }

      reply.commands.shift();
      if (!command) return redis.emit('error', new Error('Unexpected reply: ' + data));
      if (util.isError(data)) return command.callback(data);

      if (command.name === 'monitor') {
        redisState.monitorMode = true;
        this.setAutoEnd();
        return command.callback(null, data);
      }

      if (isSubReply(data)) {
        // (pub)subscribe can generate many replies. All are emitted as events.
        if (!redisState.pubSubMode) {
          redisState.pubSubMode = true;
          this.setAutoEnd();
        }
        command.callback();
        return redis.emit.apply(redis, data);
      }

      return command.callback(null, data);
    })
    .on('end', function() {
      socket.pendingWatcher = null;
      execQueue(redis);
    });
}

function sendCommand(redis, command, args, additionalCallbacks) {
  return Thunk.call(redis, function(callback) {
    var buffer;
    if (redis._redisState.ended) return callback(new Error('The redis connection was ended'));
    args = tool.slice(args);
    args.unshift(command);
    try {
      buffer = resp.bufferify(args);
    } catch (error) {
      return callback(error);
    }
    this._socket.commandQueue.push(new Command(command, buffer, callback, additionalCallbacks));
    execQueue(this);
  });
}

// This Command constructor is ever so slightly faster than using an object literal, but more importantly, using
// a named constructor helps it show up meaningfully in the V8 CPU profiler and in heap snapshots.
function Command(command, data, callback, additionalCallbacks) {
  this.name = command;
  this.data = data;
  this.callback = callback;
  this.additionalCallbacks = additionalCallbacks || 0;
}

function execQueue(redis, init) {
  var socket = redis._socket;

  if (!init && !socket.redisConnected) return;
  if (!socket.commandQueue.length) return socket.emit('queueDrain');
  if (redis._redisState.pubSubMode || redis._redisState.monitorMode) {
    if (redis._redisState.monitorMode) flushForMonitor(socket);
  } else if (socket.pendingWatcher) return;
  else socket.pendingWatcher = {commands: new Queue()};

  var pendingCommands = 0;
  var count = socket.commandsHighWater;
  var pendingWatcher = socket.pendingWatcher;

  while (socket.commandQueue.length && count--) {
    var command = socket.commandQueue.shift();
    if (socket.debugMode) tool.log({
      socketWrite: command.data.toString()
    });
    pendingWatcher.commands.push({
      name: command.name,
      callback: command.callback
    });
    while (command.additionalCallbacks--)
      pendingWatcher.commands.push({
        name: command.name,
        callback: noOp
      });

    pendingCommands++;
    if (command.name === 'monitor') flushForMonitor(socket);
    if (!socket.write(command.data)) break;
  }

  socket.frequency[pendingCommands] = 1 + (socket.frequency[pendingCommands] || 0);
}

function flushForMonitor(socket) {
  var error = new Error('Only QUIT allowed in this monitor.');
  var queue = socket.commandQueue;
  while (queue.length && queue.first().name !== 'quit') queue.shift().callback(error);
}

function flushPending(socket, error) {
  if (!socket.pendingWatcher) return;
  var command = socket.pendingWatcher.commands.shift();
  while (command) {
    command.callback(error);
    command = socket.pendingWatcher.commands.shift();
  }
  socket.pendingWatcher = null;
}

function flushAll(socket, error) {
  flushPending(socket, error);
  var command = socket.commandQueue.shift();
  while (command) {
    command.callback(error);
    command = socket.commandQueue.shift();
  }
}

var messageTypes = Object.create(null);
messageTypes.message = true;
messageTypes.pmessage = true;

function isMessageReply(reply) {
  return reply && messageTypes[reply[0]];
}

var subReplyTypes = Object.create(null);
subReplyTypes.subscribe = true;
subReplyTypes.psubscribe = true;

function isSubReply(reply) {
  return reply && subReplyTypes[reply[0]];
}

var unSubReplyTypes = Object.create(null);
unSubReplyTypes.unsubscribe = true;
unSubReplyTypes.punsubscribe = true;

function isUnSubReply(reply) {
  return reply && unSubReplyTypes[reply[0]];
}

function noOp() {}
