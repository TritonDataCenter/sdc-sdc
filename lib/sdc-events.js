#!/usr/node/bin/node
/* vim: syn=javascript ts=4 sts=4 sw=4 et: */

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * List/tail SDC events.
 *
 * Effectively, "events" are bunyan log records from any SDC service with
 * a standard "evt" field.
 * TODO: explain our events plan
 *
 * Typical usage is for getting timings
 * of tasks. Commonly these are coupled with "req_id" at the top-level to
 * group start and end events.
 *
 * * *
 *
 * Listing events means grepping log files. Well-known log file locations
 * are hardcoded here and grouped in "logsets".
 */

/*
 * TODO:
 * - check all LOGSETS are correct
 * - -j|-J|-b for bunyan output and tabular output.
 *   Option group showing all the output formats.
 * - -H, -o,  -o *,foo ('*' means default fields)
 * - -a; -n NODE,...; -n core, -N UUID  (node handling. see notes)
 * - `-s -imgapi` to *exclude* the imgapi logset
 * - shortcuts for logset groups, exclude heavy but uncommon ones (ufds?)
 *   by default?
 *
 * Someday/Maybe:
 * - `sdc-events ... vm=UUID` to first find all req_ids for ops on that VM
 *   in sdc-docker and cloudapi logs for that time period. Then get all
 *   events for those req_ids.
 * - `sdc-events ... owner=UUID|account` to first find all req_ids for ops for
 *   that user in sdc-docker and cloudapi logs for that time period. Then get
 *   all events for those req_ids.
 * - answer for `PROGRESS` func: want it without all trace logging, but probably
 *   not by default. So separate '-v' and TRACE envvar perhaps?
 * - follow
 * - --last: store last results' raw json stream to file based on PPID
 *   and allow re-access via --last. E.g. saw something interesting and want
 *   to see again.
 * - caching (cache "all events" for an hour and logset and use that)
 * - `-t TIME-RANGE`, e.g. `-t 3h-2h`
 */

var VERSION = '1.1.0';

var assert = require('assert-plus');
var bunyan = require('bunyan');
var child_process = require('child_process');
var dashdash = require('dashdash');
var fs = require('fs');
var genUuid = require('node-uuid');
var os = require('os');
var path = require('path');
var sdcClients = require('sdc-clients');
var spawn = require('child_process').spawn;
var stream = require('stream');
var vasync = require('vasync');
var VError = require('verror').VError;
var urclient = require('urclient');
var util = require('util');


// ---- globals

var p = console.error; // for dev use, don't commit with this used
var fmt = util.format;

/*
 * Unfortunately, bunyan does not presently have an output stream that can emit
 * pre-formatted messages to stderr -- see: node-bunyan#13 and node-bunyan#102.
 * For now, we shall keep bunyan logging for debugging purposes and emit our
 * own human-readable messages in verbose mode.
 */
var LOG = bunyan.createLogger({
    level: 'warn',
    name: 'sdc-events',
    stream: process.stderr
});

var OPTIONS;
var CONFIG;
var CNAPI;
var VMAPI;
var SAPI;
var URCLIENT;
var PROGRESS;


// ---- log sets

function LogSet(config) {
    assert.string(config.name, 'config.name');
    assert.optionalBool(config.global, 'config.global');
    if (!config.global) {
        assert.string(config.sapiSvcName, 'config.sapiSvcName');
    }
    assert.string(config.rottype, 'config.rottype');
    assert.string(config.rotdir, 'config.rotdir');
    assert.optionalString(config.rotname, 'config.rotname');

    for (var k in config) {
        this[k] = config[k];
    }
}

LogSet.prototype.getFileGlob = function getFileGlob(zone, hour) {
    assert.string(zone, 'zone');
    assert.string(hour, 'hour');

    var fileGlob;
    if (hour === 'curr') {
        fileGlob = this.curr;
    } else {
        assert.equal(this.rottype, 'sdc-hourly');
        fileGlob = path.join(this.rotdir,
            fmt('%s_*_%s*.log', this.rotname || this.name, hour));
    }
    if (zone !== 'global') {
        fileGlob = path.join('/zones', zone, 'root', fileGlob);
    }
    return fileGlob;
};

LogSet.prototype.toJSON = function toJSON() {
    return {
        name: this.name,
        global: Boolean(this.global),
        curr: this.curr
    };
};


function ZoneLogSet(config) {
    assert.string(config.name, 'config.name');
    if (!config.sapiSvcName) {
        config.sapiSvcName = config.name;
    }
    if (!config.curr) {
        config.curr = fmt('/var/svc/log/smartdc-site-%s:default.log',
            config.name);
    }
    if (!config.rottype) {
        config.rottype = 'sdc-hourly';
    }
    if (!config.rotdir) {
        config.rotdir = '/var/log/sdc/upload';
    }
    LogSet.call(this, config);
}
util.inherits(ZoneLogSet, LogSet);


