#!/usr/bin/env bash
# Smoke-test the deployed site. Used by .github/workflows/healthcheck.yml,
# which reports the result to healthchecks.io; also handy to run by hand:
#
#   scripts/healthcheck.sh https://learner-agent-sudo.github.io/Pdf-md/
#
# Checks that the page loads, that its no-upload Content-Security-Policy is
# intact, and that every file the page needs is served — the <script>/<link>
# files, plus the modules, workers, WASM engine, and OCR language packs that
# app.js loads on demand. The file list is read from the live site itself, so
# it always matches what is actually deployed.
#
# Prints one line per check and exits non-zero if anything is wrong.
set -euo pipefail

base="${1:?usage: $0 <site-url>}"
base="${base%/}/"
problems=0

ok()  { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; problems=$((problems + 1)); }
fetch() { curl -fsSL --retry 3 --max-time 60 "$1"; }

# 1. The page itself.
if ! page=$(fetch "$base"); then
  echo "FAIL  $base did not load"
  exit 1
fi
if grep -q 'id="drop-zone"' <<<"$page"; then
  ok "page loads"
else
  bad "page loads, but the converter UI is missing"
fi

# 2. The privacy guarantee: a CSP that allows no outside origins.
csp=$(grep -o 'http-equiv="Content-Security-Policy" content="[^"]*"' <<<"$page" || true)
if [[ -z $csp ]]; then
  bad "Content-Security-Policy is missing"
elif [[ $csp != *"default-src 'none'"* ]] || grep -qE "https?:|wss?:|\*" <<<"${csp#*content=}"; then
  bad "Content-Security-Policy now allows outside origins: ${csp#*content=}"
else
  ok "Content-Security-Policy intact (no outbound connections allowed)"
fi

# 3. Every file the page loads.
app=$(fetch "${base}app.js" || true)
mapfile -t files < <(
  {
    grep -oE '(src|href)="[^"#:]+"' <<<"$page" | cut -d'"' -f2          # <script>, <link>
    grep -oE '"(\./|vendor/)[^"]+\.m?js"' <<<"$app" | tr -d '"'          # imports, workers
    grep -oE '<option value="[a-z_]+"' <<<"$page" | cut -d'"' -f2 |
      grep -vx auto | sed 's|.*|vendor/&.traineddata.gz|'                # OCR languages
  } | sed 's|^\./||' | sort -u
)
for f in "${files[@]}"; do
  [[ $f == *.wasm.js ]] && files+=("${f%.js}") # the loader fetches its .wasm
done

for f in "${files[@]}"; do
  read -r code size < <(curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' \
    --retry 3 --max-time 120 "$base$f" || echo "000 0")
  if [[ $code == 200 && $size -gt 0 ]]; then
    ok "$f ($size bytes)"
  else
    bad "$f (HTTP $code)"
  fi
done

echo
if (( problems )); then
  echo "$problems problem(s) found on $base"
  exit 1
fi
echo "All good: page + ${#files[@]} files served from $base"
