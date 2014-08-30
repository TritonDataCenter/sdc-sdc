#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Work with SDC VMs
 *
 * TODO
 * - list should accept wildcards and operators for dates (alias=fss*, date>x)
 */

var VERSION = '1.0.1';

var p = console.log;
var fs = require('fs');
var util = require('util'),
    format = util.format;

var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var cmdln = require('cmdln'),
    Cmdln = cmdln.Cmdln;
var genUuid = require('node-uuid');
var read = require('read');
var sdcClients = require('sdc-clients'),
    VMAPI = sdcClients.VMAPI;
var sprintf = require('extsprintf').sprintf;
var filters = require('ldapjs').filters;

var common = require('../lib/common'),
    objMerge = common.objMerge,
    objCopy = common.objCopy;
var errors = require('../lib/errors');



//---- globals & config

var NAME = 'sdc-vmadm';
var config = require('../etc/config.json');

var log = bunyan.createLogger({
    name: NAME,
    serializers: bunyan.stdSerializers,
    stream: process.stderr,
    level: 'warn'
});


//---- internal support stuff

/**
 * Print a table of the given items.
 *
 * @params items {Array} of row objects.
 * @params options {Object}
 *      - `columns` {String} of comma-separated field names for columns
 *      - `skipHeader` {Boolean} Default false.
 *      - `sort` {String} of comma-separate fields on which to alphabetically
 *        sort the rows. Optional.
 *      - `validFields` {String} valid fields for `columns` and `sort`
 */
function tabulate(items, options) {
    assert.arrayOfObject(items, 'items');
    assert.object(options, 'options');
    assert.string(options.columns, 'options.columns');
    assert.optionalBool(options.skipHeader, 'options.skipHeader');
    assert.optionalString(options.sort, 'options.sort');
    assert.string(options.validFields, 'options.validFields');

    if (items.length === 0) {
        return;
    }

    // Validate.
    var validFields = options.validFields.split(',');
    var columns = options.columns.split(',');
    var sort = options.sort ? options.sort.split(',') : [];
    columns.forEach(function (c) {
        if (validFields.indexOf(c) === -1) {
            throw new TypeError(sprintf('invalid output field: "%s"', c));
        }
    });
    sort.forEach(function (s) {
        if (s[0] === '-') s = s.slice(1);
        if (validFields.indexOf(s) === -1) {
            throw new TypeError(sprintf('invalid sort field: "%s"', s));
        }
    });

    // Determine columns and widths.
    var widths = {};
    columns.forEach(function (c) { widths[c] = c.length; });
    items.forEach(function (i) {
        columns.forEach(function (c) {
            widths[c] = Math.max(widths[c], (i[c] ? String(i[c]).length : 0));
        });
    });

    var template = '';
    columns.forEach(function (c) {
        template += '%-' + String(widths[c]) + 's  ';
    });
    template = template.trim();

    function cmp(a, b) {
        for (var i = 0; i < sort.length; i++) {
            var field = sort[i];
            var invert = false;
            if (field[0] === '-') {
                invert = true;
                field = field.slice(1);
            }
            assert.ok(field.length, 'zero-length sort field: ' + options.sort);
            var a_cmp = Number(a[field]);
            var b_cmp = Number(b[field]);
            if (isNaN(a_cmp) || isNaN(b_cmp)) {
                a_cmp = a[field] || '';
                b_cmp = b[field] || '';
            }
            if (a_cmp < b_cmp) {
                return (invert ? 1 : -1);
            } else if (a_cmp > b_cmp) {
                return (invert ? -1 : 1);
            }
        }
        return 0;
    }
    if (sort.length) {
        items.sort(cmp);
    }

    if (!options.skipHeader) {
        var header = columns.map(function (c) { return c.toUpperCase(); });
        header.unshift(template);
        console.log(sprintf.apply(null, header));
    }
    items.forEach(function (i) {
        var row = columns.map(function (c) {
            var cell = i[c];
            if (cell === null || cell === undefined) {
                return '-';
            } else {
                return String(i[c]);
            }
        });
        row.unshift(template);
        console.log(sprintf.apply(null, row));
    });
}



//---- the CLI

