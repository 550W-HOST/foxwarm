#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../../../git/foxwarm/node_modules/universalify/index.js
var require_universalify = __commonJS({
  "../../../../git/foxwarm/node_modules/universalify/index.js"(exports2) {
    "use strict";
    exports2.fromCallback = function(fn) {
      return Object.defineProperty(function(...args) {
        if (typeof args[args.length - 1] === "function") fn.apply(this, args);
        else {
          return new Promise((resolve, reject) => {
            args.push((err, res) => err != null ? reject(err) : resolve(res));
            fn.apply(this, args);
          });
        }
      }, "name", { value: fn.name });
    };
    exports2.fromPromise = function(fn) {
      return Object.defineProperty(function(...args) {
        const cb = args[args.length - 1];
        if (typeof cb !== "function") return fn.apply(this, args);
        else {
          args.pop();
          fn.apply(this, args).then((r) => cb(null, r), cb);
        }
      }, "name", { value: fn.name });
    };
  }
});

// ../../../../git/foxwarm/node_modules/graceful-fs/polyfills.js
var require_polyfills = __commonJS({
  "../../../../git/foxwarm/node_modules/graceful-fs/polyfills.js"(exports2, module2) {
    var constants = require("constants");
    var origCwd = process.cwd;
    var cwd = null;
    var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;
    process.cwd = function() {
      if (!cwd)
        cwd = origCwd.call(process);
      return cwd;
    };
    try {
      process.cwd();
    } catch (er) {
    }
    if (typeof process.chdir === "function") {
      chdir = process.chdir;
      process.chdir = function(d) {
        cwd = null;
        chdir.call(process, d);
      };
      if (Object.setPrototypeOf) Object.setPrototypeOf(process.chdir, chdir);
    }
    var chdir;
    module2.exports = patch;
    function patch(fs3) {
      if (constants.hasOwnProperty("O_SYMLINK") && process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
        patchLchmod(fs3);
      }
      if (!fs3.lutimes) {
        patchLutimes(fs3);
      }
      fs3.chown = chownFix(fs3.chown);
      fs3.fchown = chownFix(fs3.fchown);
      fs3.lchown = chownFix(fs3.lchown);
      fs3.chmod = chmodFix(fs3.chmod);
      fs3.fchmod = chmodFix(fs3.fchmod);
      fs3.lchmod = chmodFix(fs3.lchmod);
      fs3.chownSync = chownFixSync(fs3.chownSync);
      fs3.fchownSync = chownFixSync(fs3.fchownSync);
      fs3.lchownSync = chownFixSync(fs3.lchownSync);
      fs3.chmodSync = chmodFixSync(fs3.chmodSync);
      fs3.fchmodSync = chmodFixSync(fs3.fchmodSync);
      fs3.lchmodSync = chmodFixSync(fs3.lchmodSync);
      fs3.stat = statFix(fs3.stat);
      fs3.fstat = statFix(fs3.fstat);
      fs3.lstat = statFix(fs3.lstat);
      fs3.statSync = statFixSync(fs3.statSync);
      fs3.fstatSync = statFixSync(fs3.fstatSync);
      fs3.lstatSync = statFixSync(fs3.lstatSync);
      if (fs3.chmod && !fs3.lchmod) {
        fs3.lchmod = function(path3, mode, cb) {
          if (cb) process.nextTick(cb);
        };
        fs3.lchmodSync = function() {
        };
      }
      if (fs3.chown && !fs3.lchown) {
        fs3.lchown = function(path3, uid, gid, cb) {
          if (cb) process.nextTick(cb);
        };
        fs3.lchownSync = function() {
        };
      }
      if (platform === "win32") {
        fs3.rename = typeof fs3.rename !== "function" ? fs3.rename : (function(fs$rename) {
          function rename(from, to, cb) {
            var start = Date.now();
            var backoff = 0;
            fs$rename(from, to, function CB(er) {
              if (er && (er.code === "EACCES" || er.code === "EPERM" || er.code === "EBUSY") && Date.now() - start < 6e4) {
                setTimeout(function() {
                  fs3.stat(to, function(stater, st) {
                    if (stater && stater.code === "ENOENT")
                      fs$rename(from, to, CB);
                    else
                      cb(er);
                  });
                }, backoff);
                if (backoff < 100)
                  backoff += 10;
                return;
              }
              if (cb) cb(er);
            });
          }
          if (Object.setPrototypeOf) Object.setPrototypeOf(rename, fs$rename);
          return rename;
        })(fs3.rename);
      }
      fs3.read = typeof fs3.read !== "function" ? fs3.read : (function(fs$read) {
        function read2(fd, buffer, offset, length, position, callback_) {
          var callback;
          if (callback_ && typeof callback_ === "function") {
            var eagCounter = 0;
            callback = function(er, _, __) {
              if (er && er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                return fs$read.call(fs3, fd, buffer, offset, length, position, callback);
              }
              callback_.apply(this, arguments);
            };
          }
          return fs$read.call(fs3, fd, buffer, offset, length, position, callback);
        }
        if (Object.setPrototypeOf) Object.setPrototypeOf(read2, fs$read);
        return read2;
      })(fs3.read);
      fs3.readSync = typeof fs3.readSync !== "function" ? fs3.readSync : /* @__PURE__ */ (function(fs$readSync) {
        return function(fd, buffer, offset, length, position) {
          var eagCounter = 0;
          while (true) {
            try {
              return fs$readSync.call(fs3, fd, buffer, offset, length, position);
            } catch (er) {
              if (er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                continue;
              }
              throw er;
            }
          }
        };
      })(fs3.readSync);
      function patchLchmod(fs4) {
        fs4.lchmod = function(path3, mode, callback) {
          fs4.open(
            path3,
            constants.O_WRONLY | constants.O_SYMLINK,
            mode,
            function(err, fd) {
              if (err) {
                if (callback) callback(err);
                return;
              }
              fs4.fchmod(fd, mode, function(err2) {
                fs4.close(fd, function(err22) {
                  if (callback) callback(err2 || err22);
                });
              });
            }
          );
        };
        fs4.lchmodSync = function(path3, mode) {
          var fd = fs4.openSync(path3, constants.O_WRONLY | constants.O_SYMLINK, mode);
          var threw = true;
          var ret;
          try {
            ret = fs4.fchmodSync(fd, mode);
            threw = false;
          } finally {
            if (threw) {
              try {
                fs4.closeSync(fd);
              } catch (er) {
              }
            } else {
              fs4.closeSync(fd);
            }
          }
          return ret;
        };
      }
      function patchLutimes(fs4) {
        if (constants.hasOwnProperty("O_SYMLINK") && fs4.futimes) {
          fs4.lutimes = function(path3, at, mt, cb) {
            fs4.open(path3, constants.O_SYMLINK, function(er, fd) {
              if (er) {
                if (cb) cb(er);
                return;
              }
              fs4.futimes(fd, at, mt, function(er2) {
                fs4.close(fd, function(er22) {
                  if (cb) cb(er2 || er22);
                });
              });
            });
          };
          fs4.lutimesSync = function(path3, at, mt) {
            var fd = fs4.openSync(path3, constants.O_SYMLINK);
            var ret;
            var threw = true;
            try {
              ret = fs4.futimesSync(fd, at, mt);
              threw = false;
            } finally {
              if (threw) {
                try {
                  fs4.closeSync(fd);
                } catch (er) {
                }
              } else {
                fs4.closeSync(fd);
              }
            }
            return ret;
          };
        } else if (fs4.futimes) {
          fs4.lutimes = function(_a, _b, _c, cb) {
            if (cb) process.nextTick(cb);
          };
          fs4.lutimesSync = function() {
          };
        }
      }
      function chmodFix(orig) {
        if (!orig) return orig;
        return function(target, mode, cb) {
          return orig.call(fs3, target, mode, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chmodFixSync(orig) {
        if (!orig) return orig;
        return function(target, mode) {
          try {
            return orig.call(fs3, target, mode);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function chownFix(orig) {
        if (!orig) return orig;
        return function(target, uid, gid, cb) {
          return orig.call(fs3, target, uid, gid, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chownFixSync(orig) {
        if (!orig) return orig;
        return function(target, uid, gid) {
          try {
            return orig.call(fs3, target, uid, gid);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function statFix(orig) {
        if (!orig) return orig;
        return function(target, options, cb) {
          if (typeof options === "function") {
            cb = options;
            options = null;
          }
          function callback(er, stats) {
            if (stats) {
              if (stats.uid < 0) stats.uid += 4294967296;
              if (stats.gid < 0) stats.gid += 4294967296;
            }
            if (cb) cb.apply(this, arguments);
          }
          return options ? orig.call(fs3, target, options, callback) : orig.call(fs3, target, callback);
        };
      }
      function statFixSync(orig) {
        if (!orig) return orig;
        return function(target, options) {
          var stats = options ? orig.call(fs3, target, options) : orig.call(fs3, target);
          if (stats) {
            if (stats.uid < 0) stats.uid += 4294967296;
            if (stats.gid < 0) stats.gid += 4294967296;
          }
          return stats;
        };
      }
      function chownErOk(er) {
        if (!er)
          return true;
        if (er.code === "ENOSYS")
          return true;
        var nonroot = !process.getuid || process.getuid() !== 0;
        if (nonroot) {
          if (er.code === "EINVAL" || er.code === "EPERM")
            return true;
        }
        return false;
      }
    }
  }
});

// ../../../../git/foxwarm/node_modules/graceful-fs/legacy-streams.js
var require_legacy_streams = __commonJS({
  "../../../../git/foxwarm/node_modules/graceful-fs/legacy-streams.js"(exports2, module2) {
    var Stream = require("stream").Stream;
    module2.exports = legacy;
    function legacy(fs3) {
      return {
        ReadStream,
        WriteStream
      };
      function ReadStream(path3, options) {
        if (!(this instanceof ReadStream)) return new ReadStream(path3, options);
        Stream.call(this);
        var self = this;
        this.path = path3;
        this.fd = null;
        this.readable = true;
        this.paused = false;
        this.flags = "r";
        this.mode = 438;
        this.bufferSize = 64 * 1024;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.encoding) this.setEncoding(this.encoding);
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.end === void 0) {
            this.end = Infinity;
          } else if ("number" !== typeof this.end) {
            throw TypeError("end must be a Number");
          }
          if (this.start > this.end) {
            throw new Error("start must be <= end");
          }
          this.pos = this.start;
        }
        if (this.fd !== null) {
          process.nextTick(function() {
            self._read();
          });
          return;
        }
        fs3.open(this.path, this.flags, this.mode, function(err, fd) {
          if (err) {
            self.emit("error", err);
            self.readable = false;
            return;
          }
          self.fd = fd;
          self.emit("open", fd);
          self._read();
        });
      }
      function WriteStream(path3, options) {
        if (!(this instanceof WriteStream)) return new WriteStream(path3, options);
        Stream.call(this);
        this.path = path3;
        this.fd = null;
        this.writable = true;
        this.flags = "w";
        this.encoding = "binary";
        this.mode = 438;
        this.bytesWritten = 0;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.start < 0) {
            throw new Error("start must be >= zero");
          }
          this.pos = this.start;
        }
        this.busy = false;
        this._queue = [];
        if (this.fd === null) {
          this._open = fs3.open;
          this._queue.push([this._open, this.path, this.flags, this.mode, void 0]);
          this.flush();
        }
      }
    }
  }
});

// ../../../../git/foxwarm/node_modules/graceful-fs/clone.js
var require_clone = __commonJS({
  "../../../../git/foxwarm/node_modules/graceful-fs/clone.js"(exports2, module2) {
    "use strict";
    module2.exports = clone;
    var getPrototypeOf = Object.getPrototypeOf || function(obj) {
      return obj.__proto__;
    };
    function clone(obj) {
      if (obj === null || typeof obj !== "object")
        return obj;
      if (obj instanceof Object)
        var copy = { __proto__: getPrototypeOf(obj) };
      else
        var copy = /* @__PURE__ */ Object.create(null);
      Object.getOwnPropertyNames(obj).forEach(function(key) {
        Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key));
      });
      return copy;
    }
  }
});

// ../../../../git/foxwarm/node_modules/graceful-fs/graceful-fs.js
var require_graceful_fs = __commonJS({
  "../../../../git/foxwarm/node_modules/graceful-fs/graceful-fs.js"(exports2, module2) {
    var fs3 = require("fs");
    var polyfills = require_polyfills();
    var legacy = require_legacy_streams();
    var clone = require_clone();
    var util = require("util");
    var gracefulQueue;
    var previousSymbol;
    if (typeof Symbol === "function" && typeof Symbol.for === "function") {
      gracefulQueue = /* @__PURE__ */ Symbol.for("graceful-fs.queue");
      previousSymbol = /* @__PURE__ */ Symbol.for("graceful-fs.previous");
    } else {
      gracefulQueue = "___graceful-fs.queue";
      previousSymbol = "___graceful-fs.previous";
    }
    function noop() {
    }
    function publishQueue(context, queue2) {
      Object.defineProperty(context, gracefulQueue, {
        get: function() {
          return queue2;
        }
      });
    }
    var debug = noop;
    if (util.debuglog)
      debug = util.debuglog("gfs4");
    else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ""))
      debug = function() {
        var m = util.format.apply(util, arguments);
        m = "GFS4: " + m.split(/\n/).join("\nGFS4: ");
        console.error(m);
      };
    if (!fs3[gracefulQueue]) {
      queue = global[gracefulQueue] || [];
      publishQueue(fs3, queue);
      fs3.close = (function(fs$close) {
        function close(fd, cb) {
          return fs$close.call(fs3, fd, function(err) {
            if (!err) {
              resetQueue();
            }
            if (typeof cb === "function")
              cb.apply(this, arguments);
          });
        }
        Object.defineProperty(close, previousSymbol, {
          value: fs$close
        });
        return close;
      })(fs3.close);
      fs3.closeSync = (function(fs$closeSync) {
        function closeSync(fd) {
          fs$closeSync.apply(fs3, arguments);
          resetQueue();
        }
        Object.defineProperty(closeSync, previousSymbol, {
          value: fs$closeSync
        });
        return closeSync;
      })(fs3.closeSync);
      if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) {
        process.on("exit", function() {
          debug(fs3[gracefulQueue]);
          require("assert").equal(fs3[gracefulQueue].length, 0);
        });
      }
    }
    var queue;
    if (!global[gracefulQueue]) {
      publishQueue(global, fs3[gracefulQueue]);
    }
    module2.exports = patch(clone(fs3));
    if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs3.__patched) {
      module2.exports = patch(fs3);
      fs3.__patched = true;
    }
    function patch(fs4) {
      polyfills(fs4);
      fs4.gracefulify = patch;
      fs4.createReadStream = createReadStream;
      fs4.createWriteStream = createWriteStream;
      var fs$readFile = fs4.readFile;
      fs4.readFile = readFile;
      function readFile(path3, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$readFile(path3, options, cb);
        function go$readFile(path4, options2, cb2, startTime) {
          return fs$readFile(path4, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$readFile, [path4, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$writeFile = fs4.writeFile;
      fs4.writeFile = writeFile;
      function writeFile(path3, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$writeFile(path3, data, options, cb);
        function go$writeFile(path4, data2, options2, cb2, startTime) {
          return fs$writeFile(path4, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$writeFile, [path4, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$appendFile = fs4.appendFile;
      if (fs$appendFile)
        fs4.appendFile = appendFile;
      function appendFile(path3, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$appendFile(path3, data, options, cb);
        function go$appendFile(path4, data2, options2, cb2, startTime) {
          return fs$appendFile(path4, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$appendFile, [path4, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$copyFile = fs4.copyFile;
      if (fs$copyFile)
        fs4.copyFile = copyFile;
      function copyFile(src, dest, flags, cb) {
        if (typeof flags === "function") {
          cb = flags;
          flags = 0;
        }
        return go$copyFile(src, dest, flags, cb);
        function go$copyFile(src2, dest2, flags2, cb2, startTime) {
          return fs$copyFile(src2, dest2, flags2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$copyFile, [src2, dest2, flags2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$readdir = fs4.readdir;
      fs4.readdir = readdir;
      var noReaddirOptionVersions = /^v[0-5]\./;
      function readdir(path3, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir2(path4, options2, cb2, startTime) {
          return fs$readdir(path4, fs$readdirCallback(
            path4,
            options2,
            cb2,
            startTime
          ));
        } : function go$readdir2(path4, options2, cb2, startTime) {
          return fs$readdir(path4, options2, fs$readdirCallback(
            path4,
            options2,
            cb2,
            startTime
          ));
        };
        return go$readdir(path3, options, cb);
        function fs$readdirCallback(path4, options2, cb2, startTime) {
          return function(err, files) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([
                go$readdir,
                [path4, options2, cb2],
                err,
                startTime || Date.now(),
                Date.now()
              ]);
            else {
              if (files && files.sort)
                files.sort();
              if (typeof cb2 === "function")
                cb2.call(this, err, files);
            }
          };
        }
      }
      if (process.version.substr(0, 4) === "v0.8") {
        var legStreams = legacy(fs4);
        ReadStream = legStreams.ReadStream;
        WriteStream = legStreams.WriteStream;
      }
      var fs$ReadStream = fs4.ReadStream;
      if (fs$ReadStream) {
        ReadStream.prototype = Object.create(fs$ReadStream.prototype);
        ReadStream.prototype.open = ReadStream$open;
      }
      var fs$WriteStream = fs4.WriteStream;
      if (fs$WriteStream) {
        WriteStream.prototype = Object.create(fs$WriteStream.prototype);
        WriteStream.prototype.open = WriteStream$open;
      }
      Object.defineProperty(fs4, "ReadStream", {
        get: function() {
          return ReadStream;
        },
        set: function(val) {
          ReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(fs4, "WriteStream", {
        get: function() {
          return WriteStream;
        },
        set: function(val) {
          WriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileReadStream = ReadStream;
      Object.defineProperty(fs4, "FileReadStream", {
        get: function() {
          return FileReadStream;
        },
        set: function(val) {
          FileReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileWriteStream = WriteStream;
      Object.defineProperty(fs4, "FileWriteStream", {
        get: function() {
          return FileWriteStream;
        },
        set: function(val) {
          FileWriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      function ReadStream(path3, options) {
        if (this instanceof ReadStream)
          return fs$ReadStream.apply(this, arguments), this;
        else
          return ReadStream.apply(Object.create(ReadStream.prototype), arguments);
      }
      function ReadStream$open() {
        var that = this;
        open(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            if (that.autoClose)
              that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
            that.read();
          }
        });
      }
      function WriteStream(path3, options) {
        if (this instanceof WriteStream)
          return fs$WriteStream.apply(this, arguments), this;
        else
          return WriteStream.apply(Object.create(WriteStream.prototype), arguments);
      }
      function WriteStream$open() {
        var that = this;
        open(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
          }
        });
      }
      function createReadStream(path3, options) {
        return new fs4.ReadStream(path3, options);
      }
      function createWriteStream(path3, options) {
        return new fs4.WriteStream(path3, options);
      }
      var fs$open = fs4.open;
      fs4.open = open;
      function open(path3, flags, mode, cb) {
        if (typeof mode === "function")
          cb = mode, mode = null;
        return go$open(path3, flags, mode, cb);
        function go$open(path4, flags2, mode2, cb2, startTime) {
          return fs$open(path4, flags2, mode2, function(err, fd) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$open, [path4, flags2, mode2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      return fs4;
    }
    function enqueue(elem) {
      debug("ENQUEUE", elem[0].name, elem[1]);
      fs3[gracefulQueue].push(elem);
      retry();
    }
    var retryTimer;
    function resetQueue() {
      var now = Date.now();
      for (var i = 0; i < fs3[gracefulQueue].length; ++i) {
        if (fs3[gracefulQueue][i].length > 2) {
          fs3[gracefulQueue][i][3] = now;
          fs3[gracefulQueue][i][4] = now;
        }
      }
      retry();
    }
    function retry() {
      clearTimeout(retryTimer);
      retryTimer = void 0;
      if (fs3[gracefulQueue].length === 0)
        return;
      var elem = fs3[gracefulQueue].shift();
      var fn = elem[0];
      var args = elem[1];
      var err = elem[2];
      var startTime = elem[3];
      var lastTime = elem[4];
      if (startTime === void 0) {
        debug("RETRY", fn.name, args);
        fn.apply(null, args);
      } else if (Date.now() - startTime >= 6e4) {
        debug("TIMEOUT", fn.name, args);
        var cb = args.pop();
        if (typeof cb === "function")
          cb.call(null, err);
      } else {
        var sinceAttempt = Date.now() - lastTime;
        var sinceStart = Math.max(lastTime - startTime, 1);
        var desiredDelay = Math.min(sinceStart * 1.2, 100);
        if (sinceAttempt >= desiredDelay) {
          debug("RETRY", fn.name, args);
          fn.apply(null, args.concat([startTime]));
        } else {
          fs3[gracefulQueue].push(elem);
        }
      }
      if (retryTimer === void 0) {
        retryTimer = setTimeout(retry, 0);
      }
    }
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/fs/index.js
var require_fs = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/fs/index.js"(exports2) {
    "use strict";
    var u = require_universalify().fromCallback;
    var fs3 = require_graceful_fs();
    var api = [
      "access",
      "appendFile",
      "chmod",
      "chown",
      "close",
      "copyFile",
      "cp",
      "fchmod",
      "fchown",
      "fdatasync",
      "fstat",
      "fsync",
      "ftruncate",
      "futimes",
      "glob",
      "lchmod",
      "lchown",
      "lutimes",
      "link",
      "lstat",
      "mkdir",
      "mkdtemp",
      "open",
      "opendir",
      "readdir",
      "readFile",
      "readlink",
      "realpath",
      "rename",
      "rm",
      "rmdir",
      "stat",
      "statfs",
      "symlink",
      "truncate",
      "unlink",
      "utimes",
      "writeFile"
    ].filter((key) => {
      return typeof fs3[key] === "function";
    });
    Object.assign(exports2, fs3);
    api.forEach((method) => {
      exports2[method] = u(fs3[method]);
    });
    exports2.exists = function(filename, callback) {
      if (typeof callback === "function") {
        return fs3.exists(filename, callback);
      }
      return new Promise((resolve) => {
        return fs3.exists(filename, resolve);
      });
    };
    exports2.read = function(fd, buffer, offset, length, position, callback) {
      if (typeof callback === "function") {
        return fs3.read(fd, buffer, offset, length, position, callback);
      }
      return new Promise((resolve, reject) => {
        fs3.read(fd, buffer, offset, length, position, (err, bytesRead, buffer2) => {
          if (err) return reject(err);
          resolve({ bytesRead, buffer: buffer2 });
        });
      });
    };
    exports2.write = function(fd, buffer, ...args) {
      if (typeof args[args.length - 1] === "function") {
        return fs3.write(fd, buffer, ...args);
      }
      return new Promise((resolve, reject) => {
        fs3.write(fd, buffer, ...args, (err, bytesWritten, buffer2) => {
          if (err) return reject(err);
          resolve({ bytesWritten, buffer: buffer2 });
        });
      });
    };
    exports2.readv = function(fd, buffers, ...args) {
      if (typeof args[args.length - 1] === "function") {
        return fs3.readv(fd, buffers, ...args);
      }
      return new Promise((resolve, reject) => {
        fs3.readv(fd, buffers, ...args, (err, bytesRead, buffers2) => {
          if (err) return reject(err);
          resolve({ bytesRead, buffers: buffers2 });
        });
      });
    };
    exports2.writev = function(fd, buffers, ...args) {
      if (typeof args[args.length - 1] === "function") {
        return fs3.writev(fd, buffers, ...args);
      }
      return new Promise((resolve, reject) => {
        fs3.writev(fd, buffers, ...args, (err, bytesWritten, buffers2) => {
          if (err) return reject(err);
          resolve({ bytesWritten, buffers: buffers2 });
        });
      });
    };
    if (typeof fs3.realpath.native === "function") {
      exports2.realpath.native = u(fs3.realpath.native);
    } else {
      process.emitWarning(
        "fs.realpath.native is not a function. Is fs being monkey-patched?",
        "Warning",
        "fs-extra-WARN0003"
      );
    }
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/mkdirs/utils.js
var require_utils = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/mkdirs/utils.js"(exports2, module2) {
    "use strict";
    var path3 = require("path");
    module2.exports.checkPath = function checkPath(pth) {
      if (process.platform === "win32") {
        const pathHasInvalidWinCharacters = /[<>:"|?*]/.test(pth.replace(path3.parse(pth).root, ""));
        if (pathHasInvalidWinCharacters) {
          const error = new Error(`Path contains invalid characters: ${pth}`);
          error.code = "EINVAL";
          throw error;
        }
      }
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/mkdirs/make-dir.js
var require_make_dir = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/mkdirs/make-dir.js"(exports2, module2) {
    "use strict";
    var fs3 = require_fs();
    var { checkPath } = require_utils();
    var getMode = (options) => {
      const defaults = { mode: 511 };
      if (typeof options === "number") return options;
      return { ...defaults, ...options }.mode;
    };
    module2.exports.makeDir = async (dir, options) => {
      checkPath(dir);
      return fs3.mkdir(dir, {
        mode: getMode(options),
        recursive: true
      });
    };
    module2.exports.makeDirSync = (dir, options) => {
      checkPath(dir);
      return fs3.mkdirSync(dir, {
        mode: getMode(options),
        recursive: true
      });
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/mkdirs/index.js
var require_mkdirs = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/mkdirs/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var { makeDir: _makeDir, makeDirSync } = require_make_dir();
    var makeDir = u(_makeDir);
    module2.exports = {
      mkdirs: makeDir,
      mkdirsSync: makeDirSync,
      // alias
      mkdirp: makeDir,
      mkdirpSync: makeDirSync,
      ensureDir: makeDir,
      ensureDirSync: makeDirSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/path-exists/index.js
var require_path_exists = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/path-exists/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var fs3 = require_fs();
    function pathExists(path3) {
      return fs3.access(path3).then(() => true).catch(() => false);
    }
    module2.exports = {
      pathExists: u(pathExists),
      pathExistsSync: fs3.existsSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/util/utimes.js
var require_utimes = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/util/utimes.js"(exports2, module2) {
    "use strict";
    var fs3 = require_fs();
    var u = require_universalify().fromPromise;
    async function utimesMillis(path3, atime, mtime) {
      const fd = await fs3.open(path3, "r+");
      let closeErr = null;
      try {
        await fs3.futimes(fd, atime, mtime);
      } finally {
        try {
          await fs3.close(fd);
        } catch (e) {
          closeErr = e;
        }
      }
      if (closeErr) {
        throw closeErr;
      }
    }
    function utimesMillisSync(path3, atime, mtime) {
      const fd = fs3.openSync(path3, "r+");
      fs3.futimesSync(fd, atime, mtime);
      return fs3.closeSync(fd);
    }
    module2.exports = {
      utimesMillis: u(utimesMillis),
      utimesMillisSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/util/stat.js
var require_stat = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/util/stat.js"(exports2, module2) {
    "use strict";
    var fs3 = require_fs();
    var path3 = require("path");
    var u = require_universalify().fromPromise;
    function getStats(src, dest, opts) {
      const statFunc = opts.dereference ? (file) => fs3.stat(file, { bigint: true }) : (file) => fs3.lstat(file, { bigint: true });
      return Promise.all([
        statFunc(src),
        statFunc(dest).catch((err) => {
          if (err.code === "ENOENT") return null;
          throw err;
        })
      ]).then(([srcStat, destStat]) => ({ srcStat, destStat }));
    }
    function getStatsSync(src, dest, opts) {
      let destStat;
      const statFunc = opts.dereference ? (file) => fs3.statSync(file, { bigint: true }) : (file) => fs3.lstatSync(file, { bigint: true });
      const srcStat = statFunc(src);
      try {
        destStat = statFunc(dest);
      } catch (err) {
        if (err.code === "ENOENT") return { srcStat, destStat: null };
        throw err;
      }
      return { srcStat, destStat };
    }
    async function checkPaths(src, dest, funcName, opts) {
      const { srcStat, destStat } = await getStats(src, dest, opts);
      if (destStat) {
        if (areIdentical(srcStat, destStat)) {
          const srcBaseName = path3.basename(src);
          const destBaseName = path3.basename(dest);
          if (funcName === "move" && srcBaseName !== destBaseName && srcBaseName.toLowerCase() === destBaseName.toLowerCase()) {
            return { srcStat, destStat, isChangingCase: true };
          }
          throw new Error("Source and destination must not be the same.");
        }
        if (srcStat.isDirectory() && !destStat.isDirectory()) {
          throw new Error(`Cannot overwrite non-directory '${dest}' with directory '${src}'.`);
        }
        if (!srcStat.isDirectory() && destStat.isDirectory()) {
          throw new Error(`Cannot overwrite directory '${dest}' with non-directory '${src}'.`);
        }
      }
      if (srcStat.isDirectory() && isSrcSubdir(src, dest)) {
        throw new Error(errMsg(src, dest, funcName));
      }
      return { srcStat, destStat };
    }
    function checkPathsSync(src, dest, funcName, opts) {
      const { srcStat, destStat } = getStatsSync(src, dest, opts);
      if (destStat) {
        if (areIdentical(srcStat, destStat)) {
          const srcBaseName = path3.basename(src);
          const destBaseName = path3.basename(dest);
          if (funcName === "move" && srcBaseName !== destBaseName && srcBaseName.toLowerCase() === destBaseName.toLowerCase()) {
            return { srcStat, destStat, isChangingCase: true };
          }
          throw new Error("Source and destination must not be the same.");
        }
        if (srcStat.isDirectory() && !destStat.isDirectory()) {
          throw new Error(`Cannot overwrite non-directory '${dest}' with directory '${src}'.`);
        }
        if (!srcStat.isDirectory() && destStat.isDirectory()) {
          throw new Error(`Cannot overwrite directory '${dest}' with non-directory '${src}'.`);
        }
      }
      if (srcStat.isDirectory() && isSrcSubdir(src, dest)) {
        throw new Error(errMsg(src, dest, funcName));
      }
      return { srcStat, destStat };
    }
    async function checkParentPaths(src, srcStat, dest, funcName) {
      const srcParent = path3.resolve(path3.dirname(src));
      const destParent = path3.resolve(path3.dirname(dest));
      if (destParent === srcParent || destParent === path3.parse(destParent).root) return;
      let destStat;
      try {
        destStat = await fs3.stat(destParent, { bigint: true });
      } catch (err) {
        if (err.code === "ENOENT") return;
        throw err;
      }
      if (areIdentical(srcStat, destStat)) {
        throw new Error(errMsg(src, dest, funcName));
      }
      return checkParentPaths(src, srcStat, destParent, funcName);
    }
    function checkParentPathsSync(src, srcStat, dest, funcName) {
      const srcParent = path3.resolve(path3.dirname(src));
      const destParent = path3.resolve(path3.dirname(dest));
      if (destParent === srcParent || destParent === path3.parse(destParent).root) return;
      let destStat;
      try {
        destStat = fs3.statSync(destParent, { bigint: true });
      } catch (err) {
        if (err.code === "ENOENT") return;
        throw err;
      }
      if (areIdentical(srcStat, destStat)) {
        throw new Error(errMsg(src, dest, funcName));
      }
      return checkParentPathsSync(src, srcStat, destParent, funcName);
    }
    function areIdentical(srcStat, destStat) {
      return destStat.ino !== void 0 && destStat.dev !== void 0 && destStat.ino === srcStat.ino && destStat.dev === srcStat.dev;
    }
    function isSrcSubdir(src, dest) {
      const srcArr = path3.resolve(src).split(path3.sep).filter((i) => i);
      const destArr = path3.resolve(dest).split(path3.sep).filter((i) => i);
      return srcArr.every((cur, i) => destArr[i] === cur);
    }
    function errMsg(src, dest, funcName) {
      return `Cannot ${funcName} '${src}' to a subdirectory of itself, '${dest}'.`;
    }
    module2.exports = {
      // checkPaths
      checkPaths: u(checkPaths),
      checkPathsSync,
      // checkParent
      checkParentPaths: u(checkParentPaths),
      checkParentPathsSync,
      // Misc
      isSrcSubdir,
      areIdentical
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/util/async.js
var require_async = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/util/async.js"(exports2, module2) {
    "use strict";
    async function asyncIteratorConcurrentProcess(iterator, fn) {
      const promises = [];
      for await (const item of iterator) {
        promises.push(
          fn(item).then(
            () => null,
            (err) => err ?? new Error("unknown error")
          )
        );
      }
      await Promise.all(
        promises.map(
          (promise) => promise.then((possibleErr) => {
            if (possibleErr !== null) throw possibleErr;
          })
        )
      );
    }
    module2.exports = {
      asyncIteratorConcurrentProcess
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/copy/copy.js
var require_copy = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/copy/copy.js"(exports2, module2) {
    "use strict";
    var fs3 = require_fs();
    var path3 = require("path");
    var { mkdirs } = require_mkdirs();
    var { pathExists } = require_path_exists();
    var { utimesMillis } = require_utimes();
    var stat = require_stat();
    var { asyncIteratorConcurrentProcess } = require_async();
    async function copy(src, dest, opts = {}) {
      if (typeof opts === "function") {
        opts = { filter: opts };
      }
      opts.clobber = "clobber" in opts ? !!opts.clobber : true;
      opts.overwrite = "overwrite" in opts ? !!opts.overwrite : opts.clobber;
      if (opts.preserveTimestamps && process.arch === "ia32") {
        process.emitWarning(
          "Using the preserveTimestamps option in 32-bit node is not recommended;\n\n	see https://github.com/jprichardson/node-fs-extra/issues/269",
          "Warning",
          "fs-extra-WARN0001"
        );
      }
      const { srcStat, destStat } = await stat.checkPaths(src, dest, "copy", opts);
      await stat.checkParentPaths(src, srcStat, dest, "copy");
      const include = await runFilter(src, dest, opts);
      if (!include) return;
      const destParent = path3.dirname(dest);
      const dirExists = await pathExists(destParent);
      if (!dirExists) {
        await mkdirs(destParent);
      }
      await getStatsAndPerformCopy(destStat, src, dest, opts);
    }
    async function runFilter(src, dest, opts) {
      if (!opts.filter) return true;
      return opts.filter(src, dest);
    }
    async function getStatsAndPerformCopy(destStat, src, dest, opts) {
      const statFn = opts.dereference ? fs3.stat : fs3.lstat;
      const srcStat = await statFn(src);
      if (srcStat.isDirectory()) return onDir(srcStat, destStat, src, dest, opts);
      if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) return onFile(srcStat, destStat, src, dest, opts);
      if (srcStat.isSymbolicLink()) return onLink(destStat, src, dest, opts);
      if (srcStat.isSocket()) throw new Error(`Cannot copy a socket file: ${src}`);
      if (srcStat.isFIFO()) throw new Error(`Cannot copy a FIFO pipe: ${src}`);
      throw new Error(`Unknown file: ${src}`);
    }
    async function onFile(srcStat, destStat, src, dest, opts) {
      if (!destStat) return copyFile(srcStat, src, dest, opts);
      if (opts.overwrite) {
        await fs3.unlink(dest);
        return copyFile(srcStat, src, dest, opts);
      }
      if (opts.errorOnExist) {
        throw new Error(`'${dest}' already exists`);
      }
    }
    async function copyFile(srcStat, src, dest, opts) {
      await fs3.copyFile(src, dest);
      if (opts.preserveTimestamps) {
        if (fileIsNotWritable(srcStat.mode)) {
          await makeFileWritable(dest, srcStat.mode);
        }
        const updatedSrcStat = await fs3.stat(src);
        await utimesMillis(dest, updatedSrcStat.atime, updatedSrcStat.mtime);
      }
      return fs3.chmod(dest, srcStat.mode);
    }
    function fileIsNotWritable(srcMode) {
      return (srcMode & 128) === 0;
    }
    function makeFileWritable(dest, srcMode) {
      return fs3.chmod(dest, srcMode | 128);
    }
    async function onDir(srcStat, destStat, src, dest, opts) {
      if (!destStat) {
        await fs3.mkdir(dest);
      }
      await asyncIteratorConcurrentProcess(await fs3.opendir(src), async (item) => {
        const srcItem = path3.join(src, item.name);
        const destItem = path3.join(dest, item.name);
        const include = await runFilter(srcItem, destItem, opts);
        if (include) {
          const { destStat: destStat2 } = await stat.checkPaths(srcItem, destItem, "copy", opts);
          await getStatsAndPerformCopy(destStat2, srcItem, destItem, opts);
        }
      });
      if (!destStat) {
        await fs3.chmod(dest, srcStat.mode);
      }
    }
    async function onLink(destStat, src, dest, opts) {
      let resolvedSrc = await fs3.readlink(src);
      if (opts.dereference) {
        resolvedSrc = path3.resolve(process.cwd(), resolvedSrc);
      }
      if (!destStat) {
        return fs3.symlink(resolvedSrc, dest);
      }
      let resolvedDest = null;
      try {
        resolvedDest = await fs3.readlink(dest);
      } catch (e) {
        if (e.code === "EINVAL" || e.code === "UNKNOWN") return fs3.symlink(resolvedSrc, dest);
        throw e;
      }
      if (opts.dereference) {
        resolvedDest = path3.resolve(process.cwd(), resolvedDest);
      }
      if (resolvedSrc !== resolvedDest) {
        if (stat.isSrcSubdir(resolvedSrc, resolvedDest)) {
          throw new Error(`Cannot copy '${resolvedSrc}' to a subdirectory of itself, '${resolvedDest}'.`);
        }
        if (stat.isSrcSubdir(resolvedDest, resolvedSrc)) {
          throw new Error(`Cannot overwrite '${resolvedDest}' with '${resolvedSrc}'.`);
        }
      }
      await fs3.unlink(dest);
      return fs3.symlink(resolvedSrc, dest);
    }
    module2.exports = copy;
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/copy/copy-sync.js
var require_copy_sync = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/copy/copy-sync.js"(exports2, module2) {
    "use strict";
    var fs3 = require_graceful_fs();
    var path3 = require("path");
    var mkdirsSync = require_mkdirs().mkdirsSync;
    var utimesMillisSync = require_utimes().utimesMillisSync;
    var stat = require_stat();
    function copySync(src, dest, opts) {
      if (typeof opts === "function") {
        opts = { filter: opts };
      }
      opts = opts || {};
      opts.clobber = "clobber" in opts ? !!opts.clobber : true;
      opts.overwrite = "overwrite" in opts ? !!opts.overwrite : opts.clobber;
      if (opts.preserveTimestamps && process.arch === "ia32") {
        process.emitWarning(
          "Using the preserveTimestamps option in 32-bit node is not recommended;\n\n	see https://github.com/jprichardson/node-fs-extra/issues/269",
          "Warning",
          "fs-extra-WARN0002"
        );
      }
      const { srcStat, destStat } = stat.checkPathsSync(src, dest, "copy", opts);
      stat.checkParentPathsSync(src, srcStat, dest, "copy");
      if (opts.filter && !opts.filter(src, dest)) return;
      const destParent = path3.dirname(dest);
      if (!fs3.existsSync(destParent)) mkdirsSync(destParent);
      return getStats(destStat, src, dest, opts);
    }
    function getStats(destStat, src, dest, opts) {
      const statSync = opts.dereference ? fs3.statSync : fs3.lstatSync;
      const srcStat = statSync(src);
      if (srcStat.isDirectory()) return onDir(srcStat, destStat, src, dest, opts);
      else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) return onFile(srcStat, destStat, src, dest, opts);
      else if (srcStat.isSymbolicLink()) return onLink(destStat, src, dest, opts);
      else if (srcStat.isSocket()) throw new Error(`Cannot copy a socket file: ${src}`);
      else if (srcStat.isFIFO()) throw new Error(`Cannot copy a FIFO pipe: ${src}`);
      throw new Error(`Unknown file: ${src}`);
    }
    function onFile(srcStat, destStat, src, dest, opts) {
      if (!destStat) return copyFile(srcStat, src, dest, opts);
      return mayCopyFile(srcStat, src, dest, opts);
    }
    function mayCopyFile(srcStat, src, dest, opts) {
      if (opts.overwrite) {
        fs3.unlinkSync(dest);
        return copyFile(srcStat, src, dest, opts);
      } else if (opts.errorOnExist) {
        throw new Error(`'${dest}' already exists`);
      }
    }
    function copyFile(srcStat, src, dest, opts) {
      fs3.copyFileSync(src, dest);
      if (opts.preserveTimestamps) handleTimestamps(srcStat.mode, src, dest);
      return setDestMode(dest, srcStat.mode);
    }
    function handleTimestamps(srcMode, src, dest) {
      if (fileIsNotWritable(srcMode)) makeFileWritable(dest, srcMode);
      return setDestTimestamps(src, dest);
    }
    function fileIsNotWritable(srcMode) {
      return (srcMode & 128) === 0;
    }
    function makeFileWritable(dest, srcMode) {
      return setDestMode(dest, srcMode | 128);
    }
    function setDestMode(dest, srcMode) {
      return fs3.chmodSync(dest, srcMode);
    }
    function setDestTimestamps(src, dest) {
      const updatedSrcStat = fs3.statSync(src);
      return utimesMillisSync(dest, updatedSrcStat.atime, updatedSrcStat.mtime);
    }
    function onDir(srcStat, destStat, src, dest, opts) {
      if (!destStat) return mkDirAndCopy(srcStat.mode, src, dest, opts);
      return copyDir(src, dest, opts);
    }
    function mkDirAndCopy(srcMode, src, dest, opts) {
      fs3.mkdirSync(dest);
      copyDir(src, dest, opts);
      return setDestMode(dest, srcMode);
    }
    function copyDir(src, dest, opts) {
      const dir = fs3.opendirSync(src);
      try {
        let dirent;
        while ((dirent = dir.readSync()) !== null) {
          copyDirItem(dirent.name, src, dest, opts);
        }
      } finally {
        dir.closeSync();
      }
    }
    function copyDirItem(item, src, dest, opts) {
      const srcItem = path3.join(src, item);
      const destItem = path3.join(dest, item);
      if (opts.filter && !opts.filter(srcItem, destItem)) return;
      const { destStat } = stat.checkPathsSync(srcItem, destItem, "copy", opts);
      return getStats(destStat, srcItem, destItem, opts);
    }
    function onLink(destStat, src, dest, opts) {
      let resolvedSrc = fs3.readlinkSync(src);
      if (opts.dereference) {
        resolvedSrc = path3.resolve(process.cwd(), resolvedSrc);
      }
      if (!destStat) {
        return fs3.symlinkSync(resolvedSrc, dest);
      } else {
        let resolvedDest;
        try {
          resolvedDest = fs3.readlinkSync(dest);
        } catch (err) {
          if (err.code === "EINVAL" || err.code === "UNKNOWN") return fs3.symlinkSync(resolvedSrc, dest);
          throw err;
        }
        if (opts.dereference) {
          resolvedDest = path3.resolve(process.cwd(), resolvedDest);
        }
        if (resolvedSrc !== resolvedDest) {
          if (stat.isSrcSubdir(resolvedSrc, resolvedDest)) {
            throw new Error(`Cannot copy '${resolvedSrc}' to a subdirectory of itself, '${resolvedDest}'.`);
          }
          if (stat.isSrcSubdir(resolvedDest, resolvedSrc)) {
            throw new Error(`Cannot overwrite '${resolvedDest}' with '${resolvedSrc}'.`);
          }
        }
        return copyLink(resolvedSrc, dest);
      }
    }
    function copyLink(resolvedSrc, dest) {
      fs3.unlinkSync(dest);
      return fs3.symlinkSync(resolvedSrc, dest);
    }
    module2.exports = copySync;
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/copy/index.js
var require_copy2 = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/copy/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    module2.exports = {
      copy: u(require_copy()),
      copySync: require_copy_sync()
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/remove/index.js
var require_remove = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/remove/index.js"(exports2, module2) {
    "use strict";
    var fs3 = require_graceful_fs();
    var u = require_universalify().fromCallback;
    function remove(path3, callback) {
      fs3.rm(path3, { recursive: true, force: true }, callback);
    }
    function removeSync(path3) {
      fs3.rmSync(path3, { recursive: true, force: true });
    }
    module2.exports = {
      remove: u(remove),
      removeSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/empty/index.js
var require_empty = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/empty/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var fs3 = require_fs();
    var path3 = require("path");
    var mkdir = require_mkdirs();
    var remove = require_remove();
    var emptyDir = u(async function emptyDir2(dir) {
      let items;
      try {
        items = await fs3.readdir(dir);
      } catch {
        return mkdir.mkdirs(dir);
      }
      return Promise.all(items.map((item) => remove.remove(path3.join(dir, item))));
    });
    function emptyDirSync(dir) {
      let items;
      try {
        items = fs3.readdirSync(dir);
      } catch {
        return mkdir.mkdirsSync(dir);
      }
      items.forEach((item) => {
        item = path3.join(dir, item);
        remove.removeSync(item);
      });
    }
    module2.exports = {
      emptyDirSync,
      emptydirSync: emptyDirSync,
      emptyDir,
      emptydir: emptyDir
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/file.js
var require_file = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/file.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var path3 = require("path");
    var fs3 = require_fs();
    var mkdir = require_mkdirs();
    async function createFile(file) {
      let stats;
      try {
        stats = await fs3.stat(file);
      } catch {
      }
      if (stats && stats.isFile()) return;
      const dir = path3.dirname(file);
      let dirStats = null;
      try {
        dirStats = await fs3.stat(dir);
      } catch (err) {
        if (err.code === "ENOENT") {
          await mkdir.mkdirs(dir);
          await fs3.writeFile(file, "");
          return;
        } else {
          throw err;
        }
      }
      if (dirStats.isDirectory()) {
        await fs3.writeFile(file, "");
      } else {
        await fs3.readdir(dir);
      }
    }
    function createFileSync(file) {
      let stats;
      try {
        stats = fs3.statSync(file);
      } catch {
      }
      if (stats && stats.isFile()) return;
      const dir = path3.dirname(file);
      try {
        if (!fs3.statSync(dir).isDirectory()) {
          fs3.readdirSync(dir);
        }
      } catch (err) {
        if (err && err.code === "ENOENT") mkdir.mkdirsSync(dir);
        else throw err;
      }
      fs3.writeFileSync(file, "");
    }
    module2.exports = {
      createFile: u(createFile),
      createFileSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/link.js
var require_link = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/link.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var path3 = require("path");
    var fs3 = require_fs();
    var mkdir = require_mkdirs();
    var { pathExists } = require_path_exists();
    var { areIdentical } = require_stat();
    async function createLink(srcpath, dstpath) {
      let dstStat;
      try {
        dstStat = await fs3.lstat(dstpath);
      } catch {
      }
      let srcStat;
      try {
        srcStat = await fs3.lstat(srcpath);
      } catch (err) {
        err.message = err.message.replace("lstat", "ensureLink");
        throw err;
      }
      if (dstStat && areIdentical(srcStat, dstStat)) return;
      const dir = path3.dirname(dstpath);
      const dirExists = await pathExists(dir);
      if (!dirExists) {
        await mkdir.mkdirs(dir);
      }
      await fs3.link(srcpath, dstpath);
    }
    function createLinkSync(srcpath, dstpath) {
      let dstStat;
      try {
        dstStat = fs3.lstatSync(dstpath);
      } catch {
      }
      try {
        const srcStat = fs3.lstatSync(srcpath);
        if (dstStat && areIdentical(srcStat, dstStat)) return;
      } catch (err) {
        err.message = err.message.replace("lstat", "ensureLink");
        throw err;
      }
      const dir = path3.dirname(dstpath);
      const dirExists = fs3.existsSync(dir);
      if (dirExists) return fs3.linkSync(srcpath, dstpath);
      mkdir.mkdirsSync(dir);
      return fs3.linkSync(srcpath, dstpath);
    }
    module2.exports = {
      createLink: u(createLink),
      createLinkSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/symlink-paths.js
var require_symlink_paths = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/symlink-paths.js"(exports2, module2) {
    "use strict";
    var path3 = require("path");
    var fs3 = require_fs();
    var { pathExists } = require_path_exists();
    var u = require_universalify().fromPromise;
    async function symlinkPaths(srcpath, dstpath) {
      if (path3.isAbsolute(srcpath)) {
        try {
          await fs3.lstat(srcpath);
        } catch (err) {
          err.message = err.message.replace("lstat", "ensureSymlink");
          throw err;
        }
        return {
          toCwd: srcpath,
          toDst: srcpath
        };
      }
      const dstdir = path3.dirname(dstpath);
      const relativeToDst = path3.join(dstdir, srcpath);
      const exists = await pathExists(relativeToDst);
      if (exists) {
        return {
          toCwd: relativeToDst,
          toDst: srcpath
        };
      }
      try {
        await fs3.lstat(srcpath);
      } catch (err) {
        err.message = err.message.replace("lstat", "ensureSymlink");
        throw err;
      }
      return {
        toCwd: srcpath,
        toDst: path3.relative(dstdir, srcpath)
      };
    }
    function symlinkPathsSync(srcpath, dstpath) {
      if (path3.isAbsolute(srcpath)) {
        const exists2 = fs3.existsSync(srcpath);
        if (!exists2) throw new Error("absolute srcpath does not exist");
        return {
          toCwd: srcpath,
          toDst: srcpath
        };
      }
      const dstdir = path3.dirname(dstpath);
      const relativeToDst = path3.join(dstdir, srcpath);
      const exists = fs3.existsSync(relativeToDst);
      if (exists) {
        return {
          toCwd: relativeToDst,
          toDst: srcpath
        };
      }
      const srcExists = fs3.existsSync(srcpath);
      if (!srcExists) throw new Error("relative srcpath does not exist");
      return {
        toCwd: srcpath,
        toDst: path3.relative(dstdir, srcpath)
      };
    }
    module2.exports = {
      symlinkPaths: u(symlinkPaths),
      symlinkPathsSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/symlink-type.js
var require_symlink_type = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/symlink-type.js"(exports2, module2) {
    "use strict";
    var fs3 = require_fs();
    var u = require_universalify().fromPromise;
    async function symlinkType(srcpath, type) {
      if (type) return type;
      let stats;
      try {
        stats = await fs3.lstat(srcpath);
      } catch {
        return "file";
      }
      return stats && stats.isDirectory() ? "dir" : "file";
    }
    function symlinkTypeSync(srcpath, type) {
      if (type) return type;
      let stats;
      try {
        stats = fs3.lstatSync(srcpath);
      } catch {
        return "file";
      }
      return stats && stats.isDirectory() ? "dir" : "file";
    }
    module2.exports = {
      symlinkType: u(symlinkType),
      symlinkTypeSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/symlink.js
var require_symlink = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/symlink.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var path3 = require("path");
    var fs3 = require_fs();
    var { mkdirs, mkdirsSync } = require_mkdirs();
    var { symlinkPaths, symlinkPathsSync } = require_symlink_paths();
    var { symlinkType, symlinkTypeSync } = require_symlink_type();
    var { pathExists } = require_path_exists();
    var { areIdentical } = require_stat();
    async function createSymlink(srcpath, dstpath, type) {
      let stats;
      try {
        stats = await fs3.lstat(dstpath);
      } catch {
      }
      if (stats && stats.isSymbolicLink()) {
        const [srcStat, dstStat] = await Promise.all([
          fs3.stat(srcpath),
          fs3.stat(dstpath)
        ]);
        if (areIdentical(srcStat, dstStat)) return;
      }
      const relative = await symlinkPaths(srcpath, dstpath);
      srcpath = relative.toDst;
      const toType = await symlinkType(relative.toCwd, type);
      const dir = path3.dirname(dstpath);
      if (!await pathExists(dir)) {
        await mkdirs(dir);
      }
      return fs3.symlink(srcpath, dstpath, toType);
    }
    function createSymlinkSync(srcpath, dstpath, type) {
      let stats;
      try {
        stats = fs3.lstatSync(dstpath);
      } catch {
      }
      if (stats && stats.isSymbolicLink()) {
        const srcStat = fs3.statSync(srcpath);
        const dstStat = fs3.statSync(dstpath);
        if (areIdentical(srcStat, dstStat)) return;
      }
      const relative = symlinkPathsSync(srcpath, dstpath);
      srcpath = relative.toDst;
      type = symlinkTypeSync(relative.toCwd, type);
      const dir = path3.dirname(dstpath);
      const exists = fs3.existsSync(dir);
      if (exists) return fs3.symlinkSync(srcpath, dstpath, type);
      mkdirsSync(dir);
      return fs3.symlinkSync(srcpath, dstpath, type);
    }
    module2.exports = {
      createSymlink: u(createSymlink),
      createSymlinkSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/index.js
var require_ensure = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/ensure/index.js"(exports2, module2) {
    "use strict";
    var { createFile, createFileSync } = require_file();
    var { createLink, createLinkSync } = require_link();
    var { createSymlink, createSymlinkSync } = require_symlink();
    module2.exports = {
      // file
      createFile,
      createFileSync,
      ensureFile: createFile,
      ensureFileSync: createFileSync,
      // link
      createLink,
      createLinkSync,
      ensureLink: createLink,
      ensureLinkSync: createLinkSync,
      // symlink
      createSymlink,
      createSymlinkSync,
      ensureSymlink: createSymlink,
      ensureSymlinkSync: createSymlinkSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/jsonfile/utils.js
var require_utils2 = __commonJS({
  "../../../../git/foxwarm/node_modules/jsonfile/utils.js"(exports2, module2) {
    function stringify(obj, { EOL = "\n", finalEOL = true, replacer = null, spaces } = {}) {
      const EOF = finalEOL ? EOL : "";
      const str = JSON.stringify(obj, replacer, spaces);
      return str.replace(/\n/g, EOL) + EOF;
    }
    function stripBom(content) {
      if (Buffer.isBuffer(content)) content = content.toString("utf8");
      return content.replace(/^\uFEFF/, "");
    }
    module2.exports = { stringify, stripBom };
  }
});

// ../../../../git/foxwarm/node_modules/jsonfile/index.js
var require_jsonfile = __commonJS({
  "../../../../git/foxwarm/node_modules/jsonfile/index.js"(exports2, module2) {
    var _fs;
    try {
      _fs = require_graceful_fs();
    } catch (_) {
      _fs = require("fs");
    }
    var universalify = require_universalify();
    var { stringify, stripBom } = require_utils2();
    async function _readFile(file, options = {}) {
      if (typeof options === "string") {
        options = { encoding: options };
      }
      const fs3 = options.fs || _fs;
      const shouldThrow = "throws" in options ? options.throws : true;
      let data = await universalify.fromCallback(fs3.readFile)(file, options);
      data = stripBom(data);
      let obj;
      try {
        obj = JSON.parse(data, options ? options.reviver : null);
      } catch (err) {
        if (shouldThrow) {
          err.message = `${file}: ${err.message}`;
          throw err;
        } else {
          return null;
        }
      }
      return obj;
    }
    var readFile = universalify.fromPromise(_readFile);
    function readFileSync(file, options = {}) {
      if (typeof options === "string") {
        options = { encoding: options };
      }
      const fs3 = options.fs || _fs;
      const shouldThrow = "throws" in options ? options.throws : true;
      try {
        let content = fs3.readFileSync(file, options);
        content = stripBom(content);
        return JSON.parse(content, options.reviver);
      } catch (err) {
        if (shouldThrow) {
          err.message = `${file}: ${err.message}`;
          throw err;
        } else {
          return null;
        }
      }
    }
    async function _writeFile(file, obj, options = {}) {
      const fs3 = options.fs || _fs;
      const str = stringify(obj, options);
      await universalify.fromCallback(fs3.writeFile)(file, str, options);
    }
    var writeFile = universalify.fromPromise(_writeFile);
    function writeFileSync(file, obj, options = {}) {
      const fs3 = options.fs || _fs;
      const str = stringify(obj, options);
      return fs3.writeFileSync(file, str, options);
    }
    module2.exports = {
      readFile,
      readFileSync,
      writeFile,
      writeFileSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/json/jsonfile.js
var require_jsonfile2 = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/json/jsonfile.js"(exports2, module2) {
    "use strict";
    var jsonFile = require_jsonfile();
    module2.exports = {
      // jsonfile exports
      readJson: jsonFile.readFile,
      readJsonSync: jsonFile.readFileSync,
      writeJson: jsonFile.writeFile,
      writeJsonSync: jsonFile.writeFileSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/output-file/index.js
var require_output_file = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/output-file/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var fs3 = require_fs();
    var path3 = require("path");
    var mkdir = require_mkdirs();
    var pathExists = require_path_exists().pathExists;
    async function outputFile(file, data, encoding = "utf-8") {
      const dir = path3.dirname(file);
      if (!await pathExists(dir)) {
        await mkdir.mkdirs(dir);
      }
      return fs3.writeFile(file, data, encoding);
    }
    function outputFileSync(file, ...args) {
      const dir = path3.dirname(file);
      if (!fs3.existsSync(dir)) {
        mkdir.mkdirsSync(dir);
      }
      fs3.writeFileSync(file, ...args);
    }
    module2.exports = {
      outputFile: u(outputFile),
      outputFileSync
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/json/output-json.js
var require_output_json = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/json/output-json.js"(exports2, module2) {
    "use strict";
    var { stringify } = require_utils2();
    var { outputFile } = require_output_file();
    async function outputJson(file, data, options = {}) {
      const str = stringify(data, options);
      await outputFile(file, str, options);
    }
    module2.exports = outputJson;
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/json/output-json-sync.js
var require_output_json_sync = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/json/output-json-sync.js"(exports2, module2) {
    "use strict";
    var { stringify } = require_utils2();
    var { outputFileSync } = require_output_file();
    function outputJsonSync(file, data, options) {
      const str = stringify(data, options);
      outputFileSync(file, str, options);
    }
    module2.exports = outputJsonSync;
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/json/index.js
var require_json = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/json/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    var jsonFile = require_jsonfile2();
    jsonFile.outputJson = u(require_output_json());
    jsonFile.outputJsonSync = require_output_json_sync();
    jsonFile.outputJSON = jsonFile.outputJson;
    jsonFile.outputJSONSync = jsonFile.outputJsonSync;
    jsonFile.writeJSON = jsonFile.writeJson;
    jsonFile.writeJSONSync = jsonFile.writeJsonSync;
    jsonFile.readJSON = jsonFile.readJson;
    jsonFile.readJSONSync = jsonFile.readJsonSync;
    module2.exports = jsonFile;
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/move/move.js
var require_move = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/move/move.js"(exports2, module2) {
    "use strict";
    var fs3 = require_fs();
    var path3 = require("path");
    var { copy } = require_copy2();
    var { remove } = require_remove();
    var { mkdirp } = require_mkdirs();
    var { pathExists } = require_path_exists();
    var stat = require_stat();
    async function move(src, dest, opts = {}) {
      const overwrite = opts.overwrite || opts.clobber || false;
      const { srcStat, isChangingCase = false } = await stat.checkPaths(src, dest, "move", opts);
      await stat.checkParentPaths(src, srcStat, dest, "move");
      const destParent = path3.dirname(dest);
      const parsedParentPath = path3.parse(destParent);
      if (parsedParentPath.root !== destParent) {
        await mkdirp(destParent);
      }
      return doRename(src, dest, overwrite, isChangingCase);
    }
    async function doRename(src, dest, overwrite, isChangingCase) {
      if (!isChangingCase) {
        if (overwrite) {
          await remove(dest);
        } else if (await pathExists(dest)) {
          throw new Error("dest already exists.");
        }
      }
      try {
        await fs3.rename(src, dest);
      } catch (err) {
        if (err.code !== "EXDEV") {
          throw err;
        }
        await moveAcrossDevice(src, dest, overwrite);
      }
    }
    async function moveAcrossDevice(src, dest, overwrite) {
      const opts = {
        overwrite,
        errorOnExist: true,
        preserveTimestamps: true
      };
      await copy(src, dest, opts);
      return remove(src);
    }
    module2.exports = move;
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/move/move-sync.js
var require_move_sync = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/move/move-sync.js"(exports2, module2) {
    "use strict";
    var fs3 = require_graceful_fs();
    var path3 = require("path");
    var copySync = require_copy2().copySync;
    var removeSync = require_remove().removeSync;
    var mkdirpSync = require_mkdirs().mkdirpSync;
    var stat = require_stat();
    function moveSync(src, dest, opts) {
      opts = opts || {};
      const overwrite = opts.overwrite || opts.clobber || false;
      const { srcStat, isChangingCase = false } = stat.checkPathsSync(src, dest, "move", opts);
      stat.checkParentPathsSync(src, srcStat, dest, "move");
      if (!isParentRoot(dest)) mkdirpSync(path3.dirname(dest));
      return doRename(src, dest, overwrite, isChangingCase);
    }
    function isParentRoot(dest) {
      const parent = path3.dirname(dest);
      const parsedPath = path3.parse(parent);
      return parsedPath.root === parent;
    }
    function doRename(src, dest, overwrite, isChangingCase) {
      if (isChangingCase) return rename(src, dest, overwrite);
      if (overwrite) {
        removeSync(dest);
        return rename(src, dest, overwrite);
      }
      if (fs3.existsSync(dest)) throw new Error("dest already exists.");
      return rename(src, dest, overwrite);
    }
    function rename(src, dest, overwrite) {
      try {
        fs3.renameSync(src, dest);
      } catch (err) {
        if (err.code !== "EXDEV") throw err;
        return moveAcrossDevice(src, dest, overwrite);
      }
    }
    function moveAcrossDevice(src, dest, overwrite) {
      const opts = {
        overwrite,
        errorOnExist: true,
        preserveTimestamps: true
      };
      copySync(src, dest, opts);
      return removeSync(src);
    }
    module2.exports = moveSync;
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/move/index.js
var require_move2 = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/move/index.js"(exports2, module2) {
    "use strict";
    var u = require_universalify().fromPromise;
    module2.exports = {
      move: u(require_move()),
      moveSync: require_move_sync()
    };
  }
});

// ../../../../git/foxwarm/node_modules/fs-extra/lib/index.js
var require_lib = __commonJS({
  "../../../../git/foxwarm/node_modules/fs-extra/lib/index.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      // Export promiseified graceful-fs:
      ...require_fs(),
      // Export extra methods:
      ...require_copy2(),
      ...require_empty(),
      ...require_ensure(),
      ...require_json(),
      ...require_mkdirs(),
      ...require_move2(),
      ...require_output_file(),
      ...require_path_exists(),
      ...require_remove()
    };
  }
});

// ../shared/dist/applyPatch.js
var require_applyPatch = __commonJS({
  "../shared/dist/applyPatch.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.extractPatchEnvelope = extractPatchEnvelope;
    exports2.parseApplyPatchInput = parseApplyPatchInput2;
    exports2.applyUpdatePatch = applyUpdatePatch;
    exports2.buildAddedFileContent = buildAddedFileContent;
    exports2.countApplyPatchOperationLines = countApplyPatchOperationLines;
    exports2.formatApplyPatchOperationSummary = formatApplyPatchOperationSummary;
    var END_PATCH = "*** End Patch";
    var END_FILE = "*** End of File";
    var FORMAT_HINT = `Expected apply_patch format:
*** Begin Patch
*** Update File: <path>
@@ optional anchor
 context line (prefix with space)
-line to delete
+line to insert
*** Add File: <path>
+new file content line
*** Delete File: <path>
*** End Patch
For Update File: context lines start with space, deletions with '-', insertions with '+'. Use '@@' to start a new section. See the apply_patch tool description for full details.`;
    var FILE_HEADER_PREFIXES = [
      "*** Update File: ",
      "*** Add File: ",
      "*** Delete File: "
    ];
    var UPDATE_SECTION_TERMINATORS = [END_PATCH, END_FILE];
    function isFileHeader(line) {
      return FILE_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix));
    }
    function normalizeNewlines(text) {
      return text.replace(/\r\n/g, "\n");
    }
    function extractPatchEnvelope(input) {
      const normalized = normalizeNewlines(input);
      const trimmed = normalized.trim();
      const beginIndex = normalized.indexOf("*** Begin Patch");
      const endIndex = normalized.lastIndexOf(END_PATCH);
      if (beginIndex !== -1 || endIndex !== -1) {
        if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
          throw new Error("Invalid apply_patch input: malformed patch envelope.");
        }
        return normalized.slice(beginIndex, endIndex + END_PATCH.length).trim();
      }
      if (trimmed) {
        const lines = trimmed.split("\n");
        if (isFileHeader(lines[0])) {
          return ["*** Begin Patch", trimmed, END_PATCH].join("\n");
        }
      }
      if (!trimmed) {
        throw new Error(`Invalid apply_patch input: missing *** Begin Patch / *** End Patch envelope.
${FORMAT_HINT}`);
      }
      throw new Error(`Invalid apply_patch input: missing *** Begin Patch / *** End Patch envelope, or bare patch must start with *** Update File: / *** Add File: / *** Delete File:.
${FORMAT_HINT}`);
    }
    function parseApplyPatchInput2(input) {
      const envelope = extractPatchEnvelope(input);
      const lines = envelope.split("\n");
      if (lines[0] !== "*** Begin Patch" || lines[lines.length - 1] !== END_PATCH) {
        throw new Error("Invalid apply_patch input: malformed patch envelope.");
      }
      const body = lines.slice(1, -1);
      const operations = [];
      let i = 0;
      while (i < body.length) {
        while (i < body.length && body[i].trim() === "")
          i++;
        if (i >= body.length)
          break;
        const line = body[i];
        const match = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
        if (!match) {
          throw new Error(`Invalid apply_patch input: expected file action header (*** Update File: / *** Add File: / *** Delete File:), got: ${line}
${FORMAT_HINT}`);
        }
        const action = match[1].toLowerCase();
        const filePath = match[2].trim();
        i++;
        const sectionLines = [];
        while (i < body.length && !isFileHeader(body[i])) {
          sectionLines.push(body[i]);
          i++;
        }
        if (action === "update") {
          operations.push({ action, filePath, lines: parseUpdateSection(sectionLines, filePath) });
        } else if (action === "add") {
          operations.push({ action, filePath, lines: parseAddSection(sectionLines, filePath) });
        } else {
          if (sectionLines.some((lineText) => lineText.trim() !== "")) {
            throw new Error(`Invalid apply_patch input for ${filePath}: delete section should not contain body lines.`);
          }
          operations.push({ action, filePath });
        }
      }
      if (operations.length === 0) {
        throw new Error("Invalid apply_patch input: patch contains no file operations.");
      }
      return operations;
    }
    function parseUpdateSection(lines, filePath) {
      if (lines.length === 0) {
        throw new Error(`Invalid apply_patch input for ${filePath}: update section must include patch lines.`);
      }
      if (!lines.some((line) => line.startsWith("+") || line.startsWith("-"))) {
        throw new Error(`Invalid apply_patch input for ${filePath}: update section must include at least one changed line.`);
      }
      return lines;
    }
    function parseAddSection(lines, filePath) {
      const contentLines = [];
      for (const line of lines) {
        if (!line.startsWith("+")) {
          throw new Error(`Invalid apply_patch input for ${filePath}: add file lines must start with '+'.`);
        }
        contentLines.push(line.slice(1));
      }
      return contentLines;
    }
    function getLineEnding(text) {
      return text.includes("\r\n") ? "\r\n" : "\n";
    }
    function restoreLineEndings(text, lineEnding) {
      return lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
    }
    function isDone(state, prefixes) {
      if (state.index >= state.lines.length)
        return true;
      return prefixes.some((prefix) => state.lines[state.index]?.startsWith(prefix));
    }
    function readStr(state, prefix) {
      const current = state.lines[state.index];
      if (typeof current === "string" && current.startsWith(prefix)) {
        state.index += 1;
        return current.slice(prefix.length);
      }
      return "";
    }
    function advanceCursorToAnchor(anchor, inputLines, cursor, parser) {
      let found = false;
      if (!inputLines.slice(0, cursor).some((line) => line === anchor)) {
        for (let i = cursor; i < inputLines.length; i += 1) {
          if (inputLines[i] === anchor) {
            cursor = i + 1;
            found = true;
            break;
          }
        }
      }
      if (!found && !inputLines.slice(0, cursor).some((line) => line.trim() === anchor.trim())) {
        for (let i = cursor; i < inputLines.length; i += 1) {
          if (inputLines[i].trim() === anchor.trim()) {
            cursor = i + 1;
            parser.fuzz += 1;
            found = true;
            break;
          }
        }
      }
      return cursor;
    }
    function readSection(lines, startIndex, filePath) {
      const context = [];
      let delLines = [];
      let insLines = [];
      const sectionChunks = [];
      let mode = "keep";
      let index = startIndex;
      const origIndex = index;
      while (index < lines.length) {
        const raw = lines[index];
        if (raw.startsWith("@@") || raw.startsWith(END_PATCH) || raw.startsWith(END_FILE)) {
          break;
        }
        if (raw === "***")
          break;
        if (raw.startsWith("***")) {
          throw new Error(`Invalid apply_patch input for ${filePath}: invalid line: ${raw}
${FORMAT_HINT}`);
        }
        index += 1;
        const lastMode = mode;
        let line = raw;
        if (line === "")
          line = " ";
        if (line[0] === "+") {
          mode = "add";
        } else if (line[0] === "-") {
          mode = "delete";
        } else if (line[0] === " ") {
          mode = "keep";
        } else {
          throw new Error(`Invalid apply_patch input for ${filePath}: invalid line: ${line}. Each line must start with ' ' (context), '-' (delete), or '+' (insert).
${FORMAT_HINT}`);
        }
        line = line.slice(1);
        const switchingToContext = mode === "keep" && lastMode !== mode;
        if (switchingToContext && (insLines.length > 0 || delLines.length > 0)) {
          sectionChunks.push({
            origIndex: context.length - delLines.length,
            delLines,
            insLines
          });
          delLines = [];
          insLines = [];
        }
        if (mode === "delete") {
          delLines.push(line);
          context.push(line);
        } else if (mode === "add") {
          insLines.push(line);
        } else {
          context.push(line);
        }
      }
      if (insLines.length > 0 || delLines.length > 0) {
        sectionChunks.push({
          origIndex: context.length - delLines.length,
          delLines,
          insLines
        });
      }
      if (index < lines.length && lines[index] === END_FILE) {
        index += 1;
        return { nextContext: context, sectionChunks, endIndex: index, eof: true };
      }
      if (index === origIndex) {
        throw new Error(`Invalid apply_patch input for ${filePath}: empty update section near line ${index + 1}.`);
      }
      return { nextContext: context, sectionChunks, endIndex: index, eof: false };
    }
    function equalsSlice(source, target, start, mapFn) {
      if (start + target.length > source.length)
        return false;
      for (let i = 0; i < target.length; i += 1) {
        if (mapFn(source[start + i]) !== mapFn(target[i]))
          return false;
      }
      return true;
    }
    function findContextCore(lines, context, start) {
      if (context.length === 0) {
        return { newIndex: start, fuzz: 0 };
      }
      for (let i = start; i < lines.length; i += 1) {
        if (equalsSlice(lines, context, i, (value) => value)) {
          return { newIndex: i, fuzz: 0 };
        }
      }
      for (let i = start; i < lines.length; i += 1) {
        if (equalsSlice(lines, context, i, (value) => value.trimEnd())) {
          return { newIndex: i, fuzz: 1 };
        }
      }
      for (let i = start; i < lines.length; i += 1) {
        if (equalsSlice(lines, context, i, (value) => value.trim())) {
          return { newIndex: i, fuzz: 100 };
        }
      }
      return { newIndex: -1, fuzz: 0 };
    }
    function findContext(lines, context, start, eof) {
      if (eof) {
        const endStart = Math.max(0, lines.length - context.length);
        const endMatch = findContextCore(lines, context, endStart);
        if (endMatch.newIndex !== -1)
          return endMatch;
        const fallback = findContextCore(lines, context, start);
        return { newIndex: fallback.newIndex, fuzz: fallback.fuzz + 1e4 };
      }
      return findContextCore(lines, context, start);
    }
    function parseUpdateDiff(lines, input, filePath) {
      const parser = {
        lines: [...lines, END_PATCH],
        index: 0,
        fuzz: 0
      };
      const inputLines = input.split("\n");
      const chunks = [];
      let cursor = 0;
      while (!isDone(parser, UPDATE_SECTION_TERMINATORS)) {
        const anchor = readStr(parser, "@@ ");
        const hasBareAnchor = !anchor && parser.lines[parser.index] === "@@";
        if (hasBareAnchor)
          parser.index += 1;
        if (!(anchor || hasBareAnchor || cursor === 0)) {
          throw new Error(`Invalid apply_patch input for ${filePath}: expected '@@' before line: ${parser.lines[parser.index]}`);
        }
        if (anchor.trim()) {
          cursor = advanceCursorToAnchor(anchor, inputLines, cursor, parser);
        }
        const { nextContext, sectionChunks, endIndex, eof } = readSection(parser.lines, parser.index, filePath);
        const nextContextText = nextContext.join("\n");
        const { newIndex, fuzz } = findContext(inputLines, nextContext, cursor, eof);
        if (newIndex === -1) {
          if (eof) {
            throw new Error(`Could not match EOF context while patching ${filePath} starting at line ${cursor + 1}:
${nextContextText}`);
          }
          throw new Error(`Could not match patch context while patching ${filePath} starting at line ${cursor + 1}:
${nextContextText}`);
        }
        parser.fuzz += fuzz;
        for (const chunk of sectionChunks) {
          chunks.push({ ...chunk, origIndex: chunk.origIndex + newIndex });
        }
        cursor = newIndex + nextContext.length;
        parser.index = endIndex;
      }
      return { chunks, fuzz: parser.fuzz };
    }
    function applyChunks(input, chunks, filePath) {
      const origLines = input.split("\n");
      const destLines = [];
      let origIndex = 0;
      for (const chunk of chunks) {
        if (chunk.origIndex > origLines.length) {
          throw new Error(`apply_patch failed for ${filePath}: chunk starts past end of file (${chunk.origIndex} > ${origLines.length}).`);
        }
        if (origIndex > chunk.origIndex) {
          throw new Error(`apply_patch failed for ${filePath}: overlapping chunk at ${chunk.origIndex} (cursor ${origIndex}).`);
        }
        destLines.push(...origLines.slice(origIndex, chunk.origIndex));
        origIndex = chunk.origIndex;
        if (chunk.insLines.length > 0) {
          destLines.push(...chunk.insLines);
        }
        origIndex += chunk.delLines.length;
      }
      destLines.push(...origLines.slice(origIndex));
      return destLines.join("\n");
    }
    function applyUpdatePatch(content, lines, filePath) {
      const lineEnding = getLineEnding(content);
      const normalizedContent = normalizeNewlines(content);
      const { chunks } = parseUpdateDiff(lines, normalizedContent, filePath);
      const updated = applyChunks(normalizedContent, chunks, filePath);
      return restoreLineEndings(updated, lineEnding);
    }
    function buildAddedFileContent(lines) {
      return lines.join("\n");
    }
    function countApplyPatchOperationLines(operation) {
      if (operation.action === "add") {
        return { added: operation.lines.length, deleted: 0 };
      }
      if (operation.action === "delete") {
        return { added: 0, deleted: 0 };
      }
      let added = 0;
      let deleted = 0;
      for (const line of operation.lines) {
        if (line.startsWith("+"))
          added += 1;
        if (line.startsWith("-"))
          deleted += 1;
      }
      return { added, deleted };
    }
    function formatApplyPatchOperationSummary(operation, displayPath = operation.filePath) {
      if (operation.action === "delete") {
        return `Deleted ${displayPath}`;
      }
      const counts = countApplyPatchOperationLines(operation);
      if (operation.action === "add") {
        return `Added ${displayPath} (+${counts.added})`;
      }
      return `Updated ${displayPath} (+${counts.added} -${counts.deleted})`;
    }
  }
});

// ../shared/dist/nodeFileTransfer.js
var require_nodeFileTransfer = __commonJS({
  "../shared/dist/nodeFileTransfer.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getNodeAgentDir = getNodeAgentDir;
    exports2.resolveNodePath = resolveNodePath;
    exports2.resolveNodeTransferPath = resolveNodeTransferPath;
    exports2.detectTransferMimeType = detectTransferMimeType;
    exports2.readNodeTransferFile = readNodeTransferFile;
    exports2.writeNodeTransferFile = writeNodeTransferFile;
    var crypto_1 = __importDefault(require("crypto"));
    var fs_extra_1 = __importDefault(require_lib());
    var os_1 = __importDefault(require("os"));
    var path_1 = __importDefault(require("path"));
    var IMAGE_MIME = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml"
    };
    var GENERIC_MIME = {
      ".json": "application/json",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".yaml": "application/yaml",
      ".yml": "application/yaml",
      ".ts": "text/plain",
      ".js": "text/plain",
      ".sh": "text/plain"
    };
    function expandHomePath(filePath) {
      if (filePath === "~")
        return os_1.default.homedir();
      if (filePath.startsWith("~/") || filePath.startsWith("~\\"))
        return path_1.default.join(os_1.default.homedir(), filePath.slice(2));
      return filePath;
    }
    function getNodeAgentDir(agentName = "main") {
      const explicit = process.env.FOXWARM_AGENT_DIR?.trim();
      if (explicit)
        return path_1.default.resolve(expandHomePath(explicit));
      const agentsDir = process.env.FOXWARM_AGENTS_DIR?.trim();
      if (agentsDir)
        return path_1.default.resolve(expandHomePath(agentsDir), agentName);
      return path_1.default.resolve(process.cwd(), "agents", agentName);
    }
    function resolveNodePath(filePath, agentName = "main", sessionCwd) {
      if (!filePath || typeof filePath !== "string")
        throw new Error("filePath is required");
      const expandedPath = expandHomePath(filePath);
      if (path_1.default.isAbsolute(expandedPath))
        return path_1.default.resolve(expandedPath);
      const base = typeof sessionCwd === "string" && sessionCwd.trim() ? expandHomePath(sessionCwd.trim()) : getNodeAgentDir(agentName);
      return path_1.default.resolve(base, expandedPath);
    }
    function resolveNodeTransferPath(filePath, agentName, restrictToAgentDir = true) {
      const agentDir = getNodeAgentDir(agentName);
      const resolved = resolveNodePath(filePath, agentName);
      if (restrictToAgentDir && !(resolved === agentDir || resolved.startsWith(agentDir + path_1.default.sep))) {
        throw new Error("Path traversal detected: cannot access files outside agent folder");
      }
      return resolved;
    }
    function detectTransferMimeType(filePath) {
      const ext = path_1.default.extname(filePath).toLowerCase();
      if (IMAGE_MIME[ext])
        return { mimeType: IMAGE_MIME[ext], isImage: true };
      return { mimeType: GENERIC_MIME[ext] || "application/octet-stream", isImage: false };
    }
    async function readNodeTransferFile(filePath, agentName, restrictToAgentDir = true) {
      const fullPath = resolveNodeTransferPath(filePath, agentName, restrictToAgentDir);
      const stats = await fs_extra_1.default.stat(fullPath);
      if (!stats.isFile())
        throw new Error(`Not a file: ${filePath}`);
      const buffer = await fs_extra_1.default.readFile(fullPath);
      const { mimeType, isImage } = detectTransferMimeType(filePath);
      return { filePath, name: path_1.default.basename(filePath), sizeBytes: buffer.length, mimeType, isImage, sha256: crypto_1.default.createHash("sha256").update(buffer).digest("hex"), dataBase64: buffer.toString("base64") };
    }
    async function writeNodeTransferFile(filePath, agentName, dataBase64, overwrite = false, restrictToAgentDir = true) {
      if (typeof dataBase64 !== "string")
        throw new Error("dataBase64 is required");
      const fullPath = resolveNodeTransferPath(filePath, agentName, restrictToAgentDir);
      const exists = await fs_extra_1.default.pathExists(fullPath);
      if (exists && !overwrite)
        throw new Error(`File already exists: ${filePath}. Use overwrite=true to replace it.`);
      const buffer = Buffer.from(dataBase64, "base64");
      await fs_extra_1.default.ensureDir(path_1.default.dirname(fullPath));
      const tempPath = `${fullPath}.${process.pid}.${crypto_1.default.randomBytes(6).toString("hex")}.tmp`;
      try {
        await fs_extra_1.default.writeFile(tempPath, buffer, { flag: "wx" });
        if (overwrite) {
          await fs_extra_1.default.rename(tempPath, fullPath);
        } else {
          await fs_extra_1.default.link(tempPath, fullPath);
          await fs_extra_1.default.remove(tempPath);
        }
      } finally {
        await fs_extra_1.default.remove(tempPath).catch(() => {
        });
      }
      return { filePath, absolutePath: fullPath, sizeBytes: buffer.length, sha256: crypto_1.default.createHash("sha256").update(buffer).digest("hex"), overwritten: exists };
    }
  }
});

// ../shared/dist/boundedTextExcerpt.js
var require_boundedTextExcerpt = __commonJS({
  "../shared/dist/boundedTextExcerpt.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.BINARY_HEX_PREVIEW_BYTES = exports2.BOUNDED_TEXT_SAMPLE_BYTES = exports2.MAX_FULL_TEXT_READ_BYTES = void 0;
    exports2.readBoundedFileSamples = readBoundedFileSamples;
    exports2.analyzeBoundedTextSample = analyzeBoundedTextSample;
    exports2.renderBoundedTextSample = renderBoundedTextSample;
    exports2.buildBoundedTextExcerpt = buildBoundedTextExcerpt;
    exports2.formatBoundedBinaryHexPreview = formatBoundedBinaryHexPreview;
    exports2.formatDisplayByteConversionDisclaimer = formatDisplayByteConversionDisclaimer;
    var promises_1 = require("fs/promises");
    exports2.MAX_FULL_TEXT_READ_BYTES = 1024 * 1024;
    exports2.BOUNDED_TEXT_SAMPLE_BYTES = 5e3;
    exports2.BINARY_HEX_PREVIEW_BYTES = 64;
    async function readBoundedFileSamples(filePath, byteLength) {
      const sampleLength = Math.min(exports2.BOUNDED_TEXT_SAMPLE_BYTES, byteLength);
      const file = await (0, promises_1.open)(filePath, "r");
      try {
        const readAt = async (position) => {
          const buffer = Buffer.alloc(sampleLength);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
          return buffer.subarray(0, bytesRead);
        };
        return {
          head: await readAt(0),
          tail: await readAt(Math.max(0, byteLength - sampleLength))
        };
      } finally {
        await file.close();
      }
    }
    function analyzeBoundedTextSample(sample, options) {
      const escapedByteIndexes = /* @__PURE__ */ new Set();
      let suspiciousByteCount = 0;
      const mark = (start, count, suspicious, escapeForDisplay) => {
        if (escapeForDisplay) {
          for (let index2 = start; index2 < start + count; index2 += 1)
            escapedByteIndexes.add(index2);
        }
        if (suspicious)
          suspiciousByteCount += count;
      };
      const isContinuation = (byte) => byte >= 128 && byte <= 191;
      let index = 0;
      while (options.allowLeadingBoundaryContinuation && index < Math.min(3, sample.length) && isContinuation(sample[index])) {
        mark(index, 1, false, true);
        index += 1;
      }
      while (index < sample.length) {
        const byte = sample[index];
        if (byte <= 127) {
          if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 || byte === 127)
            mark(index, 1, true, false);
          index += 1;
          continue;
        }
        const width = byte >= 194 && byte <= 223 ? 2 : byte >= 224 && byte <= 239 ? 3 : byte >= 240 && byte <= 244 ? 4 : 0;
        if (width === 0) {
          mark(index, 1, true, true);
          index += 1;
          continue;
        }
        if (index + width > sample.length) {
          mark(index, sample.length - index, !options.allowTrailingBoundarySequence, true);
          break;
        }
        let codePoint = byte & (width === 2 ? 31 : width === 3 ? 15 : 7);
        let valid = true;
        for (let offset = 1; offset < width; offset += 1) {
          const continuation = sample[index + offset];
          if (!isContinuation(continuation)) {
            valid = false;
            break;
          }
          codePoint = codePoint << 6 | continuation & 63;
        }
        const minimum = width === 2 ? 128 : width === 3 ? 2048 : 65536;
        if (!valid || codePoint < minimum || codePoint > 1114111 || codePoint >= 55296 && codePoint <= 57343) {
          mark(index, 1, true, true);
          index += 1;
          continue;
        }
        if (codePoint >= 128 && codePoint <= 159)
          mark(index, width, true, false);
        index += width;
      }
      return { suspiciousByteCount, escapedByteIndexes };
    }
    function renderBoundedTextSample(sample, analysis) {
      const parts = [];
      let segmentStart = 0;
      let escapedByteCount = 0;
      for (let index = 0; index < sample.length; index += 1) {
        if (!analysis.escapedByteIndexes.has(index))
          continue;
        if (segmentStart < index)
          parts.push(sample.subarray(segmentStart, index).toString("utf8"));
        parts.push(`\\x${sample[index].toString(16).padStart(2, "0")}`);
        segmentStart = index + 1;
        escapedByteCount += 1;
      }
      if (segmentStart < sample.length)
        parts.push(sample.subarray(segmentStart).toString("utf8"));
      return { text: parts.join(""), escapedByteCount };
    }
    function buildBoundedTextExcerpt(head, tail, options) {
      const headAnalysis = analyzeBoundedTextSample(head, {
        allowLeadingBoundaryContinuation: false,
        allowTrailingBoundarySequence: options.headMayEndMidCodePoint
      });
      const tailAnalysis = analyzeBoundedTextSample(tail, {
        allowLeadingBoundaryContinuation: options.tailMayStartMidCodePoint,
        allowTrailingBoundarySequence: false
      });
      const sampledByteCount = head.length + tail.length;
      const suspiciousByteCount = headAnalysis.suspiciousByteCount + tailAnalysis.suspiciousByteCount;
      if (suspiciousByteCount > sampledByteCount * 0.1) {
        return { isBinary: true, suspiciousByteCount, sampledByteCount, escapedByteCount: 0 };
      }
      const renderedHead = renderBoundedTextSample(head, headAnalysis);
      const renderedTail = renderBoundedTextSample(tail, tailAnalysis);
      return {
        isBinary: false,
        suspiciousByteCount,
        sampledByteCount,
        renderedHead: renderedHead.text,
        renderedTail: renderedTail.text,
        escapedByteCount: renderedHead.escapedByteCount + renderedTail.escapedByteCount
      };
    }
    function formatBoundedBinaryHexPreview(head, tail, byteLength, subject, byteSource = "file") {
      const toHex = (sample) => sample.subarray(0, exports2.BINARY_HEX_PREVIEW_BYTES).toString("hex");
      return [
        `[foxwarm: ${subject} appears binary; showing hexadecimal previews from a ${byteLength}-byte ${byteSource}]`,
        `Head (${Math.min(head.length, exports2.BINARY_HEX_PREVIEW_BYTES)} bytes): ${toHex(head)}`,
        `Tail (${Math.min(tail.length, exports2.BINARY_HEX_PREVIEW_BYTES)} bytes): ${toHex(tail)}`,
        "[foxwarm: raw binary content omitted; source file remains unchanged]"
      ].join("\n");
    }
    function formatDisplayByteConversionDisclaimer(subject) {
      return `Foxwarm \\xNN placeholders above are display conversions, not literal ${subject}.`;
    }
  }
});

// ../shared/dist/fileOperations.js
var require_fileOperations = __commonJS({
  "../shared/dist/fileOperations.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.nativeFileOperations = void 0;
    exports2.createNativeFileOperations = createNativeFileOperations2;
    exports2.fileOperationPathExists = fileOperationPathExists;
    exports2.readWholeFile = readWholeFile;
    var fs_extra_1 = __importDefault(require_lib());
    var node_path_1 = __importDefault(require("node:path"));
    var promises_1 = require("node:fs/promises");
    function kindOf(stats) {
      if (stats.isFile())
        return "file";
      if (stats.isDirectory())
        return "directory";
      if (stats.isSymbolicLink())
        return "symlink";
      return "other";
    }
    function createNativeFileOperations2() {
      return {
        async stat(filePath) {
          const stats = await fs_extra_1.default.stat(filePath);
          return { kind: kindOf(stats), size: stats.size, modifiedAtMs: stats.mtimeMs };
        },
        async read(filePath, offset, count) {
          if (!Number.isSafeInteger(offset) || offset < 0)
            throw new Error("File read offset must be a nonnegative safe integer.");
          if (!Number.isSafeInteger(count) || count < 0)
            throw new Error("File read count must be a nonnegative safe integer.");
          if (count === 0)
            return Buffer.alloc(0);
          const file = await (0, promises_1.open)(filePath, "r");
          const output = Buffer.alloc(count);
          let total = 0;
          try {
            while (total < count) {
              const { bytesRead } = await file.read(output, total, count - total, offset + total);
              if (bytesRead === 0)
                break;
              total += bytesRead;
            }
          } finally {
            await file.close();
          }
          return output.subarray(0, total);
        },
        async readdir(dirPath) {
          const names = await fs_extra_1.default.readdir(dirPath);
          const entries = [];
          for (const name of names) {
            const stats = await fs_extra_1.default.lstat(node_path_1.default.join(dirPath, name));
            entries.push({ name, kind: kindOf(stats), size: stats.size, modifiedAtMs: stats.mtimeMs });
          }
          return entries;
        },
        async write(filePath, content, flag) {
          await fs_extra_1.default.writeFile(filePath, content, { flag });
        },
        async mkdir(dirPath) {
          await fs_extra_1.default.ensureDir(dirPath);
        },
        async remove(filePath) {
          await fs_extra_1.default.remove(filePath);
        }
      };
    }
    exports2.nativeFileOperations = createNativeFileOperations2();
    async function fileOperationPathExists(operations, filePath) {
      try {
        await operations.stat(filePath);
        return true;
      } catch {
        return false;
      }
    }
    async function readWholeFile(operations, filePath) {
      const chunks = [];
      const chunkSize = 64 * 1024;
      let offset = 0;
      while (true) {
        const chunk = await operations.read(filePath, offset, chunkSize);
        if (chunk.length === 0)
          break;
        chunks.push(chunk);
        offset += chunk.length;
        if (chunk.length < chunkSize)
          break;
      }
      return Buffer.concat(chunks);
    }
  }
});

// ../shared/dist/fileToolCore.js
var require_fileToolCore = __commonJS({
  "../shared/dist/fileToolCore.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.formatWriteContentRefRetryHint = formatWriteContentRefRetryHint;
    exports2.normalizeOptionalLineBound = normalizeOptionalLineBound;
    exports2.readDirectoryListing = readDirectoryListing;
    exports2.getInlineImageMimeType = getInlineImageMimeType;
    exports2.readFileToolPath = readFileToolPath;
    exports2.findWriteParentIssue = findWriteParentIssue;
    exports2.formatWriteParentIssueMessage = formatWriteParentIssueMessage;
    exports2.ensureWriteParentReady = ensureWriteParentReady;
    exports2.writeFileToolPath = writeFileToolPath;
    var path_1 = __importDefault(require("path"));
    var boundedTextExcerpt_1 = require_boundedTextExcerpt();
    var fileOperations_1 = require_fileOperations();
    function formatWriteContentRefRetryHint(filePath, contentRef, createDirs = false) {
      const params = [
        `filePath: ${JSON.stringify(filePath)}`,
        `contentRef: ${JSON.stringify(contentRef)}`,
        "overwrite: true",
        ...createDirs ? ["createDirs: true"] : []
      ].join(", ");
      const action = createDirs ? "retry and create the missing parent directories" : "confirm overwriting";
      const replacementRequirements = createDirs ? "the desired `filePath` and `createDirs: true`" : "the desired `filePath` and `overwrite: true`";
      return ` The attempted content is already cached. Do not include or pass the \`content\` argument when using \`contentRef\`; it is unnecessary. To ${action}, call write({ ${params} }). The cached payload may instead be written to another authorized \`filePath\` in the same session/agent. If you intentionally want to correct or replace the attempted content instead, omit \`contentRef\` and call \`write\` with the new \`content\` plus ${replacementRequirements}. Never pass \`content\` and \`contentRef\` together.`;
    }
    var INLINE_IMAGE_MIME = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp"
    };
    function normalizeOptionalLineBound(value) {
      if (value === void 0 || value === null)
        return void 0;
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric === 0)
        return void 0;
      return numeric;
    }
    function normalizeDirectoryListingStartEnd(startLine, endLine, totalItems) {
      const normalizedStartLine = normalizeOptionalLineBound(startLine);
      const normalizedEndLine = normalizeOptionalLineBound(endLine);
      const startItem = normalizedStartLine !== void 0 ? Math.max(1, Math.floor(normalizedStartLine)) : 1;
      const endItem = normalizedEndLine !== void 0 ? Math.max(0, Math.floor(normalizedEndLine)) : Math.min(totalItems, startItem + 49);
      return { startItem, endItem };
    }
    function formatDirectoryListingLine(entry, itemNumber) {
      const name = entry.kind === "directory" ? `${entry.name}/` : entry.name;
      const sizeLabel = entry.kind === "file" ? `, ${entry.size} B` : "";
      const typeLabel = entry.kind === "directory" ? "dir" : entry.kind;
      return `${itemNumber}. \`${name}\` (${typeLabel}${sizeLabel}) - ${new Date(entry.modifiedAtMs).toISOString()}`;
    }
    async function readDirectoryListing(fullPath, displayPath, startLine, endLine, operations = fileOperations_1.nativeFileOperations) {
      const entries = await operations.readdir(fullPath);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const totalItems = entries.length;
      const { startItem, endItem } = normalizeDirectoryListingStartEnd(startLine, endLine, totalItems);
      const pageEntries = startItem <= endItem ? entries.slice(Math.max(0, startItem - 1), Math.min(totalItems, endItem)) : [];
      const lines = [`Directory listing for \`${displayPath}\``, ""];
      if (pageEntries.length === 0) {
        lines.push(totalItems === 0 ? "(empty directory)" : "(no items in requested range)");
      } else {
        lines.push(...pageEntries.map((entry, index) => formatDirectoryListingLine(entry, startItem + index)));
      }
      lines.push("");
      const shownStart = pageEntries.length > 0 ? startItem : 0;
      const shownEnd = pageEntries.length > 0 ? startItem + pageEntries.length - 1 : 0;
      const footer = [`Showing items ${shownStart}-${shownEnd} of ${totalItems}.`];
      const nextStart = startItem + pageEntries.length;
      if (nextStart <= totalItems) {
        const nextEnd = Math.min(totalItems, nextStart + 49);
        footer.push(`Next page: read({ filePath: ${JSON.stringify(displayPath)}, startLine: ${nextStart}, endLine: ${nextEnd} })`);
      }
      lines.push(footer.join(" "));
      return lines.join("\n");
    }
    function getInlineImageMimeType(filePath) {
      return INLINE_IMAGE_MIME[path_1.default.extname(filePath).toLowerCase()];
    }
    var RangeByteCollector = class {
      constructor() {
        this.totalBytes = 0;
        this.fullParts = [];
        this.head = Buffer.alloc(0);
        this.tail = Buffer.alloc(0);
      }
      append(part) {
        if (part.length === 0)
          return;
        this.totalBytes += part.length;
        if (this.fullParts) {
          this.fullParts.push(part);
          if (this.totalBytes > boundedTextExcerpt_1.MAX_FULL_TEXT_READ_BYTES)
            this.fullParts = null;
        }
        if (this.head.length < 5e3)
          this.head = Buffer.concat([this.head, part.subarray(0, 5e3 - this.head.length)]);
        this.tail = Buffer.concat([this.tail, part]).subarray(Math.max(0, this.tail.length + part.length - 5e3));
      }
      trimTrailingLf() {
        if (this.totalBytes === 0 || this.tail[this.tail.length - 1] !== 10)
          return;
        this.totalBytes -= 1;
        this.tail = this.tail.subarray(0, -1);
        if (this.totalBytes < 5e3)
          this.head = this.head.subarray(0, -1);
        if (this.fullParts?.length) {
          const last = this.fullParts.length - 1;
          this.fullParts[last] = this.fullParts[last].subarray(0, -1);
        }
      }
      fullBuffer() {
        return this.fullParts ? Buffer.concat(this.fullParts) : null;
      }
      samples() {
        return { head: this.head, tail: this.tail };
      }
    };
    async function readLineRangeBounded(operations, fullPath, sourceSize, startLine, endLine) {
      const selected = new RangeByteCollector();
      let line = 1;
      let offset = 0;
      let endedAtRequestedLine = false;
      outer: while (offset < sourceSize) {
        const buffer = await operations.read(fullPath, offset, Math.min(64 * 1024, sourceSize - offset));
        if (buffer.length === 0)
          break;
        offset += buffer.length;
        let segmentStart = -1;
        for (let index = 0; index < buffer.length; index += 1) {
          const include = line >= startLine && (endLine === void 0 || line <= endLine);
          if (include && segmentStart < 0)
            segmentStart = index;
          if (buffer[index] !== 10)
            continue;
          if (include && segmentStart >= 0) {
            selected.append(Buffer.from(buffer.subarray(segmentStart, index + 1)));
            segmentStart = -1;
          }
          if (endLine !== void 0 && line === endLine) {
            endedAtRequestedLine = true;
            break outer;
          }
          line += 1;
        }
        if (segmentStart >= 0)
          selected.append(Buffer.from(buffer.subarray(segmentStart)));
      }
      if (endedAtRequestedLine)
        selected.trimTrailingLf();
      return { selected, endedAtRequestedLine };
    }
    function formatBoundedFileRead(displayPath, originalFileSize, head, tail, selectedByteCount, label) {
      const excerpt = (0, boundedTextExcerpt_1.buildBoundedTextExcerpt)(head, tail, {
        headMayEndMidCodePoint: true,
        tailMayStartMidCodePoint: true
      });
      const conversionNote = excerpt.escapedByteCount > 0 ? `
${(0, boundedTextExcerpt_1.formatDisplayByteConversionDisclaimer)("file content")}` : "";
      const footer = `
---
File content was shortened for inline display.
Original file size: ${originalFileSize} bytes.
Complete content remains in source file: ${displayPath}.${conversionNote}`;
      if (excerpt.isBinary)
        return `${(0, boundedTextExcerpt_1.formatBoundedBinaryHexPreview)(head, tail, selectedByteCount, label, label === "selected file range" ? "selected range" : "file")}${footer}`;
      const escapedByteNote = excerpt.escapedByteCount > 0 ? `; escaped ${excerpt.escapedByteCount} byte(s)` : "";
      return [
        excerpt.renderedHead,
        `[foxwarm: ${label} middle omitted; showing bounded head and tail samples from ${selectedByteCount}-byte selected content${escapedByteNote}]`,
        excerpt.renderedTail
      ].join("\n") + footer;
    }
    async function readFileToolPath(fullPath, displayPath, startLine, endLine, operations = fileOperations_1.nativeFileOperations) {
      const stats = await operations.stat(fullPath);
      if (stats.kind === "directory") {
        return readDirectoryListing(fullPath, displayPath, startLine, endLine, operations);
      }
      const mimeType = getInlineImageMimeType(fullPath);
      if (mimeType) {
        const buffer = await operations.read(fullPath, 0, stats.size);
        return {
          output: `[Image loaded: ${displayPath}]`,
          mimeType,
          sizeBytes: buffer.length,
          inlineData: { data: buffer.toString("base64"), mimeType }
        };
      }
      const normalizedStartLine = normalizeOptionalLineBound(startLine);
      const normalizedEndLine = normalizeOptionalLineBound(endLine);
      if (stats.size > boundedTextExcerpt_1.MAX_FULL_TEXT_READ_BYTES) {
        if (normalizedStartLine !== void 0 || normalizedEndLine !== void 0) {
          const start = normalizedStartLine !== void 0 ? Math.max(1, Math.floor(normalizedStartLine)) : 1;
          const end = normalizedEndLine !== void 0 ? Math.max(0, Math.floor(normalizedEndLine)) : void 0;
          const { selected } = await readLineRangeBounded(operations, fullPath, stats.size, start, end);
          const fullSelected = selected.fullBuffer();
          if (fullSelected) {
            return `${fullSelected.toString("utf8")}
---
Original file size: ${stats.size} bytes.
Complete content remains in source file: ${displayPath}.`;
          }
          const { head: head2, tail: tail2 } = selected.samples();
          return formatBoundedFileRead(displayPath, stats.size, head2, tail2, selected.totalBytes, "selected file range");
        }
        const sampleLength = Math.min(5e3, stats.size);
        const head = await operations.read(fullPath, 0, sampleLength);
        const tail = await operations.read(fullPath, Math.max(0, stats.size - sampleLength), sampleLength);
        return formatBoundedFileRead(displayPath, stats.size, head, tail, stats.size, "file content");
      }
      let content = (await operations.read(fullPath, 0, stats.size)).toString("utf8");
      if (normalizedStartLine !== void 0 || normalizedEndLine !== void 0) {
        const lines = content.split("\n");
        const start = normalizedStartLine !== void 0 ? Math.max(0, normalizedStartLine - 1) : 0;
        const end = normalizedEndLine !== void 0 ? Math.min(lines.length, normalizedEndLine) : lines.length;
        content = lines.slice(start, end).join("\n");
      }
      return content;
    }
    async function findWriteParentIssue(fullPath, operations = fileOperations_1.nativeFileOperations) {
      const parentDir = path_1.default.resolve(path_1.default.dirname(fullPath));
      const root = path_1.default.parse(parentDir).root;
      const relativeParent = path_1.default.relative(root, parentDir);
      if (!relativeParent)
        return null;
      let current = root;
      for (const part of relativeParent.split(path_1.default.sep).filter(Boolean)) {
        current = path_1.default.join(current, part);
        try {
          const stats = await operations.stat(current);
          if (stats.kind !== "directory")
            return { path: current, reason: "not-directory" };
        } catch (err) {
          if (err?.code === "ENOENT")
            return { path: current, reason: "missing" };
          throw err;
        }
      }
      return null;
    }
    function formatWriteParentIssueMessage(issue, retryHint) {
      const base = issue.reason === "missing" ? `Parent directory does not exist: ${issue.path}. write does not create parent directories by default. Retry with createDirs=true to create missing parent directories.` : `Parent path is not a directory: ${issue.path}.`;
      return retryHint ? `${base}${retryHint}` : base;
    }
    async function ensureWriteParentReady(fullPath, createDirs, operations = fileOperations_1.nativeFileOperations) {
      if (createDirs === true) {
        await operations.mkdir(path_1.default.dirname(fullPath));
        return;
      }
      const parentIssue = await findWriteParentIssue(fullPath, operations);
      if (parentIssue) {
        throw new Error(formatWriteParentIssueMessage(parentIssue));
      }
    }
    function resolveExistsMessage(existsMessage) {
      return typeof existsMessage === "function" ? existsMessage() : existsMessage;
    }
    function shouldDiagnoseWriteParentError(err) {
      return err?.code === "ENOENT" || err?.code === "ENOTDIR";
    }
    async function writeFileToolPath(fullPath, content, options, operations = fileOperations_1.nativeFileOperations) {
      if (options.createDirs === true) {
        await operations.mkdir(path_1.default.dirname(fullPath));
      }
      try {
        await operations.write(fullPath, content, options.overwrite ? "w" : "wx");
      } catch (err) {
        if (err?.code === "EEXIST" && !options.overwrite) {
          throw new Error(resolveExistsMessage(options.existsMessage));
        }
        if (options.createDirs !== true && shouldDiagnoseWriteParentError(err)) {
          const parentIssue = await findWriteParentIssue(fullPath, operations);
          if (parentIssue) {
            throw new Error(formatWriteParentIssueMessage(parentIssue, options.parentIssueRetryHint?.(parentIssue)));
          }
        }
        throw err;
      }
    }
  }
});

// ../shared/dist/execCwd.js
var require_execCwd = __commonJS({
  "../shared/dist/execCwd.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.expandHomePath = expandHomePath;
    exports2.resolveExecCwd = resolveExecCwd;
    exports2.buildInvalidExecCwdMessage = buildInvalidExecCwdMessage;
    exports2.validateResolvedExecCwd = validateResolvedExecCwd;
    exports2.resolveValidatedExecCwd = resolveValidatedExecCwd;
    var fs_extra_1 = __importDefault(require_lib());
    var os_1 = __importDefault(require("os"));
    var path_1 = __importDefault(require("path"));
    function expandHomePath(filePath) {
      if (filePath === "~")
        return os_1.default.homedir();
      if (filePath.startsWith("~/") || filePath.startsWith("~\\"))
        return path_1.default.join(os_1.default.homedir(), filePath.slice(2));
      return filePath;
    }
    function resolveExecCwd(options) {
      const explicit = typeof options.cwd === "string" && options.cwd.trim().length > 0 ? options.cwd.trim() : void 0;
      const session = typeof options.sessionCwd === "string" && options.sessionCwd.trim().length > 0 ? options.sessionCwd.trim() : void 0;
      const source = explicit ? "explicit" : session ? "session" : "default";
      const raw = explicit || session;
      const base = session ? expandHomePath(session) : options.defaultCwd;
      const candidate = raw || options.defaultCwd;
      const expanded = expandHomePath(candidate);
      const cwd = path_1.default.isAbsolute(expanded) ? path_1.default.resolve(expanded) : path_1.default.resolve(base, expanded);
      return { cwd, raw, source };
    }
    function formatNode(nodeId) {
      return nodeId && nodeId.trim().length > 0 ? ` on node \`${nodeId}\`` : "";
    }
    function buildInvalidExecCwdMessage(resolved, reason, nodeId) {
      const rawPart = resolved.raw ? ` Raw cwd: \`${resolved.raw}\`.` : "";
      return `Cannot start exec${formatNode(nodeId)}: working directory is invalid (${reason}). Source: ${resolved.source}.${rawPart} Resolved cwd: \`${resolved.cwd}\`.`;
    }
    async function validateResolvedExecCwd(resolved, nodeId) {
      let stats;
      try {
        stats = await fs_extra_1.default.stat(resolved.cwd);
      } catch (err) {
        if (err?.code === "ENOENT") {
          throw new Error(buildInvalidExecCwdMessage(resolved, "path does not exist", nodeId));
        }
        if (err?.code === "EACCES" || err?.code === "EPERM") {
          throw new Error(buildInvalidExecCwdMessage(resolved, `path is not accessible: ${err.code}`, nodeId));
        }
        throw new Error(buildInvalidExecCwdMessage(resolved, err?.message || String(err), nodeId));
      }
      if (!stats.isDirectory()) {
        throw new Error(buildInvalidExecCwdMessage(resolved, "path is not a directory", nodeId));
      }
      try {
        await fs_extra_1.default.access(resolved.cwd, fs_extra_1.default.constants.R_OK | fs_extra_1.default.constants.X_OK);
      } catch (err) {
        throw new Error(buildInvalidExecCwdMessage(resolved, `directory is not accessible: ${err?.code || err?.message || err}`, nodeId));
      }
      return resolved;
    }
    async function resolveValidatedExecCwd(options) {
      return await validateResolvedExecCwd(resolveExecCwd(options), options.nodeId);
    }
  }
});

// ../shared/dist/outputTruncation.js
var require_outputTruncation = __commonJS({
  "../shared/dist/outputTruncation.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.truncateOutputForDisplay = truncateOutputForDisplay;
    exports2.formatTruncationFooterNotes = formatTruncationFooterNotes;
    var DEFAULT_PER_LINE_MAX_CHARS = 550;
    var DEFAULT_PER_LINE_HEAD_CHARS = 250;
    var DEFAULT_PER_LINE_TAIL_CHARS = 250;
    function replaceLoneSurrogates(text) {
      let output = "";
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code >= 55296 && code <= 56319) {
          const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
          if (next >= 56320 && next <= 57343) {
            output += text[i] + text[i + 1];
            i += 1;
          } else {
            output += "\uFFFD";
          }
          continue;
        }
        if (code >= 56320 && code <= 57343) {
          output += "\uFFFD";
          continue;
        }
        output += text[i];
      }
      return output;
    }
    function splitChars(text) {
      const sanitized = replaceLoneSurrogates(text);
      const Segmenter = Intl.Segmenter;
      if (typeof Segmenter === "function") {
        try {
          const segmenter = new Segmenter(void 0, { granularity: "grapheme" });
          return Array.from(segmenter.segment(sanitized), (part) => String(part.segment));
        } catch {
        }
      }
      return Array.from(sanitized);
    }
    function charLength(text) {
      return splitChars(text).length;
    }
    function takeStart(text, count) {
      if (count <= 0)
        return "";
      const chars = splitChars(text);
      return chars.length <= count ? chars.join("") : chars.slice(0, count).join("");
    }
    function takeEnd(text, count) {
      if (count <= 0)
        return "";
      const chars = splitChars(text);
      return chars.length <= count ? chars.join("") : chars.slice(-count).join("");
    }
    function splitLines(text) {
      if (text.length === 0)
        return [];
      return replaceLoneSurrogates(text).split(/\r\n|\n|\r/);
    }
    function joinedLength(lines) {
      if (lines.length === 0)
        return 0;
      return lines.reduce((sum, line) => sum + charLength(line), 0) + Math.max(0, lines.length - 1);
    }
    function buildFooterNotes(result) {
      const notes = [];
      if (result.lineTruncatedCount > 0 || result.omittedLineCount > 0) {
        const placeholders = [];
        if (result.lineTruncatedCount > 0)
          placeholders.push("line-too-long placeholders");
        if (result.omittedLineCount > 0)
          placeholders.push("line-range omission placeholders");
        notes.push(`Foxwarm placeholders above (${placeholders.join(", ")}) are not original output content.`);
      }
      if (result.omittedLineCount > 0 && result.omittedLineRange && result.omittedLineReason) {
        notes.push(`Omitted ${result.omittedLineCount} line(s) from original line range ${result.omittedLineRange.begin}-${result.omittedLineRange.end} because ${result.omittedLineReason}.`);
      }
      notes.push(`Original output: ${result.originalLineCount} line(s), ${result.originalCharCount} character(s).`);
      return notes;
    }
    function truncateLongLines(lines, options) {
      let count = 0;
      const output = lines.map((line, index) => {
        const length = charLength(line);
        if (length <= options.perLineMaxChars)
          return line;
        count += 1;
        return `${takeStart(line, options.perLineHeadChars)}...[foxwarm: line too long (${length} chars at line ${index + 1})]...${takeEnd(line, options.perLineTailChars)}`;
      });
      return { lines: output, count };
    }
    function lineRangeOmissionMessage(omittedCount, begin, end, reason) {
      return `[foxwarm: ${omittedCount} lines (line range ${begin}-${end}) omitted because ${reason}]`;
    }
    function lineRangePlaceholder(omittedCount, begin, end, reason) {
      return `--- ${lineRangeOmissionMessage(omittedCount, begin, end, reason)} ---`;
    }
    function truncateWholeLines(lines, maxChars, reason) {
      const currentLength = joinedLength(lines);
      if (currentLength <= maxChars) {
        return { text: lines.join("\n"), omittedLineCount: 0 };
      }
      if (lines.length <= 1) {
        const line = lines[0] || "";
        const marker = lineRangeOmissionMessage(0, 1, 1, reason);
        const available = Math.max(0, maxChars - charLength(marker));
        const head = Math.ceil(available / 2);
        const tail = Math.max(0, available - head);
        return {
          text: `${takeStart(line, head)}${marker}${takeEnd(line, tail)}`,
          omittedLineCount: 0
        };
      }
      const headBudget = Math.max(0, Math.floor(maxChars * 0.62));
      const tailBudget = Math.max(0, maxChars - headBudget);
      let headCount = 0;
      let headLength = 0;
      while (headCount < lines.length - 1) {
        const nextLength = charLength(lines[headCount]) + (headCount > 0 ? 1 : 0);
        if (headLength + nextLength > headBudget)
          break;
        headLength += nextLength;
        headCount += 1;
      }
      let tailCount = 0;
      let tailLength = 0;
      while (tailCount < lines.length - headCount - 1) {
        const line = lines[lines.length - 1 - tailCount];
        const nextLength = charLength(line) + (tailCount > 0 ? 1 : 0);
        if (tailLength + nextLength > tailBudget)
          break;
        tailLength += nextLength;
        tailCount += 1;
      }
      const build = () => {
        const omittedLineCount = Math.max(0, lines.length - headCount - tailCount);
        const begin = headCount + 1;
        const end = lines.length - tailCount;
        const marker = lineRangePlaceholder(omittedLineCount, begin, end, reason);
        const pieces = [
          ...lines.slice(0, headCount),
          marker,
          ...lines.slice(lines.length - tailCount)
        ];
        return { marker, pieces, omittedLineCount, begin, end, text: pieces.join("\n") };
      };
      let built = build();
      while (charLength(built.text) > maxChars && (headCount > 0 || tailCount > 0)) {
        if (tailCount > 0 && (tailCount >= headCount || headCount === 0)) {
          tailCount -= 1;
        } else if (headCount > 0) {
          headCount -= 1;
        } else {
          tailCount -= 1;
        }
        built = build();
      }
      return {
        text: built.text,
        omittedLineCount: built.omittedLineCount,
        omittedLineRange: { begin: built.begin, end: built.end }
      };
    }
    function truncateOutputForDisplay(text, options) {
      const maxChars = Math.max(0, Math.floor(options.maxChars));
      const rawText = String(text ?? "");
      const originalText = replaceLoneSurrogates(rawText);
      const originalCharCount = charLength(originalText);
      const originalLines = splitLines(originalText);
      const originalLineCount = originalLines.length;
      if (!options.force && originalCharCount <= maxChars) {
        return {
          text: rawText,
          truncated: false,
          originalLineCount,
          originalCharCount,
          lineTruncatedCount: 0,
          omittedLineCount: 0,
          placeholderKinds: [],
          footerNotes: []
        };
      }
      const lineOptions = {
        perLineMaxChars: options.perLineMaxChars ?? DEFAULT_PER_LINE_MAX_CHARS,
        perLineHeadChars: options.perLineHeadChars ?? DEFAULT_PER_LINE_HEAD_CHARS,
        perLineTailChars: options.perLineTailChars ?? DEFAULT_PER_LINE_TAIL_CHARS
      };
      const longLineResult = truncateLongLines(originalLines, lineOptions);
      const reason = options.lineOmissionReason || "this file is too long";
      const wholeLineResult = truncateWholeLines(longLineResult.lines, maxChars, reason);
      const placeholderKinds = [];
      if (longLineResult.count > 0)
        placeholderKinds.push("line");
      if (wholeLineResult.omittedLineCount > 0)
        placeholderKinds.push("line-range");
      const result = {
        text: wholeLineResult.text,
        truncated: true,
        originalLineCount,
        originalCharCount,
        lineTruncatedCount: longLineResult.count,
        omittedLineCount: wholeLineResult.omittedLineCount,
        omittedLineRange: wholeLineResult.omittedLineRange,
        omittedLineReason: wholeLineResult.omittedLineCount > 0 ? reason : void 0,
        placeholderKinds,
        footerNotes: []
      };
      result.footerNotes = buildFooterNotes(result);
      return result;
    }
    function formatTruncationFooterNotes(result) {
      return result.footerNotes.slice();
    }
  }
});

// ../shared/dist/tokenCount.js
var require_tokenCount = __commonJS({
  "../shared/dist/tokenCount.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.estimateTokenCount = estimateTokenCount;
    function estimateTokenCount(text) {
      if (!text)
        return 0;
      let count = 0;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 128) {
          count += 0.33;
        } else {
          count += 1;
        }
      }
      return Math.ceil(count);
    }
  }
});

// ../shared/dist/processOperations.js
var require_processOperations = __commonJS({
  "../shared/dist/processOperations.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.nativeProcessOperations = void 0;
    exports2.createNativeProcessOperations = createNativeProcessOperations;
    var node_child_process_1 = require("node:child_process");
    var node_fs_1 = require("node:fs");
    var PROCESS_INSPECTION_TIMEOUT_MS = 2e3;
    var PROCESS_INSPECTION_MAX_BUFFER_BYTES = 1024 * 1024;
    function runProcessInspectionCommand(command, args) {
      return new Promise((resolve, reject) => {
        (0, node_child_process_1.execFile)(command, args, {
          encoding: "utf8",
          timeout: PROCESS_INSPECTION_TIMEOUT_MS,
          maxBuffer: PROCESS_INSPECTION_MAX_BUFFER_BYTES,
          windowsHide: true
        }, (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(String(stdout));
        });
      });
    }
    async function inspectNativeProcessSnapshot(platform) {
      if (platform === "win32") {
        const script = [
          "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
          "$items = @(Get-CimInstance Win32_Process | ForEach-Object {",
          "  [PSCustomObject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; cmdline = $(if ($_.CommandLine) { [string]$_.CommandLine } else { [string]$_.Name }) }",
          "})",
          "ConvertTo-Json -InputObject $items -Compress"
        ].join("\n");
        const output2 = await runProcessInspectionCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
        const parsed = JSON.parse(output2.trim() || "[]");
        const items = Array.isArray(parsed) ? parsed : [parsed];
        return items.map((item) => ({
          pid: Number(item?.pid),
          parentPid: Number(item?.parentPid),
          cmdline: typeof item?.cmdline === "string" ? item.cmdline : ""
        }));
      }
      if (platform !== "linux" && platform !== "darwin" && platform !== "freebsd" && platform !== "openbsd") {
        throw new Error(`Process inspection is unsupported on ${platform}`);
      }
      const output = await runProcessInspectionCommand("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "command="]);
      const entries = [];
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s*(.*)$/);
        if (!match)
          continue;
        entries.push({ pid: Number(match[1]), parentPid: Number(match[2]), cmdline: match[3] || "" });
      }
      return entries;
    }
    function createNativeProcessOperations() {
      const platform = process.platform;
      return {
        platform,
        nodePath: process.execPath,
        async launch(request) {
          const child = (0, node_child_process_1.spawn)(request.command, request.args, {
            cwd: request.cwd,
            env: request.env,
            stdio: "ignore",
            detached: request.detached,
            windowsHide: request.windowsHide,
            shell: false
          });
          await new Promise((resolve, reject) => {
            child.once("spawn", () => resolve());
            child.once("error", reject);
          });
          child.unref();
          if (!child.pid)
            throw new Error("Failed to start background process: missing pid");
          return { pid: child.pid };
        },
        isRunning(pid) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            return error?.code === "EPERM";
          }
        },
        async readWorkingDirectory(pid) {
          if (platform !== "linux")
            return null;
          try {
            const raw = await node_fs_1.promises.readlink(`/proc/${pid}/cwd`);
            const cwd = raw.trim();
            return cwd || null;
          } catch (error) {
            if (error?.code === "ENOENT" || error?.code === "ESRCH")
              return null;
            throw error;
          }
        },
        inspectSnapshot() {
          return inspectNativeProcessSnapshot(platform);
        }
      };
    }
    exports2.nativeProcessOperations = createNativeProcessOperations();
  }
});

// ../shared/dist/persistentExec.js
var require_persistentExec = __commonJS({
  "../shared/dist/persistentExec.js"(exports2) {
    "use strict";
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PersistentExecManager = exports2.BACKGROUND_PROCESS_TREE_LIMIT = exports2.BACKGROUND_PROCESS_CMDLINE_LIMIT = exports2.OVERSIZED_LOG_SAMPLE_BYTES = exports2.MAX_FULL_LOG_READ_BYTES = exports2.MAX_EXEC_TIMEOUT_SECONDS = exports2.MIN_EXEC_TIMEOUT_SECONDS = exports2.DEFAULT_EXEC_TIMEOUT_SECONDS = void 0;
    exports2.resolveExecTimeoutSeconds = resolveExecTimeoutSeconds;
    exports2.truncateProcessCmdline = truncateProcessCmdline;
    exports2.formatProcessTreeSnapshot = formatProcessTreeSnapshot;
    var crypto_1 = __importDefault(require("crypto"));
    var fs_extra_1 = __importDefault(require_lib());
    var path_1 = __importDefault(require("path"));
    var execCwd_1 = require_execCwd();
    var outputTruncation_1 = require_outputTruncation();
    var tokenCount_1 = require_tokenCount();
    var boundedTextExcerpt_1 = require_boundedTextExcerpt();
    var processOperations_1 = require_processOperations();
    exports2.DEFAULT_EXEC_TIMEOUT_SECONDS = 15;
    exports2.MIN_EXEC_TIMEOUT_SECONDS = 1;
    exports2.MAX_EXEC_TIMEOUT_SECONDS = 60;
    function resolveExecTimeoutSeconds(timeoutValue) {
      if (timeoutValue === void 0 || timeoutValue === null) {
        return {
          requestedSeconds: exports2.DEFAULT_EXEC_TIMEOUT_SECONDS,
          effectiveSeconds: exports2.DEFAULT_EXEC_TIMEOUT_SECONDS
        };
      }
      if (typeof timeoutValue !== "number" || !Number.isFinite(timeoutValue)) {
        throw new Error(`timeout must be a number between ${exports2.MIN_EXEC_TIMEOUT_SECONDS} and ${exports2.MAX_EXEC_TIMEOUT_SECONDS} seconds`);
      }
      if (timeoutValue < exports2.MIN_EXEC_TIMEOUT_SECONDS) {
        throw new Error(`timeout must be between ${exports2.MIN_EXEC_TIMEOUT_SECONDS} and ${exports2.MAX_EXEC_TIMEOUT_SECONDS} seconds`);
      }
      if (timeoutValue > exports2.MAX_EXEC_TIMEOUT_SECONDS) {
        return {
          requestedSeconds: timeoutValue,
          effectiveSeconds: exports2.MAX_EXEC_TIMEOUT_SECONDS,
          warning: `WARNING: Requested timeout ${formatExecTimeoutSeconds(timeoutValue)}s exceeds the ${exports2.MAX_EXEC_TIMEOUT_SECONDS}s maximum; using ${exports2.MAX_EXEC_TIMEOUT_SECONDS}s.`
        };
      }
      return { requestedSeconds: timeoutValue, effectiveSeconds: timeoutValue };
    }
    var RECONCILE_INTERVAL_MS = 5e3;
    var STATUS_POLL_INTERVAL_MS = 250;
    var MISSING_STATUS_GRACE_MS = 3e3;
    var PARTIAL_LOG_BYTES = 4e3;
    var INLINE_LOG_LIMIT_BYTES = 2e4;
    var INLINE_EXCERPT_HALF_BYTES = 5e3;
    exports2.MAX_FULL_LOG_READ_BYTES = boundedTextExcerpt_1.MAX_FULL_TEXT_READ_BYTES;
    exports2.OVERSIZED_LOG_SAMPLE_BYTES = boundedTextExcerpt_1.BOUNDED_TEXT_SAMPLE_BYTES;
    var EXEC_PATHS_WAIT_TIMEOUT_MS = 1e3;
    var EXEC_PATHS_POLL_INTERVAL_MS = 25;
    var BACKGROUND_COMMAND_PREVIEW_LIMIT = 100;
    exports2.BACKGROUND_PROCESS_CMDLINE_LIMIT = 100;
    exports2.BACKGROUND_PROCESS_TREE_LIMIT = 40;
    var BACKGROUND_PROCESS_TREE_MAX_INDENT = 20;
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    function escapeInlineCode(text) {
      return text.replace(/`/g, "\\`");
    }
    function summarizeCommandForNotification(text, maxLength = BACKGROUND_COMMAND_PREVIEW_LIMIT) {
      const compact = text.replace(/\s+/g, " ").trim();
      if (compact.length <= maxLength)
        return compact;
      const marker = "...[foxwarm: command middle omitted]...";
      if (maxLength <= marker.length)
        return compact.slice(0, maxLength);
      const remaining = maxLength - marker.length;
      const headLength = Math.ceil(remaining * 0.6);
      const tailLength = remaining - headLength;
      return `${compact.slice(0, headLength)}${marker}${compact.slice(-tailLength)}`;
    }
    function formatExecTimeoutSeconds(seconds) {
      return Number.isInteger(seconds) ? String(seconds) : String(seconds);
    }
    function buildBackgroundTimeoutShortNotice(timeoutSeconds) {
      return `[Process running longer than ${formatExecTimeoutSeconds(timeoutSeconds)}s]`;
    }
    function buildBackgroundTimeoutFullNotice(timeoutSeconds) {
      const shortNotice = buildBackgroundTimeoutShortNotice(timeoutSeconds);
      return `${shortNotice} Switched to background. The system will send a notification message when done. STOP calling tools to check status. Wait for notification unless working on other tasks in parallel; if you continue other work, remember this process remains outstanding until its completion message arrives.`;
    }
    function truncateProcessCmdline(cmdline, maxLength = exports2.BACKGROUND_PROCESS_CMDLINE_LIMIT) {
      const compact = cmdline.replace(/\s+/g, " ").trim() || "[cmdline unavailable]";
      const characters = Array.from(compact);
      if (characters.length <= maxLength)
        return compact;
      if (maxLength <= 1)
        return characters.slice(0, Math.max(0, maxLength)).join("");
      return `${characters.slice(0, maxLength - 1).join("")}\u2026`;
    }
    function formatProcessTreeSnapshot(entries, rootPid) {
      const heading = `Process tree (best-effort live snapshot; managed shell-script root PID ${rootPid}):`;
      const byPid = /* @__PURE__ */ new Map();
      for (const entry of entries) {
        if (!Number.isInteger(entry.pid) || entry.pid <= 0 || byPid.has(entry.pid))
          continue;
        byPid.set(entry.pid, entry);
      }
      if (!byPid.has(rootPid)) {
        return `${heading}
(Process tree unavailable: the root process was no longer visible during inspection.)`;
      }
      const children = /* @__PURE__ */ new Map();
      for (const entry of byPid.values()) {
        const siblings = children.get(entry.parentPid) || [];
        siblings.push(entry);
        children.set(entry.parentPid, siblings);
      }
      for (const siblings of children.values())
        siblings.sort((left, right) => left.pid - right.pid);
      const ordered = [];
      const visited = /* @__PURE__ */ new Set();
      const pending = [{ entry: byPid.get(rootPid), depth: 0 }];
      while (pending.length > 0) {
        const current = pending.pop();
        if (visited.has(current.entry.pid))
          continue;
        visited.add(current.entry.pid);
        ordered.push(current);
        const descendants = children.get(current.entry.pid) || [];
        for (let index = descendants.length - 1; index >= 0; index -= 1) {
          pending.push({ entry: descendants[index], depth: current.depth + 1 });
        }
      }
      const visible = ordered.slice(0, exports2.BACKGROUND_PROCESS_TREE_LIMIT);
      const lines = visible.map(({ entry, depth }) => {
        const indent = " ".repeat(Math.min(depth * 2, BACKGROUND_PROCESS_TREE_MAX_INDENT));
        return `${indent}PID ${entry.pid}: ${truncateProcessCmdline(entry.cmdline)}`;
      });
      const omitted = ordered.length - visible.length;
      if (omitted > 0)
        lines.push(`[foxwarm: ${omitted} additional descendant process(es) omitted]`);
      return `${heading}
${lines.join("\n")}`;
    }
    function buildStatusWriterInvocationPosix() {
      return `"$FOXWARM_EXEC_NODE_PATH" -e 'const fs = require("fs"); const statusPath = process.argv[1]; const rawExitCode = process.argv[2]; const exitCode = rawExitCode === "null" ? null : Number(rawExitCode); fs.writeFileSync(statusPath, JSON.stringify({ exitCode, finishedAt: new Date().toISOString() }) + "\\n");'`;
    }
    function buildManagedExecScript(command, platform) {
      if (platform === "win32") {
        return [
          '$ErrorActionPreference = "Continue"',
          "chcp 65001 | Out-Null",
          '$basePath = Join-Path $env:FOXWARM_EXEC_LOG_DIR ("{0}_pid{1}" -f $env:FOXWARM_EXEC_TIME_TOKEN, $PID)',
          "$index = 0",
          "while ($true) {",
          "  if ($index -eq 0) {",
          '    $logPath = "$basePath.log"',
          "  } else {",
          '    $logPath = "${basePath}_$index.log"',
          "  }",
          '  $statusPath = "$logPath.exit.json"',
          '  $cwdPath = "$logPath.cwd.txt"',
          "  if (!(Test-Path -LiteralPath $logPath) -and !(Test-Path -LiteralPath $statusPath) -and !(Test-Path -LiteralPath $cwdPath)) { break }",
          "  $index += 1",
          "}",
          '$pathsTmp = "$env:FOXWARM_EXEC_PATHS_PATH.tmp.$PID"',
          "$paths = @{ logPath = $logPath; statusPath = $statusPath; cwdPath = $cwdPath } | ConvertTo-Json -Compress",
          "Set-Content -LiteralPath $pathsTmp -Value $paths",
          "Move-Item -LiteralPath $pathsTmp -Destination $env:FOXWARM_EXEC_PATHS_PATH -Force",
          "Start-Transcript -LiteralPath $logPath -Append | Out-Null",
          "$global:LASTEXITCODE = $null",
          "$foxwarmExecSucceeded = $true",
          "try {",
          "  & $env:FOXWARM_EXEC_COMMAND_PATH",
          "  $foxwarmExecSucceeded = $?",
          "} catch {",
          "  Write-Error $_",
          "  $foxwarmExecSucceeded = $false",
          "}",
          "if ($null -ne $global:LASTEXITCODE) {",
          "  $EXIT_CODE = [int]$global:LASTEXITCODE",
          "} elseif ($foxwarmExecSucceeded) {",
          "  $EXIT_CODE = 0",
          "} else {",
          "  $EXIT_CODE = 1",
          "}",
          '$cwdTmp = "$cwdPath.tmp.$PID"',
          '$statusTmp = "$statusPath.tmp.$PID"',
          "(Get-Location).Path | Set-Content -LiteralPath $cwdTmp -NoNewline",
          "Move-Item -LiteralPath $cwdTmp -Destination $cwdPath -Force",
          '$status = @{ exitCode = $EXIT_CODE; finishedAt = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json -Compress',
          "Set-Content -LiteralPath $statusTmp -Value $status",
          "Move-Item -LiteralPath $statusTmp -Destination $statusPath -Force",
          "Stop-Transcript | Out-Null",
          "exit $EXIT_CODE"
        ].join("\r\n");
      }
      return [
        "#!/usr/bin/env bash",
        "set +e",
        "foxwarm_exec_choose_paths() {",
        '  base_path="${FOXWARM_EXEC_LOG_DIR}/${FOXWARM_EXEC_TIME_TOKEN}_pid$$"',
        "  index=0",
        "  while :; do",
        '    if [ "$index" -eq 0 ]; then',
        '      log_path="${base_path}.log"',
        "    else",
        '      log_path="${base_path}_${index}.log"',
        "    fi",
        '    status_path="${log_path}.exit.json"',
        '    cwd_path="${log_path}.cwd.txt"',
        '    if [ ! -e "$log_path" ] && [ ! -e "$status_path" ] && [ ! -e "$cwd_path" ]; then',
        "      break",
        "    fi",
        "    index=$((index + 1))",
        "  done",
        '  export FOXWARM_EXEC_LOG_PATH="$log_path"',
        '  export FOXWARM_EXEC_STATUS_PATH="$status_path"',
        '  export FOXWARM_EXEC_CWD_PATH="$cwd_path"',
        '  paths_tmp="${FOXWARM_EXEC_PATHS_PATH}.tmp.$$"',
        `  "$FOXWARM_EXEC_NODE_PATH" -e '''const fs = require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ logPath: process.argv[2], statusPath: process.argv[3], cwdPath: process.argv[4] }) + "\\n");''' "$paths_tmp" "$FOXWARM_EXEC_LOG_PATH" "$FOXWARM_EXEC_STATUS_PATH" "$FOXWARM_EXEC_CWD_PATH"`,
        '  mv "$paths_tmp" "$FOXWARM_EXEC_PATHS_PATH"',
        '  exec >> "$FOXWARM_EXEC_LOG_PATH" 2>&1',
        "}",
        "foxwarm_exec_choose_paths",
        "foxwarm_exec_finalize() {",
        "  exit_code=$?",
        '  cwd_tmp="${FOXWARM_EXEC_CWD_PATH}.tmp.$$"',
        '  status_tmp="${FOXWARM_EXEC_STATUS_PATH}.tmp.$$"',
        '  pwd > "$cwd_tmp"',
        '  mv "$cwd_tmp" "$FOXWARM_EXEC_CWD_PATH"',
        `  ${buildStatusWriterInvocationPosix()} "$status_tmp" "$exit_code"`,
        '  mv "$status_tmp" "$FOXWARM_EXEC_STATUS_PATH"',
        "}",
        "trap foxwarm_exec_finalize EXIT",
        "set +e",
        command
      ].join("\n");
    }
    function buildResolvedExecPaths(execDir, timeToken, pid, collisionIndex = 0) {
      const suffix = collisionIndex > 0 ? `_${collisionIndex}` : "";
      const logPath = path_1.default.join(execDir, `${timeToken}_pid${pid}${suffix}.log`);
      return { logPath, statusPath: `${logPath}.exit.json`, cwdPath: `${logPath}.cwd.txt` };
    }
    function formatDate(date = /* @__PURE__ */ new Date()) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    function formatTime(date = /* @__PURE__ */ new Date()) {
      const h = String(date.getHours()).padStart(2, "0");
      const m = String(date.getMinutes()).padStart(2, "0");
      const s = String(date.getSeconds()).padStart(2, "0");
      const ms = String(date.getMilliseconds()).padStart(3, "0");
      return `${h}${m}${s}${ms}`;
    }
    var PersistentExecManager = class {
      constructor(options) {
        this.options = options;
        this.runningExecs = /* @__PURE__ */ new Map();
        this.initialized = false;
        this.initializationPromise = null;
        this.reconcileTimer = null;
        this.reconcileChain = Promise.resolve();
        this.registryMutationChain = Promise.resolve();
        this.completionDispatcher = options.completionDispatcher || (async () => {
        });
      }
      get processOperations() {
        return this.options.processOperations || processOperations_1.nativeProcessOperations;
      }
      getDefaultCwd(agentName = "main") {
        return this.options.getDefaultCwd(agentName);
      }
      registryPath() {
        return this.options.registryPath;
      }
      async saveRunningExecs() {
        const registryPath = this.registryPath();
        if (!registryPath)
          return;
        await fs_extra_1.default.ensureDir(path_1.default.dirname(registryPath));
        const tempPath = `${registryPath}.${process.pid}.${crypto_1.default.randomBytes(4).toString("hex")}.tmp`;
        try {
          await fs_extra_1.default.writeJson(tempPath, { execs: Array.from(this.runningExecs.values()) }, { spaces: 2 });
          await fs_extra_1.default.rename(tempPath, registryPath);
        } catch (err) {
          await fs_extra_1.default.remove(tempPath).catch(() => {
          });
          throw err;
        }
      }
      async commitRegistryMutation(mutate) {
        let result;
        const operation = this.registryMutationChain.then(async () => {
          result = mutate();
          await this.saveRunningExecs();
        });
        this.registryMutationChain = operation.then(() => void 0, () => void 0);
        await operation;
        return result;
      }
      async loadRunningExecs() {
        this.runningExecs.clear();
        const registryPath = this.registryPath();
        if (!registryPath)
          return;
        try {
          const data = await fs_extra_1.default.readJson(registryPath);
          const rawExecs = Array.isArray(data?.execs) ? data.execs : [];
          for (const raw of rawExecs) {
            if (!raw || typeof raw !== "object")
              continue;
            if (typeof raw.id !== "string" || typeof raw.logPath !== "string" || typeof raw.statusPath !== "string")
              continue;
            if (!Number.isFinite(Number(raw.pid)) || !Number.isFinite(Number(raw.startedAt)))
              continue;
            const agentName = typeof raw.agentName === "string" && raw.agentName.trim().length > 0 ? raw.agentName : "main";
            const entry = {
              id: raw.id,
              pid: Number(raw.pid),
              sessionId: typeof raw.sessionId === "string" ? raw.sessionId : void 0,
              agentName,
              nodeId: typeof raw.nodeId === "string" && raw.nodeId.trim().length > 0 ? raw.nodeId : this.options.nodeId || "master",
              command: typeof raw.command === "string" ? raw.command : "",
              initialCwd: typeof raw.initialCwd === "string" && raw.initialCwd.trim().length > 0 ? raw.initialCwd : this.getDefaultCwd(agentName),
              cwdRaw: typeof raw.cwdRaw === "string" ? raw.cwdRaw : void 0,
              cwdSource: raw.cwdSource === "explicit" || raw.cwdSource === "session" || raw.cwdSource === "default" ? raw.cwdSource : void 0,
              logPath: raw.logPath,
              statusPath: raw.statusPath,
              cwdPath: typeof raw.cwdPath === "string" && raw.cwdPath.trim().length > 0 ? raw.cwdPath : `${raw.logPath}.cwd.txt`,
              startedAt: Number(raw.startedAt),
              notifyOnCompletion: raw.notifyOnCompletion === true,
              recoveredAfterRestart: raw.recoveredAfterRestart === true
            };
            this.runningExecs.set(entry.id, entry);
          }
        } catch (err) {
          if (err?.code !== "ENOENT")
            this.options.logger?.error?.({ err }, "Failed to load running exec registry");
        }
      }
      async removeRunningExec(id) {
        await this.commitRegistryMutation(() => {
          this.runningExecs.delete(id);
        });
      }
      async updateRunningExec(id, updates) {
        return await this.commitRegistryMutation(() => {
          const current = this.runningExecs.get(id);
          if (!current)
            return null;
          const updated = { ...current, ...updates };
          this.runningExecs.set(id, updated);
          return updated;
        });
      }
      async waitForResolvedExecPaths(pathsPath, fallback) {
        const deadline = Date.now() + EXEC_PATHS_WAIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          try {
            const raw = await fs_extra_1.default.readJson(pathsPath);
            if (typeof raw?.logPath === "string" && typeof raw?.statusPath === "string" && typeof raw?.cwdPath === "string") {
              await fs_extra_1.default.remove(pathsPath).catch(() => {
              });
              return { logPath: raw.logPath, statusPath: raw.statusPath, cwdPath: raw.cwdPath };
            }
          } catch (err) {
            if (err?.code !== "ENOENT")
              this.options.logger?.warn?.({ err, pathsPath }, "Failed to read exec paths metadata; retrying");
          }
          await sleep(EXEC_PATHS_POLL_INTERVAL_MS);
        }
        return fallback;
      }
      async initialize() {
        if (this.initialized)
          return;
        if (!this.initializationPromise) {
          this.initializationPromise = this.initializeOnce().finally(() => {
            this.initializationPromise = null;
          });
        }
        await this.initializationPromise;
      }
      async initializeOnce() {
        await this.loadRunningExecs();
        let changed = false;
        for (const [id, entry] of this.runningExecs.entries()) {
          if (!entry.notifyOnCompletion) {
            this.runningExecs.set(id, { ...entry, notifyOnCompletion: true, recoveredAfterRestart: true });
            changed = true;
          }
        }
        if (changed)
          await this.saveRunningExecs();
        this.scheduleReconcile();
        this.initialized = true;
        this.options.logger?.info?.({ execCount: this.runningExecs.size }, "Exec manager initialized");
        await this.queueReconcile();
      }
      scheduleReconcile() {
        if (this.reconcileTimer)
          clearInterval(this.reconcileTimer);
        this.reconcileTimer = setInterval(() => {
          void this.queueReconcile();
        }, RECONCILE_INTERVAL_MS);
        this.reconcileTimer.unref?.();
      }
      async queueReconcile() {
        this.reconcileChain = this.reconcileChain.then(async () => {
          await this.reconcileRunningExecs();
        }).catch((err) => {
          this.options.logger?.error?.({ err }, "Exec reconcile loop failed");
        });
        await this.reconcileChain;
      }
      async startPersistentExec(options) {
        const command = String(options.command || "");
        const agentName = options.agentName || "main";
        const nodeId = options.nodeId || this.options.nodeId || "master";
        const sessionId = options.sessionId;
        const defaultCwd = this.getDefaultCwd(agentName);
        const cwdResult = await (0, execCwd_1.resolveValidatedExecCwd)({
          cwd: options.cwd,
          sessionCwd: options.sessionCwd,
          defaultCwd,
          nodeId
        });
        const initialCwd = cwdResult.cwd;
        const tempDir = this.options.getExecTempDir(agentName);
        const startedAt = /* @__PURE__ */ new Date();
        const dateDir = path_1.default.join(tempDir, formatDate(startedAt));
        const timeToken = formatTime(startedAt);
        await fs_extra_1.default.ensureDir(tempDir);
        await fs_extra_1.default.ensureDir(dateDir);
        const execId = `exec_${Date.now()}_${crypto_1.default.randomBytes(4).toString("hex")}`;
        const processOperations = this.processOperations;
        const platform = processOperations.platform;
        const scriptPath = `${path_1.default.join(dateDir, execId)}.command${platform === "win32" ? ".ps1" : ".sh"}`;
        const commandScriptPath = platform === "win32" ? `${path_1.default.join(dateDir, execId)}.user.ps1` : void 0;
        const pathsPath = path_1.default.join(dateDir, `${execId}.paths.json`);
        if (commandScriptPath) {
          await fs_extra_1.default.writeFile(commandScriptPath, `${command}${command.endsWith("\n") ? "" : "\n"}`);
        }
        await fs_extra_1.default.writeFile(scriptPath, `${buildManagedExecScript(command, platform)}${command.endsWith("\n") ? "" : "\n"}`, platform === "win32" ? void 0 : { mode: 448 });
        const launcher = platform === "win32" ? { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath] } : { command: "/bin/bash", args: [scriptPath] };
        let launched;
        try {
          launched = await processOperations.launch({
            command: launcher.command,
            args: launcher.args,
            cwd: initialCwd,
            env: {
              ...process.env,
              TERM: "xterm-256color",
              FOXWARM_EXEC_LOG_DIR: dateDir,
              FOXWARM_EXEC_TIME_TOKEN: timeToken,
              FOXWARM_EXEC_PATHS_PATH: pathsPath,
              FOXWARM_EXEC_NODE_PATH: processOperations.nodePath,
              ...commandScriptPath ? { FOXWARM_EXEC_COMMAND_PATH: commandScriptPath } : {}
            },
            detached: platform !== "win32",
            windowsHide: true
          });
        } catch (err) {
          if (err?.code === "ENOENT") {
            throw new Error(`Failed to start exec on node \`${nodeId}\`: ${err.message}. Working directory was validated as \`${initialCwd}\`.`);
          }
          throw err;
        }
        const resolvedPaths = await this.waitForResolvedExecPaths(pathsPath, buildResolvedExecPaths(dateDir, timeToken, launched.pid));
        const entry = {
          id: execId,
          pid: launched.pid,
          sessionId,
          agentName,
          nodeId,
          command,
          initialCwd,
          cwdRaw: cwdResult.raw,
          cwdSource: cwdResult.source,
          logPath: resolvedPaths.logPath,
          statusPath: resolvedPaths.statusPath,
          cwdPath: resolvedPaths.cwdPath,
          startedAt: startedAt.getTime(),
          notifyOnCompletion: false
        };
        await this.commitRegistryMutation(() => {
          this.runningExecs.set(entry.id, entry);
        });
        this.options.logger?.info?.({ execId: entry.id, pid: entry.pid, sessionId, nodeId }, "Persistent exec started");
        return entry;
      }
      async readExecCwd(cwdPath) {
        try {
          const raw = await fs_extra_1.default.readFile(cwdPath, "utf8");
          const cwd = raw.trim();
          return cwd || null;
        } catch (err) {
          if (err?.code === "ENOENT")
            return null;
          throw err;
        }
      }
      async readLogExcerpt(filePath, maxChars) {
        const stat = await fs_extra_1.default.stat(filePath);
        if (stat.size <= 0) {
          return {
            text: "",
            truncated: false,
            capturedOutputWasEmpty: true,
            capturedOutputEndedWithLf: false
          };
        }
        if (stat.size > exports2.MAX_FULL_LOG_READ_BYTES) {
          const { head, tail } = await (0, boundedTextExcerpt_1.readBoundedFileSamples)(filePath, stat.size);
          const capturedOutputEndedWithLf = tail.length > 0 && tail[tail.length - 1] === 10;
          const excerpt = (0, boundedTextExcerpt_1.buildBoundedTextExcerpt)(head, tail, {
            headMayEndMidCodePoint: true,
            tailMayStartMidCodePoint: true
          });
          if (excerpt.isBinary) {
            return {
              text: (0, boundedTextExcerpt_1.formatBoundedBinaryHexPreview)(head, tail, stat.size, "oversized binary log"),
              truncated: true,
              capturedOutputWasEmpty: false,
              capturedOutputEndedWithLf,
              oversized: true,
              originalByteLength: stat.size
            };
          }
          const escapedByteNote = excerpt.escapedByteCount > 0 ? `; escaped ${excerpt.escapedByteCount} byte(s)` : "";
          const text2 = [
            excerpt.renderedHead,
            `[foxwarm: oversized log middle omitted; showing bounded head and tail samples from a ${stat.size}-byte file${escapedByteNote}]`,
            excerpt.renderedTail
          ].join("\n");
          const truncation2 = (0, outputTruncation_1.truncateOutputForDisplay)(text2, {
            maxChars,
            force: text2.length > maxChars,
            lineOmissionReason: "this oversized log sample is too long"
          });
          return {
            text: truncation2.text,
            truncated: true,
            capturedOutputWasEmpty: false,
            capturedOutputEndedWithLf,
            truncation: truncation2.truncated ? truncation2 : void 0,
            oversized: true,
            originalByteLength: stat.size,
            hasDisplayByteConversions: excerpt.escapedByteCount > 0
          };
        }
        const text = await fs_extra_1.default.readFile(filePath, "utf8");
        const truncation = (0, outputTruncation_1.truncateOutputForDisplay)(text, {
          maxChars,
          force: text.length > maxChars,
          lineOmissionReason: "this file is too long"
        });
        return {
          text: truncation.text,
          truncated: truncation.truncated,
          capturedOutputWasEmpty: text.length === 0,
          capturedOutputEndedWithLf: text.endsWith("\n"),
          truncation: truncation.truncated ? truncation : void 0
        };
      }
      async readPartialLog(logPath) {
        try {
          const excerpt = await this.readLogExcerpt(logPath, PARTIAL_LOG_BYTES);
          if (excerpt.capturedOutputWasEmpty) {
            return { ...excerpt, text: "(Command started, no output yet)", truncated: false };
          }
          if (!excerpt.truncated)
            return excerpt;
          const markerSeparator = excerpt.text.endsWith("\n") ? "" : "\n";
          return { ...excerpt, text: `${excerpt.text}${markerSeparator}...(truncated)` };
        } catch (err) {
          if (err?.code === "ENOENT") {
            return {
              text: "(Command started, no output yet)",
              truncated: false,
              capturedOutputWasEmpty: true,
              capturedOutputEndedWithLf: false
            };
          }
          throw err;
        }
      }
      async readDisplayOutput(logPath) {
        try {
          const excerpt = await this.readLogExcerpt(logPath, INLINE_LOG_LIMIT_BYTES);
          if (excerpt.capturedOutputWasEmpty)
            return { ...excerpt, text: "(No output)", truncated: false };
          if (!excerpt.truncated && (0, tokenCount_1.estimateTokenCount)(excerpt.text) <= 1e4)
            return excerpt;
          if (excerpt.truncated)
            return excerpt;
          const truncation = (0, outputTruncation_1.truncateOutputForDisplay)(excerpt.text, {
            maxChars: INLINE_EXCERPT_HALF_BYTES * 2,
            force: true,
            lineOmissionReason: "this file is too long"
          });
          return {
            ...excerpt,
            text: truncation.text,
            truncated: true,
            truncation
          };
        } catch (err) {
          if (err?.code === "ENOENT") {
            return {
              text: "(No output)",
              truncated: false,
              capturedOutputWasEmpty: true,
              capturedOutputEndedWithLf: false
            };
          }
          throw err;
        }
      }
      buildForegroundFooter(entry, status, output, warning) {
        const lines = ["---", `Exit code: ${status.exitCode === null ? "unknown" : status.exitCode}`];
        if (status.error)
          lines.push(`Error: ${status.error}`);
        if (warning)
          lines.push(warning);
        if (output.truncated) {
          lines.push(`Command output saved to: ${entry.logPath}`);
          lines.push("Output was shortened for inline display.");
        }
        if (output.oversized && output.originalByteLength !== void 0) {
          lines.push(`Original log size: ${output.originalByteLength} bytes.`);
        } else if (output.truncation?.footerNotes?.length) {
          lines.push(...output.truncation.footerNotes);
        }
        if (!output.capturedOutputWasEmpty && !output.capturedOutputEndedWithLf) {
          lines.push("Original command output had no trailing newline.");
        }
        if (output.hasDisplayByteConversions)
          lines.push((0, boundedTextExcerpt_1.formatDisplayByteConversionDisclaimer)("command output"));
        return lines.join("\n");
      }
      async buildLiveProcessTree(entry) {
        try {
          const entries = await (this.options.processSnapshotProvider || (() => this.processOperations.inspectSnapshot()))();
          return formatProcessTreeSnapshot(entries, entry.pid);
        } catch (err) {
          this.options.logger?.warn?.({ err, execId: entry.id, pid: entry.pid }, "Failed to inspect background exec process tree");
          return `Process tree (best-effort live snapshot; managed shell-script root PID ${entry.pid}):
(Process tree unavailable: process inspection failed or is unsupported on this platform.)`;
        }
      }
      async readExecStatus(statusPath) {
        try {
          const raw = await fs_extra_1.default.readJson(statusPath);
          return {
            exitCode: typeof raw?.exitCode === "number" ? raw.exitCode : null,
            finishedAt: typeof raw?.finishedAt === "string" && raw.finishedAt ? raw.finishedAt : (/* @__PURE__ */ new Date()).toISOString(),
            error: typeof raw?.error === "string" ? raw.error : void 0
          };
        } catch (err) {
          if (err?.code === "ENOENT")
            return null;
          throw err;
        }
      }
      async ensureFallbackStatus(entry) {
        const existing = await this.readExecStatus(entry.statusPath);
        if (existing)
          return existing;
        if (await this.processOperations.isRunning(entry.pid))
          return null;
        if (Date.now() - entry.startedAt < MISSING_STATUS_GRACE_MS)
          return null;
        const fallback = { exitCode: null, finishedAt: (/* @__PURE__ */ new Date()).toISOString(), error: "Process exited but no status file was written." };
        await fs_extra_1.default.ensureDir(path_1.default.dirname(entry.statusPath));
        const tempPath = `${entry.statusPath}.tmp.${process.pid}.${crypto_1.default.randomBytes(4).toString("hex")}`;
        await fs_extra_1.default.writeJson(tempPath, fallback);
        await fs_extra_1.default.rename(tempPath, entry.statusPath);
        return fallback;
      }
      async waitForExecCompletion(execId, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const entry = this.runningExecs.get(execId);
          if (!entry)
            return null;
          const status = await this.ensureFallbackStatus(entry);
          if (status)
            return status;
          await sleep(STATUS_POLL_INTERVAL_MS);
        }
        return null;
      }
      async markExecForBackgroundNotification(execId) {
        return await this.updateRunningExec(execId, { notifyOnCompletion: true });
      }
      async finalizeForegroundExec(execId) {
        await this.removeRunningExec(execId);
      }
      async buildForegroundExecResult(entry, status, warning) {
        const output = await this.readDisplayOutput(entry.logPath);
        const footerSeparator = output.text.endsWith("\n") ? "" : "\n";
        return `${output.text}${footerSeparator}${this.buildForegroundFooter(entry, status, output, warning)}`;
      }
      async buildBackgroundTimeoutResult(entry, timeoutSeconds = exports2.DEFAULT_EXEC_TIMEOUT_SECONDS, warning) {
        const partialOutput = await this.readPartialLog(entry.logPath);
        const fullNotice = buildBackgroundTimeoutFullNotice(timeoutSeconds);
        const processTree = await this.buildLiveProcessTree(entry);
        const nodeLine = entry.nodeId && entry.nodeId !== "master" ? `Node: \`${entry.nodeId}\`
` : "";
        const warningLine = warning ? `${warning}
` : "";
        const sizeLine = partialOutput.oversized && partialOutput.originalByteLength !== void 0 ? `
Original log size: ${partialOutput.originalByteLength} bytes.` : "";
        const conversionNote = partialOutput.hasDisplayByteConversions ? `
${(0, boundedTextExcerpt_1.formatDisplayByteConversionDisclaimer)("command output")}` : "";
        const footerSeparator = partialOutput.text.endsWith("\n") ? "" : "\n";
        const trailingNewlineLine = !partialOutput.capturedOutputWasEmpty && !partialOutput.capturedOutputEndedWithLf ? "Partial output captured so far had no trailing newline.\n" : "";
        return `Partial Output:
${partialOutput.text}${footerSeparator}---
${fullNotice}
${trailingNewlineLine}${warningLine}${nodeLine}PID: ${entry.pid}
${processTree}
Log file: ${entry.logPath}${sizeLine}${conversionNote}`;
      }
      buildCompletionMessage(entry, status) {
        const exitText = status.exitCode === null ? "unknown" : String(status.exitCode);
        const nodeLine = entry.nodeId && entry.nodeId !== "master" ? `
Node: \`${entry.nodeId}\`` : "";
        const errorLine = status.error ? `
Error: ${status.error}` : "";
        return `Background Process Finished
command: \`${escapeInlineCode(summarizeCommandForNotification(entry.command))}\`${nodeLine}
Exit code: ${exitText}${errorLine}
Command output in ${entry.logPath}`;
      }
      async readFinishedExecWorkingDirectory(entry) {
        return await this.readExecCwd(entry.cwdPath);
      }
      async readLiveExecWorkingDirectory(entry) {
        return await this.processOperations.readWorkingDirectory(entry.pid);
      }
      listRunningExecs() {
        return Array.from(this.runningExecs.values());
      }
      async reconcileRunningExecs() {
        for (const entry of Array.from(this.runningExecs.values())) {
          if (!entry.notifyOnCompletion)
            continue;
          let status = null;
          try {
            status = await this.ensureFallbackStatus(entry);
          } catch (err) {
            this.options.logger?.error?.({ err, execId: entry.id, statusPath: entry.statusPath }, "Failed to inspect exec status");
            continue;
          }
          if (!status)
            continue;
          const message = this.buildCompletionMessage(entry, status);
          try {
            await this.completionDispatcher(entry, status, message);
            await this.removeRunningExec(entry.id);
            this.options.logger?.info?.({ execId: entry.id, pid: entry.pid, sessionId: entry.sessionId }, "Delivered background exec completion");
          } catch (err) {
            this.options.logger?.warn?.({ err, execId: entry.id, sessionId: entry.sessionId }, "Failed to deliver background exec completion; will retry");
          }
        }
      }
    };
    exports2.PersistentExecManager = PersistentExecManager;
  }
});

// ../shared/dist/nodeTools.js
var require_nodeTools = __commonJS({
  "../shared/dist/nodeTools.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports2 && exports2.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports2 && exports2.__importStar || /* @__PURE__ */ (function() {
      var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function(o2) {
          var ar = [];
          for (var k in o2) if (Object.prototype.hasOwnProperty.call(o2, k)) ar[ar.length] = k;
          return ar;
        };
        return ownKeys(o);
      };
      return function(mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) {
          for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        }
        __setModuleDefault(result, mod);
        return result;
      };
    })();
    var __importDefault = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.nodeTools = void 0;
    exports2.read = read2;
    exports2.write = write2;
    exports2.edit = edit2;
    exports2.apply_patch = apply_patch2;
    exports2.get_default_cwd = get_default_cwd;
    exports2.exec = exec;
    exports2.buildBrowserScreenshotResult = buildBrowserScreenshotResult;
    exports2.browse_open = browse_open;
    exports2.browse_list = browse_list;
    exports2.browse_get = browse_get;
    exports2.browse_close = browse_close;
    exports2.browse_interact = browse_interact;
    var crypto_1 = __importDefault(require("crypto"));
    var path_1 = __importDefault(require("path"));
    var applyPatch_1 = require_applyPatch();
    var nodeFileTransfer_1 = require_nodeFileTransfer();
    var fileToolCore_1 = require_fileToolCore();
    var fileOperations_1 = require_fileOperations();
    var persistentExec_1 = require_persistentExec();
    var processOperations_1 = require_processOperations();
    function escapeRegExp(text) {
      return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    function applyExactReplacement(content, searchText, replaceText, label) {
      if (!content.includes(searchText))
        throw new Error(`Could not find ${label} in file. Make sure whitespace matches exactly.`);
      const regex = new RegExp(escapeRegExp(searchText), "g");
      const matches = content.match(regex);
      if (matches && matches.length > 1)
        throw new Error(`Found ${matches.length} occurrences of ${label} in file. Edit tool only replaces once. Please make ${label} more specific to match exactly one location.`);
      return content.replace(regex, replaceText);
    }
    function resolveToolPath(filePath, ctx) {
      return (0, nodeFileTransfer_1.resolveNodePath)(filePath, ctx.session?.agent || "main", ctx.session?.cwd);
    }
    async function read2(args, ctx = {}) {
      const { filePath, startLine, endLine } = args;
      return (0, fileToolCore_1.readFileToolPath)(resolveToolPath(filePath, ctx), filePath, startLine, endLine, ctx.fileOperations);
    }
    async function write2(args, ctx = {}) {
      const { filePath, content, overwrite } = args;
      if (typeof content !== "string")
        throw new Error("write requires string content");
      const fullPath = resolveToolPath(filePath, ctx);
      await (0, fileToolCore_1.writeFileToolPath)(fullPath, content, {
        overwrite: overwrite === true,
        existsMessage: `File already exists: ${filePath}. Use overwrite=true to overwrite, or use edit tool to modify existing file.`,
        createDirs: args.createDirs === true
      }, ctx.fileOperations);
      return "File written successfully";
    }
    async function edit2(args, ctx = {}) {
      const { filePath, oldText, newText } = args;
      if (typeof oldText !== "string" || typeof newText !== "string")
        throw new Error("Edit tool requires oldText and newText. Use apply_patch for patch-style edits.");
      const fullPath = resolveToolPath(filePath, ctx);
      const operations = ctx.fileOperations || fileOperations_1.nativeFileOperations;
      const content = (await (0, fileOperations_1.readWholeFile)(operations, fullPath)).toString("utf8");
      await operations.write(fullPath, applyExactReplacement(content, oldText, newText, "oldText"), "w");
      return "File edited successfully";
    }
    async function applyPatchOperations(input, resolveOperationPath, fileOperations) {
      const operations = (0, applyPatch_1.parseApplyPatchInput)(input);
      const summaries = [];
      for (let idx = 0; idx < operations.length; idx++) {
        const operation = operations[idx];
        const { fullPath, displayPath } = resolveOperationPath(operation.filePath);
        try {
          if (operation.action === "update") {
            if (!await (0, fileOperations_1.fileOperationPathExists)(fileOperations, fullPath))
              throw new Error(`Cannot update missing file: ${displayPath}`);
            const content = (await (0, fileOperations_1.readWholeFile)(fileOperations, fullPath)).toString("utf8");
            await fileOperations.write(fullPath, (0, applyPatch_1.applyUpdatePatch)(content, operation.lines, displayPath), "w");
            summaries.push((0, applyPatch_1.formatApplyPatchOperationSummary)(operation, displayPath));
          } else if (operation.action === "add") {
            if (await (0, fileOperations_1.fileOperationPathExists)(fileOperations, fullPath))
              throw new Error(`Cannot add file that already exists: ${displayPath}`);
            await fileOperations.mkdir(path_1.default.dirname(fullPath));
            await fileOperations.write(fullPath, (0, applyPatch_1.buildAddedFileContent)(operation.lines), "w");
            summaries.push((0, applyPatch_1.formatApplyPatchOperationSummary)(operation, displayPath));
          } else {
            if (!await (0, fileOperations_1.fileOperationPathExists)(fileOperations, fullPath))
              throw new Error(`Cannot delete missing file: ${displayPath}`);
            await fileOperations.remove(fullPath);
            summaries.push((0, applyPatch_1.formatApplyPatchOperationSummary)(operation, displayPath));
          }
        } catch (err) {
          const succeeded = summaries.length > 0 ? `
Operations already applied (these changes are already on disk):
${summaries.map((line) => `- ${line}`).join("\n")}
` : "";
          const remaining = operations.length - idx - 1;
          const remainingHint = remaining > 0 ? `
${remaining} remaining operation(s) were not applied.` : "";
          throw new Error(`${err.message}${succeeded}${remainingHint}`);
        }
      }
      return `Patch applied successfully.
${summaries.map((line) => `- ${line}`).join("\n")}`;
    }
    async function apply_patch2(args, ctx = {}) {
      if (!args.input || typeof args.input !== "string")
        throw new Error("apply_patch requires input string.");
      return applyPatchOperations(args.input, (filePath) => ({ fullPath: resolveToolPath(filePath, ctx), displayPath: filePath }), ctx.fileOperations || fileOperations_1.nativeFileOperations);
    }
    var sessionEventDispatchers = /* @__PURE__ */ new Map();
    var execManagers = /* @__PURE__ */ new Map();
    function getExecManager(agentName) {
      const existing = execManagers.get(agentName);
      if (existing)
        return existing;
      const execTempDir = path_1.default.join((0, nodeFileTransfer_1.getNodeAgentDir)(agentName), ".temp", "exec");
      const manager = new persistentExec_1.PersistentExecManager({
        getDefaultCwd: () => process.cwd(),
        getExecTempDir: () => execTempDir,
        registryPath: path_1.default.join(execTempDir, "running-exec.json"),
        nodeId: process.env.FOXWARM_NODE_ID || "remote-node",
        processOperations: processOperations_1.nativeProcessOperations,
        completionDispatcher: async (entry, _status, message) => {
          const dispatcher = entry.sessionId ? sessionEventDispatchers.get(entry.sessionId) : void 0;
          if (dispatcher)
            await dispatcher(message, "background");
        }
      });
      execManagers.set(agentName, manager);
      return manager;
    }
    async function get_default_cwd() {
      return process.cwd();
    }
    async function exec(args, ctx = {}) {
      const command = String(args.command || "");
      if (!command.trim())
        throw new Error("exec requires command");
      const resolvedTimeout = (0, persistentExec_1.resolveExecTimeoutSeconds)(args.timeout);
      const timeoutSeconds = resolvedTimeout.effectiveSeconds;
      const agentName = ctx.session?.agent || "main";
      if (ctx.sessionId && ctx.queueSystemEvent)
        sessionEventDispatchers.set(ctx.sessionId, ctx.queueSystemEvent);
      const manager = getExecManager(agentName);
      await manager.initialize();
      const entry = await manager.startPersistentExec({
        command,
        sessionId: ctx.sessionId,
        agentName,
        nodeId: ctx.runtimeNodeId || ctx.session?.currentNode || process.env.FOXWARM_NODE_ID || "remote-node",
        cwd: args.cwd,
        sessionCwd: ctx.session?.cwd
      });
      const status = await manager.waitForExecCompletion(entry.id, timeoutSeconds * 1e3);
      if (status) {
        try {
          return await manager.buildForegroundExecResult(entry, status, resolvedTimeout.warning);
        } finally {
          await manager.finalizeForegroundExec(entry.id);
        }
      }
      await manager.markExecForBackgroundNotification(entry.id);
      return await manager.buildBackgroundTimeoutResult(entry, timeoutSeconds, resolvedTimeout.warning);
    }
    var SharedBrowserManager = class {
      constructor() {
        this.browser = null;
        this.tabs = /* @__PURE__ */ new Map();
      }
      async ensureBrowser() {
        if (this.browser)
          return this.browser;
        const puppeteer = await Promise.resolve().then(() => __importStar(require("puppeteer-core")));
        const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || "/usr/bin/chromium-browser";
        this.browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
        return this.browser;
      }
      async open(url) {
        const browser2 = await this.ensureBrowser();
        const page = await browser2.newPage();
        await page.goto(url, { waitUntil: "networkidle2", timeout: 3e4 });
        const id = `tab_${Date.now()}_${crypto_1.default.randomBytes(4).toString("hex")}`;
        const title = await page.title();
        this.tabs.set(id, { page, url, title });
        return { tabId: id, url, title };
      }
      async list() {
        return Array.from(this.tabs.entries()).map(([id, tab]) => ({ id, url: tab.url, title: tab.title }));
      }
      async get(id, screenshot) {
        const tab = this.tabs.get(id);
        if (!tab)
          throw new Error(`Tab ${id} not found`);
        tab.url = tab.page.url();
        tab.title = await tab.page.title();
        if (screenshot) {
          const buffer = await tab.page.screenshot({ fullPage: screenshot === "full" });
          return buildBrowserScreenshotResult({ id, url: tab.url, title: tab.title }, buffer);
        }
        return { id, url: tab.url, title: tab.title, content: await tab.page.content() };
      }
      async close(id) {
        const tab = this.tabs.get(id);
        if (!tab)
          throw new Error(`Tab ${id} not found`);
        await tab.page.close();
        this.tabs.delete(id);
        return `Tab ${id} closed`;
      }
      async interact(id, action, params = {}) {
        const tab = this.tabs.get(id);
        if (!tab)
          throw new Error(`Tab ${id} not found`);
        switch (action) {
          case "click":
            await tab.page.click(params.selector);
            await tab.page.waitForNavigation({ waitUntil: "networkidle2", timeout: 5e3 }).catch(() => {
            });
            return `Clicked: ${params.selector}`;
          case "type":
            await tab.page.type(params.selector, params.text);
            return `Typed into ${params.selector}`;
          case "fill":
            await tab.page.evaluate((selector, text) => {
              const el = document.querySelector(selector);
              if (!el)
                throw new Error(`Selector not found: ${selector}`);
              el.value = text;
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }, params.selector, params.text);
            return `Filled ${params.selector}`;
          case "press":
            await tab.page.keyboard.press(params.key);
            return `Pressed key: ${params.key}`;
          case "scroll":
            await tab.page.evaluate((y) => window.scrollBy(0, y), params.y || 0);
            return `Scrolled by ${params.y || 0}px`;
          case "wait":
            await tab.page.waitForSelector(params.selector, { timeout: params.timeout || 5e3 });
            return `Waited for: ${params.selector}`;
          case "evaluate":
            return `Evaluated: ${JSON.stringify(await tab.page.evaluate(params.code))}`;
          case "goto":
            await tab.page.goto(params.url, { waitUntil: "networkidle2", timeout: 3e4 });
            tab.url = params.url;
            tab.title = await tab.page.title();
            return `Navigated to: ${params.url}
Title: ${tab.title}`;
          case "back":
            await tab.page.goBack({ waitUntil: "networkidle2" });
            return "Navigated back";
          case "forward":
            await tab.page.goForward({ waitUntil: "networkidle2" });
            return "Navigated forward";
          case "reload":
            await tab.page.reload({ waitUntil: "networkidle2" });
            return "Page reloaded";
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      }
    };
    function buildBrowserScreenshotResult(tab, buffer) {
      const mimeType = "image/png";
      return {
        ...tab,
        output: `[Screenshot of ${tab.id}]`,
        mimeType,
        sizeBytes: buffer.length,
        inlineData: { data: buffer.toString("base64"), mimeType }
      };
    }
    var browser = new SharedBrowserManager();
    async function browse_open(args) {
      return browser.open(String(args.url || ""));
    }
    async function browse_list() {
      return browser.list();
    }
    async function browse_get(args) {
      return browser.get(String(args.tabId || ""), args.screenshot);
    }
    async function browse_close(args) {
      return browser.close(String(args.tabId || ""));
    }
    async function browse_interact(args) {
      return browser.interact(String(args.tabId || ""), String(args.action || ""), args.params || {});
    }
    exports2.nodeTools = { read: read2, write: write2, edit: edit2, apply_patch: apply_patch2, exec, get_default_cwd, browse_open, browse_list, browse_get, browse_close, browse_interact };
  }
});

// src/invoke.ts
var import_fs_extra2 = __toESM(require_lib());
var import_node_path2 = __toESM(require("node:path"));
var import_nodeTools = __toESM(require_nodeTools());
var import_applyPatch = __toESM(require_applyPatch());

// src/worktreeFileOperations.ts
var import_fs_extra = __toESM(require_lib());
var import_node_path = __toESM(require("node:path"));
var import_fileOperations = __toESM(require_fileOperations());
function inside(root, candidate) {
  const relative = import_node_path.default.relative(root, candidate);
  return relative === "" || !relative.startsWith(`..${import_node_path.default.sep}`) && relative !== ".." && !import_node_path.default.isAbsolute(relative);
}
async function nearestExisting(candidate) {
  let current = candidate;
  while (true) {
    if (await import_fs_extra.default.pathExists(current)) return current;
    const parent = import_node_path.default.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}
async function rejectSymlinkComponents(root, candidate) {
  const relative = import_node_path.default.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(import_node_path.default.sep).filter(Boolean)) {
    current = import_node_path.default.join(current, segment);
    try {
      const stats = await import_fs_extra.default.lstat(current);
      if (stats.isSymbolicLink()) throw new Error("Sandbox file path contains a symlink component.");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}
async function assertWorktreePath(rootInput, candidateInput, existing) {
  const root = await import_fs_extra.default.realpath(import_node_path.default.resolve(rootInput));
  const candidate = import_node_path.default.resolve(candidateInput);
  if (!inside(root, candidate)) throw new Error("Sandbox file path is outside the configured worktree.");
  await rejectSymlinkComponents(root, candidate);
  const anchor = existing ? candidate : await nearestExisting(candidate);
  let real;
  try {
    real = await import_fs_extra.default.realpath(anchor);
  } catch {
    throw new Error("Sandbox file path could not be resolved safely.");
  }
  if (!inside(root, real)) throw new Error("Sandbox file path escapes the configured worktree through a symlink.");
  return candidate;
}
function createWorktreeFileOperations(root) {
  const native = (0, import_fileOperations.createNativeFileOperations)();
  return {
    async stat(filePath) {
      return native.stat(await assertWorktreePath(root, filePath, true));
    },
    async read(filePath, offset, count) {
      return native.read(await assertWorktreePath(root, filePath, true), offset, count);
    },
    async readdir(filePath) {
      return native.readdir(await assertWorktreePath(root, filePath, true));
    },
    async write(filePath, content, flag) {
      const exists = await import_fs_extra.default.pathExists(filePath);
      return native.write(await assertWorktreePath(root, filePath, exists), content, flag);
    },
    async mkdir(filePath) {
      return native.mkdir(await assertWorktreePath(root, filePath, false));
    },
    async remove(filePath) {
      return native.remove(await assertWorktreePath(root, filePath, true));
    }
  };
}

// src/invoke.ts
function rejectParentSegments(value, label) {
  if (typeof value !== "string") return;
  if (value.split(/[\\/]+/).includes("..")) throw new Error(`${label} must not contain parent-directory segments.`);
}
async function main() {
  const rootRaw = process.env.FOXWARM_WORKTREE_ROOT;
  if (!rootRaw) throw new Error("Sandbox runtime is missing FOXWARM_WORKTREE_ROOT.");
  const root = await import_fs_extra2.default.realpath(import_node_path2.default.resolve(rootRaw));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!request || !request.args || typeof request.args !== "object" || Array.isArray(request.args)) throw new Error("Sandbox runtime request is invalid.");
  if (!["read", "write", "edit", "apply_patch"].includes(request.toolName)) throw new Error(`Unsupported sandbox capability: ${request.toolName}`);
  if (request.toolName === "write" && Object.prototype.hasOwnProperty.call(request.args, "contentRef")) {
    throw new Error("Sandbox Node write does not support contentRef; provide literal content instead.");
  }
  if (request.toolName === "apply_patch") {
    if (typeof request.args.input !== "string") throw new Error("apply_patch requires input string.");
    for (const operation of (0, import_applyPatch.parseApplyPatchInput)(request.args.input)) rejectParentSegments(operation.filePath, "Sandbox patch path");
  } else {
    rejectParentSegments(request.args.filePath, "Sandbox file path");
  }
  rejectParentSegments(request.cwd, "Sandbox session cwd");
  const cwd = typeof request.cwd === "string" && request.cwd.trim() ? import_node_path2.default.resolve(request.cwd) : root;
  const relative = import_node_path2.default.relative(root, cwd);
  if (relative === ".." || relative.startsWith(`..${import_node_path2.default.sep}`) || import_node_path2.default.isAbsolute(relative)) throw new Error("Sandbox session cwd is outside the configured worktree.");
  await assertWorktreePath(root, cwd, true);
  const ctx = { session: { agent: "main", cwd }, fileOperations: createWorktreeFileOperations(root) };
  const tools = { read: import_nodeTools.read, write: import_nodeTools.write, edit: import_nodeTools.edit, apply_patch: import_nodeTools.apply_patch };
  const result = await tools[request.toolName](request.args, ctx);
  process.stdout.write(JSON.stringify({ ok: true, result }));
}
main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
});
