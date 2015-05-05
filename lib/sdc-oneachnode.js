#!/usr/node/bin/node
/* vim: syn=javascript ts=4 sts=4 sw=4 et: */

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var mod_path = require('path');
var mod_fs = require('fs');

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_dashdash = require('dashdash');
var mod_extsprintf = require('extsprintf');
var mod_jsprim = require('jsprim');
var mod_os = require('os');
var mod_urclient = require('urclient');
var mod_vasync = require('vasync');
var mod_verror = require('verror');

var VError = mod_verror.VError;

/*
 * Unfortunately, bunyan does not presently have an output stream that can emit
 * pre-formatted messages to stderr -- see: node-bunyan#13 and node-bunyan#102.
 * For now, we shall keep bunyan logging for debugging purposes and emit our
 * own human-readable messages in verbose mode.
 */
var LOG = mod_bunyan.createLogger({
    level: process.env.LOG_LEVEL || mod_bunyan.WARN,
    name: 'sdc-oneachnode'
});

var OPTIONS;
var CONFIG;

var INTERRUPT = 0;

var URCLIENT;
var RUN_QUEUE;
var ERRORS = [];
var RESULTS = [];
var HEADER_PRINTED = false;
var NEED_NEWLINE = false;
var EXEC_FAILURE = false;

/*
 * Record the start hrtime of the process, so that we can (in verbose mode)
 * note the passing of mechanical time.
 */
var EPOCH = process.hrtime();

/*
 * We synchronise the entire program on this barrier.  Once the barrier
 * drains, we will call exit(), which will check to see if we need to
 * emit a final error and exit non-zero.
 */
var BARRIER = mod_vasync.barrier();
BARRIER.start('main');
BARRIER.on('drain', exit);

/*
 * So that programs can interpret the failure mode of sdc-oneachnode,
 * we document some exit statuses for specific fault conditions.  Do
 * not break these.
 */
var EXIT_STATUS = {
    success: 0,
    generic: 1,
    option_parse: 2,
    missing_nodes: 10,
    exec_failure: 20
};

/*
 * We require exactly one of the following options to be specified for
 * every invocation, as they define the blast radius for this sdc-oneachnode
 * invocation:
 */
var TARGET_OPTION_NAMES = [
    'allnodes',
    'computeonly',
    'node'
];

var OPTION_SPECS = [
    {
        group: 'target selection options (must provide exactly one)'
    },
    {
        names: [ 'allnodes', 'a' ],
        type: 'bool',
        help: 'execute on all nodes, including the headnode'
    },
    {
        names: [ 'computeonly', 'c' ],
        type: 'bool',
        help: 'only execute on compute nodes'
    },
    {
        names: [ 'node', 'n' ],
        type: 'string',
        helpArg: 'NODE[,NODE,...]',
        help: [ 'node (or comma-separated list of nodes) on which to',
          'execute (hostname or UUID)' ].join(' ')
    },
    {
        group: 'file transfer options'
    },
    {
        names: [ 'dir', 'd' ],
        type: 'string',
        helpArg: 'DIR',
        help: 'directory in which to write files'
    },
    {
        names: [ 'get', 'g' ],
        type: 'string',
        helpArg: 'FILE',
        help: 'have remote nodes receive the specified file from this node'
    },
    {
        names: [ 'put', 'p' ],
        type: 'string',
        helpArg: 'FILE',
        help: 'have remote nodes send the specified file to this node'
    },
    {
        names: [ 'clobber', 'X' ],
        type: 'bool',
        help: 'overwrite destination file if it exists'
    },
    {
        group: 'formatting options'
    },
    {
        names: [ 'immediate', 'I' ],
        type: 'bool',
        help: [ 'print command results immediately as they arrive, rather',
            'than sorting them for output at the end' ].join(' ')
    },
    {
        names: [ 'oneline', 'N' ],
        type: 'bool',
        help: [ 'force terse, one line per host output mode; multi-line',
            'output will be reduced to the last non-blank line, as if',
            'piped through "tail -1"' ].join(' ')
    },
    {
        names: [ 'json', 'j' ],
        type: 'bool',
        help: 'output results as a JSON array at the end of processing'
    },
    {
        names: [ 'jsonstream', 'J' ],
        type: 'bool',
        help: 'new-line separated JSON streaming output; same as "-jI"'
    },
    {
        group: 'other options'
    },
    {
        names: [ 'help', 'h' ],
        type: 'bool',
        help: 'print this help message'
    },
    {
        names: [ 'listonly', 'l' ],
        type: 'bool',
        help: 'do not run a command, just do discovery and list nodes'
    },
    {
        names: [ 'timeout', 't' ],
        type: 'positiveInteger',
        helpArg: 'SECONDS',
        help: 'timeout (in seconds) for node discovery',
        default: 4
    },
    {
        names: [ 'exectimeout', 'T' ],
        type: 'positiveInteger',
        helpArg: 'SECONDS',
        help: 'timeout (in seconds) for command execution on discovered nodes',
        default: 60
    },
    {
        names: [ 'quiet', 'q' ],
        type: 'bool',
        help: 'print no output, not even errors'
    },
    {
        names: [ 'verbose', 'v' ],
        type: 'bool',
        help: 'print diagnostic output to stderr'
    }
];