function CLI() {
    Cmdln.call(this, {
        name: 'sdc-vmadm',
        desc: 'Administer SDC VMs in VMAPI',
        // Custom options. By default you get -h/--help.
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

// Custom `init` to handle custom options (i.e. 'version' defined above).
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

    this.initVmapiClient();
    // Cmdln class handles `opts.help`.
    Cmdln.prototype.init.apply(this, arguments);
};


CLI.prototype.initVmapiClient = function () {
    var options = {
        log: log,
        url: 'http://' + config.vmapi_domain
    };
    this.vmapi = new VMAPI(options);
};


CLI.prototype.do_get = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 1) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var uuid = args[0];
    this.vmapi.getVm({ uuid: uuid }, function (err, vm) {
        if (err) {
            return callback(new errors.APIError(err));
        }
        p(JSON.stringify(vm, null, 2));
        return callback();
    });
};
CLI.prototype.do_get.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_get.help = (
    'Get a VM.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} get [<options>] <uuid>\n' +
    '\n' +
    '{{options}}\n' +
    'This emits in JSON by default.\n'
);


CLI.prototype.do_list = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    }

    var SEARCHABLE_FIELDS = {
        uuid: true,
        owner_uuid: true,
        image_uuid: true,
        billing_id: true,
        server_uuid: true,
        // tags: true,
        brand: true,
        state: true,
        alias: true,
        ram: true,
        // create_timestamp: true,
        max_physical_memory: true
    };
    var VALID_FIELDS = [
        'uuid', 'owner_uuid', 'brand', 'server_uuid', 'billing_id', 'alias',
        'ram', 'max_physical_memory', 'max_swap', 'quota', 'cpu_cap',
        'cpu_shares', 'max_lwps', 'create_timestamp', 'destroyed',
        'last_modified', 'state', 'zpool', 'zfs_io_priority',
        'firewall_enabled', 'limit_priv'
    ];
    var searchOpts = { state: 'active' };

    for (var i = 0; i < args.length; i++) {
        var arg = args[i];
        /* JSSTYLED */
        var opParser = /^(.*?)\s*(=|==)\s*(.*?)$/;
        var parsed = opParser.exec(arg);
        if (!parsed) {
            continue;
        }
        var field = parsed[1];
        var value = parsed[3];
        if (!field.match(/tag\.(.*)/) && !SEARCHABLE_FIELDS[field]) {
            throw new Error(sprintf('unknown filter field: "%s"', field));
        }
        if (field === 'ram') {
            field = 'max_physical_memory';
        }
        searchOpts[field] = value;

    }

    this.vmapi.listVms(searchOpts, function (err, vms) {
        if (err) {
            return callback(new errors.APIError(err));
        }
        if (opts.json) {
            p(JSON.stringify(vms, null, 2));
        } else {
            tabulate(vms, {
                skipHeader: opts.H,
                columns: opts.long ? 'uuid,brand,ram,state,alias' : opts.o,
                sort: opts.s,
                validFields: VALID_FIELDS.join(',')
            });
        }

        return callback();
    });
};
CLI.prototype.do_list.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['json', 'j'],
        type: 'bool',
        help: 'JSON output.'
    },
    {
        names: ['H'],
        type: 'bool',
        help: 'Do not print table header row.'
    },
    {
        names: ['o'],
        type: 'string',
        'default': 'uuid,brand,ram,state,alias',
        help: 'Specify fields (columns) to output.',
        helpArg: 'field1,...'
    },
    {
        names: ['s'],
        type: 'string',
        'default': 'create_timestamp',
        help: 'Sort on the given fields. Default is "create_timestamp".',
        helpArg: 'field1,...'
    },
    {
        names: ['long', 'l'],
        type: 'bool',
        help: 'Longer table output. Shortcut for ' +
            '"-o uuid,brand,ram,state,alias".'
    }
];
CLI.prototype.do_list.help = (
    'List and/or search VMs.\n' +
    '\n' +
    'Usage:\n' +
    '    {{name}} list [<options>] <terms...>\n' +
    '\n' +
    '{{options}}\n' +
    'The search terms must be field=value pairs. The following fields are\n' +
    'valid for filtering VMs and can also be used for sorting the output\n' +
    'with the -s option as well: uuid, ram, max_physical_memory, \n' +
    'owner_uuid, image_uuid, billing_id, server_uuid, brand, state, alias.\n' +
    '\n' +
    'Examples:\n' +
    '\n' +
    '    sdc-vmadm list brand=joyent\n' +
    '    sdc-vmadm list ram=256\n' +
    '    sdc-vmadm list brand=kvm state=running\n'
);


