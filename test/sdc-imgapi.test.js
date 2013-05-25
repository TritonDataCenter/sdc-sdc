/*
 * Copyright (c) 2013 Joyent Inc. All rights reserved.
 */

var format = require('util').format;
var exec = require('child_process').exec;


// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;


test('sdc-imgapi /ping', function (t) {
    exec('sdc-imgapi /ping', function (err, stdout, stderr) {
        t.ifError(err, err);
        t.equal(stderr, '', 'stderr');
        t.ok(/pong/.test(stdout), 'stdout has pong');
        t.end();
    });
});
