"use strict";
var P = require('bluebird');
var util = require('util');

if (!Array.prototype.last) {
    Array.prototype.last = function() {
        return this[this.length - 1];
    };
}


var req = require('request');

// Increase the number of sockets per server
require('http').globalAgent.maxSockets = 100;

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

    if ((o.method === 'get' || o.method === 'put')
            && o.retries === undefined) {
        // Idempotent methods: Retry by default
        o.retries = 5;
    }


    // Set a timeout by default
    if (o.timeout === undefined) {
        o.timeout = 1 * 60 * 1000; // 1 minute
    }
    return o;
}

/*
 * Error instance wrapping HTTP error responses
 *
 * Has the same properties as the original response.
 */
function HTTPError(response) {
    Error.call(this);
    Error.captureStackTrace(this, HTTPError);
    this.name = this.constructor.name;
    this.message = JSON.stringify(response);

    for (var key in response) {
        this[key] = response[key];
    }
}
util.inherits(HTTPError, Error);

function wrap(method) {
    return function (url, options) {
        options = getOptions(url, options, method);
        return new P(function(resolve, reject) {
            var retries = options.retries;
            var delay = 50;
            var cb = function(err, res) {
                if (err || !res) {
                    if (retries) {
                        //console.log('retrying', options, retries, delay);
                        setTimeout(req.bind(req, options, cb), delay);
                        retries--;
                        delay *= 2;
                        return;
                    }
                    if (!err) {
                        err = new HTTPError({
                            status: 500,
                            body: {
                                type: 'empty_response',
                            }
                        });
                    } else {
                        err =  new HTTPError({
                            status: 500,
                            body: {
                                type: 'internal_error',
                                description: err.toString(),
                                error: err
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
                    reject(new HTTPError(ourRes));
                } else {
                    resolve(ourRes);
                }
            };

            req(options, cb);
        });
    };
}

var preq = function preq (url, options) {
    var method = (options || url || {}).method || 'get';
    return preq[method](url, options);
};

var methods = ['get','head','put','post','delete','trace','options','mkcol','patch'];
methods.forEach(function(method) {
    preq[method] = wrap(method);
});

module.exports = preq;
