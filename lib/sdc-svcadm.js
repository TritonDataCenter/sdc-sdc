#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * CLI client for SAPI (https://github.com/joyent/sdc-sapi).
 * This is intended to replace `sapiadm`.
 */

var p = console.log;
var fs = require('fs');
var util = require('util'),
    format = util.format;

var assert = require('assert-plus');
var bunyan = require('bunyan');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
var SAPI = require('sdc-clients').SAPI;

var common = require('./common'),
    objCopy = common.objCopy;
var errors = require('./errors');



//---- globals & config

var NAME = 'sdc-svcadm';
var VERSION = '1.0.0';

var CONFIG = require('../etc/config.json');

var log = bunyan.createLogger({
    name: NAME,
    serializers: bunyan.stdSerializers,
    stream: process.stderr,
    level: 'warn'
});

var UA = format('%s/%s (node/%s)', NAME, VERSION, process.versions.node);


//---- internal support stuff

/**
 * Convert a boolean or string representation (as in redis or UFDS or a
 * query param) into a boolean, or raise TypeError trying.
 *
 * @param value {Boolean|String} The input value to convert.
 * @param default_ {Boolean} The default value is `value` is undefined.
 * @param errName {String} The variable name to quote in the possibly
 *      raised TypeError.
 */
function boolFromString(value, default_, errName) {
    if (value === undefined) {
        return default_;
    } else if (value === 'false') {
        return false;
    } else if (value === 'true') {
        return true;
    } else if (typeof (value) === 'boolean') {
        return value;
    } else {
        throw new TypeError(
            format('invalid value for "%s": %j', errName, value));
    }
}



//---- the CLI

function CLI() {
    Cmdln.call(this, {
        name: NAME,
        desc: 'Administer the SDC Services API (SAPI)',
        options: [
            {names: ['help', 'h'], type: 'bool', help: 'Print help and exit.'},
            {name: 'version', type: 'bool', help: 'Print version and exit.'},
            {names: ['verbose', 'v'], type: 'bool',
                help: 'Verbose/debug output.'}
        ],
        helpOpts: {
            includeEnv: true,
            minHelpCol: 23 /* line up with option help */
        }
    });
}
util.inherits(CLI, Cmdln);

CLI.prototype.init = function (opts, args, callback) {
    if (opts.version) {
        p(this.name, VERSION);
        callback(false);
        return;
    }
    this.opts = opts;
    if (opts.verbose) {
        log.level('trace');
        log.src = true;
    }

    self.userAgent = UA;
    Object.defineProperty(this, 'sapi', {
        get: function () {
            if (self._sapi === undefined) {
                self._sapi = new SAPI({
                    url: 'http://' + CONFIG.sapi_domain,
                    agent: false,
                    userAgent: self.userAgent,
                    log: self.log
                });
            }
            return self._sapi;
        }
    });

    Cmdln.prototype.init.apply(this, arguments);
};


CLI.prototype.do_ping = function (subcmd, opts, args, cb) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length !== 0) {
        return cb(new errors.UsageError(format(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    this.sapi.ping(function (err, pong) {
        if (err) {
            cb(err);
        } else {
            console.log(JSON.stringify(pong, null, 4));
            cb();
        }
    });
};
CLI.prototype.do_ping.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_ping.help = (
    'Ping the SAPI service.\n'
    + '\n'
    + 'Usage:\n'
    + '     {{name}} ping [<options>]\n'
    + '\n'
    + '{{options}}\n'
);




//---- mainline

// TODO: update to latest cmdln and use simpler cmdln.main().
if (require.main === module) {
    var cli = new CLI();
    cli.main(process.argv, function (err, subcmd) {
        if (err) {
            var subcmdStr = subcmd ? ' ' + subcmd : '';
            var code = (err.body ? err.body.code : err.code);
            if (code) {
                console.error('%s%s: error (%s): %s', cli.name, subcmdStr,
                    code, err.message);
            } else {
                console.error('%s%s: error: %s', cli.name, subcmdStr,
                    err.message);
            }
            if (cli.opts.verbose && err.stack) {
                console.error('\n' + err.stack);
            }
            process.exit(err.exitStatus !== undefined ? err.exitStatus : 1);
        } else {
            process.exit(0);
        }
    });
}
