#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# Dump data to be pulled *every minute* to "/var/log/sdc-data/..."
#
# The intention is that this is run every minute by a cron job.
# WARNING: If this takes more than a minute to run then we have a problem!
#
# The separate hourly cronjob running 'upload-sdc-data.sh' uploads dump files to
# Manta. Note that we must name dump files "FOO_minutely-TIMESTAMP.EXT" so
# that the upload script knows not to blow away the current hourly file.
#
# The "dump-hourly-sdc-data.sh" handles purging stale old dumps if uploads
# to Manta are not working.
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail



#---- globals/config

PATH=/opt/smartdc/sdc/bin:/opt/smartdc/sdc/build/node/bin:/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

TOP=$(cd $(dirname $0)/../; pwd)
CONFIG=$TOP/etc/config.json
JSON=$TOP/node_modules/.bin/json

DUMPDIR=/var/log/sdc-data



#---- support stuff

function fatal
{
    echo "$0: fatal error: $*"
    exit 1
}

function errexit
{
    [[ $1 -ne 0 ]] || exit 0
    fatal "error exit status $1"
}



#---- mainline

trap 'errexit $?' EXIT

echo ""
echo "--"
START=$(date +%s)
echo "$0 started at $(date -u '+%Y-%m-%dT%H:%M:%S')"

mkdir -p $DUMPDIR

# We'll be running more than once per hour and want all of those
# dumps to go to the same hourly log file for pickup by
# "upload-sdc-data", so we'll fake our "TIMESTAMP" to one for this
# hour.
TIMESTAMP=$(date -u "+%s")
TOPOFHOUR=$(( $TIMESTAMP - $TIMESTAMP % 3600 ))

# Note: We are dumping to the same area as "dump-sdc-data.sh".
# That script will handle purging dump files older than a week.

ufds_is_master=$($JSON -f $CONFIG ufds_is_master)
if [[ "$ufds_is_master" == "true" ]]; then
  echo "UFDS in this DC is the master. Skipping MTR to UFDS master."
else
    echo "Get MTR report to UFDS master"
    ufds_remote_ip=$($JSON -f $CONFIG ufds_remote_ip)
    if [[ -z "$ufds_remote_ip" ]]; then
        echo "$0: warning: 'ufds_remote_ip' is empty (skipping mtr)"
    else
        DUMPFILE=$DUMPDIR/mtr_ufds_master_minutely-$TOPOFHOUR.log
        touch $DUMPFILE
        echo "" >>$DUMPFILE
        echo "-- timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ') ufds_remote_ip=$ufds_remote_ip" >>$DUMPFILE
        mtr --report $ufds_remote_ip >>$DUMPFILE
    fi
fi

ls -al $DUMPDIR/*$TOPOFHOUR* 2>/dev/null || true

END=$(date +%s)
echo "$0 finished at $(date -u '+%Y-%m-%dT%H:%M:%S') ($(($END - $START)) seconds)"
