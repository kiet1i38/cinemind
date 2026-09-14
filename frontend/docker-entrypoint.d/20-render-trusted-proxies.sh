#!/bin/sh

set -eu

# Generate the trusted outer-proxy boundary at container start. The default is
# fail-closed: no incoming forwarding header is trusted until an operator
# explicitly supplies proxy CIDR blocks.
output="/etc/nginx/conf.d/cinemind-trusted-proxies.conf"
networks="${CINEMIND_TRUSTED_UPSTREAM_PROXY_NETWORKS:-}"

{
  printf '%s\n' 'real_ip_header X-Forwarded-For;' 'real_ip_recursive on;'
  valid_networks=""
  old_ifs=$IFS
  IFS=,
  for network in $networks; do
    network=$(printf '%s' "$network" | tr -d '[:space:]')
    case "$network" in
      "") ;;
      */*)
        case "$network" in
          *[!0-9A-Fa-f:./]*)
            printf '%s\n' "Ignoring invalid trusted proxy network: $network" >&2
            ;;
          *) valid_networks="$valid_networks $network" ;;
        esac
        ;;
      *)
        printf '%s\n' "Ignoring invalid trusted proxy network: $network" >&2
        ;;
    esac
  done
  IFS=$old_ifs
  for network in $valid_networks; do
    printf 'set_real_ip_from %s;\n' "$network"
  done
  printf '%s\n' 'geo $realip_remote_addr $cinemind_trusted_upstream {' '  default 0;'
  for network in $valid_networks; do
    printf '  %s 1;\n' "$network"
  done
  printf '%s\n' '}'
  printf '%s\n' 'map "$cinemind_trusted_upstream:$http_x_forwarded_proto" $cinemind_forwarded_proto {'
  printf '%s\n' '  default $scheme;' '  "~^1:https$" https;' '  "~^1:http$" http;' '}'
} > "$output"
