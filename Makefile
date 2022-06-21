#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2021 Joyent, Inc.
# Copyright 2022 MNX Cloud, Inc.
#

#
# Makefile for the 'sdc' zone
#

#
# Vars, Tools, Files, Flags
#
NAME		:= sdc
DOC_FILES	 = index.md sdc-amon-probes.md
JS_FILES	:= $(shell find lib test -name '*.js' | grep -v '/tmp/') bin/sdc-check-amqp
ESLINT_FILES	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
RONNJS		 = $(NODE) ./node_modules/.bin/ronn
PERCENT		:= %

ifeq ($(shell uname -s),SunOS)
	# minimal-64-lts@21.4.0
	NODE_PREBUILT_IMAGE=18b094b0-eb01-11e5-80c1-175dac7ddf02
	NODE_PREBUILT_VERSION=v6.17.1
	NODE_PREBUILT_TAG=gz
endif

ENGBLD_USE_BUILDIMAGE	= true
ENGBLD_REQUIRE		:= $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

BUILD_PLATFORM  = 20210826T002459Z

ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.defs
else
	NPM := $(shell which npm)
	NPM_EXEC=$(NPM)
endif

RELEASE_TARBALL	:= $(NAME)-pkg-$(STAMP).tar.gz
RELSTAGEDIR       := /tmp/$(NAME)-$(STAMP)

# triton-origin-x86_64-21.4.0
BASE_IMAGE_UUID = 502eeef2-8267-489f-b19c-a206906f57ef
BUILDIMAGE_NAME = $(NAME)
BUILDIMAGE_DESC	= SDC tools/ops zone
BUILDIMAGE_DO_PKGSRC_UPGRADE = true
BUILDIMAGE_PKGSRC = mtr-0.86nb3
AGENTS		= amon config

MAN_PAGES = \
	man1/amqpsnoop.1 \
	man1/sdc-amon.1 \
	man1/sdc-amonrelay.1 \
	man1/sdc-cnapi.1 \
	man1/sdc-dirty-vms.1 \
	man1/sdc-fwapi.1 \
	man1/sdc-imgapi.1 \
	man1/sdc-ldap.1 \
	man1/sdc-mahi.1 \
	man1/sdc-napi.1 \
	man1/sdc-oneachnode.1 \
	man1/sdc-papi.1 \
	man1/sdc-sapi.1 \
	man1/sdc-vmapi.1 \
	man1/sdc-waitforjob.1 \
	man1/sdc-workflow.1

BUILD_MAN_FILES = $(MAN_PAGES:%=build/man/%)

CLEAN_FILES += build/man

#
# Targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NPM_EXEC) sdc-scripts sdc-napi-ufds-watcher
	$(NPM) install

.PHONY: man
man: $(BUILD_MAN_FILES)

build/man/%: man/%.ronn
	mkdir -p $(@D)
	$(RONNJS) --roff $^ \
	    --date `git log -1 --date=short --pretty=format:'$(PERCENT)cd' $^` \
	    `date +$(PERCENT)Y` \
	    > $@
	echo >> $@

.PHONY: hermes
hermes: deps/hermes/.git
	cd deps/hermes && make install DESTDIR=$(TOP)/build/hermes

.PHONY: release
release: all docs man hermes sdc-napi-ufds-watcher
	@echo "Building $(RELEASE_TARBALL)"
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELSTAGEDIR)/site
	touch $(RELSTAGEDIR)/site/.do-not-delete-me
	mkdir -p $(RELSTAGEDIR)/root
	cp -r \
		$(TOP)/bin \
		$(TOP)/lib \
		$(TOP)/node_modules \
		$(TOP)/package.json \
		$(TOP)/sapi_manifests \
		$(TOP)/README.md \
		$(TOP)/CHANGES.md \
		$(TOP)/probes \
		$(TOP)/test \
		$(TOP)/tools \
		$(TOP)/build/man \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(TOP)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(TOP)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	cp -r \
		$(TOP)/build/node \
		$(TOP)/build/docs \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	cp -r $(TOP)/build/hermes/opt/smartdc/hermes \
		$(RELSTAGEDIR)/root/opt/smartdc/hermes
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/hermes/etc
	cp -r $(TOP)/deps/sdc-napi-ufds-watcher/ \
		$(RELSTAGEDIR)/root/opt/smartdc/napi-ufds-watcher
	cp $(TOP)/etc/logsets.json \
		$(RELSTAGEDIR)/root/opt/smartdc/hermes/etc
	(cd $(RELSTAGEDIR) && $(TAR) -I pigz -cf $(TOP)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

.PHONY: publish
publish: release
	mkdir -p $(ENGBLD_BITS_DIR)/$(NAME)
	cp $(TOP)/$(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)

DISTCLEAN_FILES += node_modules

.PHONY: clean
clean::
	test ! -f deps/hermes/.git || (cd deps/hermes && make clean)
	test ! -f deps/sdc-napi-ufds-watcher/.git || (cd deps/sdc-napi-ufds-watcher && make clean)

.PHONY: distclean
distclean::
	test ! -f deps/hermes/.git || (cd deps/hermes && make distclean)
	test ! -f deps/sdc-napi-sfds-watcher || (cd deps/sdc-napi-ufds-watcher && make distclean)



include ./deps/eng/tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.targ
endif
include ./deps/eng/tools/mk/Makefile.targ

sdc-scripts: deps/sdc-scripts/.git

sdc-napi-ufds-watcher: deps/sdc-napi-ufds-watcher/.git
	cd deps/sdc-napi-ufds-watcher && make