function GzAgentLogSet(config) {
    assert.string(config.name, 'config.name');
    if (config.global === undefined) {
        config.global = true;
    }
    if (!config.curr) {
        config.curr = fmt('/var/svc/log/smartdc-agent-%s:default.log',
            config.name);
    }
    if (!config.rottype) {
        config.rottype = 'sdc-hourly';
    }
    if (!config.rotdir) {
        config.rotdir = fmt('/var/log/sdc/%s', config.name);
    }
    LogSet.call(this, config);
}
util.inherits(GzAgentLogSet, LogSet);


var LOGSETS = [
    new ZoneLogSet({name: 'imgapi'}),
    new ZoneLogSet({name: 'napi'}),
    new ZoneLogSet({name: 'cnapi'}),
    new ZoneLogSet({name: 'vmapi'}),
    new ZoneLogSet({
        name: 'docker',
        curr: '/var/svc/log/smartdc-application-docker:default.log'
    }),
    new ZoneLogSet({name: 'sapi'}),
    new ZoneLogSet({name: 'papi'}),
    new ZoneLogSet({name: 'fwapi'}),
    new ZoneLogSet({name: 'amon-master', sapiSvcName: 'amon'}),
    new ZoneLogSet({
        name: 'wf-api',
        sapiSvcName: 'workflow',
        curr: '/var/svc/log/smartdc-application-wf-api:default.log'
    }),
    new ZoneLogSet({
        name: 'wf-runner',
        sapiSvcName: 'workflow',
        curr: '/var/svc/log/smartdc-application-wf-runner:default.log'
    }),
    new ZoneLogSet({
        name: 'volapi-server',
        sapiSvcName: 'volapi',
        curr: '/var/svc/log/smartdc-application-volapi-server:default.log'
    }),
    new ZoneLogSet({
        name: 'volapi-updater',
        sapiSvcName: 'volapi',
        curr: '/var/svc/log/smartdc-application-volapi-updater:default.log'
    }),

    new LogSet({
        name: 'cloudapi',
        sapiSvcName: 'cloudapi',
        curr: '/var/svc/log/smartdc-application-cloudapi:cloudapi-*.log',
        rottype: 'sdc-hourly',
        rotdir: '/var/log/sdc/upload',
        rotname: 'cloudapi-*'
    }),

    new LogSet({
        name: 'ufds-master',
        sapiSvcName: 'ufds',
        curr: '/var/svc/log/smartdc-application-ufds-master:ufds-*.log',
        rottype: 'sdc-hourly',
        rotdir: '/var/log/sdc/upload',
        rotname: 'ufds-master-*'
    }),

    new GzAgentLogSet({name: 'vm-agent'}),
    new GzAgentLogSet({name: 'net-agent'}),
    new GzAgentLogSet({name: 'firewaller', rotdir: '/var/log/sdc/upload'}),
    new GzAgentLogSet({name: 'vminfod', rotdir: '/var/log/sdc/upload'}),

    new GzAgentLogSet({name: 'cn-agent'}),
    new LogSet({
        name: 'cn-agent-tasks',
        global: true,
        curr: '/var/log/cn-agent/logs/*.log',
        rottype: 'sdc-hourly',
        rotdir: '/var/log/cn-agent'
    }),

    new GzAgentLogSet({name: 'provisioner'}),
    new LogSet({
        name: 'provisioner-tasks',
        global: true,
        curr: '/var/log/provisioner/logs/*.log',
        rottype: 'sdc-hourly',
        rotdir: '/var/log/provisioner',
        rotname: 'provisioner_tasks'
    }),

    new LogSet({
        name: 'vmadm',
        global: true,
        curr: '/var/log/vm/logs/*.log',
        rottype: 'sdc-hourly',
        rotdir: '/var/log/vm'
    }),
    new LogSet({
        name: 'vmadmd',
        global: true,
        curr: '/var/svc/log/system-smartdc-vmadmd:default.log',
        rottype: 'sdc-hourly',
        rotdir: '/var/log/vm'
    }),
    new LogSet({
        name: 'fwadm',
        global: true,
        curr: '/var/log/fw/logs/*.log',
        rottype: 'sdc-hourly',
        rotdir: '/var/log/fw'
    })

    /*
     * TODO: Other logs to consider:
     * - hagfish-watcher gz agent doesn't rotate
     * - hermes-actor gz agent doesn't rotate
     * - config-agent gz agent doesn't rotate
     * - smartlogin gz agent doesn't rotate
     * - metadata gz agent doesn't rotate
     * - gz amon-agent and amon-relay don't rotate
     * - ur gz agent doesn't rotate
     * - sdc: hermes and hermes-proxy?
     * - dhcpd?
     * - binder?
     * - mahi?
     * - adminui?
     * - ca? and cainstsvc gz agent?
     * - zones' amon-agent and config-agent? and registrar?
     *
     * Excluded logs:
     * - heartbeater doesn't rotate (deprecated agent, so leave this out)
     */
];



