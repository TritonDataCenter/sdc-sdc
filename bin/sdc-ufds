#!/bin/bash
#
# Copyright (c) 2013 Joyent Inc., All rights reserved.
#
# Convenience wrapper for calling the *local* UFDS using the ldapjs-* commands.
# WARNING: This does NOT call the "master" UFDS, if there is one.
#

# Find the directory the script lives in. We'll load config relative to that.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CONFIG_JSON="${SCRIPT_DIR}/../etc/config.json"

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail


arch=$(uname -s)


# Arguments.
verbose=0
if [ "$1" == "-v" ]; then
    shift
    verbose=1
fi
command=$1
if [[ -z "$command" ]]; then
    echo "sdc-ufds -- light wrapper around ldapjs-* commands for this datacenter's UFDS"
    echo ""
    echo "Usage:"
    echo "  sdc-ufds [-v] COMMAND ARGS"
    echo ""
    echo "Commands:"
    echo "  search, s         call 'ldapjs-search' with appropriate connection/auth args"
    echo "  modify            call 'ldapjs-modify'"
    echo "  add               call 'ldapjs-add'"
    echo "  delete, del, rm   call 'ldapjs-delete'"
    exit 0
fi
shift;


# Determine connection and auth info.
if [[ -f ${CONFIG_JSON} ]]; then
    CONFIG_ufds_domain=$(json ufds_domain < ${CONFIG_JSON});
    CONFIG_ufds_ldap_root_dn=$(json ufds_ldap_root_dn < ${CONFIG_JSON});
    CONFIG_ufds_ldap_root_pw=$(json ufds_ldap_root_pw < ${CONFIG_JSON});

    UFDS_CREDENTIALS="$CONFIG_ufds_ldap_root_dn:$CONFIG_ufds_ldap_root_pw"
    UFDS_HOST="${CONFIG_ufds_domain}"
else
    if [[ -z "$UFDS_CREDENTIALS" ]]; then
        UFDS_CREDENTIALS=cn=root:secret
    fi
fi
if [[ -z "$UFDS_HOST" ]]; then
    echo "Unable to find UFDS host." >&2
    exit 1
fi
if [[ -z "$UFDS_PORT" ]]; then
    UFDS_PORT=636
fi

ufds_dn=$(echo "$UFDS_CREDENTIALS" | cut -d: -f1)
ufds_pw=$(echo "$UFDS_CREDENTIALS" | cut -d: -f2)

export ldapjs_opts="--url ldaps://$UFDS_HOST:$UFDS_PORT --binddn ${ufds_dn} --password ${ufds_pw}"
export ldapjs_opts_masked="--url ldaps://$UFDS_HOST:$UFDS_PORT --binddn ${ufds_dn} --password ***"


# Run the command.
case $command in

search|s)
    [ "$verbose" == "1" ] && echo "$SCRIPT_DIR/../node_modules/.bin/ldapjs-search $ldapjs_opts --base o=smartdc $@" >&2
    $SCRIPT_DIR/../node_modules/.bin/ldapjs-search $ldapjs_opts --base o=smartdc "$@"
    ;;

modify)
    [ "$verbose" == "1" ] && echo "$SCRIPT_DIR/../node_modules/.bin/ldapjs-modify $ldapjs_opts $@" >&2
    $SCRIPT_DIR/../node_modules/.bin/ldapjs-modify $ldapjs_opts "$@"
    ;;

add)
    [ "$verbose" == "1" ] && echo "$SCRIPT_DIR/../node_modules/.bin/ldapjs-add $ldapjs_opts $@" >&2
    $SCRIPT_DIR/../node_modules/.bin/ldapjs-add $ldapjs_opts "$@"
    ;;

delete|rm|del)
    [ "$verbose" == "1" ] && echo "$SCRIPT_DIR/../node_modules/.bin/ldapjs-delete $ldapjs_opts $@" >&2
    $SCRIPT_DIR/../node_modules/.bin/ldapjs-delete $ldapjs_opts "$@"
    ;;

*)
    echo "sdc-ufds: error: unknown command '$command'"
    exit 1
    ;;
esac
