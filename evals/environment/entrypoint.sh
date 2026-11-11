#!/bin/bash
set -euo pipefail
# 只有网络初始化进程持有 NET_ADMIN。被测进程及其子进程丢弃全部能力。
if [[ "$(id -u)" == "0" ]]; then
  if [[ -n "${AXI_EVAL_RELAY_IP:-}" ]]; then
    iptables -P OUTPUT DROP
    iptables -A OUTPUT -o lo -j ACCEPT
    iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$AXI_EVAL_RELAY_IP" --dport 8787 -j ACCEPT
    ip6tables -P OUTPUT DROP
    ip6tables -A OUTPUT -o lo -j ACCEPT
  fi
  chown 1000:1000 /task /home/eval /tmp
  exec setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs "$@"
fi
exec "$@"
