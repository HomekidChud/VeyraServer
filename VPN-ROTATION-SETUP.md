# VPN exit rotation setup

Veyra can rotate an active session across multiple configured VPN exits. This is intended for privacy/resilience and does not guarantee a different public IP unless the upstream provider actually exposes distinct exits.

Recommended Render environment variables:

VPN_ENABLED=true
VPN_FAILOVER=true
VPN_KILL_SWITCH=true
VPN_ROTATION_INTERVAL_MS=300000
VPN_ROTATION_MIN_GAP_MS=60000
VPN_ROTATION_SAME_IP_GUARD=true

Provide multiple exits in `VPN_PROFILES_JSON` or `VPN_PROFILES_FILE`.

A single fixed proxy/WireGuard endpoint cannot produce a different public IP merely because Veyra rotates locally.