/*
 * Output functions:
 */

function
printf()
{
    var out = mod_extsprintf.sprintf.apply(mod_extsprintf, arguments);
    process.stdout.write(out);
}

function
output(rr)
{
    if (rr.error) {
        printf('=== Failure from %s:\n', nodename(rr));
        printf('<ERROR: %s>\n\n', rr.error.message);
        return;
    }

    var out = rr.result.exit_status === 0 ? rr.result.stdout :
        rr.result.stdout + rr.result.stderr;

    printf('=== Output from %s:\n', nodename(rr));
    printf('%s\n', out);
    if (out[out.length - 1] !== '\n')
        printf('\n');
}

function
nodename(server)
{
    return (server.uuid + ' (' + server.hostname + ')');
}

function
emit_list_only(server)
{
    var fmt = '%-36s  %s\n';
    if (!HEADER_PRINTED)
            printf(fmt, 'UUID', 'HOSTNAME');
    HEADER_PRINTED = true;
    printf(fmt, server.uuid, server.hostname);
}

function
non_empty_lines(rr)
{
    if (rr.error)
        return ([ rr.error.message ]);

    if (!rr.result)
        return ([]);

    var str = rr.result.exit_status === 0 ? rr.result.stdout :
        rr.result.stdout + rr.result.stderr;
    var lines = str.split(/\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (l)
            out.push(l);
    }
    return (out);
}

function
emit_terse(rr)
{
    /*
     * Just clip out the last non-empty line...
     */
    var lines = non_empty_lines(rr);

    var fmt = '%-20s  %s\n';
    if (!HEADER_PRINTED)
        printf(fmt, 'HOSTNAME', 'STATUS');
    HEADER_PRINTED = true;
    if (rr.error) {
        printf(fmt, rr.hostname, '<ERROR: ' + rr.error.message + '>');
    } else {
        printf(fmt, rr.hostname, lines.length < 1 ? '' :
            lines[lines.length - 1]);
    }
}

function
final_output()
{
    if (OPTIONS.immediate || OPTIONS.quiet)
        return;

    var can_terse = true;
    for (var i = 0; i < RESULTS.length; i++) {
        if (non_empty_lines(RESULTS[i]).length > 1) {
            can_terse = false;
            break;
        }
    }

    /*
     * Ensure our stdout will be visually separate from the last verbose
     * log line:
     */
    final_newline();

    RESULTS.sort(by_hostname);
    if (OPTIONS.json) {
        process.stdout.write(JSON.stringify(RESULTS) + '\n');
        return;
    }
    for (i = 0; i < RESULTS.length; i++) {
        var rr = RESULTS[i];

        if (OPTIONS.listonly) {
            emit_list_only(rr);
        } else if (OPTIONS.get || OPTIONS.put || can_terse ||
          OPTIONS.oneline) {
            emit_terse(rr);
        } else {
            output(rr);
        }
    }
}

function
timestamp()
{
    var delta = process.hrtime(EPOCH);
    return (Math.floor(delta[0] * 1000 + delta[1] / 1000000));
}

function
final_newline()
{
    if (NEED_NEWLINE)
        process.stderr.write('\n');
    NEED_NEWLINE = false;
}

function
errprintf()
{
    if (OPTIONS.quiet)
        return;

    var args = Array.prototype.slice.call(arguments);
    var fmt = '[%6d] ' + args.shift() + '\n';
    args.unshift(timestamp());
    args.unshift(fmt);
    var out = mod_extsprintf.sprintf.apply(mod_extsprintf, args);
    process.stderr.write(out);
    /*
     * We will need a newline when we go to print final tabulated
     * output or error messages, in order to visually separate those
     * from the torrent of verbose log messeages.
     */
    NEED_NEWLINE = true;
}

function
verbose()
{
    if (!OPTIONS.verbose)
        return;
    errprintf.apply(null, arguments);
}