CLI.prototype.do_create = function (subcmd, opts, args, callback) {
    var self = this;
    var vmapi = self.vmapi;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    }

    var fields = [
        {
            name: 'owner_uuid',
            prompt: true
        },
        {
            name: 'image_uuid',
            prompt: true
        },
        {
            name: 'brand',
            prompt: true,
            description: 'One of "joyent-minimal", "joyent", "kvm" or "sngl"'
        },
        {
            name: 'networks',
            prompt: true,
            json: true,
            description: 'JSON array'
        },
        {
            name: 'billing_id',
            prompt: true,
            description: 'SDC Package UUID'
        }
    ];

    function readField(field, default_, cb) {
        if (cb === undefined) {
            cb = default_;
            default_ = undefined;
        }
        assert.object(field, 'field');
        assert.func(cb);

        var prompt;
        if (field.description) {
            prompt = field.name + ' (' + field.description + '):';
        } else {
            prompt = field.name + ':';
        }
        //TODO: 'required', don't allow empty string
        var readOpts = {
            prompt: prompt,
            silent: field.hidden,
            'default': default_
        };

        read(readOpts, function (rErr, val) {
            if (rErr)
                return cb(rErr);
            val = val.trim();
            if (field.json) {
                try {
                    val = JSON.parse(val);
                } catch (parseErr) {
                    cb(parseErr);
                }
            }

            cb(null, val);
        });
    }

    var data = {};
    async.series([
        function dataFromStdin(next) {
            if (opts.i || opts.f || args.length > 0) {
                return next();
            }
            var stdin = '';
            process.stdin.resume();
            process.stdin.on('data', function (chunk) {
                stdin += chunk;
            });
            process.stdin.on('end', function () {
                try {
                    objMerge(data, JSON.parse(stdin));
                    next();
                } catch (ex) {
                    next(new errors.UsageError(
                        sprintf('invalid JSON data on stdin: %s', ex)));
                }
            });
        },
        function dataFromFile(next) {
            if (!opts.f) {
                return next();
            } else if (opts.i) {
                return next(new errors.UsageError(
                    'cannot use both "-i" and "-f" options'));
            } else if (args.length > 0) {
                return next(new errors.UsageError(
                    'cannot specify args and the "-f" option'));
            }
            fs.readFile(opts.f, function (rErr, content) {
                try {
                    objMerge(data, JSON.parse(content));
                    next();
                } catch (ex) {
                    next(new errors.UsageError(
                        sprintf('invalid JSON data in "%s": %s', opts.f, ex)));
                }
            });
        },
        function dataFromArgs(next) {
            if (args.length === 0) {
                return next();
            }
            for (var i = 0; i < args.length; i++) {
                var arg = args[i];
                var idx = arg.indexOf('=');
                if (idx === -1) {
                    return next(new errors.UsageError(sprintf(
                        'invalid field arg "%s": must match ' +
                        '"<field>=<value>"', arg)));
                }
                var field = arg.slice(0, idx);
                var value = arg.slice(idx + 1);
                try {
                    value = JSON.parse(value);
                } catch (e) {}
                data[field] = value;
            }
            next();
        },
        function dataFromPrompting(next) {
            if (!opts.i) {
                return next();
            }
            async.eachSeries(fields, function askField(field, nextField) {
                if (!field.prompt && !opts.all) {
                    return nextField();
                }
                readField(field, data[field.name], function (rfErr, val) {
                    if (rfErr)
                        return nextField(rfErr);
                    if (val) {
                        data[field.name] = val;
                    }
                    nextField();
                });
            }, next);
        },
        function createVm(next) {
            vmapi.createVm(data, function (err, job) {
                if (err) {
                    return next(new errors.APIError(err));
                }
                p('VM %s (job "%s") created', job['vm_uuid'], job['job_uuid']);
                next();
            });
        }
    ], callback);
};
CLI.prototype.do_create.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        name: 'f',
        type: 'string',
        help: 'JSON file with user data.'
    },
    {
        name: 'i',
        type: 'bool',
        help: 'Interactively prompt for fields. Only the following fields' +
            'are prompted: owner_uuid, image_uuid, brand, networks and ' +
            'billing_id.'
    }
];
CLI.prototype.do_create.help = (
    'Create a new VM.\n' +
    '\n' +
    'Usage:\n' +
    '   ...stdin... | {{name}} create            # 1. data as JSON on stdin\n' +
    '   {{name}} create -f foo.json              # 2. data in JSON file\n' +
    '   {{name}} create <field>=<value>...       # 3. all fields as args\n' +
    '   {{name}} create -i [<field>=<value>...]  # 4. prompt for fields\n' +
    '\n' +
    '{{options}}\n'
);


