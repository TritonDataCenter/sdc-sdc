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
# Dump data from SDC services to "/var/log/sdc-data/..."
#
# The intention is that this is run at the top of the hour. Then a separate
# cronjob running 'upload-sdc-data.sh' uploads all those to Manta. The
# separation is to separate failure modes. Each script will log and an Amon
# probe will watch for 'fatal error' in those logs.
#
# Uploading to Manta only happens if the 'sdc' application is configured with
# a SDC_MANTA_URL. To avoid endless filling of /var/log/sdc-data, dumps
# older than a week will be removed.
#
# TODO: add other services; ensure not too heavy on them (e.g. full dump of VMs)
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
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

TIMESTAMP=$(date -u "+%s")
mkdir -p /var/log/sdc-data

echo "Purge dumps older than a week."
for path in $(ls $DUMPDIR/*-*.json 2>/dev/null)
do
    f=$(basename $path)
    dumptime=$(echo $f | cut -d- -f 2 | cut -d. -f 1)
    # 604800 is a week of seconds
    if [[ $dumptime -lt $(( $START - 604800 )) ]]; then
        echo "Purging more-than-week-old ($dumptime < $START - 604800) dump file '$path'"
        rm -f $path
    fi
done

echo "Dump IMGAPI images"
sdc-imgadm list -a -j >$DUMPDIR/imgapi_images-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping IMGAPI images failed" >&2

# PII cert, drop customer_metadata and internal_metadata (modulo
# some allowed keys). The following is meant to be used with `json -e ...`.
sanitizeVmJson='
    this.customer_metadata = undefined;

    // Allow certain internal_metadata keys.
    var iAllowedKeys = {
        "com.joyent:ipnat_owner": true
    };
    var iKeys = Object.keys(this.internal_metadata);
    var iMeta = {};
    for (var i = 0; i < iKeys.length; i++) {
        var iKey = iKeys[i];
        if (iAllowedKeys[iKey]) {
            iMeta[iKey] = this.internal_metadata[iKey];
        }
    }
    this.internal_metadata = iMeta;'

# Dump VMs according to VMAPI
echo "Dump VMAPI vms"
count=$(sdc-vmapi /vms?state=active -X HEAD | grep 'x-joyent-resource-count' | cut -d ' ' -f2 | tr -d '\r\n')
if [[ $? != 0 ]]; then
    echo "$0: error: Dumping VMAPI VMs failed. Could not get count of VMs" >&2
else
    per_page=1000
    offset=0
    num_pages=$(($count / $per_page))
    if [[ $(($num_pages * $per_page)) < $count ]]; then
        num_pages=$((num_pages + 1))
    fi
    for ((i = 1; i <= $num_pages; i++)); do
        sdc-vmapi "/vms?state=active&limit=$per_page&offset=$offset" \
            | $JSON -Hae "$sanitizeVmJson" -o jsony-0 \
            >>$DUMPDIR/vmapi_vms-$TIMESTAMP.json
        if [ $? -ne 0  ]; then
            echo "$0: error: Dumping VMAPI VMs failed" >&2
            break
        fi
        offset=$(($i * $per_page))
    done
fi

echo "Dump vmadm VM info on all CNs"
# 1. Dump on each CN.
sdc-oneachnode -a -q '
    if [[ -d /opt/smartdc/agents/lib ]]; then
        vmadm lookup -j >/var/tmp/vmadm_vms.json;
    else
        echo "no vmadm lookup -j on 6.5";
    fi'
if [ $? -ne 0  ]; then
    echo "$0: error: Dumping 'vmadm lookup -j' on nodes" >&2
fi
# 2. Put that file to the headnode.
PUTDIR=/var/tmp/vmadm_vms.$$
rm -rf $PUTDIR
mkdir -p $PUTDIR
sdc-oneachnode -a -q -d $PUTDIR -p /var/tmp/vmadm_vms.json
if [ $? -ne 0  ]; then
    echo "$0: error: Getting 'vmadm lookup -j' dumps from nodes" >&2
fi
# 3. Massage the data from each expected CN into newline-separated JSON
#   (one line per VM).
DUMPFILE=$DUMPDIR/vmadm_vms-$TIMESTAMP.json
rm -f $DUMPFILE
nodeerrs=""
sdc-cnapi /servers?extras=sysinfo \
                | $JSON -H -c 'this.sysinfo["SDC Version"]' -a uuid \
                | while read node; do
    f=$PUTDIR/$node
    if [[ ! -s $f ]]; then
        nodeerrs="$nodeerrs $node"
        continue
    fi
    $JSON -f $f -e "this.cn=\"$node\"" -e "$sanitizeVmJson" \
        -a -o jsony-0 >>$DUMPFILE
done
if [[ -n "$nodeerrs" ]]; then
    echo "$0: error: Getting vmadm vms from some nodes: $nodeerrs" >&2
fi
rm -rf $PUTDIR


echo "Dump CNAPI servers"
sdc-cnapi /servers?extras=all >$DUMPDIR/cnapi_servers-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping CNAPI servers failed" >&2

# TODO: not sure about dumping all Amon alarms. This endpoint was never intended
# for prod use.
echo "Dump Amon alarms"
sdc-amon /alarms >$DUMPDIR/amon_alarms-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping Amon alarms failed" >&2

papi_domain=$($JSON -f /opt/smartdc/sdc/etc/config.json papi_domain)
if [[ -n "$papi_domain" ]]; then
    # We dump as a one-package-per-line json stream. This scales up
    # to many packages better.
    echo "Dump PAPI packages"
    CURL_OPTS="--connect-timeout 10 -sS -H accept:application/json"
    curl ${CURL_OPTS} --url "http://$papi_domain/packages" \
        | $JSON -Ha -o jsony-0 \
        >$DUMPDIR/papi_packages-$TIMESTAMP.json
    [ $? -ne 0 ] && echo "$0: error: Dumping PAPI packages failed" >&2
fi

echo "Dump NAPI nic_tags, nics, networks, network_pools"
sdc-napi /nic_tags >$DUMPDIR/napi_nic_tags-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping NAPI NIC tags failed" >&2
# TODO: Disabled right now b/c RobG said this might be too heavy in prod.
#sdc-napi /nics >$DUMPDIR/napi_nics-$TIMESTAMP.json
sdc-napi /networks >$DUMPDIR/napi_networks-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping NAPI networks failed" >&2
sdc-napi /network_pools >$DUMPDIR/napi_network_pools-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping NAPI network pools failed" >&2

echo "Dump SAPI applications, services, instances"
sdc-sapi /applications >$DUMPDIR/sapi_applications-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping SAPI applications failed" >&2
sdc-sapi /services >$DUMPDIR/sapi_services-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping SAPI services failed" >&2
sdc-sapi /instances >$DUMPDIR/sapi_instances-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping SAPI instances failed" >&2
sdc-sapi /manifests >$DUMPDIR/sapi_manifests-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping SAPI manifests failed" >&2

echo "Dump Workflow workflows, jobs"
sdc-workflow /workflows >$DUMPDIR/workflow_workflows-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping WFAPI workflows failed" >&2
# Right now we dump recent jobs (jobs created in the past 2 hours)
now=$TIMESTAMP
ago=$(date -u "+%s" -d -2hour)
# javascript expects milliseconds
now=$((now * 1000))
ago=$((ago * 1000))
sdc-workflow "/jobs?since=${ago}&until=${now}" >$DUMPDIR/workflow_recent_jobs-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping WFAPI jobs failed" >&2

ls -al $DUMPDIR/*$TIMESTAMP*

END=$(date +%s)
echo "$0 finished at $(date -u '+%Y-%m-%dT%H:%M:%S') ($(($END - $START)) seconds)"
