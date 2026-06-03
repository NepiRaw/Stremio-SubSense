#!/bin/bash
set -e

# ============================================================
# WARP Setup (optional - only runs if WARP_ENABLED=true)
# Provides a SOCKS5 proxy on localhost:40000 for upstream
# subtitle providers that block datacenter IPs
# ============================================================

if [ "${WARP_ENABLED}" = "true" ] || [ "${WARP_ENABLED}" = "1" ]; then
    echo "[WARP] Starting Cloudflare WARP setup..."

    WARP_SLEEP="${WARP_SLEEP:-3}"
    WARP_PORT="${WARP_PORT:-40000}"

    # Create tun device if not exists
    if [ ! -e /dev/net/tun ]; then
        mkdir -p /dev/net
        mknod /dev/net/tun c 10 200
        chmod 600 /dev/net/tun
    fi

    # Start dbus (required by warp-svc)
    mkdir -p /run/dbus
    if [ -f /run/dbus/pid ]; then
        rm /run/dbus/pid
    fi
    dbus-daemon --config-file=/usr/share/dbus-1/system.conf

    # Start WARP daemon
    warp-svc --accept-tos > /dev/null 2>&1 &
    sleep "$WARP_SLEEP"

    # Register WARP if not already registered
    if [ ! -f /var/lib/cloudflare-warp/reg.json ]; then
        warp-cli --accept-tos registration new && echo "[WARP] Client registered"
        if [ -n "$WARP_LICENSE_KEY" ]; then
            warp-cli --accept-tos registration license "$WARP_LICENSE_KEY" && echo "[WARP] License registered"
        fi
    else
        echo "[WARP] Client already registered"
    fi

    # Use proxy mode: only traffic routed through the SOCKS5 port goes through WARP.
    # Direct fetch() uses VPS IP (required for OpenSubtitles cookie-based downloads).
    warp-cli --accept-tos mode proxy
    warp-cli --accept-tos proxy port "$WARP_PORT"
    warp-cli --accept-tos connect

    sleep "$WARP_SLEEP"

    # Verify WARP proxy is working
    if curl -s --socks5-hostname "127.0.0.1:$WARP_PORT" "https://cloudflare.com/cdn-cgi/trace" 2>/dev/null | grep -q "warp=on\|warp=plus"; then
        echo "[WARP] Proxy mode active on 127.0.0.1:$WARP_PORT"
    else
        echo "[WARP] WARNING: WARP proxy may not be ready. Retrying..."
        sleep 3
        if curl -s --socks5-hostname "127.0.0.1:$WARP_PORT" "https://cloudflare.com/cdn-cgi/trace" 2>/dev/null | grep -q "warp=on\|warp=plus"; then
            echo "[WARP] Proxy mode active on 127.0.0.1:$WARP_PORT (after retry)"
        else
            echo "[WARP] WARNING: WARP may not be fully connected. Provider downloads may fail."
        fi
    fi

    export WARP_PROXY_URL="socks5h://127.0.0.1:$WARP_PORT"
else
    echo "[WARP] Disabled (set WARP_ENABLED=true to enable)"
fi

exec npm start
