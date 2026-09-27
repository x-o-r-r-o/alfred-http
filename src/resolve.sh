#!/bin/bash
# Pass a result through to Alfred's clipboard object (⌘↩ paste).
# Long texts arrive as "httpfile:<path>" (written by http.js to the workflow cache). Only converted
# commands (out/<id>.txt) and downloaded text bodies (resp/<id>/body|preview.<ext>) directly inside
# the cache are read, so text that merely looks like "httpfile:<cache>/../secret" is passed through.
if [[ "$1" == httpfile:* && -n "$alfred_workflow_cache" ]]; then
  f="${1#httpfile:}"
  name="${f#"$alfred_workflow_cache"/}"
  if [[ "$name" != "$f" && -f "$f" ]] && [[ "$name" =~ ^out/[0-9a-f]{14}\.txt$ || "$name" =~ ^resp/[a-z0-9]{6,16}-[a-z0-9]{4,8}/(body|preview)\.(json|html|xml|txt|svg)$ ]]; then
    cat "$f"
    exit
  fi
fi
printf '%s' "$1"
