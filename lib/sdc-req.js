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

/*
 * grep a request UUID on all the SDC application logs.
 */

var mod_path = require('path');
var mod_fs = require('fs');

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_dashdash = require('dashdash');
var mod_os = require('os');
var mod_urclient = require('urclient');
var mod_vasync = require('vasync');
var mod_verror = require('verror');
var mod_sdc = require('sdc-clients');

var VError = mod_verror.VError;

/*
 * Unfortunately, bunyan does not presently have an output stream that can emit
 * pre-formatted messages to stderr -- see: node-bunyan#13 and node-bunyan#102.
 * For now, we shall keep bunyan logging for debugging purposes and emit our
 * own human-readable messages in verbose mode.
 */
var LOG = mod_bunyan.createLogger({
    level: process.env.LOG_LEVEL || mod_bunyan.WARN,
    name: 'sdc-req'
});

var OPTIONS;
var CONFIG;

var URCLIENT;
var VMAPI;
var QUEUE;
var REQUEST_ID;

var OPTION_SPECS = [
    {
        names: [ 'help', 'h' ],
        type: 'bool',
        help: 'print this help message'
    }
];

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
        console.error('ERROR: could not read configuration file "%s"',
            path);
        process.exit(1);
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
    var parser = mod_dashdash.createParser({
        options: options,
        allowUnknown: false
    });

    var usage = function (msg) {
        var us = [
            'Usage: sdc-req REQUEST_ID'
        ].join('\n') + '\n\n' + parser.help({
            indent: 2,
            headingIndent: 0
        });

        if (msg) {
            if (!opts.quiet) {
                console.error('ERROR: ' + msg);
                console.error(us);
            }
            process.exit(1);
        } else {
            console.log(us);
            process.exit(0);
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

    if (opts._args.length !== 1)
        usage('must provide a request ID');

    REQUEST_ID = opts._args[0];

    return (opts);
}

/*
 * Node discovery:
 */

function
init_vmapi(log)
{
    mod_assert.object(log, 'log');
    mod_assert.object(CONFIG, 'CONFIG');
    mod_assert.string(CONFIG.vmapi_domain, 'CONFIG.vmapi_domain');

    return (new mod_sdc.VMAPI({
        log: log,
        url: 'http://' + CONFIG.vmapi_domain
    }));
}

function
list_vms(callback)
{
    var search_opts = {
        query: '(&(state=running)(tags=*-smartdc_type=core-*))'
    };

    VMAPI.listVms(search_opts, function (err, vms) {
        var i;

        if (err) {
            err = new VError(err, 'could not enumerate VMs');
            callback(err);
            return;
        }

        var out = [];
        for (i = 0; i < vms.length; i++) {
            var vm = vms[i];

            if (!vm.tags || !vm.tags.smartdc_role)
                continue;

            out.push({
                server_uuid: vm.server_uuid,
                vm_uuid: vm.uuid,
                role: vm.tags.smartdc_role
            });
        }

        callback(null, out);
    });
}

/*
 * Worker function:
 */

function
grep_vm_logs(vm, next)
{
    mod_assert.string(vm.server_uuid, 'vm.server_uuid');
    mod_assert.string(vm.vm_uuid, 'vm.vm_uuid');
    mod_assert.string(vm.role, 'vm.role');

    var globs = [];
    var add_glob = function (glob) {
        globs.push(mod_path.join('/zones', vm.vm_uuid, 'root', glob));
    };

    switch (vm.role) {
    case 'moray':
        add_glob('/var/log/moray.log');
        break;
    case 'cloudapi':
        add_glob('/var/log/cloudapi.log');
        break;
    default:
        add_glob('/var/svc/log/*smartdc*.log');
        add_glob('/var/log/sdc/upload/*.log');
        break;
    }

    if (globs.length < 1) {
        next();
        return;
    }

    var script = [
        '#!/bin/bash',
        '',
        'for file in ' + globs.join(' ') + '; do',
        '    if [[ -f "${file}" ]]; then',
        '        grep -- "${1}" "${file}"',
        '    fi',
        'done',
        ''
    ].join('\n');

    URCLIENT.exec({
        script: script,
        server_uuid: vm.server_uuid,
        timeout: 30 * 1000,
        env: {},
        args: [
            REQUEST_ID
        ]
    }, function (err, result) {
        if (err) {
            console.error('ERROR: (vm %s, %s) %s', vm.role, vm.vm_uuid,
              err.message);
        } else {
            process.stdout.write(result.stdout);
            if (result.status !== 0) {
                process.stderr.write(result.stderr);
            }
        }
        next();
    });
}

/*
 * Entry point:
 */

function
main()
{
    OPTIONS = parse_options(OPTION_SPECS, process.argv);

    CONFIG = read_config();

    VMAPI = init_vmapi(LOG.child({
        component: 'vmapi'
    }));

    QUEUE = mod_vasync.queuev({
        worker: grep_vm_logs,
        concurrency: 5
    });

    URCLIENT = mod_urclient.create_ur_client({
        log: LOG,
        connect_timeout: 5000,
        enable_http: false,
        bind_ip: get_local_ip(),
        amqp_config: get_amqp_config()
    });
    URCLIENT.on('ready', function () {
        list_vms(function (err, servers) {
            if (err) {
                console.error('ERROR: %s', err.message);
                process.exit(1);
            }

            QUEUE.push(servers);
            QUEUE.close();
        });
    });

    QUEUE.on('end', function () {
        process.exit(0);
    });
}

main();
