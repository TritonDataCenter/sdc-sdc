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
# Add the 'sdc' service to SAPI.
#
# WARNING: This is incomplete and broken.
#

# TODO: should ensure owner is admin
image_uuid=$(sdc-imgadm list name=sdc -H -o uuid | tail -1)

if [[ -z "$image_uuid" ]]; then
	echo "error: no 'sdc' image loaded into imgapi"
	exit 1
fi

sdc-sapi /services -X POST -d@- <<EOM
{
    "name": "sdc",
    "application_uuid": "$(sdc-sapi /applications?name=sdc | json -H 0.uuid)",
    "params": {
        "package_name": "sdc_256",
        "image_uuid": "$(sdc-imgadm list name=sdc -H -o uuid | tail -1)",
        "networks": ["admin", "external"],
        "tags": {
            "smartdc_role": "sdc",
            "smartdc_type": "core"
        }
    },
    "metadata": {
    },
    "manifests": {
    }
}
EOM
