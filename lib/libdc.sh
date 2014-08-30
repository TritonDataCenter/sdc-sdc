#!/usr/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# Common functions for sdc-* bash tools.
#


TOP=$(cd $(dirname $0)/../ 2>/dev/null; pwd)
CONFIG=$TOP/etc/config.json

if [[ $1 == "--no-headers" ]]; then
    CURL_OPTS="-4 --connect-timeout 10 -sS -H accept:application/json"
    shift
else
    CURL_OPTS="-4 --connect-timeout 10 -sS -i -H accept:application/json -H content-type:application/json"
fi


function fatal() {
    echo "$@" >&2
    exit 1
}


AMON_URL=
function amon() {
    local path=$1
    shift
    if [[ -z "$AMON_URL" ]]; then
        AMON_URL="http://$(json -f $CONFIG amon_domain)"
    fi
    if [[ -z "$SDC_API_VERSION" ]]; then
        SDC_API_VERSION="*"
    fi
    (curl ${CURL_OPTS} -H "accept-version: ${SDC_API_VERSION}" \
        --url "${AMON_URL}${path}" "$@") || return $?
    echo ""  # sometimes the result is not terminated with a newline
    return 0
}

CLOUDAPI_URL=
CLOUDAPI_SDC_KEY_ID=
function cloudapi() {
    local path=$1
    shift
    if [[ -z "$CLOUDAPI_URL" ]]; then
        CLOUDAPI_URL="https://$(json -f $CONFIG cloudapi_domain)"
    fi
    if [[ -z "$CLOUDAPI_SDC_KEY_ID" ]]; then
        CLOUDAPI_SDC_KEY_ID="$(json -f $CONFIG sdc_key_id)"
    fi
    local cuser=$CLOUDAPI_USER
    if [[ -z "$cuser" ]]; then
        cuser=admin
    fi

    # Sign with the old http-signature scheme.
    local now=$(date -u "+%a, %d %h %Y %H:%M:%S GMT")
    local signature=$(echo "$now" | tr -d '\n' | \
        openssl dgst -sha256 -sign $HOME/.ssh/sdc.id_rsa | \
        openssl enc -e -a | tr -d '\n')
    local authz="Authorization: Signature keyId=\"/$cuser/keys/$CLOUDAPI_SDC_KEY_ID\",algorithm=\"rsa-sha256\" $signature"
    local version="X-Api-Version:~7"

    (curl ${CURL_OPTS} -k -H "$version" -H "$authz" -H "Date: $now" \
        --url "${CLOUDAPI_URL}${path}" "$@") || return $?
    echo ""  # sometimes the result is not terminated with a newline
    return 0
}

CNAPI_URL=
function cnapi() {
    local path=$1
    shift
    if [[ -z "$CNAPI_URL" ]]; then
        CNAPI_URL="http://$(json -f $CONFIG cnapi_domain)"
    fi
    if [[ -z "$SDC_API_VERSION" ]]; then
        SDC_API_VERSION="*"
    fi
    (curl ${CURL_OPTS} -H "accept-version: ${SDC_API_VERSION}" \
        --url "${CNAPI_URL}${path}" "$@") || return $?
    echo ""  # sometimes the result is not terminated with a newline
    return 0
}

NAPI_URL=
function napi() {
    local path=$1
    shift
    if [[ -z "$NAPI_URL" ]]; then
        NAPI_URL="http://$(json -f $CONFIG napi_domain)"
    fi
    if [[ -z "$SDC_API_VERSION" ]]; then
        SDC_API_VERSION="*"
    fi
    (curl ${CURL_OPTS} -H "accept-version: ${SDC_API_VERSION}" \
        --url "${NAPI_URL}${path}" "$@") || return $?
    echo ""  # sometimes the result is not terminated with a newline
    return 0
}

FWAPI_URL=
function fwapi() {
    local path=$1
    shift
    if [[ -z "$FWAPI_URL" ]]; then
        FWAPI_URL="http://$(json -f $CONFIG fwapi_domain)"
    fi
    if [[ -z "$SDC_API_VERSION" ]]; then
        SDC_API_VERSION="*"
    fi
    (curl ${CURL_OPTS} -H "accept-version: ${SDC_API_VERSION}" \
        --url "${FWAPI_URL}${path}" "$@") || return $?
    echo ""  # sometimes the result is not terminated with a newline
    return 0
}

PAPI_URL=
function papi() {
    local path=$1
    shift
    if [[ -z "$PAPI_URL" ]]; then
        PAPI_URL="http://$(json -f $CONFIG papi_domain)"
    fi
    if [[ -z "$SDC_API_VERSION" ]]; then
        SDC_API_VERSION="*"
    fi
    (curl ${CURL_OPTS} -H "accept-version: ${SDC_API_VERSION}" \
        --url "${PAPI_URL}${path/\\\"/\"}" "$@") || return $?
    echo ""  # sometimes the result is not terminated with a newline
    return 0
}

