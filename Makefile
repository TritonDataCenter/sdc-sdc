#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Makefile for the 'sdc' zone
#

#
# Vars, Tools, Files, Flags
#
NAME		:= sdc
DOC_FILES	 = index.restdown
JS_FILES	:= $(shell find lib test -name '*.js' | grep -v '/tmp/')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
NODEUNIT	:= ./node_modules/.bin/nodeunit

NODE_PREBUILT_VERSION=v0.8.23
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_CC_VERSION=4.6.2
	NODE_PREBUILT_TAG=zone
endif


include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	include ./tools/mk/Makefile.node.defs
endif

RELEASE_TARBALL	:= $(NAME)-pkg-$(STAMP).tar.bz2
RELTMPDIR       := /tmp/$(STAMP)



#
# Targets
#
.PHONY: all
all: | $(NODEUNIT)
	$(NPM) install

$(NODEUNIT): | $(NPM_EXEC)
	$(NPM) install

.PHONY: test
test: | $(NODEUNIT)
	$(NODEUNIT) test/*.test.js

.PHONY: release
release: all
	@echo "Building $(RELEASE_TARBALL)"
	mkdir -p $(RELTMPDIR)/$(NAME)
	cp -r \
		$(TOP)/bin \
		$(TOP)/build \
		$(TOP)/lib \
		$(TOP)/node_modules \
		$(TOP)/package.json \
		$(TOP)/README.md \
		$(TOP)/CHANGES.md \
		$(TOP)/test \
		$(RELTMPDIR)/$(NAME)
	(cd $(RELTMPDIR) && $(TAR) -jcf $(TOP)/$(RELEASE_TARBALL) $(NAME))
	@rm -rf $(RELTMPDIR)

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp $(TOP)/$(RELEASE_TARBALL) $(BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)

DISTCLEAN_FILES += node_modules


include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
else
	include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.targ
