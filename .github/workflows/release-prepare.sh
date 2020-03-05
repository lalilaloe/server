#!/usr/bin/env bash

ASSETVERSION=$(cat ./version/release.json| jq .version -r)

# CHeck if versions match
if [ "$VERSION" != "$ASSETVERSION" ]; then
    echo "Error: Version in assets and semantic-release version mismatch!";
    echo "  - Asset Version: $ASSETVERSION";
    echo "  - semantic-release Version: $VERSION";
    exit 1;
fi

sentry-cli releases new -p server "${VERSION}"