SAPI_URL=
function sapi() {
    local path=$1
    shift
    if [[ -z "$SAPI_URL" ]]; then
        SAPI_URL="http://$(json -f $CONFIG sapi_domain)"
    fi
    if [[ -z "$SDC_API_VERSION" ]]; then
        SDC_API_VERSION="*"
    fi
    (curl ${CURL_OPTS} -H "accept-version: ${SDC_API_VERSION}" \
        --url "${SAPI_URL}${path}" "$@") || return $?
    echo ""  # sometimes the result is not terminated with a newline
    return 0
}

WORKFLOW_URL=
function workflow() {
    local path=$1
    shift
    if [[ -z "$WORKFLOW_URL" ]]; then
        WORKFLOW_URL="http://$(json -f $CONFIG workflow_domain)"
    fi
    if [[ -z "$SDC_API_VERSION" ]]; then
        SDC_API_VERSION="*"
    fi
    (curl ${CURL_OPTS} -H "accept-version: ${SDC_API_VERSION}" \
        --url "${WORKFLOW_URL}${path}" "$@") || return $?
    echo ""  # sometimes the result is not terminated with a newline
    return 0
}

VMAPI_URL=
function vmapi() {
    local path=$1
    shift
    if [[ -z "$VMAPI_URL" ]]; then
        VMAPI_URL="http://$(json -f $CONFIG vmapi_domain)"
    fi
    if [[ -z "$SDC_API_VERSION" ]]; then
        SDC_API_VERSION="*"
    fi
    (curl ${CURL_OPTS} -H "accept-version: ${SDC_API_VERSION}" \
        --url "${VMAPI_URL}${path}" "$@") || return $?
    echo ""  # sometimes the result is not terminated with a newline
    return 0
}


# filename passed must have a 'Job-Location: ' header in it.
watch_job()
{
    local filename=$1

    # This may in fact be the hackiest possible way I could think up to do this
    rm -f /tmp/job_status.$$.old
    touch /tmp/job_status.$$.old
    local prev_execution=
    local chain_results=
    local execution="unknown"
    local job_status=
    local loop=0
    local output=
    local http_result=
    local http_code=
    local http_message=

    local job=$(json -H job_uuid < ${filename})
    if [[ -z ${job} ]]; then
        echo "+ FAILED! Result has no Job-Location: header. See ${filename}." >&2
        return 2
    fi

    echo "+ Job is /jobs/${job}"

    while [[ ${execution} == "running" || ${execution} == "queued" || ${execution} == "unknown" ]] \
        && [[ ${loop} -lt 120 ]]; do

        local output=$(workflow /jobs/${job})
        local http_result=$(echo "${output}" | grep "^HTTP/1.1 [0-9][0-9][0-9] " | tail -1)
        local http_code=$(echo "${http_result}" | cut -d' ' -f2)
        local http_message=$(echo "${http_result}" | cut -d' ' -f3-)

        if echo "${http_code}" | grep "^[45]" >/dev/null; then
            echo "+ Failed to get status (will retry), workflow said: ${http_code} ${http_message}"
        else
            job_status=$(echo "${output}" | json -H)
            echo "${job_status}" | json chain_results | json -a result > /tmp/job_status.$$.new
            diff -u /tmp/job_status.$$.old /tmp/job_status.$$.new | grep -v "No differences encountered" | grep "^+[^+]" | sed -e "s/^+/+ /"
            mv /tmp/job_status.$$.new /tmp/job_status.$$.old
            execution=$(echo "${job_status}" | json execution)
            if [[ ${execution} != ${prev_execution} ]]; then
                echo "+ Job status changed to: ${execution}"
                prev_execution=${execution}
            fi
        fi
        sleep 0.5
    done

    if [[ ${execution} == "succeeded" ]]; then
        echo "+ Success!"
        return 0
    elif [[ ${execution} == "canceled" ]]; then
        echo "+ CANCELED! (details in /jobs/${job})" >&2
        return 1
    else
        echo "+ FAILED! (details in /jobs/${job})" >&2
        return 1
    fi
}

provision_zone_from_payload()
{
    local tmpfile=$1
    local verbose="$2"

    vmapi /vms -X POST -H "Content-Type: application/json" --data-binary @${tmpfile} >/tmp/provision.$$ 2>&1
    return_code=$?
    if [[ ${return_code} != 0 ]]; then
        echo "VMAPI FAILED with:" >&2
        cat /tmp/provision.$$ >&2
        return ${return_code}
    fi
    provisioned_uuid=$(json -H vm_uuid < /tmp/provision.$$)
    if [[ -z ${provisioned_uuid} ]]; then
        if [[ -n $verbose ]]; then
            echo "+ FAILED: Unable to get uuid for new ${zrole} VM (see /tmp/provision.$$)."
            cat /tmp/provision.$$ | json -H
            exit 1
        else
            fatal "+ FAILED: Unable to get uuid for new ${zrole} VM (see /tmp/provision.$$)."
        fi
    fi

    echo "+ Sent provision to VMAPI for ${provisioned_uuid}"
    watch_job /tmp/provision.$$

    return $?
}
