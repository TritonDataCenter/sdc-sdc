/*
 * Copyright (c) 2013 Joyent Inc. All rights reserved.
 *
 * Error classes for some of the sdc tools.
 */

var util = require('util'),
    format = util.format;
var assert = require('assert-plus');
var verror = require('verror'),
    WError = verror.WError;



// ---- error classes

/**
 * Base imgadm error. Instances will always have a string `message` and
 * a string `code` (a CamelCase string).
 */
function SdcError(options) {
    assert.object(options, 'options');
    assert.string(options.message, 'options.message');
    assert.string(options.code, 'options.code');
    assert.optionalObject(options.cause, 'options.cause');
    assert.optionalNumber(options.statusCode, 'options.statusCode');
    var self = this;

    var args = [];
    if (options.cause) args.push(options.cause);
    args.push(options.message);
    WError.apply(this, args);

    var extra = Object.keys(options).filter(
        function (k) { return ['cause', 'message'].indexOf(k) === -1; });
    extra.forEach(function (k) {
        self[k] = options[k];
    });
}
util.inherits(SdcError, WError);

function InternalError(options) {
    assert.object(options, 'options');
    assert.optionalString(options.source, 'options.source');
    assert.optionalObject(options.cause, 'options.cause');
    assert.string(options.message, 'options.message');
    var message = options.message;
    if (options.source) {
        message = options.source + ': ' + message;
    }
    SdcError.call(this, {
        cause: options.cause,
        message: message,
        code: 'InternalError',
        exitStatus: 1
    });
}
util.inherits(InternalError, SdcError);

function UsageError(cause, message) {
    if (message === undefined) {
        message = cause;
        cause = undefined;
    }
    assert.string(message);
    SdcError.call(this, {
        cause: cause,
        message: message,
        code: 'Usage',
        exitStatus: 1
    });
}
util.inherits(UsageError, SdcError);

function NoSuchKeyError(cause, userLoginOrUuid, keyNameOrFingerprint) {
    if (keyNameOrFingerprint === undefined) {
        keyNameOrFingerprint = userLoginOrUuid;
        userLoginOrUuid = cause;
        cause = undefined;
    }
    assert.string(userLoginOrUuid, 'userLoginOrUuid');
    assert.string(keyNameOrFingerprint, 'keyNameOrFingerprint');
    SdcError.call(this, {
        cause: cause,
        message: format('user "%s" has no key with name or fingerprint "%s"',
            userLoginOrUuid, keyNameOrFingerprint),
        code: 'NoSuchKey',
        exitStatus: 1
    });
}
util.inherits(NoSuchKeyError, SdcError);

function APIError(cause) {
    assert.object(cause, 'cause');
    assert.optionalNumber(cause.statusCode, 'cause.statusCode');
    assert.string(cause.body.code, 'cause.body.code');
    assert.string(cause.body.message, 'cause.body.message');
    var message = cause.body.message;
    if (cause.body.errors) {
        cause.body.errors.forEach(function (e) {
            message += format('\n    %s: %s', e.field, e.code);
            if (e.message) {
                message += ': ' + e.message;
            }
        });
    }
    SdcError.call(this, {
        cause: cause,
        message: message,
        code: cause.body.code,
        statusCode: cause.statusCode,
        exitStatus: 1
    });
}
APIError.description = 'An error from an SDC API request.';
util.inherits(APIError, SdcError);




// ---- exports

module.exports = {
    SdcError: SdcError,
    InternalError: InternalError,
    UsageError: UsageError,
    NoSuchKeyError: NoSuchKeyError,
    APIError: APIError
};
