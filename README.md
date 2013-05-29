# a CLI for the IMGAPI

Repository: <git@git.joyent.com:sdc.git>
Browsing: <https://mo.joyent.com/sdc>
Who: Trent Mick
Docs: <https://mo.joyent.com/docs/sdc>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/TOOLS>


# Overview

The SDC headnode GZ has historically had a number of `sdc-*` tools in
"/opt/smartdc/bin" (e.g. sdc-vmapi, sdc-ldap). These live(d) in
usb-headnode.git. Because they are not installed via an image they
weren't upgradeable via SAPI. To support the later an 'sdc' core
zone (akin to the Manta 'ops') zone was created. This repo is it.


# Rules for commits

- If the commit is at all significant, then increment the patch
  version (in "package.json") and add an appropriate note to
  "CHANGES.md".

- `make check`

- Test by pushing local changes to a COAL or test HN and test:

        ./tools/rsync-to $HN
        ./tools/test-on $HN

  Or the shortcut for COAL:

        make coaltest    # NYI