// ---- internal support stuff

function humanDurationFromMs(ms) {
    assert.number(ms, 'ms');
    var sizes = [
        ['ms', 1000, 's'],
        ['s', 60, 'm'],
        ['m', 60, 'h'],
        ['h', 24, 'd']
    ];
    if (ms === 0) {
        return '0ms';
    }
    var bits = [];
    var n = ms;
    for (var i = 0; i < sizes.length; i++) {
        var size = sizes[i];
        var remainder = n % size[1];
        if (remainder === 0) {
            bits.unshift('');
        } else {
            bits.unshift(fmt('%d%s', remainder, size[0]));
        }
        n = Math.floor(n / size[1]);
        if (n === 0) {
            break;
        } else if (size[2] === 'd') {
            bits.unshift(fmt('%d%s', n, size[2]));
            break;
        }
    }
    return bits.slice(0, 2).join('');
}

function readConfig() {
    var configPath = process.env.SMARTDC_CONFIG_FILE ||
        path.join(__dirname, '../etc/config.json');
    var obj;
    try {
        obj = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (ex) {
        console.error('sdc-events error: could not read config file "%s": %s',
            configPath, ex);
        process.exit(1);
    }
    return (obj);
}

function getLocalIpSync() {
    var interfaces = os.networkInterfaces();
    var ifs = interfaces['net0'] || interfaces['en1'] || interfaces['en0'];
    var ip;

    /*
     * Not running inside 'sdc' zone
     */
    if (!ifs) {
        return (CONFIG.admin_ip);
    }

    for (var i = 0; i < ifs.length; i++) {
        if (ifs[i].family === 'IPv4') {
            ip = ifs[i].address;
            break;
        }
    }
    return ip;
}

function getAmqpConfigSync() {
    assert.object(CONFIG, 'CONFIG');
    assert.string(CONFIG.rabbitmq, 'CONFIG.rabbitmq');

    var arr = CONFIG.rabbitmq.split(':');
    assert.strictEqual(arr.length, 4, 'malformed rabbitmq: ' +
        CONFIG.rabbitmq);

    return ({
        login: arr[0],
        password: arr[1],
        host: arr[2],
        port: Number(arr[3])
    });
}


/**
 * It is a bit of a PITA to get the set of instances for a single app
 * in SDC, e.g. getting all the 'sdc' instances when the 'manta' app is
 * in the mix.
 */
function sapiGetInsts(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.app, 'opts.app');
    assert.func(cb, 'cb');

    SAPI.listApplications({name: opts.app}, function (appsErr, apps) {
        if (appsErr) {
            return cb(appsErr);
        } else if (apps.length !== 1) {
            return cb(new Error(fmt('unexpected number of "%s" apps: %d',
                opts.app, apps.length)));
        }
        var appUuid = apps[0].uuid;

        SAPI.listServices({application_uuid: appUuid}, function (err, svcs) {
            if (err) {
                return cb(err);
            }
            var svcFromUuid = {};
            var instsFromSvcName = {};
            svcs.forEach(function (svc) {
                svcFromUuid[svc.uuid] = svc;
                instsFromSvcName[svc.name] = [];
            });

            SAPI.listInstances(function (instsErr, allInsts) {
                if (instsErr) {
                    return cb(instsErr);
                }
                var insts = [];
                for (var i = 0; i < allInsts.length; i++) {
                    var inst = allInsts[i];
                    var svc = svcFromUuid[inst.service_uuid];
                    if (svc) {
                        inst.svc = svc;
                        insts.push(inst);
                        instsFromSvcName[svc.name].push(inst);
                    }
                }
                cb(null, insts, instsFromSvcName);
            });
        });
    });
}


function initVmapi() {
    assert.object(LOG, 'LOG');
    assert.object(CONFIG, 'CONFIG');
    assert.string(CONFIG.vmapi_domain, 'CONFIG.vmapi_domain');

    VMAPI = new sdcClients.VMAPI({
        log: LOG.child({component: 'vmapi'}, true),
        url: 'http://' + CONFIG.vmapi_domain,
        agent: false
    });
}

function initCnapi() {
    assert.object(LOG, 'LOG');
    assert.object(CONFIG, 'CONFIG');
    assert.string(CONFIG.cnapi_domain, 'CONFIG.cnapi_domain');

    CNAPI = new sdcClients.CNAPI({
        log: LOG.child({component: 'cnapi'}, true),
        url: 'http://' + CONFIG.cnapi_domain,
        agent: false
    });
}