CLI.prototype.do_update = function (subcmd, opts, args, callback) {
    var self = this;
    var vmapi = self.vmapi;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length === 0) {
        return callback(new errors.UsageError('expecting VM UUID'));
    }
    var uuid = args[0];
    args.shift();

    var data = {};
    async.series([
        function dataFromStdin(next) {
            if (opts.i || opts.f || args.length > 0) {
                return next();
            }
            var stdin = '';
            process.stdin.resume();
            process.stdin.on('data', function (chunk) {
                stdin += chunk;
            });
            process.stdin.on('end', function () {
                try {
                    objMerge(data, JSON.parse(stdin));
                    next();
                } catch (ex) {
                    next(new errors.UsageError(
                        sprintf('invalid JSON data on stdin: %s', ex)));
                }
            });
        },
        function dataFromFile(next) {
            if (!opts.f) {
                return next();
            } else if (opts.i) {
                return next(new errors.UsageError(
                    'cannot use both "-i" and "-f" options'));
            } else if (args.length > 0) {
                return next(new errors.UsageError(
                    'cannot specify args and the "-f" option'));
            }
            fs.readFile(opts.f, function (rErr, content) {
                try {
                    objMerge(data, JSON.parse(content));
                    next();
                } catch (ex) {
                    next(new errors.UsageError(
                        sprintf('invalid JSON data in "%s": %s', opts.f, ex)));
                }
            });
        },
        function dataFromArgs(next) {
            if (args.length === 0) {
                return next();
            }
            for (var i = 0; i < args.length; i++) {
                var arg = args[i];
                var idx = arg.indexOf('=');
                if (idx === -1) {
                    return next(new errors.UsageError(sprintf(
                        'invalid field arg "%s": must match ' +
                        '"<field>=<value>"', arg)));
                }
                var field = arg.slice(0, idx);
                var value = arg.slice(idx + 1);
                try {
                    value = JSON.parse(value);
                } catch (e) {}
                data[field] = value;
            }
            next();
        },
        function updateVm(next) {
            data.uuid = uuid;
            vmapi.updateVm(data, function (err, job) {
                if (err) {
                    return next(new errors.APIError(err));
                }
                p('Update job %s for VM %s created', job['job_uuid'],
                    job['vm_uuid']);
                next();
            });
        }
    ], callback);
};
CLI.prototype.do_update.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        name: 'f',
        type: 'string',
        help: 'JSON file with user data.'
    }
];
CLI.prototype.do_update.help = (
    'Update a VM.\n' +
    '\n' +
    'Usage:\n' +
    '  ...stdin... | {{name}} update <uuid>      # 1. data as JSON on stdin\n' +
    '  {{name}} update <uuid> -f foo.json        # 2. data in JSON file\n' +
    '  {{name}} update <uuid> <field>=<value>... # 3. all fields as args\n' +
    '\n' +
    '{{options}}\n'
);


