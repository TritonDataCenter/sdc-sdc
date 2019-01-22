#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2019, Joyent, Inc.
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
# IMPORTANT: This is being deprecated. Please do not add more dumps.
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
mkdir -p $DUMPDIR

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

#
# Note: This vmadm_vms dump can be very expensive on larger DCs since it runs at
# least 2 commands on every single CN in the DC and then does a relatively
# expensive CNAPI query.
#
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

echo "Dump PAPI packages"
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

echo "Dump NAPI networks"
sdc-napi /networks >$DUMPDIR/napi_networks-$TIMESTAMP.json
[ $? -ne 0 ] && echo "$0: error: Dumping NAPI networks failed" >&2

ls -al $DUMPDIR/*$TIMESTAMP*

END=$(date +%s)
echo "$0 finished at $(date -u '+%Y-%m-%dT%H:%M:%S') ($(($END - $START)) seconds)"
