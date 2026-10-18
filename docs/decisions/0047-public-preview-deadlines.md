# 0047 — Public previews always expire; environments have no TTL

`--ttl` is accepted only by `preview` (minutes, positive and finite), default 30
minutes. Each publication stores its absolute expiry independently of its lease.
Successful `up` renews an active preview for its stored TTL from completion time,
updating both the persisted deadline and the live origin timer without restarting
the tunnel. Failed `up`, traffic, sleep pardon and daemon restart do not extend it.
Automatic expiry preserves publication intent and its TTL; a successful `up`
reopens that preview. Restart alone leaves expired access closed. Explicit
`preview stop`, release, forbidden configuration or removing the published service
clears intent, so later `up` remains private. Never-published environments remain
private too. A failed republish is reported through `previewNotice` and
`previewRestore.state=failed`, without failing the successful service start. Expiry ends public access while retaining private services,
data and the lease. Legacy publications without deadlines are revoked on recovery.

Publishers target a private `PreviewGate`, which forwards to the service's public
proxy. At its deadline it closes the listener and existing streams independently
of environment locks, long builds or failure to kill the tunnel. The engine also
reaps the tunnel. After a daemon crash its gate is gone; recovery stops the old
tunnel before opening any service ports, and restores only unexpired publications.

Environment TTL options are rejected by CLI and up RPC. The old lease TTL setting
is ignored and existing lease deadlines are retired during recovery. Use `release`
to relinquish a lease. Idle timeout remains the service resource policy.

Proxy startup holds the original request and forwards the application's response
unchanged when ready. It does not inject a loading page into API or WebSocket
traffic. A failed or timed-out start returns generic HTTP 503 plus Retry-After only
for recognizable HTTP/1 requests before an application response starts. Binary,
TLS, or established streams close normally instead. Detailed logs stay local;
proxy diagnostics expose readiness time, state, and a safe error/log pointer.
