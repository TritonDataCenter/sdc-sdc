#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2020 Joyent, Inc.
# Copyright 2024 MNX Cloud, Inc.
#

#
# Upload SDC service data in "/var/log/sdc-data/..." to manta.
# Files there are of the form:
#       $thing-$timestamp.$ext
#       imgapi_images-1376953200.json
# which get uploaded to manta as:
#       $SDC_MANTA_URL/$SDC_MANTA_USER/stor/sdc/$thing/$dcname/YYYY/MM/DD/HH/$basename.json
#       https://us-central.manta.mnx.io/admin/stor/sdc/imgapi_images/$dcname/2013/08/18/02/images_images-1376953200.json
#
# Note: Earlier discussion was that the service's VM UUID would be in the
# basename. Currently this data is being gathered via whatever IP is provided
# from DNS for that address. Given we don't have sharding currently, I don't
# see why the VM UUID need be included. (TODO: Perhaps we want to hit each
# of the N servers for each service once we have HA?)
#
# Files are added to the dump dir by a separate cron running
# 'dump-*-sdc-data.sh'.
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail



#---- globals/config

PATH=/opt/smartdc/sdc/bin:/opt/smartdc/sdc/build/node/bin:/opt/smartdc/sdc/node_modules/manta/bin:/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

TOP=$(cd $(dirname $0)/../; pwd)
CONFIG=$TOP/etc/config.json
JSON=$TOP/node_modules/.bin/json

DUMPDIR=/var/log/sdc-data

[[ -f /root/.sdc_mantaprofile ]] && source /root/.sdc_mantaprofile


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

if [[ -z "$MANTA_URL" ]]; then
    echo "no configured MANTA_URL, skipping upload"
    exit
fi
echo "MANTA_URL: $MANTA_URL"

# From:
#   $thing-$timestamp.$ext
# to:
#   /$SDC_MANTA_USER/stor/sdc/$thing/$dcname/YYYY/MM/DD/HH/$thing-$timestamp.$ext
dcname=$($JSON -f /opt/smartdc/sdc/etc/config.json datacenter_name)
for path in $(ls $DUMPDIR/*-*.*)
do
    echo "consider '$path'"
    f=$(basename $path)
    thing=$(echo $f | cut -d- -f 1)
    dumptime=$(echo $f | cut -d- -f 2 | cut -d. -f 1)
    dumpext=$(echo $f | cut -d- -f 2 | cut -d. -f 2)
    timepath=$(date -d "@$dumptime" "+%Y/%m/%d/%H")
    mpath="/$MANTA_USER/stor/sdc/$thing/$dcname/$timepath/$thing-$dumptime.$dumpext"

    echo "upload to '$mpath'"
    mmkdir -p $(dirname $mpath)

    content_type="text/plain"
    if [[ "$dumpext" == "json" ]]; then
        content_type="application/json"
    fi
    if [[ -n "$content_type" ]]; then
        ct_opt="-H \"Content-Type: $content_type\""
    fi
    mput -H "Content-Type: $content_type" -f $path $mpath
    rm $path
done

END=$(date +%s)
echo "$0 finished at $(date -u '+%Y-%m-%dT%H:%M:%S') ($(($END - $START)) seconds)"
