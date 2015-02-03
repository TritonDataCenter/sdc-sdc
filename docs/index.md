---
title: SDC tools/ops zone
markdown2extras: tables, code-friendly
apisections:
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# SDC tools/ops zone

This repository holds the code for the 'sdc' core SmartDataCenter zone.
This document will briefly introduce those tools and also give a general
overview of the various APIs and systems in SDC.


# Tools

As a rule all (most) tools are prefixed with 'sdc-' to avoid name conflicts,
make the scope obvious, and to facilitate discovery in the shell via
`sdc-<TAB>`.

There are a number of APIs in SDC and most of them have tools to facilitate
using them from the command line. Typically those are in two categories:
(a) A raw tool that just wraps calling the API and does minimal massaging of
the response. For the HTTP APIs, these raw tools are typically a light wrapper
around `curl`. Examples: sdc-imgapi, sdc-vmapi. (b) A higher-level and
friendlier CLI tool, often with 'adm' in the name (following the smartos
administrator tool naming tradition).

| API                                         | Raw API Tool  | Friendlier "adm" tool                       |
| ------------------------------------------- | ------------- | ------------------------------------------- |
| Amon Master API (amon)                      | sdc-amon      | sdc-amonadm                                 |
| Amon Relay API (a small debugging-only API) | sdc-amonrelay | (N/A almost no need to call Amon Relay API) |
| Compute Node API (CNAPI)                    | sdc-cnapi     | sdc-server                                  |
| Firewall API (FWAPI)                        | sdc-fwapi     | sdc-fwadm (NYI: need a ticket)              |
| Image API (IMGAPI)                          | sdc-imgapi    | sdc-imgadm                                  |
| Network API (NAPI)                          | sdc-napi      | sdc-network                                 |
| Virtual Machine API (VMAPI)                 | sdc-vmapi     | sdc-vmadm (NYI: TOOLS-307)                  |
| Workflow API                                | sdc-workflow  | sdc-wfadm (NYI: TOOLS-308)                  |
| UFDS                                        | sdc-ldap      | --                                          |
| Service API (SAPI)                          | sdc-sapi      | sapiadm (*)                                 |
| x                                           | x             | x                                           |

In addition there are a number of other tools not directly associated with
an API in the DC:

| Tool           | Description                                               |
| -------------- | --------------------------------------------------------- |
| joyent-imgadm  | Joyent Images (images.joyent.com)                         |
| updates-imgadm | SDC Updates (updates.joyent.com)                          |
| sdc-req        | Search for a request UUID on all the SDC application logs |


TODO: document appropriate of:

    sdc-rollback
    sdc-lastcomm
    sdc-backup               sdc-sbcreate
    sdc-login                sdc-sbupload
    sdc-create-2nd-manatee   sdc-manatee-clear-error  sdc-server
    sdc-create-binder        sdc-manatee-history      sdc-setconsole
    sdc-manatee-stat         sdc-upgrade
    sdc-vm
    sdc-dsapi                sdc-network
    sdc-factoryreset         sdc-oneachnode           sdc-vmmanifest
    sdc-phonehome            sdc-vmname
    sdc-healthcheck          sdc-post-upgrade
    sdc-heartbeatsnoop       sdc-rabbitstat           sdc-zfs-io-throttle.d
    sdc-image-sync           sdc-restore
    sdc-role


# Uploading SDC service API data to Manta

The DC's 'sdc' zone (there should be only one) handles taking hourly dumps
of most of the SDC API's models and uploading those to Manta. Here is how
that works (see TOOLS-278 for background):

- Every minute and hourly cron job (at the top of the hour) dumps the output of
  the various APIs to "/var/log/sdc-data/*.json":

        * * * * * /opt/smartdc/sdc/tools/dump-minutely-sdc-data.sh >>/var/log/dump-minutely-sdc-data.log 2>&1
        0 * * * * /opt/smartdc/sdc/tools/dump-hourly-sdc-data.sh >>/var/log/dump-hourly-sdc-data.log 2>&1

  That script will drop dump files more than a week old to ensure these don't
  grow to consume all space.

- At 10 minutes after the hour, a separate cron job uploads those dumps to Manta
  **if the DC is configured with a Manta to use**:

        10 * * * * /opt/smartdc/sdc/tools/upload-sdc-data.sh >>/var/log/upload-sdc-data.log 2>&1