function initSapi() {
    assert.object(LOG, 'LOG');
    assert.object(CONFIG, 'CONFIG');
    assert.string(CONFIG.sapi_domain, 'CONFIG.sapi_domain');

    SAPI = new sdcClients.SAPI({
        log: LOG.child({component: 'sapi'}, true),
        url: 'http://' + CONFIG.sapi_domain,
        agent: false
    });
}


/**
 * Grep the bunyan log for each given "log instance" (logInst) for a one hour
 * segment, then sort the results chronologically. This creates a new
 * readable stream of hits. The returned hits are the raw bunyan log line
 * (i.e. a string).
 */
function BunyanSortedGrep(opts) {
    assert.object(opts, 'opts');
    assert.string(opts.zonename, 'opts.zonename');
    assert.string(opts.hour, 'opts.hour');
    assert.arrayOfObject(opts.logInsts, 'opts.logInsts');
    assert.arrayOfObject(opts.filters, 'opts.filters');
    assert.optionalObject(opts.startTimeCut, 'opts.startTimeCut');
    LOG.debug({opts: opts}, 'BunyanSortedGrep');

    this.zonename = opts.zonename;
    this.hour = opts.hour;
    this.logInsts = opts.logInsts;
    this.startTimeCut = opts.startTimeCut;

    /*
     * `filters` is an array of filter definitions like this:
     *      [<field>, <op>[, <value>]]
     *
     * Supported <op>s are (shown with examples):
     *      ['TERM', 'raw']
     *          grep for 'TERM'
     *      ['evt', 'exists']
     *          'evt' field exists
     *      ['req_id', 'in', [<UUID1>, <UUID2>]]
     *          'req_id' field is one of the given UUIDs
     *
     * These get translated to grep patterns.
     *
     * TODO: We should also do post-filtering on the pre-`grep`d and
     * `JSON.parse`d Bunyan records to avoid false positives.
     */
    this.grepPatterns = [];
    for (var i = 0; i < opts.filters.length; i++) {
        var field = opts.filters[i][0];
        var op = opts.filters[i][1];
        var value = opts.filters[i][2];
        switch (op) {
        case 'raw':
            this.grepPatterns.push(fmt('%s', field));
            break;
        case 'exists':
            this.grepPatterns.push(fmt('"%s":', field));
            break;
        case 'in':
            // Only support string values for now.
            assert.arrayOfString(value, 'opts.filters['+i+'][2]');
            this.grepPatterns.push(fmt('"%s":"(%s)"', field, value.join('|')));
            break;
        default:
            throw new Error(fmt(
                'unknown BunyanSortedGrep filter op: "%s"', op));
        }
    }

    stream.Readable.call(this, {objectMode: true});
}
util.inherits(BunyanSortedGrep, stream.Readable);


BunyanSortedGrep.prototype._localGrep = function _localGrep(logInst, cb) {
    var fileGlob = logInst.logset.getFileGlob(logInst.zone, this.hour);
    assert.equal(this.grepPatterns.join('\n').indexOf('\''), -1,
        'Limitation: not escaping single-quotes yet');
    var grepCmd = '';
    for (var i = 0; i < this.grepPatterns.length; i++) {
        if (i === 0) {
            grepCmd += fmt('/usr/bin/egrep -h -- \'%s\' %s',
                this.grepPatterns[i], fileGlob);
        } else {
            grepCmd += fmt(' | /usr/bin/egrep -- \'%s\'', this.grepPatterns[i]);
        }
    }
    var argv = ['/usr/bin/bash', '-c', grepCmd];
    LOG.trace({argv: argv}, '_localGrep');

    var grep = spawn(argv[0], argv.slice(1),
        {stdio: ['ignore', 'pipe', 'ignore']});
    grep.stdout.setEncoding('utf8');
    grep.on('error', function (err) {
        console.error('ERROR: _localGrep error:', err);
    });

    var chunks = [];
    grep.stdout.on('data', function (chunk) {
        chunks.push(chunk);
    });
    grep.on('close', function () {
        cb(null, chunks.join(''));
    });

    // Dev Note: perhaps useful when streaming
    //var lstream = new LineStream({encoding: 'utf8'});
    //lstream.on('error', onGrepError);
    //lstream.on('line', onGrepHit);
    //lstream.on('finish', onGrepFinish);
    //grep.stdout.pipe(lstream);
};


