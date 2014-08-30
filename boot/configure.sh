#!/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace
set -o errexit

PATH=/opt/smartdc/sdc/bin:/opt/smartdc/sdc/build/node/bin:/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin
SAPIADM=/opt/smartdc/config-agent/bin/sapiadm

function fatal
{
    echo "$0: fatal error: $*"
    exit 1
}


# Tune TCP so will work better with Manta.
# '|| true' because this 'ipadm set-prop' is necessary on some platform versions
# and breaks on older ones.
ipadm set-prop -t -p max_buf=2097152 tcp || true
ndd -set /dev/tcp tcp_recv_hiwat 2097152
ndd -set /dev/tcp tcp_xmit_hiwat 2097152
ndd -set /dev/tcp tcp_conn_req_max_q 2048
ndd -set /dev/tcp tcp_conn_req_max_q0 8192


config_path=/opt/smartdc/sdc/etc/config.json
admin_uuid=$(json -f ${config_path} ufds_admin_uuid)
[[ -z "$admin_uuid" ]] && fatal "could not determine admin_uuid"
datacenter_name=$(json -f ${config_path} datacenter_name)
[[ -z "$datacenter_name" ]] && fatal "could not determine datacenter_name"


# Add a '$dcname sdc key' ssh key on the 'admin' user and to ~/.ssh in *every
# SDC core zone* (by adding for manifest on the 'sdc' *application* in SAPI).
#
# This will be used for ssh'ing to each sdc zone (e.g. by the 'sdc-req' tool).
# TODO(trent): Is that last use case still true? Else move the key to the
#              SDC *service*.
#
# Note: we do this lazily on every boot in case we can't currently contact
# the UFDS master.
key_name="$datacenter_name sdc key"
keys=$(sdc-useradm keys -j $admin_uuid || true)
if [[ -z "$keys" ]]; then
    echo "Warning: Could not get admin's ($admin_uuid) keys from UFDS." \
        "Skipping '$key_name' setup."
else
    key=$(echo "$keys" | json -c "this.name==='$key_name'" -a)
    if [[ -n "$key" ]]; then
        echo "Already have '$key_name' key on admin user"
    elif [[ "$(sdc-useradm ping --master)" != "pong" ]]; then
        echo "Skip '$key_name' setup because cannot reach UFDS master"
    else
        echo "Create '$key_name' key for admin user, add to the 'sdc' SAPI app"
        key_file=/var/tmp/sdc.id_rsa
        rm -f $key_file $key_file.pub
        ssh-keygen -t rsa -C "$key_name" -f "$key_file" -N ""
        key_fingerprint=$(ssh-keygen -l -f "$key_file" | awk '{print $2}')

        # Add the keys to the sdc service metadata, which will be used by the
        # actual manifests that write the keys to each 'sdc' zone.
        sdc_app_uuid=$(sdc-sapi /applications?name=sdc | json -H 0.uuid)
        if [[ -z "$sdc_app_uuid" ]]; then
            echo "Warning: Could not get sdc app info from SAPI. " \
                "Skipping '$key_name' setup."
        else
            node -e "
                var fs = require('fs');
                var d = {
                    metadata: {
                        SDC_PRIVATE_KEY: fs.readFileSync('$key_file', 'ascii'),
                        SDC_PUBLIC_KEY: fs.readFileSync('$key_file.pub', 'ascii'),
                        SDC_KEY_ID: '$key_fingerprint'
                    }
                };
                console.log(JSON.stringify(d,null,2));
                " >/var/tmp/sdc-key-update.json
            $SAPIADM update $sdc_app_uuid -f /var/tmp/sdc-key-update.json

            # Add the key to the admin user.
            sdc-useradm add-key -n "$key_name" ${admin_uuid} ${key_file}.pub
        fi

        rm -f $key_file $key_file.pub /var/tmp/sdc-key-update.json
    fi
fi


exit 0
