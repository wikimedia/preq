var preq = require('../index');
var assert = require('assert');

describe('preq', function() {
    it('should retry', function() {
        this.timeout(20000);
        var tStart = new Date();
        return preq.get({
            // Some unreachable port
            uri: 'http://localhost:666666/',
            retries: 6
        })
        .catch(function(e) {
            assert.equal(e.status, 500);
            var tDelta = new Date() - tStart;
            if (tDelta < 3150) {
                throw new Error("Does not look as if this actually retried!")
            }
        });
    });
});

