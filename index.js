"use strict";

var P = require('bluebird');
var url = require('url');
var util = require('util');
var semver = require('semver');

function setupConnectionTimeout(protocol) {
    var http = require(protocol);
    var Agent = http.Agent;

    // Many concurrent connections to the same host
    function ConnectTimeoutAgent() {
        Agent.apply(this, arguments);
    }
    util.inherits(ConnectTimeoutAgent, Agent);

    ConnectTimeoutAgent.prototype.createSocket = function() {
        var args = Array.prototype.slice.call(arguments);
        var options = this.options;
        var cb = null;
        function setup(err, s) {
            if (err) {
                if (typeof cb === 'function') {
                    cb(err, s);
                }
                return;
            }
            // Set up a connect timeout if connectTimeout option is set
            if (options.connectTimeout && !s.connectTimeoutTimer) {
                s.connectTimeoutTimer = setTimeout(function() {
                    var e = new Error('ETIMEDOUT');
                    e.code = 'ETIMEDOUT';
                    s.end();
                    s.emit('error', e);
                    s.destroy();
                }, options.connectTimeout);
                s.once('connect',  function() {
                    if (s.connectTimeoutTimer) {
                        clearTimeout(s.connectTimeoutTimer);
                        s.connectTimeoutTimer = undefined;
                    }
                });
            }
            if (typeof cb === 'function') {
                cb(null, s);
            }
        }
        // Unfortunately, `createSocket` is not a public method of Agent
        // and, in v5.7 of node, it switched to being an asynchronous method.
        // `setup` is passed in to remain compatible going forward, while
        // we continue to return the socket if the synchronous method is
        // feature detected.
        var sufficientNodeVersion = semver.gte(process.version, '5.7.0');
        if (sufficientNodeVersion) {
            cb = args[2];
            args[2] = setup;
        }
        var sock = Agent.prototype.createSocket.apply(this, args);
        if (!sufficientNodeVersion) {
            setup(null, sock);
            return sock;
        }
    };

    http.globalAgent = new ConnectTimeoutAgent({
        connectTimeout: 5 * 1000,
        // Setting this too high (especially 'Infinity') leads to high
        // (hundreds of mb) memory usage in the agent under sustained request
        // workloads. 250 should be a reasonable upper bound for practical
        // applications.
        maxSockets: 250
    });
}
setupConnectionTimeout('http');
setupConnectionTimeout('https');

var request = P.promisify(require('request'), { multiArgs: true });

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
        // Idempotent methods: Retry once by default
        o.retries = 1;
    }

    if (o.query) {
        o.qs = o.query;
        o.query = undefined;
    }

    // Set a timeout by default
    if (o.timeout === undefined) {
        o.timeout = 2 * 60 * 1000; // 2 minutes
    }

    if ((o.headers && /\bgzip\b/.test(o.headers['accept-encoding'])) || (o.gzip === undefined && o.method === 'get')) {
        o.gzip = true;
    }

    // Default to binary requests (return buffer)
    if (o.encoding === undefined) {
        o.encoding = null;
    } else {
        o._encodingProvided = true;
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
    this.message = response.status.toString();
    if (response.body && response.body.type) {
        this.message += ': ' + response.body.type;
    }
    for (var key in response) {
        this[key] = response[key];
    }
}
util.inherits(HTTPError, Error);


/*
 * Encapsulate the state associated with a single HTTP request
 */
function Request (method, url, options) {
    this.options = getOptions(url, options, method);
    this.retries = this.options.retries;
    this.timeout = this.options.timeout;
    this.delay = 100; // start with 100ms
}

Request.prototype.retry = function (err) {
    if (this.retries) {
        this.retries--;
        // exponential backoff with some fuzz, but start with a short delay
        this.delay = this.delay * 2 + this.delay * Math.random();
        // grow the timeout linearly, plus some fuzz
        this.timeout += this.options.timeout + Math.random() * this.options.timeout;

        return P.bind(this)
        .delay(this.delay)
        .then(this.run);
    } else {
        throw err;
    }
};

Request.prototype.run = function () {
    var self = this;
    return P.try(function() { return request(self.options) })
    .bind(this)
    .then(function(responses) {
        if (!responses || responses.length < 2) {
            return this.retry(new HTTPError({
                status: 502,
                body: {
                    type: 'empty_response',
                }
            }));
        } else {
            var response = responses[0];
            var body = responses[1]; // decompressed

            if (self.options.gzip && response.headers) {
                delete response.headers['content-encoding'];
                delete response.headers['content-length'];
            }

            if (body && response.headers && !self.options._encodingProvided) {
                var contentType = response.headers['content-type'];
                if (/^text\/|application\/json\b/.test(contentType)) {
                    // Convert buffer to string
                    body = body.toString();
                    delete response.headers['content-length'];
                }

                if (/^application\/(?:problem\+)?json\b/.test(contentType)) {
                    body = JSON.parse(body);
                }
            }

            var res = {
                status: response.statusCode,
                headers: response.headers,
                body: body
            };

            // Check if we were redirected
            if (self.options.uri !== response.request.uri.href) {
                if (!res.headers['content-location']) {
                    // Indicate the redirect via an injected Content-Location
                    // header
                    res.headers['content-location'] = response.request.uri.href;
                } else {
                    // Make sure that we resolve the returned content-location
                    // relative to the last request URI
                    res.headers['content-location'] = url.parse(response.request.uri)
                            .resolve(res.headers['content-location']);
                }
            }

            if (res.status >= 400) {
                if (res.status === 503
                        && /^[0-9]+$/.test(response.headers['retry-after'])
                        && parseInt(response.headers['retry-after']) * 1000 < self.options.timeout) {
                    self.delay = parseInt(response.headers['retry-after']) * 1000;
                    return self.retry(new HTTPError(res));
                }

                throw new HTTPError(res);
            } else {
                return res;
            }
        }
    },
    function (err) {
        return this.retry(new HTTPError({
            status: 504,
            body: {
                type: 'internal_http_error',
                description: err.toString(),
                error: err,
                stack: err.stack,
                uri: self.options.uri,
                method: self.options.method,
            },
            stack: err.stack
        }));
    });
};

var preq = function preq (url, options) {
    var method = (options || url || {}).method || 'get';
    return new Request(method, url, options).run();
};

var methods = ['get','head','put','post','delete','trace','options','mkcol','patch'];
methods.forEach(function(method) {
    preq[method] = function (url, options) {
        return new Request(method, url, options).run();
    };
});

module.exports = preq;
