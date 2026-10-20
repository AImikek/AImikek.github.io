#!/bin/sh
# Stamps a new version into tasks/index.html and tasks/version.json. Run before committing a Tasks change.
cd "$(dirname "$0")"
TAG="v$(date -u +%Y-%m-%d.%H%M)"
sed -i.bak -E "s/const APP_VERSION='[^']*';/const APP_VERSION='$TAG';/" index.html && rm -f index.html.bak
sed -i.bak -E "s/const SHELL = '[^']*';/const SHELL = 'tasks-$TAG';/" sw.js && rm -f sw.js.bak
printf '{"tag": "%s"}\n' "$TAG" > version.json
echo "Tasks version $TAG"
