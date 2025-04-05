#!/usr/bin/env bash

# Installer for 'ft' script
#
# How to use:
#
# curl -fsSL https://ft.install.jerry.company | bash

if [[ "${DEBUG-}" == "true" || "${DEBUG-}" == "1" ]]; then
  set -x
fi

set -euo pipefail

DENO_VERSION=2.2.6
DENO_INSTALL_SCRIPT_URL="https://gist.githubusercontent.com/LukeChannings/09d53f5c364391042186518c8598b85e/raw/deno_install.sh"

main() {
  setup_flutter_test_home
  setup_deno_home
  install_deno_to_flutter_test_home
  install_flutter_test
}

setup_flutter_test_home() {
  if [[ -z "${FLUTTER_TEST_HOME-}" ]]; then
    FLUTTER_TEST_HOME="$HOME/.flutter-test"
  fi

  if [[ ! -d "$FLUTTER_TEST_HOME" ]]; then
    mkdir -p "$FLUTTER_TEST_HOME"
  fi
  if [[ -f "$FLUTTER_TEST_HOME/flutter-test" ]]; then
    # Remove the old flutter-test script
    rm -f "$FLUTTER_TEST_HOME/flutter-test"
  fi
}

setup_deno_home() {
  export DENO_INSTALL="$FLUTTER_TEST_HOME/deno"
  export DENO_BIN="$DENO_INSTALL/bin"
  export DENO_EXE="$DENO_BIN/deno"
}

install_deno_to_flutter_test_home() {
  local should_remove_existing_deno=false
  local should_install_deno=false

  if [[ ! -d "$DENO_INSTALL" ]]; then
    should_install_deno=true
  elif [[ ! -f "$DENO_EXE" ]]; then
    should_remove_existing_deno=true
    should_install_deno=true
  else
    # Need to check the version of the installed Deno
    local installed_deno_version
    installed_deno_version="$("$DENO_EXE" -V | awk '{print $2}')"

    if [[ "$installed_deno_version" != "$DENO_VERSION" ]]; then
      should_remove_existing_deno=true
      should_install_deno=true
    fi
  fi

  if [[ "$should_remove_existing_deno" = true ]]; then
    echo "Removing existing Deno installation..." >&2
    rm -rf "$FLUTTER_TEST_HOME/deno"
  fi

  if [[ "$should_install_deno" = true ]]; then
    echo "Installing Deno $DENO_VERSION..." >&2
    curl -fsSL "$DENO_INSTALL_SCRIPT_URL" |
      sh -s -- "v$DENO_VERSION" >/dev/null
  fi
}

install_flutter_test() {
  echo "Installing 'ft' to '$FLUTTER_TEST_HOME'..." >&2

  rm -f "$FLUTTER_TEST_HOME/ft"
  temp_file="$(mktemp).ts"
  curl -fsSL "https://github.com/fenv-org/ft/releases/download/v0.2.0-alpha.10/flutter_test.ts" -o "$temp_file"
  "$DENO_EXE" compile -A "$temp_file" -o "$FLUTTER_TEST_HOME/ft"
  rm -f "$temp_file"

  echo "Flutter Test was installed successfully to $FLUTTER_TEST_HOME/ft"
  echo
  echo "Please add the following to your shell profile:"
  echo
  echo "export PATH=\"\$PATH:$FLUTTER_TEST_HOME\""
  echo
  echo "And, then you can run 'ft' from the command line."
}

main "$@"
