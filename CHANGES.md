# sdc (SDC ops core zone) Changelog

## 1.8.4

- TRITON-2109 sdc-migrate abort should delete the record when successful
- TRITON-2052 sdc-imgadm import should import from any channel by default

## 1.8.3

- TRITON-1777 sdc-migrate finalize does not output anything on success

## 1.8.2

- TRITON-1721 sdc-migrate needs a cleanup command.
  Implemented the `sdc-migrate finalize` command.

## 1.8.1

- TRITON-1718 sdc-migrate is missing 'abort' help docs

## 1.8.0

- TRITON-1233 Add sdc-migrate command to headnode's GZ

## 1.7.1

- TRITON-788 Update to sdc-amonadm that isn't broken by sdc-clients@11
  change.

## 1.7.0

- TRITON-1076 remove unused data dumps from dump-hourly-sdc-data.sh
- Dumps that remain (all others were removed):
    * `cnapi_servers-$TIMESTAMP.json`
    * `napi_networks-$TIMESTAMP.json`
    * `papi_packages-$TIMESTAMP.json`
    * `vmadm_vms-$TIMESTAMP.json`
    * `vmapi_vms-$TIMESTAMP.json`

## 1.6.1

- TRITON-1082 hermes-proxy should not run itself out of files and memory

## 1.6.0

- AGENT-997 update hermes to sdcnode (v6.15.1)

## 1.5.2

- MANTA-4030 Drop pinned lru-cache top-level dep. The release or lru-cache@4.1.5
  fixes the issue.

## 1.5.1

- MANTA-4030 many images using node 0.10 or 0.12 broken by transitive
  lru-cache@4.1.4 dep

## 1.5.0

- TOOLS-1857 Add sdc-volapi command to headnode's GZ

## 1.4.0

- Manta instances with a large number of load balancer IP addresses are
  now supported by hermes, the log archival service (TOOLS-1641).

## 1.3.0

- Add 'sdc-useradm *-attr' commands:

        sdc-useradm replace-attr <login|uuid> <attr> <value>

        sdc-useradm add-attr <login|uuid> <attr> <value> [<value>...]

        # Delete an attribute with a single value.
        sdc-useradm delete-attr <login|uuid> <attr>
        # Delete a specific attribute value from the user.
        sdc-useradm delete-attr <login|uuid> <attr> <value>
        # Delete all attribute values from the user.
        sdc-useradm delete-attr -a <login|uuid> <attr>


## 1.1.2

- DAPI-220: remove DAPI zone

## 1.1.1

- TOOLS-273: sdc-useradm search FIELD=VALUE ...

## 1.1.0

- `sdc-cloudapi` and sdc service setup to create an "sdc key" on the admin user
  for CloudAPI auth.
- `sdc-useradm` is a good start at working with sdcPerson and sdckey entries
  in UFDS.

## 1.0.3

Added sdc-papi.

## 1.0.2

Added sdc-amon, sdc-amonrelay.

## 1.0.1

Added sdc-ldap(1)

## 1.0.0

First release.