BunyanSortedGrep.prototype._urGrep = function _urGrep(logInst, cb) {
    var fileGlob = logInst.logset.getFileGlob(logInst.zone, this.hour);

    assert.equal(this.grepPatterns.join('\n').indexOf('\''), -1,
        'Limitation: not escaping single-quotes yet');
    var grepCmd = '';
    for (var i = 0; i < this.grepPatterns.length; i++) {
        if (i === 0) {
            grepCmd += fmt('/usr/bin/egrep -h -- \'%s\' "${file}"',
                this.grepPatterns[i]);
        } else {
            grepCmd += fmt(' | /usr/bin/egrep -- \'%s\'', this.grepPatterns[i]);
        }
    }
    LOG.trace({fileGlob: fileGlob, grepCmd: grepCmd}, '_urGrep');

    var script = [
        '#!/bin/bash',
        '',
        'for file in ' + fileGlob + '; do',
        '    if [[ -f "${file}" ]]; then',
        '        ' + grepCmd,
        '    fi',
        'done',
        'exit 0'
    ].join('\n');

    URCLIENT.exec({
        script: script,
        server_uuid: logInst.node.uuid,
        timeout: 30 * 1000,
        env: {}
    }, function (err, result) {
        if (err) {
            // TODO: just warn?
            cb(err);
        } else if (result.exit_status !== 0) {
            cb(new Error(fmt('error running grep on server "%s": %s',
                logInst.node.uuid, result.stderr)));
        } else {
            // TODO: How do we tell if the output is clipped?
            cb(null, result.stdout);
        }
    });
};


BunyanSortedGrep.prototype._start = function () {
    var self = this;
    var hits = [];

    var queue = vasync.queuev({
        concurrency: 5,
        worker: grepOneInst
    });
    queue.on('end', doneGreps);
    queue.push(self.logInsts, function doneOneInst(err) {
        if (err) {
            // TODO: gracefully handle this
            throw err;
        }
    });
    queue.close();

    function grepOneInst(logInst, next) {
        var grepFunc = (self.zonename === 'global' && logInst.node.headnode
            ? '_localGrep' : '_urGrep');
        self[grepFunc](logInst, function (err, output) {
            if (err) {
                return next(err);
            } else if (!output) {
                return next();
           }

            var lines = output.split(/\n/);
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (!line.trim()) {
                    continue;
                }
                try {
                    var rec = JSON.parse(line);
                } catch (ex) {
                    console.warn('WARN: grep hit is not a JSON line (skip): %j',
                        line);
                    continue;
                }

                var time = new Date(rec.time);
                if (self.startTimeCut && time < self.startTimeCut) {
                    continue;
                }

                hits.push({
                    line: line,
                    rec: rec,
                    time: time
                });
            }

            next();
        });
    }

    function doneGreps() {
        // Done receiving hits: sort and push them.
        var SORT_START = Date.now();
        LOG.trace('[%s] start sorting %d hits for hour "%s"',
            SORT_START, hits.length, self.hour);
        hits = hits.sort(function cmpTime(a, b) {
            if (a.time < b.time) {
                return -1;
            } else if (a.time > b.time) {
                return 1;
            } else {
                return 0;
            }
        });
        var SORT_END = Date.now();
        LOG.trace('[%s] end sorting %d hits for hour "%s" (duration %s)',
            SORT_END, hits.length, self.hour, SORT_END-SORT_START);

        for (var i = 0; i < hits.length; i++) {
            if (!self.push(hits[i].rec)) {
                console.warn('WARN: ignoring backpressure!');
            }
        }
        self.push(null);
    }
};

BunyanSortedGrep.prototype._read = function (size) {
    if (!this._started) {
        this._started = true;
        this._start();
    }
};


// ---- renderers

function TransObj2JsonStream() {
    stream.Transform.call(this, {
        /* BEGIN JSSTYLED */
        /*
         * TODO: I don't understand the impact of this. Setting to
         * highWaterMark=0 plus 1000s of hits results in:
         *      Trace: (node) warning: Recursive process.nextTick detected. This will break in the next version of node. Please use setImmediate for recursive deferral.
         *           at maxTickWarn (node.js:381:17)
         *           at process._nextTick [as _currentTickHandler] (node.js:484:9)
         *           at process.nextTick (node.js:335:15)
         *           at onwrite (_stream_writable.js:266:15)
         *           at WritableState.onwrite (_stream_writable.js:97:5)
         *           at WriteStream.Socket._write (net.js:653:5)
         *           at doWrite (_stream_writable.js:226:10)
         *           at writeOrBuffer (_stream_writable.js:216:5)
         *           at WriteStream.Writable.write (_stream_writable.js:183:11)
         *           at WriteStream.Socket.write (net.js:615:40)
         *           at Console.warn (console.js:61:16)
         *           at Console.trace (console.js:95:8)
         * and a crash on recursion limit. See related discussion at
         * <https://github.com/joyent/node/issues/6718>.
         */
        //highWaterMark: 0,
        /* END JSSTYLED */
        objectMode: true
    });
}
util.inherits(TransObj2JsonStream, stream.Transform);

