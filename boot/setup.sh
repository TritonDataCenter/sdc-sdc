#!/usr/bin/bash
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
#set -o errexit

PATH=/opt/local/bin:/opt/local/sbin:/usr/bin:/usr/sbin

role=sdc
app_name=$role

CONFIG_AGENT_LOCAL_MANIFESTS_DIRS="/opt/smartdc/$role /opt/smartdc/hermes"

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/boot/lib/util.sh
sdc_common_setup

# Cookie to identify this as a SmartDC zone and its role
mkdir -p /var/smartdc/sdc

# Add the main bin dir to the PATH.
# Note: we do NOT want the $role/node_modules/.bin dir on the PATH because
# we install 'node-smartdc' there to have it available, but we don't want
# all those 'sdc-*' commands on the default PATH.
echo "" >>/root/.profile
echo "export MANPATH=\${MANPATH}:/opt/smartdc/${role}/man" >>/root/.profile
echo "export PATH=/opt/smartdc/$role/bin:/opt/smartdc/$role/build/node/bin:\$PATH" >>/root/.profile
echo '[[ -f $HOME/.sdc_mantaprofile ]] && source $HOME/.sdc_mantaprofile' >>/root/.profile

# Setup crontab
crontab=/tmp/$role-$$.cron
crontab -l > $crontab
[[ $? -eq 0 ]] || fatal "Unable to write to $crontab"
echo '' >>$crontab
echo '* * * * * /opt/smartdc/sdc/tools/dump-minutely-sdc-data.sh >>/var/log/dump-minutely-sdc-data.log 2>&1' >>$crontab
echo '0 * * * * /opt/smartdc/sdc/tools/dump-hourly-sdc-data.sh >>/var/log/dump-hourly-sdc-data.log 2>&1' >>$crontab
echo '10 * * * * /opt/smartdc/sdc/tools/upload-sdc-data.sh >>/var/log/upload-sdc-data.log 2>&1' >>$crontab
echo '0 * * * * /opt/smartdc/sdc/bin/sdc-amonadm update >>/var/log/update-probes-hourly.log 2>&1' >>$crontab
crontab $crontab
[[ $? -eq 0 ]] || fatal "Unable import crontab"
rm -f $crontab

/usr/sbin/svccfg import /opt/smartdc/hermes/smf/hermes.xml
/usr/sbin/svccfg import /opt/smartdc/hermes/smf/hermes-proxy.xml

# Log rotation.
sdc_log_rotation_add amon-agent /var/svc/log/*amon-agent*.log 1g
sdc_log_rotation_add config-agent /var/svc/log/*config-agent*.log 1g
sdc_log_rotation_add hermes /var/svc/log/*hermes:default.log 1g
sdc_log_rotation_add hermes-proxy /var/svc/log/*hermes-proxy:default.log 1g
# Don't really need these 3 to go up to manta right now.
logadm -w sdc-data -C 3 -c -s 1m '/var/log/*-sdc-data.log'
sdc_log_rotation_setup_end


# All done, run boilerplate end-of-setup
sdc_setup_complete

exit 0
