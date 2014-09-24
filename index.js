if (!global.Promise) {
    global.Promise = require('bluebird');
}

if (!Array.prototype.last) {
    Array.prototype.last = function() {
        return this[this.length - 1];
    };
}

var req = require('request');

function getOptions(uri, o) {
    if (!o || o.constructor !== Object) {
        if (uri) {
            if (typeof uri === 'object') {
                o = uri;
            } else {
                o = { uri: uri };
            }
        } else {
            throw new Error('preq options missing!');
        }
    } else {
        o.uri = uri;
    }
    if (o.body && o.body.constructor === Object) {
        if (o.headers && /^application\/json/.test(o.headers['content-type'])) {
            o.body = JSON.stringify(o.body);
        } else if (o.method === 'post') {
            o.form = o.body;
            o.body = undefined;
        }
    }
    return o;
}

function wrap(method) {
    return function (url, options) {
        var options = getOptions(url, options);
        if (method) {
            options.method = method;
        }
        return new Promise(function(resolve, reject) {
            var cb = function(err, res) {
                if (err) {
                    reject({
                        status: 500,
                        body: {
                            type: 'unknown_error',
                            err: err.toString(),
                            stack: e.stack
                        }
                    });
                }
                res.status = res.statusCode;
                res.statusCode = undefined;
                res.request = undefined;

                if (res.status >= 400) {
                    return reject(res);
                }
                resolve(res);
            };

            req(options, cb);
        });
    };
}

var preq = wrap(req);

var methods = ['get','head','put','post','delete','trace','options','mkcol','patch'];
methods.forEach(function(method) {
    preq[method] = wrap(method);
});

module.exports = preq;