TransObj2JsonStream.prototype._transform = function (chunk, enc, cb) {
    this.push(JSON.stringify(chunk) + '\n');
    cb();
};

function TransBunyan2TraceEvent() {
    stream.Transform.call(this, {
        objectMode: true,
        // TODO: I don't understand the impact of this
        //highWaterMark: 0,
        encoding: 'utf8'
    });
}
util.inherits(TransBunyan2TraceEvent, stream.Transform);

TransBunyan2TraceEvent.prototype._transform = function (rec, enc, cb) {
    var ev = rec.evt;
    ev.pid = ev.tid = rec.pid;
    ev.id = rec.req_id || fmt('(no req_id %s)', genUuid());

    /*
     * Rebase all 'ts' to 0 because trace-viewer starts at zero, and scrolling
     * fwd from Jan 1, 1970 is pretty frustrating. :)
     *
     * TODO: option to reset per-id might make for nice above/below comparisons
     * in trace-viewer.
     */
    ev.ts = new Date(rec.time).valueOf() * 1000;
    if (!this._tsBase) {
        this._tsBase = ev.ts;
    }
    ev.ts -= this._tsBase;

    // TODO make prefixing to the <event>.name optional?
    // TODO add rec.component to the prefixing?
    ev.name = rec.name + '.' + ev.name;

    if (ev.cat) {
        ev.cat = rec.name + ',' + ev.cat;
    } else {
        ev.cat = rec.name;
    }

    // TODO consider adding req_id (or id) to the args, trace-viewer hides 'id'
    if (!ev.args) {
        ev.args = {};
    }

    if (!this._first) {
        this.push('[');
        this._first = true;
    } else {
        this.push(',\n');
    }
    this.push(JSON.stringify(ev));
    cb();
};

TransBunyan2TraceEvent.prototype._flush = function (cb) {
    if (this._first) {
        this.push(']\n');
    }
    cb();
};



// ---- custom dashdash option type for `-t TIME`

/**
 * A 'timeAgo' option type that allows either a duration (an amount of time
 * ago):
 *      1h      one hour ago
 *      2d      two days ago
 *      90m     ninety minutes ago
 *      120s    120 seconds ago
 * or a date (another parsable by `new Date()`).
 */
var durationRe = /^([1-9]\d*)([smhd])$/;
function parseTimeAgo(option, optstr, arg) {
    var t;
    var match = durationRe.exec(arg);
    if (match) {
        var num = match[1];
        var scope = match[2];
        var delta = 0;
        switch (scope) {
            case 's':
                delta += num * 1000;
                break;
            case 'm':
                delta += num * 60 * 1000;
                break;
            case 'h':
                delta += num * 60 * 60 * 1000;
                break;
            case 'd':
                delta += num * 24 * 60 * 60 * 1000;
                break;
            default:
                throw new Error(fmt('unknown duration scope: "%s"', scope));
        }
        t = new Date(Date.now() - delta);
    } else {
        try {
            t = dashdash.parseDate(arg);
        } catch (ex) {
            throw new Error(fmt('arg for "%s" is not a valid duration ' +
                '(e.g. 1h) or date: "%s"', optstr, arg));
        }
    }
    return t;
}

// Here we add the new 'duration' option type to dashdash's set.
dashdash.addOptionType({
    name: 'timeAgo',
    takesArg: true,
    helpArg: 'TIME',
    parseArg: parseTimeAgo
});



// ---- mainline

var OPTION_SPECS = [
    {
        names: [ 'help', 'h' ],
        type: 'bool',
        help: 'print this help message'
    },
    {
        names: [ 'version' ],
        type: 'bool',
        help: 'print the version'
    },
    {
        names: [ 'verbose', 'v' ],
        type: 'bool',
        help: 'verbose output'
    },
    {
        names: [ 'quiet', 'q' ],
        type: 'bool',
        help: 'quiet output'
    },
    {
        names: ['x'],
        type: 'arrayOfString',
        help: 'Internal testing option. Do not use this.'
    },
    {
        group: ''
    },
    {
        names: ['time', 't'],
        type: 'timeAgo',
        help: 'Start time. Specify a date or a time duration "ago", e.g. 2h ' +
            'for two hours ago (s=second, m=minute, h=hour, d=day). Default ' +
            'is one hour ago.'
    },
    {
        names: ['logset', 's'],
        type: 'arrayOfString',
        helpArg: 'NAME',
        help: 'Logsets to search. By default all logsets are searched. ' +
            'Known logsets: ' +
            LOGSETS.map(function (ls) { return ls.name; }).sort().join(', ')
    },
    {
        names: ['event-trace', 'E'],
        type: 'bool',
        help: 'Output an event trace file, as required by trace-viewer ' +
            '<https://github.com/google/trace-viewer>. Note that this offsets' +
            'all times (the "ts" field) to zero for the first event to ' +
            'simplify finding the start in the viewer.'
    }
];


