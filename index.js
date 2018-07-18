"use strict";

const P = require('bluebird');
const url = require('url');
const querystring = require('querystring');
const request = require('requestretry');

function createConnectTimeoutAgent(protocol) {
    const http = require(`${protocol}`);

    // Many concurrent connections to the same host
    class ConnectTimeoutAgent extends http.Agent {
        createSocket(req, options, cb) {
            const connectTimeoutTimer = setTimeout(() => {
                const e = new Error('ETIMEDOUT');
                e.code = 'ETIMEDOUT';
                cb(e);
            }, this.options.connectTimeout);
            super.createSocket(req, options, (error, newSocket) => {
                newSocket.on('connect', () => {
                    clearTimeout(connectTimeoutTimer);
                });
                cb(error, newSocket);
            });
        }
    }

    return ConnectTimeoutAgent;
}

const defaultAgentOptions = {
    connectTimeout: (process.env.PREQ_CONNECT_TIMEOUT || 5) * 1000,
    // Setting this too high (especially 'Infinity') leads to high
    // (hundreds of mb) memory usage in the agent under sustained request
    // workloads. 250 should be a reasonable upper bound for practical
    // applications.
    maxSockets: 250
};
const httpAgentClass = createConnectTimeoutAgent('http');
const httpsAgentClass = createConnectTimeoutAgent('https');

function getOptions(uri, o, method) {
    if (!o || o.constructor !== Object) {
        if (uri) {
            if (typeof uri === 'object') {
                o = uri;
            } else {
                o = { uri };
            }
        } else {
            throw new Error('preq options missing!');
        }
    } else {
        o.uri = uri;
    }
    o.uri = o.uri || o.url;
    o.method = method;
    o.headers = o.headers || {};
    Object.keys(o.headers).forEach((header) => {
        if (header.toLowerCase() !== header) {
            o.headers[header.toLowerCase()] = o.headers[header];
            delete o.headers[header];
        }
    });
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
        o.maxAttempts = 2;
    } else {
        o.maxAttempts = o.retries + 1;
    }

    if (o.query) {
        o.qs = o.query;
        o.query = undefined;
    }

    // Set a timeout by default
    if (o.timeout === undefined) {
        o.timeout = 2 * 60 * 1000; // 2 minutes
    }

    if ((o.headers && /\bgzip\b/.test(o.headers['accept-encoding']))
        || (o.gzip === undefined && o.method === 'get')) {
        o.gzip = true;
    }

    // Default to binary requests (return buffer)
    if (o.encoding === undefined) {
        o.encoding = null;
    } else {
        o._encodingProvided = true;
    }

    o.agentClass = /^https/.test(o.uri) ? httpsAgentClass : httpAgentClass;
    o.agentOptions = Object.assign({}, defaultAgentOptions, o.agentOptions);

    return o;
}

/*
 * Error instance wrapping HTTP error responses
 *
 * Has the same properties as the original response.
 */
class HTTPError extends Error {
    constructor(response) {
        super();
        Error.captureStackTrace(this, HTTPError);
        this.name = this.constructor.name;
        this.message = response.status.toString();
        if (response.body && response.body.type) {
            this.message += `: ${response.body.type}`;
        }
        Object.assign(this, response);
    }
}


/*
 * Encapsulate the state associated with a single HTTP request
 */
class Request {
    constructor(method, url, options) {
        this.options = getOptions(url, options, method);
        this.delay = 100; // start with 100ms
        this.options.delayStrategy = () => {
            // exponential backoff with some fuzz, but start with a short delay
            const delay = this.delay;
            this.delay = this.delay * 2 + this.delay * Math.random();
            return delay;
        };
        this.options.promiseFactory = resolver => new P(resolver);
        this.options.retryStrategy = (err, response) => {
            if (response && response.statusCode === 503
                    && /^[0-9]+$/.test(response.headers['retry-after'])) {
                this.delay = parseInt(response.headers['retry-after'], 10) * 1000;
                return true;
            }
            return request.RetryStrategies.HTTPOrNetworkError(err, response);
        };
    }

    run() {
        return request(this.options)
        .then((response) => {
            let body = response.body;
            if (this.options.gzip && response.headers) {
                delete response.headers['content-encoding'];
                delete response.headers['content-length'];
            }

            if (body && response.headers && !this.options._encodingProvided) {
                const contentType = response.headers['content-type'];
                // Decodes:  "text/...", "application/json...", "application/vnd.geo+json..."
                if (/^text\/|application\/([^+;]+\+)?json\b/.test(contentType)) {
                    // Convert buffer to string
                    body = body.toString();
                    delete response.headers['content-length'];
                }

                if (/^application\/([^+;]+\+)?json\b/.test(contentType)) {
                    body = JSON.parse(body);
                }
            }

            // 204, 205 and 304 responses must not contain any body
            if (response.statusCode === 204 || response.statusCode === 205
                || response.statusCode === 304) {
                body = undefined;
            }

            const res = {
                status: response.statusCode,
                headers: response.headers,
                body
            };

            // Check if we were redirected
            let origURI = this.options.uri;
            if (this.options.qs && Object.keys(this.options.qs).length) {
                origURI += `?${querystring.stringify(this.options.qs)}`;
            }

            if (origURI !== response.request.uri.href
                && url.format(origURI) !== response.request.uri.href) {
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
                throw new HTTPError(res);
            } else {
                return res;
            }
        }, (err) => {
            throw new HTTPError({
                status: err.status || 504,
                body: {
                    type: 'internal_http_error',
                    description: err.toString(),
                    error: err,
                    stack: err.stack,
                    uri: this.options.uri,
                    method: this.options.method,
                },
                stack: err.stack
            });
        });
    }
}

const preq = (url, options) => {
    const method = (options || url || {}).method || 'get';
    return new Request(method, url, options).run();
};

const methods = ['get', 'head', 'put', 'post', 'delete', 'trace', 'options', 'mkcol', 'patch'];
methods.forEach((method) => {
    preq[method] = (url, options) => new Request(method, url, options).run();
});

module.exports = preq;