CLI.prototype.do_add_nics = function (subcmd, opts, args, callback) {
    var self = this;
    var vmapi = self.vmapi;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length === 0) {
        return callback(new errors.UsageError('expecting VM UUID'));
    }
    var uuid = args[0];
    args.shift();

    var data = {};
    async.series([
        function dataFromStdin(next) {
            if (opts.i || opts.f || args.length > 0) {
                return next();
            }
            var stdin = '';
            process.stdin.resume();
            process.stdin.on('data', function (chunk) {
                stdin += chunk;
            });
            process.stdin.on('end', function () {
                try {
                    objMerge(data, JSON.parse(stdin));
                    next();
                } catch (ex) {
                    next(new errors.UsageError(
                        sprintf('invalid JSON data on stdin: %s', ex)));
                }
            });
        },
        function dataFromFile(next) {
            if (!opts.f) {
                return next();
            } else if (opts.i) {
                return next(new errors.UsageError(
                    'cannot use both "-i" and "-f" options'));
            } else if (args.length > 0) {
                return next(new errors.UsageError(
                    'cannot specify args and the "-f" option'));
            }
            fs.readFile(opts.f, function (rErr, content) {
                try {
                    objMerge(data, JSON.parse(content));
                    next();
                } catch (ex) {
                    next(new errors.UsageError(
                        sprintf('invalid JSON data in "%s": %s', opts.f, ex)));
                }
            });
        },
        function addNics(next) {
            data.uuid = uuid;
            vmapi.addNics(data, function (err, job) {
                if (err) {
                    return next(new errors.APIError(err));
                }
                p('AddNics job %s for VM %s created', job['job_uuid'],
                    job['vm_uuid']);
                next();
            });
        }
    ], callback);
};
CLI.prototype.do_add_nics.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        name: 'f',
        type: 'string',
        help: 'JSON file with user data.'
    }
];
CLI.prototype.do_add_nics.help = (
    'Add NICs to a VM.\n' +
    '\n' +
    'Usage:\n' +
    '   ...stdin... | {{name}} add-nics <uuid>   # 1. data as JSON on stdin\n' +
    '   {{name}} add-nics <uuid> -f foo.json     # 2. data in JSON file\n' +
    '\n' +
    '{{options}}\n'
);


CLI.prototype.do_remove_nics = function (subcmd, opts, args, callback) {
    var self = this;
    var vmapi = self.vmapi;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length === 0) {
        return callback(new errors.UsageError('expecting VM UUID'));
    }
    var uuid = args[0];
    args.shift();

    var data = {};
    async.series([
        function dataFromStdin(next) {
            if (opts.i || opts.f || args.length > 0) {
                return next();
            }
            var stdin = '';
            process.stdin.resume();
            process.stdin.on('data', function (chunk) {
                stdin += chunk;
            });
            process.stdin.on('end', function () {
                try {
                    objMerge(data, JSON.parse(stdin));
                    next();
                } catch (ex) {
                    next(new errors.UsageError(
                        sprintf('invalid JSON data on stdin: %s', ex)));
                }
            });
        },
        function dataFromFile(next) {
            if (!opts.f) {
                return next();
            } else if (opts.i) {
                return next(new errors.UsageError(
                    'cannot use both "-i" and "-f" options'));
            } else if (args.length > 0) {
                return next(new errors.UsageError(
                    'cannot specify args and the "-f" option'));
            }
            fs.readFile(opts.f, function (rErr, content) {
                try {
                    objMerge(data, JSON.parse(content));
                    next();
                } catch (ex) {
                    next(new errors.UsageError(
                        sprintf('invalid JSON data in "%s": %s', opts.f, ex)));
                }
            });
        },
        function removeNics(next) {
            data.uuid = uuid;
            vmapi.removeNics(data, function (err, job) {
                if (err) {
                    return next(new errors.APIError(err));
                }
                p('RemoveNics job %s for VM %s created', job['job_uuid'],
                    job['vm_uuid']);
                next();
            });
        }
    ], callback);
};
CLI.prototype.do_remove_nics.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        name: 'f',
        type: 'string',
        help: 'JSON file with user data.'
    }
];
CLI.prototype.do_remove_nics.help = (
    'Remove NICs from a VM.\n' +
    '\n' +
    'Usage:\n' +
    ' ...stdin... | {{name}} remove-nics <uuid>  # 1. data as JSON on stdin\n' +
    ' {{name}} remove-nics <uuid> -f foo.json    # 2. data in JSON file\n' +
    '\n' +
    '{{options}}\n'
);


CLI.prototype.do_stop = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 1) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var uuid = args[0];
    this.vmapi.stopVm({ uuid: uuid }, function (err, job) {
        if (err) {
            return callback(new errors.APIError(err));
        }
        p('Stop job %s for VM %s created', job['job_uuid'], job['vm_uuid']);
        return callback();
    });
};
CLI.prototype.do_stop.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_stop.help = (
    'Stop a VM.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} stop [<options>] <uuid>\n' +
    '\n' +
    '{{options}}\n'
);