- These script's log files are monitored with an Amon log-scan alarm for
  'fatal error'



# Uploading SDC log data to Manta

TODO: describe how this works and where pieces are uploaded.



# Operators Guide

## HOWTO: Configure SDC to use a Manta

Given a Manta to use, SDC will upload hourly API data dumps, log files,
etc. This requires three pieces:

1. An SSH key for all relevant parts of SDC to use.
2. A Manta location (base MANTA_URL and MANTA_USER) to use.
3. If not already, the 'sdc' zone needs an external NIC.

**Step 1 is handled automatically** the first time the 'sdc' zone is setup. A
new SSH key is created and added to the metadata of the 'sdc' *application*
in SAPI. For example:

    [root@headnode (coal) ~]# sdc-sapi /applications?name=sdc | json -H 0.metadata | json -j SDC_PRIVATE_KEY SDC_PUBLIC_KEY SDC_KEY_ID
    {
      "SDC_PRIVATE_KEY": "-----BEGIN RSA PRIVATE KEY-----\nMII...",
      "SDC_PUBLIC_KEY": "ssh-rsa AAAAB3NzaC...",
      "SDC_KEY_ID": "a6:87:6f:3e:7f:fb:96:ea:64:63:85:a2:e2:0f:26:86"
    }

Note: If you have an alternative key that you want to use, you can replace the
automatically generated one as follows. First, get the priv and pub key files
to the headnode GZ, e.g. to "/var/tmp/mykey.id_rsa" and
"/var/tmp/mykey.id_rsa.pub".

    # Update the 'sdc' SAPI service
    keypath=/var/tmp/mykey.id_rsa
    keyid=$(ssh-keygen -l -f "$keypath.pub" | awk '{print $2}')
    /usr/node/bin/node -e "
        var fs = require('fs');
        var d = {
            metadata: {
                SDC_PRIVATE_KEY: fs.readFileSync('$keypath', 'ascii'),
                SDC_PUBLIC_KEY: fs.readFileSync('$keypath.pub', 'ascii'),
                SDC_KEY_ID: '$keyid'
            }
        };
        console.log(JSON.stringify(d,null,2));
        " >/var/tmp/sdc-key-update.json
    sdc_app=$(sdc-sapi /applications?name=sdc | json -Ha uuid)
    sapiadm update $sdc_app -f /var/tmp/sdc-key-update.json

    # Update the key on the 'admin' user.
    datacenter_name=$(bash /lib/sdc/config.sh -json | json datacenter_name)
    sdc-useradm delete-key admin "$datacenter_name sdc key" || true
    sdc-useradm add-key -n "$datacenter_name sdc key" admin $keypath.pub

(TODO: there should be a 'sdcadm' tool for this.)


**Step 2 must manually be set** by:

(a) setting the "SDC_MANTA_URL" and "SDC_MANTA_USER" metadata on the 'sdc'
    *application*; and
(b) ensuring this Manta user has the "SDC_PUBLIC_KEY" (e.g. via the portal)

Step (a) can be done as in the following example (here I am using my own
Manta user area for COAL dev testing):

    sapiadm update $(sdc-sapi /applications?name=sdc | json -H 0.uuid) \
        metadata.SDC_MANTA_USER=trent.mick
    sapiadm update $(sdc-sapi /applications?name=sdc | json -H 0.uuid) \
        metadata.SDC_MANTA_URL=https://us-east.manta.joyent.com

For step (b) you either need to manually add your ssh key on the SDC_MANTA_USER
you used to the user database being used by Manta... or you could set the
SDC key to be one that you already know exists there. The latter can be done
for COAL by running the following from your Mac:

    # Usage:
    #   ./tools/set-sdc-key.sh HEADNODE PRIV-KEY-FILE
    # For example:
    cd <sdc.git-clone>
    ./tools/set-sdc-key.sh coal ~/.ssh/automation.id_rsa

**Step 3 can be done with as follows**, run from the headnode GZ:

    sdc-vmapi /vms/$(vmadm lookup -1 alias=sdc0)?action=add_nics -X POST -d@- <<EOP | sdc sdc-waitforjob
    {
        "networks": [{"uuid": "$(sdc-napi /networks?name=external | json -H 0.uuid)"}]
    }
    EOP
    sleep 10  # wait for the sdc zone to reboot
