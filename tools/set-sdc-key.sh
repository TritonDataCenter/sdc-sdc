#!/bin/bash
#
# Set the SDC ssh key on the given headnode to the given key. Note
# that this needs to be a passphrase-less key to work.
#
# Usage:
#       set-sdc-key.sh HEADNODE PRIVATE-KEY-FILE
#
# Example:
#       set-sdc-key.sh coal ~/.ssh/id_rsa.automation
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


#---- utils

function usage {
    echo "Usage:"
    echo "    set-sdc-key.sh HEADNODE PRIVATE-KEY-FILE KEY-NAME"
    echo ""
    echo "Example:"
    echo "    set-sdc-key.sh coal ~/.ssh/id_rsa.automation automation"
}

function fatal {
    echo "$0: fatal error: $*"
    echo ""
    usage
    exit 1
}


#---- mainline

headnode=$1
privkey=$2
keyname=$3

[[ -z "$headnode" ]] && fatal "no HEADNODE argument given"
[[ -z "$privkey" ]] && fatal "no PRIVATE-KEY-FILE argument given"
[[ -z "$keyname" ]] && fatal "no KEY-NAME argument given"
[[ -f "$privkey" ]] || fatal "'$privkey' does not exist"
pubkey=$privkey.pub
[[ -f "$pubkey" ]] || fatal "'$pubkey' does not exist"
keyid=$(ssh-keygen -l -f $pubkey | awk '{print $2}' | tr -d '\n')

scp $pubkey $headnode:/var/tmp/sdckey.id_rsa.pub
cat <<EOF | ssh -T $headnode
set -o xtrace
set -o errexit

PATH=/opt/smartdc/bin:\$PATH
sdcapp=\$(sdc-sapi /applications?name=sdc | json -H 0.uuid)
# Put the JSON on a single line to workaround pre-SAPI-168 SAPIs.
echo '{
    "metadata": {
        "SDC_PRIVATE_KEY": $(node -e "var fs=require('fs'); console.log(JSON.stringify(fs.readFileSync('$privkey', 'utf8')))"),
        "SDC_PUBLIC_KEY": "$(cat $pubkey)",
        "SDC_KEY_ID": "$keyid"
    }
}' | json -o json-0 | sapiadm update \$sdcapp

ufds_admin_uuid=\$(sdc-sapi /applications?name=sdc | json -H 0.metadata.ufds_admin_uuid)
sdczone=\$(vmadm lookup -1 alias=sdc0)
mv /var/tmp/sdckey.id_rsa.pub /zones/\$sdczone/root/var/tmp/
# Allow this to fail in case this is a replicated user and it already has
# a key with this fingerprint.
sdc sdc-useradm add-key -n "$keyname" \$ufds_admin_uuid /var/tmp/sdckey.id_rsa.pub || true
EOF

echo "New key set on the 'sdc' app in the '$headnode' SAPI."
echo "Within about 90s the key should be updated in all SDC core zones."

