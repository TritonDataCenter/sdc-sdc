#!/bin/bash
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
