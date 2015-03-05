# sdc (SDC ops core zone) Changelog

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