CLI.prototype.do_start = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 1) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var uuid = args[0];
    this.vmapi.startVm({ uuid: uuid }, function (err, job) {
        if (err) {
            return callback(new errors.APIError(err));
        }
        p('Start job %s for VM %s created', job['job_uuid'], job['vm_uuid']);
        return callback();
    });
};
CLI.prototype.do_start.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_start.help = (
    'Start a VM.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} start [<options>] <uuid>\n' +
    '\n' +
    '{{options}}\n'
);


CLI.prototype.do_reboot = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 1) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var uuid = args[0];
    this.vmapi.rebootVm({ uuid: uuid }, function (err, job) {
        if (err) {
            return callback(new errors.APIError(err));
        }
        p('Reboot job %s for VM %s created', job['job_uuid'], job['vm_uuid']);
        return callback();
    });
};
CLI.prototype.do_reboot.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_reboot.help = (
    'Reboot a VM.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} reboot [<options>] <uuid>\n' +
    '\n' +
    '{{options}}\n'
);


CLI.prototype.do_reprovision = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 2) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var uuid = args[0];
    var imageUuid = args[1];

    this.vmapi.reprovisionVm({ uuid: uuid, image_uuid: imageUuid },
      function (err, job) {
        if (err) {
            return callback(new errors.APIError(err));
        }
        p('Reprovision job %s for VM %s created', job['job_uuid'],
            job['vm_uuid']);
        return callback();
    });
};
CLI.prototype.do_reprovision.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_reprovision.help = (
    'Reprovision a VM.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} reprovision [<options>] <uuid> <image_uuid>\n' +
    '\n' +
    '{{options}}\n'
);


CLI.prototype.do_snapshot = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length === 0 || args.length > 2) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var params = { uuid: args[0] };
    if (args[1]) {
        params.name = args[1];
    }
    this.vmapi.snapshotVm(params, function (err, job) {
        if (err) {
            return callback(new errors.APIError(err));
        }
        p('Snapshot job %s for VM %s created', job['job_uuid'], job['vm_uuid']);
        return callback();
    });
};
CLI.prototype.do_snapshot.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_snapshot.help = (
    'Snapshot a VM.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} snapshot [<options>] <uuid> [<name>]\n' +
    '\n' +
    '{{options}}\n'
);


CLI.prototype.do_rollback = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 2) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var params = { uuid: args[0], name: args[1] };
    this.vmapi.rollbackVm(params, function (err, job) {
        if (err) {
            return callback(new errors.APIError(err));
        }
        p('Rollback job %s for VM %s created', job['job_uuid'], job['vm_uuid']);
        return callback();
    });
};
CLI.prototype.do_rollback.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_rollback.help = (
    'Rollback a VM.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} rollback [<options>] <uuid> <name>\n' +
    '\n' +
    '{{options}}\n'
);


CLI.prototype.do_delete_snapshot = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 2) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var params = { uuid: args[0], name: args[1] };
    this.vmapi.deleteSnapshot(params, function (err, job) {
        if (err) {
            return callback(new errors.APIError(err));
        }
        p('Delete snapshot job %s for VM %s created', job['job_uuid'],
            job['vm_uuid']);
        return callback();
    });
};
CLI.prototype.do_delete_snapshot.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_delete_snapshot.help = (
    'Delete a snapshot from VM.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} delete-snapshot [<options>] <uuid> <name>\n' +
    '\n' +
    '{{options}}\n'
);


CLI.prototype.do_delete = function (subcmd, opts, args, callback) {
    if (opts.help) {
        this.do_help('help', {}, [subcmd], callback);
        return;
    } else if (args.length !== 1) {
        return callback(new errors.UsageError(sprintf(
            'incorrect number of arguments: "%s"', args.join(' '))));
    }
    var uuid = args[0];
    this.vmapi.deleteVm({ uuid: uuid }, function (err, job) {
        if (err) {
            return callback(new errors.APIError(err));
        }
        p('Delete job %s for VM %s created', job['job_uuid'], job['vm_uuid']);
        return callback();
    });
};
CLI.prototype.do_delete.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    }
];
CLI.prototype.do_delete.help = (
    'Delete a VM.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} delete [<options>] <uuid>\n' +
    '\n' +
    '{{options}}\n'
);


//---- mainline

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
