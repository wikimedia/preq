if (!global.Promise) {
    global.Promise = require('bluebird');
}

var util = require('util');

if (!Array.prototype.last) {
    Array.prototype.last = function() {
        return this[this.length - 1];
    };
}

var req = require('request');

function getOptions(uri, o, method) {
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
    o.method = method;
    if (o.body && o.body instanceof Object) {
        if (o.headers && /^application\/json/.test(o.headers['content-type'])) {
            o.body = JSON.stringify(o.body);
        } else if (o.method === 'post') {
            o.form = o.body;
            o.body = undefined;
        }
    }
    return o;
}

/*
 * Error instance wrapping HTTP error responses
 *
 * Has the same properties as the original response.
 */
function HTTPErrorResponse(response) {
    for (var key in response) {
        this[key] = response[key];
    }
    this.stack = this.toString();
}
util.inherits(HTTPErrorResponse, Error);

function wrap(method) {
    return function (url, options) {
        options = getOptions(url, options, method);
        return new Promise(function(resolve, reject) {
            var cb = function(err, res) {
                if (err || !res) {
                    if (!err) {
                        err = new HTTPErrorResponse({
                            status: 500,
                            body: {
                                type: 'empty_response',
                            }
                        });
                    } else {
                        err =  new HTTPErrorResponse({
                            status: 500,
                            body: {
                                type: 'internal_error'
                            },
                            stack: err.stack
                        });
                    }
                    return reject(err);
                }
                if (res.body && res.headers &&
                        /^application\/json/.test(res.headers['content-type'])) {
                    res.body = JSON.parse(res.body);
                }

                var ourRes = {
                    status: res.statusCode,
                    headers: res.headers,
                    body: res.body
                };

                if (ourRes.status >= 400) {
                    reject(new HTTPErrorResponse(ourRes));
                } else {
                    resolve(ourRes);
                }
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