/*
 * Sorting functions:
 */

function
by_hostname(a, b)
{
    if (a.hostname < b.hostname)
        return (-1);
    else if (a.hostname > b.hostname)
        return (1);
    else
        return (0);
}

/*
 * Configuration:
 */

function
read_config()
{
    var path = process.env.SMARTDC_CONFIG_FILE || mod_path.join(__dirname,
        '..', 'etc', 'config.json');

    var obj;
    try {
        obj = JSON.parse(mod_fs.readFileSync(path, 'utf8'));
    } catch (ex) {
        ERRORS.push(new VError(ex, 'could not read configuration file "%s"',
            path));
        exit();
    }

    return (obj);
}

function
get_local_ip()
{
    var interfaces = mod_os.networkInterfaces();
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

function
get_amqp_config()
{
    mod_assert.object(CONFIG, 'CONFIG');
    mod_assert.string(CONFIG.rabbitmq, 'CONFIG.rabbitmq');

    var arr = CONFIG.rabbitmq.split(':');
    mod_assert.strictEqual(arr.length, 4, 'malformed rabbitmq: ' +
        CONFIG.rabbitmq);

    return ({
        login: arr[0],
        password: arr[1],
        host: arr[2],
        port: Number(arr[3])
    });
}

/*
 * Command-line option parsing:
 */

function
parse_options(options, args)
{
    var i;

    var parser = mod_dashdash.createParser({
        options: options,
        interspersed: false,
        allowUnknown: false
    });

    var usage = function (msg) {
        var us = [
            'Usage: sdc-oneachnode [-a|-c|-n NODE[,NODE,...]] [-t|-T SECONDS]',
            '                      [-g|-p FILE] [-d DIR] [-hjJlvINX]'
        ].join('\n') + '\n\n' + parser.help({
            indent: 2,
            headingIndent: 0
        });

        if (msg) {
            if (!opts.quiet) {
                console.error('ERROR: ' + msg);
                console.error(us);
            }
            process.exit(EXIT_STATUS.option_parse);
        } else {
            console.log(us);
            process.exit(EXIT_STATUS.success);
        }
    };

    var opts;
    try {
        opts = parser.parse(args);
    } catch (ex) {
        usage(ex.message);
    }

    if (opts.help)
        usage();

    if (opts.quiet && opts.verbose)
        usage('cannot be both quiet and verbose');

    /*
     * The user must be precise when specifying the execution targets.  Note
     * that the "allnodes" option is the now-explicit version of the prior
     * default behaviour, where we target all nodes that responded to our
     * initial broadcast.
     */
    var target_count = 0;
    for (i = 0; i < TARGET_OPTION_NAMES.length; i++) {
        if (opts[TARGET_OPTION_NAMES[i]])
            target_count++;
    }
    if (target_count !== 1)
        usage('exactly one of -a, -c or -n must be specified');

    /*
     * Check for potentially errant option-like strings in the non-option area:
     */
    for (i = 0; i < opts._args.length; i++) {
        /*
         * We would like to specifically call the user out on interspersing the
         * non-option argument (i.e. the command) amongst option arguments.
         * Setting "interspersed" to false causes dashdash to stop argument
         * parsing at the first non-option argument, but we can still look
         * through _args to see if the user has done something unclear.
         */
        if (opts._args[i].substring(0, 1) === '-')
            usage('all options must appear before the command string');
    }

    /*
     * Parse the node list.  Do not allow duplicate entries in the host list;
     * users _must_ be precise with sdc-oneachnode.
     */
    if (opts.node) {
        var ti = opts.node.split(',');
        var to = [];
        for (i = 0; i < ti.length; i++) {
            var node = (ti[i] || '').trim();
            if (!node)
                continue;
            if (to.indexOf(node) !== -1)
                usage('duplicate host in --node (-n) list');
            to.push(node);
        }
        if (to.length === 0)
            usage('no valid hosts provided for --node (-n)');
        opts.node_list = to;
    }

    if (opts.jsonstream) {
        /*
         * --jsonstream (-J) is the combination of --immediate (-I)
         *  and --json (-j).
         */
        opts.json = true;
        opts.immediate = true;
    }

    if (opts.get || opts.put || opts.dir) {
        /*
         * File transfer mode:
         */
        if (opts.get && opts.put)
            usage('cannot get and put a file at the same time');
        else if (!opts.get && !opts.put)
            usage('must specify -g (get) or -p (put) with -d (dir)');
        else if (!opts.dir)
            usage('must specify -d (dir) with -g (get) or -p (put)');

        if (opts.listonly)
            usage('discovery-only mode cannot use -g/-p/-d');
        if (opts._args.length !== 0)
            usage('cannot specify both a file and a command');
    } else if (opts._args.length > 0) {
        /*
         * Command mode:
         */
        if (opts.listonly)
            usage('cannot send a command in discovery-only mode');
        if (opts._args.length !== 1)
            usage('must specify entire command as a single, quoted argument');
        opts.command = opts._args[0];
    } else if (!opts.listonly) {
        usage('must specify either a file upload, file download or command');
    }

    return (opts);
}

function
init_run_queue(urclient, finish_callback)
{
    var opts = {
        urclient: urclient,
        timeout: Math.floor(OPTIONS.exectimeout * 1000)
    };

    if (OPTIONS.get) {
        opts.type = 'send_file';
        opts.src_file = OPTIONS.get;
        opts.dst_dir = OPTIONS.dir;
        opts.clobber = OPTIONS.clobber || false;
    } else if (OPTIONS.put) {
        opts.type = 'recv_file';
        opts.src_file = OPTIONS.put;
        opts.dst_dir = OPTIONS.dir;
    } else {
        opts.type = 'exec';
        opts.script = '#!/bin/bash\n\n' + OPTIONS.command + '\n';
        opts.env = {
            PATH: process.env.PATH,
            HOME: '/root',
            LOGNAME: 'root',
            USER: 'root'
        };
    }

    var process_result = function (rr) {
        if (OPTIONS.immediate) {
            /*
             * Invoking with -I means we emit results as soon as they arrive.
             */
            if (OPTIONS.json) {
                process.stdout.write(JSON.stringify(rr) + '\n');
            } else {
                if (OPTIONS.oneline) {
                    emit_terse(rr);
                } else {
                    output(rr);
                }
            }
        } else {
            /*
             * Otherwise, we store them for later sorting and output.
             */
            RESULTS.push(rr);
        }
    };

    var rq = mod_urclient.create_run_queue(opts);

    rq.on('dispatch', function (server) {
        verbose('running on ' + nodename(server));
    });

    rq.on('success', function (server, result) {
        verbose('run ok on ' + nodename(server));

        var rr = mod_jsprim.deepCopy(server);
        if (OPTIONS.get || OPTIONS.put) {
            rr.result = {
                stdout: 'ok',
                stderr: '',
                exit_status: 0
            };
        } else {
            rr.result = result;
        }

        process_result(rr);
    });

    rq.on('failure', function (server, error) {
        verbose('error on ' + nodename(server));
        verbose('  :: error: ' + error.message);
        if (error.stderr) {
            verbose('  :: stderr:\n' + error.stderr);
        }

        var rr = mod_jsprim.deepCopy(server);
        rr.error = {
            message: error.message,
            name: error.name,
            code: error.code || null
        };

        process_result(rr);
    });

    rq.on('end', function () {
        verbose('command run complete');
        final_output();
        finish_callback();
    });

    return (rq);
}

function
exit()
{
    if (ERRORS.length > 0) {
        /*
         * If we received an active failure response, or no response at all,
         * for some subset of our requests, then return the correct exit
         * status:
         */
        var exit_status = EXEC_FAILURE ? EXIT_STATUS.exec_failure :
            EXIT_STATUS.generic;

        final_newline();

        for (var i = 0; i < ERRORS.length; i++) {
            var j;
            var err = ERRORS[i];

            if (err.nodes_missing && err.nodes_missing.length > 0) {
                /*
                 * If we did not succeed at discovery due to unresponsive or
                 * missing nodes, we must set our exit status accordingly:
                 */
                exit_status = EXIT_STATUS.missing_nodes;
            }

            if (OPTIONS.quiet)
                continue;

            process.stderr.write('ERROR: ' + err.message + '\n');

            if (err.nodes_missing && err.nodes_missing.length > 0) {
                err.nodes_missing.sort();
                process.stderr.write('\n  missing nodes:\n');
                for (j = 0; j < err.nodes_missing.length; j++) {
                    process.stderr.write('    ' + err.nodes_missing[j] + '\n');
                }
                process.stderr.write('\n');
            }

            if (err.duplicate) {
                err.duplicate.sort();
                process.stderr.write('\n  these names refer to the ' +
                    'same node:\n');
                for (j = 0; j < err.duplicate.length; j++) {
                    process.stderr.write('    ' + err.duplicate[j] + '\n');
                }
                process.stderr.write('\n');
            }
        }
        process.exit(exit_status);
    } else if (INTERRUPT > 0) {
        final_newline();
        if (!OPTIONS.quiet)
            process.stderr.write('Interrupted.\n');
        process.exit(EXIT_STATUS.generic);
    } else {
        process.exit(EXIT_STATUS.success);
    }
}

/*
 * Node discovery:
 */

function
run_discovery(done)
{
    var disco = URCLIENT.discover({
        timeout: OPTIONS.timeout * 1000,
        exclude_headnode: !!OPTIONS.computeonly,
        node_list: OPTIONS.node_list || undefined
    });

    var fail = function (err) {
        ERRORS.push(err);

        verbose('discovery failed');
        verbose('ERROR: %s', err.message);

        if (RUN_QUEUE) {
            /*
             * We don't want to discard the responses from commands already
             * dispatched.  Cancel the run queue, and we will exit with the
             * error when it has finished collecting already-dispatched
             * requests.
             */
            RUN_QUEUE.cancel();
        }

        done();
    };

    disco.on('error', fail);
    disco.on('server', function (server) {
        verbose('found ' + server.uuid + ' (' + server.hostname + ')');

        var rr = {
            uuid: server.uuid,
            hostname: server.hostname
        };

        if (OPTIONS.listonly) {
            if (OPTIONS.immediate) {
                if (OPTIONS.json) {
                    process.stdout.write(JSON.stringify(rr) + '\n');
                } else {
                    emit_list_only(rr);
                }
            } else {
                RESULTS.push(rr);
            }
        } else {
            RUN_QUEUE.add_server(rr);
        }
    });
    disco.on('duplicate', function (uuid, hostname) {
        var err = new VError('duplicate host specification detected');
        err.duplicate = [
            uuid,
            hostname
        ];

        /*
         * We are done with this discovery session.  Cancel it and
         * ignore future error/end events.
         */
        disco.removeAllListeners();
        disco.cancel();

        fail(err);
    });
    disco.on('end', function () {
        verbose('discovery complete');

        mod_assert.ok(OPTIONS.listonly || OPTIONS.command || OPTIONS.get ||
            OPTIONS.put);
        if (OPTIONS.listonly) {
            /*
             * We have been instructed to simply print the list of servers.
             */
            final_output();
        } else {
            /*
             * We are running a command (or sending/receiving files), so close
             * the run queue and instruct it to dispatch our queued requests if
             * we have not done so already:
             */
            RUN_QUEUE.close();
            RUN_QUEUE.start();
        }
        done();
    });
}

/*
 * Entry point:
 */

function
main()
{
    OPTIONS = parse_options(OPTION_SPECS, process.argv);

    if (OPTIONS.put) {
        try {
            var st = mod_fs.lstatSync(OPTIONS.dir);
            if (!st.isDirectory()) {
                if (!OPTIONS.quiet)
                    process.stderr.write('ERROR: not a directory: "' +
                        OPTIONS.dir + '"\n');
                process.exit(EXIT_STATUS.generic);
            }
        } catch (ex) {
            if (!OPTIONS.quiet)
                process.stderr.write('ERROR: ' + ex.message + '\n');
            process.exit(EXIT_STATUS.generic);
        }
    }

    CONFIG = read_config();

    BARRIER.start('discovery');
    URCLIENT = mod_urclient.create_ur_client({
        log: LOG,
        connect_timeout: 5000,
        enable_http: !!(OPTIONS.get || OPTIONS.put),
        bind_ip: get_local_ip(),
        amqp_config: get_amqp_config()
    });
    URCLIENT.on('ready', function () {
        verbose('discovering servers');
        run_discovery(function () {
            BARRIER.done('discovery');
        });
    });

    if (!OPTIONS.listonly) {
        BARRIER.start('run_queue');
        RUN_QUEUE = init_run_queue(URCLIENT, function () {
            BARRIER.done('run_queue');
            if (INTERRUPT > 0)
                exit();
        });
        if (!OPTIONS.node_list) {
            /*
             * We do not have a priori knowledge of the host list, so we may as
             * well begin executing commands on nodes as soon as they are
             * discovered.
             */
            RUN_QUEUE.start();
        }
    }

    /*
     * The first time the user presses ^C, we will abort the run queue.  This
     * will cause an immediate 'end' to be emitted, after which we will print
     * any sorted output we have already collected.  If the user presses
     * ^C more than once, we will just exit immediately.
     */
    process.on('SIGINT', function () {
        if (INTERRUPT++ > 0 || !RUN_QUEUE) {
            exit();
            return;
        }
        RUN_QUEUE.abort();
    });

    BARRIER.done('main');
}

main();