function parseOpts(options, args) {
    var parser = dashdash.createParser({
        options: options,
        allowUnknown: false
    });

    function usage(msg) {
        var us = [
            'Usage:\n  sdc-events [<options>] [<req-id> ...]'
        ].join('\n') + '\n\nOptions:\n' + parser.help({
            indent: 2,
            headingIndent: 0
        });

        if (msg) {
            console.error('sdc-events error: ' + msg);
            console.error(us);
            process.exit(1);
        } else {
            console.log(us);
            process.exit(0);
        }
    }

    var opts;
    try {
        opts = parser.parse(args);
    } catch (ex) {
        usage(ex.message);
    }

    if (opts.help)
        usage();

    return (opts);
}


function main() {
    OPTIONS = parseOpts(OPTION_SPECS, process.argv);
    if (OPTIONS.verbose) {
        LOG.level('trace');
    }
    LOG.trace('OPTIONS', OPTIONS);

    PROGRESS = function () {};
    if (OPTIONS.verbose) {
        PROGRESS = console.error;
    }

    CONFIG = readConfig();
    initVmapi();
    initSapi();
    initCnapi();

    var filters = [
        ['evt', 'exists']
    ];
    if (OPTIONS._args.length > 0) {
        filters.push(['req_id', 'in', OPTIONS._args]);
    }
    if (OPTIONS.x) {
        // Hack internal option to override regular filtering. This can be
        // dangerous because it can result in large numbers of hits across
        // the DC.
        filters = [[OPTIONS.x, 'raw']];
    }
    assert.ok(filters.length > 0, 'no search filters');

    var oneHour = 60 * 60 * 1000;
    var now = Date.now();
    var start = OPTIONS.time || new Date(now - oneHour);
    // Ensure we don't try to search a huge time range.
    var MAX_RANGE = 7 * 24 * oneHour; // one week
    var range = now - start;
    if (range > MAX_RANGE) {
        throw new Error(fmt('time range, %s, is too large (>%s)',
            humanDurationFromMs(range), humanDurationFromMs(MAX_RANGE)));
    }

    vasync.pipeline({arg: {}, funcs: [
        function getZonename(ctx, next) {
            child_process.execFile('/usr/bin/zonename', [], {},
                    function (err, stdout, stderr) {
                if (err) {
                    return next(err);
                }
                ctx.zonename = stdout.trim();
                next();
            });
        },

        function getNodes(ctx, next) {
            CNAPI.listServers({extras: 'sysinfo'}, function (err, servers) {
                ctx.nodes = servers.filter(function (server) {
                    var isVirtualServer = server.sysinfo &&
                        server.sysinfo['System Type'] === 'Virtual';
                    return server.status === 'running' && server.setup &&
                        !isVirtualServer;
                });
                ctx.nodeFromUuid = [];
                ctx.nodeFromHostname = [];
                for (var i = 0; i < ctx.nodes.length; i++) {
                    var node = ctx.nodes[i];
                    ctx.nodeFromUuid[node.uuid] = node;
                    ctx.nodeFromHostname[node.hostname] = node;
                }
                next();
            });
        },

        function getLogsets(ctx, next) {
            if (!OPTIONS.logset || OPTIONS.logset.length === 0) {
                ctx.logsets = LOGSETS;
            } else {
                ctx.logsets = [];
                var logsetFromName = {};
                for (var i = 0; i < LOGSETS.length; i++) {
                    logsetFromName[LOGSETS[i].name] = LOGSETS[i];
                }
                for (i = 0; i < OPTIONS.logset.length; i++) {
                    var name = OPTIONS.logset[i];
                    if (!logsetFromName[name]) {
                        return next(new Error(
                            fmt('unknown logset: "%s"', name)));
                    }
                    ctx.logsets.push(logsetFromName[name]);
                }
            }
            next();
        },

        function getSdcInsts(ctx, next) {
            sapiGetInsts({app: 'sdc'}, function (err, insts, instsFromSvc) {
                if (err) {
                    return next(err);
                }
                ctx.sdcInstsFromSvc = instsFromSvc;
                ctx.sdcInstFromUuid = {};
                for (var i = 0; i < insts.length; i++) {
                    ctx.sdcInstFromUuid[insts[i].uuid] = insts[i];
                }
                next();
            });
        },

        function getVmInfo(ctx, next) {
            /**
             * Instead of getting each VM (there could be up to dozens),
             * lets get all of admin's VMs in one req and filter those.
             *
             * 'cloudapi' zones typically don't have
             * `tags.smartdc_core=true` so we can't filter on that. And
             * VMAPI doesn't support filtering on presence of a tag
             * (e.g. `smartdc_role`).
             */
            ctx.vmFromUuid = {};
            var listVmsOpts = {
                state: 'active',
                owner_uuid: CONFIG.ufds_admin_uuid
            };
            VMAPI.listVms(listVmsOpts, function (err, vms) {
                if (err) {
                    return next(err);
                }
                for (var i = 0; i < vms.length; i++) {
                    var vm = vms[i];
                    if (ctx.sdcInstFromUuid[vm.uuid]) {
                        ctx.vmFromUuid[vm.uuid] = vm;
                    }
                }
                next();
            });
        },

        function getLogInsts(ctx, next) {
            var i, j;
            ctx.logInsts = [];
            ctx.haveNonHeadnodeInsts = false;
            for (i = 0; i < ctx.logsets.length; i++) {
                var logset = ctx.logsets[i];
                if (logset.global) {
                    for (j = 0; j < ctx.nodes.length; j++) {
                        if (!ctx.nodes[j].headnode) {
                            ctx.haveNonHeadnodeInsts = true;
                        }
                        ctx.logInsts.push({
                            logset: logset,
                            node: ctx.nodes[j],
                            zone: 'global'
                        });
                    }
                } else {
                    var sdcInsts = ctx.sdcInstsFromSvc[
                        logset.sapiSvcName] || [];
                    for (j = 0; j < sdcInsts.length; j++) {
                        var nodeUuid =
                            ctx.vmFromUuid[sdcInsts[j].uuid].server_uuid;
                        var node = ctx.nodeFromUuid[nodeUuid];
                        if (node) {
                            if (!node.headnode) {
                                ctx.haveNonHeadnodeInsts = true;
                            }
                            ctx.logInsts.push({
                                logset: logset,
                                node: node,
                                zone: sdcInsts[j].uuid
                            });
                        }
                    }
                }
            }
            next();
        },

        function initUrClientIfNeeded(ctx, next) {
            if (ctx.zonename === 'global' && !ctx.haveNonHeadnodeInsts) {
                return next();
            }

            URCLIENT = urclient.create_ur_client({
                log: LOG,
                connect_timeout: 5000,
                enable_http: false,
                bind_ip: getLocalIpSync(),
                amqp_config: getAmqpConfigSync()
            });
            URCLIENT.on('ready', next);
        },

        function chooseRenderer(ctx, next) {
            if (OPTIONS.event_trace) {
                ctx.renderer = new TransBunyan2TraceEvent();
            } else {
                ctx.renderer = new TransObj2JsonStream();
            }
            next();
        },

        function searchByHour(ctx, next) {
            // Limitation: Assuming `logset.rottype == 'sdc-hourly'`.
            var hours = [];
            var topOfHour = now - (now % oneHour);
            // Offset *forward* one hour because logs starting at, e.g.,
            // 2015-02-13T20:15:03 are in this log file:
            // "${logset.name}_*_2015-02-13T21:*.log"
            var s = start.valueOf();
            while (s <= topOfHour) {
                hours.push(new Date(s + oneHour).toISOString().slice(0, 14));
                s += oneHour;
            }
            hours.push('curr');
            LOG.info({now: new Date(now), start: start, hours: hours},
                'hours');

            PROGRESS('Searching %d logsets across %d nodes (%d insts), ' +
                'in %d one hour segments', ctx.logsets.length, ctx.nodes.length,
                ctx.logInsts.length, hours.length);
            ctx.renderer.pipe(process.stdout);

            vasync.forEachPipeline({
                inputs: hours,
                func: function searchOneHour(hour, nextHour) {
                    PROGRESS('Searching hour "%s"', hour);
                    var hits = new BunyanSortedGrep({
                        zonename: ctx.zonename,
                        hour: hour,
                        logInsts: ctx.logInsts,
                        filters: filters,
                        startTimeCut: (hour === hours[0] ? start : undefined)
                    });
                    hits.pipe(ctx.renderer, {end: false});
                    hits.on('end', function () {
                        nextHour();
                    });
                }
            }, next);
        },

        function closeThings(ctx, next) {
            if (URCLIENT) {
                URCLIENT.close();
            }
            ctx.renderer.end();
            next();
        }

    ]}, function done(err) {
        if (err) {
            console.error('sdc-events error: %s',
                (OPTIONS.verbose ? err.stack : err.message));
            process.exit(1);
        }
    });
}


process.stdout.on('error', function (err) {
    if (err.code === 'EPIPE') {
        process.exit(0);
    }
});


main();
