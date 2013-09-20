#!/bin/bash
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
sdc-imgapi /images?state=all >$DUMPDIR/imgapi_images-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping IMGAPI images failed" >&2

# PII cert, drop customer_metadata and internal_metadat
echo "Dump VMAPI vms"
count=$(sdc-vmapi /vms?state=active -X HEAD | grep 'x-joyent-resource-count' | cut -d ' ' -f2 | tr -d '\r\n')
if [[ $? != 0 ]]; then
    echo "$0: error: Dumping VMAPI VMs failed. Could not get count of VMs" >&2
else
    sdc-vmapi "/vms?state=active&limit=$count" \
        | $JSON -e 'this.customer_metadata=undefined; this.internal_metadata=undefined;' \
        >$DUMPDIR/vmapi_vms-$TIMESTAMP.json
    [ $? -ne 0 ] && echo "$0: error: Dumping VMAPI VMs failed" >&2
fi

echo "Dump CNAPI servers"
sdc-cnapi /servers?extras=all >$DUMPDIR/cnapi_servers-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping CNAPI servers failed" >&2

# TODO: not sure about dumping all Amon alarms. This endpoint was never intended
# for prod use.
echo "Dump Amon alarms"
sdc-amon /alarms >$DUMPDIR/amon_alarms-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping Amon alarms failed" >&2

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
# TODO: Disabled right now pending discussion on timeouts here in heavy usage.
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
